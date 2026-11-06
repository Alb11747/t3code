import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ChatAttachmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const firstInstanceId = ProviderInstanceId.make("claude_first");
const targetInstanceId = ProviderInstanceId.make("claude_target");
const threadId = ThreadId.make("thread:message-destination");
const modelSelection = { instanceId: targetInstanceId, model: "test" };

function providerThread(
  id: string,
  instanceId: ProviderInstanceId,
  usedTokens: number,
  lastRunOrdinal: number,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make(id),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: id, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: { usedTokens },
    createdAt: DateTime.makeUnsafe(0),
    updatedAt,
  };
}

function layerTest(compatibleAccounts: boolean) {
  const adapters = [firstInstanceId, targetInstanceId].map(
    (instanceId): ProviderAdapter.ProviderAdapterV2["Service"] => ({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Destination resolution must not open provider sessions"),
    }),
  );
  const registry = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
        return adapter === undefined
          ? Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            )
          : Effect.succeed(adapter);
      },
      list: () => Effect.succeed([firstInstanceId, targetInstanceId]),
      getMetadata: (instanceId) =>
        Effect.succeed({
          driver,
          continuationKey: compatibleAccounts ? "claude:shared-history" : `claude:${instanceId}`,
          enabled: true,
          capabilities: ClaudeProviderCapabilitiesV2,
        }),
    }),
  );
  const database = SqlitePersistence.layerMemory;
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry({ name: "message-destination" }, registry, {
        databaseLayer: database,
        runEffectWorker: false,
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [firstInstanceId]: { driver, enabled: true },
          [targetInstanceId]: { driver, enabled: true },
        },
      }),
    ),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  );
}

it.effect.each([
  "compatible-account",
  "retained-order",
  "same-instance-active",
  "missing-active",
  "busy-queue",
  "busy-self-compact",
  "warm",
  "small",
  "human",
  "reported-expiry",
  "warm-reported",
  "busy-boundary",
  "compact-attachment",
  "scheduled",
  "compact",
  "compact-partial",
] as const)("checks the %s conversation that the next message actually resumes", (scenario) =>
  Effect.gen(function* () {
    const busyQueue = scenario === "busy-queue" || scenario === "busy-self-compact";
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messages = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const projectId = ProjectId.make("project:message-destination");
    const epoch = DateTime.makeUnsafe(0);
    const first = providerThread(
      "native:first",
      firstInstanceId,
      busyQueue ? 1_000 : 500_000,
      20,
      epoch,
    );
    const retained = providerThread(
      "native:retained",
      targetInstanceId,
      scenario === "small" ? 199_999 : scenario === "busy-boundary" ? 1_000 : 500_000,
      20,
      epoch,
    );
    const recent = providerThread(
      "native:recent",
      targetInstanceId,
      1_000,
      10,
      DateTime.makeUnsafe(69 * 60_000),
    );
    const active = scenario === "same-instance-active" ? retained : first;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:message-destination"),
      threadId,
      projectId,
      title: "Message destination",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        ...[first, retained, recent].map((payload) => ({
          id: EventId.make(`event:${payload.id}`),
          type: "provider-thread.updated" as const,
          threadId,
          occurredAt: epoch,
          payload,
        })),
        {
          id: EventId.make("event:active-provider"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: epoch,
          payload: {
            ...thread,
            activeProviderThreadId: scenario === "missing-active" ? null : active.id,
          },
        },
      ],
    });
    if (busyQueue || scenario === "busy-boundary") {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:busy-work"),
        threadId,
        messageId: MessageId.make("message:busy-work"),
        text: "Earlier work",
        attachments: [],
        modelSelection: { instanceId: firstInstanceId, model: "test" },
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const current = yield* orchestrator.getThreadRecords(threadId, []);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:select-queued-account"),
            type: "thread.provider-switched",
            threadId,
            occurredAt: epoch,
            payload: { ...current.thread, modelSelection, providerInstanceId: targetInstanceId },
          },
        ],
      });
    }
    if (scenario === "reported-expiry" || scenario === "warm-reported") {
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:reported-cache-expiry"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: epoch,
            payload: {
              id: ProviderTurnId.make("turn:cache-expiry"),
              providerThreadId: retained.id,
              nodeId: NodeId.make("node:cache-expiry"),
              runAttemptId: RunAttemptId.make("attempt:cache-expiry"),
              nativeTurnRef: null,
              ordinal: 1,
              status: "completed",
              startedAt: epoch,
              completedAt: epoch,
              tokenUsage: {
                usedTokens: 500_000,
                updatedAt: "1970-01-01T00:02:00.000Z",
                promptCacheTtlMs: 300_000,
                promptCacheExpiresAt: "1970-01-01T00:05:00.000Z",
              },
            },
          },
        ],
      });
    }
    yield* TestClock.adjust(
      scenario === "warm"
        ? "69 minutes"
        : scenario === "reported-expiry"
          ? "5 minutes"
          : scenario === "warm-reported"
            ? "4 minutes"
            : "70 minutes",
    );
    const input: ThreadManagement.ThreadManagementSendInput = {
      projectId,
      threadId,
      commandId: CommandId.make("send:message-destination"),
      messageId: MessageId.make("message:message-destination"),
      text: scenario === "compact-attachment" ? "/compact" : "Continue",
      attachments:
        scenario === "compact-attachment"
          ? [
              {
                type: "image",
                id: ChatAttachmentId.make("attachment_compact"),
                name: "frame.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ]
          : [],
      mode: busyQueue ? "queue" : "auto",
      createdBy: scenario === "human" ? "user" : "agent",
      creationSource: "mcp",
      ...(scenario === "scheduled"
        ? { scheduledTaskId: ScheduledTaskId.make("scheduled:control") }
        : {}),
    };
    if (scenario === "compact" || scenario === "compact-partial") {
      if (scenario === "compact-partial") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make(`agent-compact:${input.commandId}`),
          messageId: MessageId.make(`agent-compact:${input.messageId}`),
          text: "/compact",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "agent",
          creationSource: "mcp",
        });
      }
      const sent = yield* messages.sendToThread({ ...input, contextPolicy: "compact" });
      expect(sent.delivery).toBe("queued");
      expect(sent.run.afterCompactionMessageId).toBe(
        MessageId.make(`agent-compact:${input.messageId}`),
      );
      const replay = yield* messages.sendToThread({ ...input, contextPolicy: "compact" });
      expect(replay.run.id).toBe(sent.run.id);
      const stored = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      expect(stored.messages.filter((message) => message.text === "/compact")).toHaveLength(1);
      expect(stored.messages.filter((message) => message.id === input.messageId)).toHaveLength(1);
      return;
    }
    if (scenario === "busy-self-compact") {
      // The calling agent's own turn is the busy run: compact after it, then deliver.
      const sent = yield* messages.sendToThread({
        ...input,
        senderThreadId: threadId,
        contextPolicy: "compact",
      });
      expect(sent.delivery).toBe("queued");
      const compactId = MessageId.make(`agent-compact:${input.messageId}`);
      expect(sent.run.afterCompactionMessageId).toBe(compactId);
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      expect(runs.find((run) => run.userMessageId === compactId)?.status).toBe("queued");
      return;
    }
    if (scenario === "missing-active") {
      const sent = yield* messages.sendToThread(input);
      expect(sent.run.providerThreadId).not.toBe(retained.id);
      expect(sent.run.providerThreadId).not.toBe(first.id);
      return;
    }
    if (
      scenario === "warm" ||
      scenario === "small" ||
      scenario === "human" ||
      scenario === "scheduled" ||
      scenario === "warm-reported"
    ) {
      expect((yield* messages.sendToThread(input)).delivery).toBe("started");
      return;
    }
    const error = yield* Effect.flip(messages.sendToThread(input));
    expect(error).toBeInstanceOf(ThreadManagement.ThreadManagementContextPolicyError);
    expect(
      (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.some(
        (message) => message.id === input.messageId,
      ),
    ).toBe(false);
    if (scenario === "busy-queue") {
      const busyError = yield* Effect.flip(
        messages.sendToThread({ ...input, contextPolicy: "compact" }),
      );
      expect(busyError.message).toContain("busy");
    }
    const sent = yield* messages.sendToThread({ ...input, contextPolicy: "keep" });
    expect(sent.run.providerThreadId).toBe(
      scenario === "compatible-account" ? first.id : retained.id,
    );
    if (scenario === "busy-boundary") {
      expect(sent.delivery).toBe("queued");
      expect(
        (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.find(
          (message) => message.id === input.messageId,
        )?.atToolBoundary,
      ).toBe(true);
      const fresh = yield* messages.sendToThread({
        ...input,
        commandId: CommandId.make("command:fresh-boundary"),
        messageId: MessageId.make("message:fresh-boundary"),
        freshContext: true,
        contextPolicy: "compact",
      });
      expect(fresh.delivery).toBe("queued");
      expect(fresh.run.providerThreadId).not.toBe(retained.id);
      expect(fresh.run.afterCompactionMessageId).toBeUndefined();
      expect(fresh.message.atToolBoundary).not.toBe(true);
    }
    if (scenario === "busy-queue") {
      expect(sent.delivery).toBe("queued");
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const busy = runs.find((run) => run.id !== sent.run.id)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:busy-work-ended"),
            type: "run.updated",
            threadId,
            runId: busy.id,
            occurredAt: now,
            payload: { ...busy, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.resumeQueuedRuns;
      const released = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === sent.run.id,
      )!;
      expect(released.status).toBe("starting");
      expect(released.providerThreadId).toBe(retained.id);
    }
  }).pipe(
    Effect.provide(
      layerTest(
        scenario === "compatible-account" ||
          scenario === "busy-queue" ||
          scenario === "busy-self-compact" ||
          scenario === "busy-boundary",
      ),
    ),
  ),
);
