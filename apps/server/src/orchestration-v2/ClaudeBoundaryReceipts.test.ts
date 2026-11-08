import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { readClaudeBoundaryReceipts } from "./Adapters/ClaudeSavedMessageReceipts.ts";
import { makeClaudeBoundaryReceiptRecovery } from "./ClaudeBoundaryReceipts.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("Claude boundary saved history", (it) => {
  it.effect(
    "settles saved offers after restart in their original run and leaves missing offers held",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boundary-recovery-" });
        const project = path.join(directory, "projects", "project");
        yield* fs.makeDirectory(project, { recursive: true });
        yield* fs.writeFileString(
          path.join(project, "native-session.jsonl"),
          encodeLine({
            type: "attachment",
            sessionId: "native-session",
            isSidechain: false,
            attachment: { type: "queued_command", source_uuid: "saved" },
          }),
        );
        const threadId = ThreadId.make("recovery-thread");
        const projection = {
          thread: { id: threadId, archivedAt: null, deletedAt: null },
          runs: ["saved", "missing"].map((id) => ({
            id: `queued-${id}`,
            userMessageId: `message-${id}`,
            status: "queued",
            queueHeld: true,
            boundaryOffer: { id, targetRunId: "original-run", providerTurnId: "original-turn" },
          })),
          messages: [],
          providerTurns: [{ id: "original-turn", providerThreadId: "provider-thread" }],
          providerThreads: [
            {
              id: "provider-thread",
              providerInstanceId: "claude",
              nativeThreadRef: { nativeId: "native-session" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const operations: unknown[] = [];
        const recover = yield* makeClaudeBoundaryReceiptRecovery.pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords: () => Effect.succeed(projection),
                dispatch: (command) =>
                  Effect.sync(() => {
                    operations.push(command);
                    return {} as never;
                  }),
              }),
              Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                reserveBoundary: (reservation) =>
                  Effect.sync(() => {
                    operations.push(reservation);
                  }),
              }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  providerInstances: {
                    claude: {
                      driver: ProviderDriverKind.make("claudeAgent"),
                      config: { homePath: directory },
                    },
                  },
                }),
              }),
            ),
          ),
        );
        yield* recover;
        assert.deepEqual(operations, [
          {
            threadId,
            turnItemId: "turn-item:message:message-saved",
            runId: "original-run",
            queuedRunId: "queued-saved",
            offerId: "saved",
            providerTurnId: "original-turn",
          },
          {
            type: "queued-message.promote-to-steer",
            commandId: "tool-boundary-receipt:saved",
            threadId,
            queuedRunId: "queued-saved",
            targetRunId: "original-run",
            boundaryOffer: { id: "saved", step: "receipt" },
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "recovers exact root receipts and legacy context while retaining ambiguous offers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boundary-receipts-" });
        const project = path.join(directory, "project");
        yield* fs.makeDirectory(project);
        const entry = (attachment: unknown, overrides: Record<string, unknown> = {}) => ({
          type: "attachment",
          sessionId: "native-session",
          isSidechain: false,
          attachment,
          ...overrides,
        });
        const legacy = "From another agent (delivery legacy):\nOriginal saved update";
        const legacyBatch = [
          "From the user (delivery batch-first):\nFirst update\n\nSecond paragraph",
          "From another agent (delivery batch-middle):\nMiddle update",
          "From the user (delivery batch-last):\nLast update",
        ];
        const results = path.join(project, "native-session", "tool-results");
        yield* fs.makeDirectory(results, { recursive: true });
        const persistedContext = "From another agent (delivery persisted):\nSaved large update";
        const persistedLast = "From the user (delivery persisted-last):\nLast saved update";
        const outputPath = path.join(results, "hook-hook-large-1-additionalContext.txt");
        yield* fs.writeFileString(
          outputPath,
          `New messages:\n${persistedContext}\n\n${persistedLast}`,
        );
        const persisted = (output: string) =>
          `<persisted-output>\nOutput too large (29KB). Full output saved to: ${output}\n\nPreview (first 2KB):\nNew messages:\n${persistedContext.slice(0, 30)}\n...\n</persisted-output>`;
        const outsidePath = path.join(project, "hook-hook-outside-1-additionalContext.txt");
        yield* fs.writeFileString(
          outsidePath,
          "New messages:\nFrom another agent (delivery outside):\nOutside the session",
        );
        const wrongOwnerPath = path.join(
          results,
          "hook-hook-foreign-owner-1-additionalContext.txt",
        );
        yield* fs.writeFileString(
          wrongOwnerPath,
          "New messages:\nFrom another agent (delivery wrong-owner):\nAnother hook's output",
        );
        const rows = [
          entry({ type: "queued_command", source_uuid: "saved" }),
          entry({ type: "queued_command", source_uuid: "saved" }),
          entry({ type: "queued_command", source_uuid: "foreign" }, { sessionId: "other-session" }),
          entry({ type: "queued_command", source_uuid: "child" }, { isSidechain: true }),
          entry({ type: "hook_additional_context", content: [`New messages:\n${legacy}`] }),
          entry({
            type: "hook_additional_context",
            content: [`New messages:\n${legacyBatch.join("\n\n")}`],
          }),
          entry({
            type: "hook_additional_context",
            content: ["New messages:\nFrom the user (delivery changed-legacy):\nChanged text"],
          }),
          entry({ type: "hook_additional_context", content: ["changed original text"] }),
          entry({
            type: "hook_additional_context",
            hookName: "PostToolBatch",
            hookEvent: "PostToolBatch",
            toolUseID: "hook-large",
            content: [persisted(outputPath)],
          }),
          entry({
            type: "hook_additional_context",
            hookName: "PostToolBatch",
            hookEvent: "PostToolBatch",
            toolUseID: "hook-outside",
            content: [persisted(outsidePath)],
          }),
          entry({
            type: "hook_additional_context",
            hookName: "PostToolBatch",
            hookEvent: "PostToolBatch",
            toolUseID: "hook-wrong-owner",
            content: [persisted(wrongOwnerPath)],
          }),
          entry({
            type: "hook_additional_context",
            hookName: "PostToolBatch",
            hookEvent: "PostToolBatch",
            toolUseID: "hook-missing",
            content: [persisted(path.join(results, "hook-hook-missing-1-additionalContext.txt"))],
          }),
          { type: "queue-operation", operation: "enqueue", content: "queued-only" },
          { type: "user", uuid: "unrelated-turn" },
        ];
        yield* fs.writeFileString(
          path.join(project, "native-session.jsonl"),
          `${rows.map((row) => encodeLine(row)).join("\n")}\n{"type":"attachment"`,
        );
        const saved = yield* readClaudeBoundaryReceipts({
          projectsDirectory: directory,
          nativeThreadId: "native-session",
          offers: [
            { id: "saved" },
            { id: "foreign" },
            { id: "child" },
            { id: "queued-only" },
            { id: "missing" },
            { id: "legacy", legacyContext: legacy },
            ...legacyBatch.map((legacyContext, index) => ({
              id: ["batch-first", "batch-middle", "batch-last"][index]!,
              legacyContext,
            })),
            {
              id: "changed-legacy",
              legacyContext: "From the user (delivery changed-legacy):\nOriginal text",
            },
            { id: "wrong-legacy", legacyContext: "Original saved update" },
            { id: "partial-legacy", legacyContext: legacyBatch.slice(0, 2).join("\n\n") },
            { id: "persisted", legacyContext: persistedContext },
            { id: "persisted-last", legacyContext: persistedLast },
            {
              id: "wrong-owner",
              legacyContext: "From another agent (delivery wrong-owner):\nAnother hook's output",
            },
            {
              id: "missing-file",
              legacyContext: "From another agent (delivery missing-file):\nNot saved",
            },
            {
              id: "outside",
              legacyContext: "From another agent (delivery outside):\nOutside the session",
            },
          ],
        });
        assert.deepEqual(
          [...saved],
          [
            "saved",
            "legacy",
            "batch-first",
            "batch-middle",
            "batch-last",
            "persisted",
            "persisted-last",
          ],
        );
        assert.deepEqual(
          [
            ...(yield* readClaudeBoundaryReceipts({
              projectsDirectory: path.join(directory, "absent"),
              nativeThreadId: "native-session",
              offers: [{ id: "missing" }],
            })),
          ],
          [],
        );
      }).pipe(Effect.scoped),
  );
});
