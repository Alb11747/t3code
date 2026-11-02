import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Queue tests must not open a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "compaction-queue" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

it.effect.each([
  { outcome: "completed", compacted: false, beforeSend: false, destinationChanged: false },
  { outcome: "completed", compacted: false, beforeSend: true, destinationChanged: false },
  { outcome: "failed", compacted: false, beforeSend: true, destinationChanged: false },
  { outcome: "interrupted", compacted: false, beforeSend: true, destinationChanged: false },
  { outcome: "completed", compacted: true, beforeSend: false, destinationChanged: false },
  { outcome: "completed", compacted: true, beforeSend: true, destinationChanged: false },
  { outcome: "completed", compacted: true, beforeSend: true, destinationChanged: true },
] as const)(
  "releases a message only after successful compaction ($outcome, compacted=$compacted, beforeSend=$beforeSend, destinationChanged=$destinationChanged)",
  ({ outcome, compacted, beforeSend, destinationChanged }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:compaction-queue");
      const compactMessageId = MessageId.make("message:compact");
      const messageId = MessageId.make("message:after-compact");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:compaction-queue"),
        threadId,
        projectId: ProjectId.make("project:compaction-queue"),
        title: "Compaction queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:compact"),
        threadId,
        messageId: compactMessageId,
        text: "/compact",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const compactRun = runs[0]!;
      const now = yield* DateTime.now;
      const terminalEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("event:compact-ended"),
          type: "run.updated",
          threadId,
          runId: compactRun.id,
          occurredAt: now,
          payload: { ...compactRun, status: outcome, completedAt: now },
        },
        {
          id: EventId.make("event:compaction-result"),
          type: "turn-item.updated",
          threadId,
          runId: compactRun.id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("item:compaction"),
            type: "compaction",
            threadId,
            runId: compactRun.id,
            nodeId: compactRun.rootNodeId,
            providerThreadId: compactRun.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            driver: adapter.driver,
            status: compacted ? "completed" : "failed",
            title: "Compaction result",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      ];
      if (beforeSend) yield* sink.write({ events: terminalEvents });
      const send = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("send:after-compact"),
        threadId,
        messageId,
        text: "Continue",
        attachments: [],
        afterCompactionMessageId: compactMessageId,
        dispatchMode: { type: "queue_after_active" as const },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      if (destinationChanged) {
        const current = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
        const destination = {
          ...current.providerThreads[0]!,
          id: ProviderThreadId.make("native:new-destination"),
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:new-destination"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: destination,
            },
            {
              id: EventId.make("event:select-new-destination"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: { ...current.thread, activeProviderThreadId: destination.id },
            },
          ],
        });
        const error = yield* Effect.flip(orchestrator.dispatch(send));
        expect(error).toBeInstanceOf(Orchestrator.OrchestratorContextPolicyRequiredError);
        expect(
          (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.some(
            (message) => message.id === messageId,
          ),
        ).toBe(false);
        return;
      }
      yield* orchestrator.dispatch(send);
      if (!beforeSend) yield* sink.write({ events: terminalEvents });
      yield* orchestrator.resumeQueuedRuns;
      // A replay after a partial send must retain the persisted prerequisite.
      yield* orchestrator.dispatch(send);
      const current = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      const next = current.runs.find((run) => run.userMessageId === messageId)!;
      expect(next.status).toBe(compacted ? "starting" : "queued");
      expect(current.messages.filter((message) => message.id === messageId)).toHaveLength(1);
      if (!compacted) {
        expect(next.afterCompactionMessageId).toBe(compactMessageId);
        yield* orchestrator.dispatch({
          type: "queued-run.start",
          threadId,
          runId: next.id,
          commandId: CommandId.make("force:start-after-compact"),
        });
        expect(
          (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
            (run) => run.id === next.id,
          )?.status,
        ).toBe("queued");
        const promotion = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("force:steer-after-compact"),
            threadId,
            queuedRunId: next.id,
            targetRunId: compactRun.id,
          })
          .pipe(Effect.result);
        expect(promotion._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(layerTest)),
);
