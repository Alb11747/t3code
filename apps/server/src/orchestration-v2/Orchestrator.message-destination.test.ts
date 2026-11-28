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
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { queuedAgentReportBatch } from "./QueuedRunOrder.ts";
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
  providerDriver = driver,
): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make(id),
    driver: providerDriver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: providerDriver, nativeId: id, strength: "strong" },
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

function layerTest(
  compatibleAccounts: boolean,
  providerDriver = driver,
  settings: { readonly idleCompaction?: "off" } = {},
) {
  const capabilities =
    providerDriver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2;
  const adapters = [firstInstanceId, targetInstanceId].map(
    (instanceId): ProviderAdapter.ProviderAdapterV2["Service"] => ({
      instanceId,
      driver: providerDriver,
      getCapabilities: () => Effect.succeed(capabilities),
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
          driver: providerDriver,
          continuationKey: compatibleAccounts ? "claude:shared-history" : `claude:${instanceId}`,
          enabled: true,
          capabilities,
        }),
    }),
  );
  const database = SqlitePersistence.layerMemory;
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry({ name: "message-destination" }, registry, {
        databaseLayer: database,
        runEffectWorker: false,
        ...(settings.idleCompaction === undefined
          ? {}
          : { settingsLayer: ServerSettings.layerTest(settings).pipe(Layer.orDie) }),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        ...settings,
        providerInstances: {
          [firstInstanceId]: { driver: providerDriver, enabled: true },
          [targetInstanceId]: { driver: providerDriver, enabled: true },
        },
      }),
    ),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  );
}

const scenarios = [
  "compatible-account",
  "retained-order",
  "same-instance-active",
  "missing-active",
  "busy-queue",
  "busy-same-conversation",
  "busy-self-compact",
  "queued-context-policies",
  "warm",
  "small",
  "human",
  "reported-expiry",
  "warm-reported",
  "busy-preparing",
  "compact-attachment",
  "scheduled",
  "compact",
]
  .map((scenario) => ({ scenario, providerDriver: driver }))
  .concat(
    ["compact", "busy-self-compact"].map((scenario) => ({
      scenario,
      providerDriver: ProviderDriverKind.make("codex"),
    })),
  );

it.effect.each(scenarios)("resumes $providerDriver $scenario", ({ scenario, providerDriver }) =>
  Effect.gen(function* () {
    const queuedContextPolicies = scenario === "queued-context-policies";
    const busySameConversation = scenario === "busy-same-conversation";
    const busyQueue =
      scenario === "busy-queue" ||
      busySameConversation ||
      scenario === "busy-self-compact" ||
      queuedContextPolicies;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messages = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const projectId = ProjectId.make("project:message-destination");
    const epoch = DateTime.makeUnsafe(0);
    const first = providerThread(
      "native:first",
      firstInstanceId,
      busyQueue && !busySameConversation ? 1_000 : 500_000,
      20,
      epoch,
      providerDriver,
    );
    const retained = providerThread(
      "native:retained",
      targetInstanceId,
      scenario === "small"
        ? 199_999
        : scenario === "busy-preparing" || queuedContextPolicies
          ? 1_000
          : 500_000,
      20,
      epoch,
      providerDriver,
    );
    const recent = providerThread(
      "native:recent",
      targetInstanceId,
      1_000,
      10,
      DateTime.makeUnsafe(69 * 60_000),
      providerDriver,
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
    if (busyQueue || scenario === "busy-preparing") {
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
      // busy-same-conversation queues onto the busy run's own conversation.
      yield* sink.write({
        events: busySameConversation
          ? []
          : [
              {
                id: EventId.make("event:select-queued-account"),
                type: "thread.provider-switched",
                threadId,
                occurredAt: epoch,
                payload: {
                  ...current.thread,
                  modelSelection,
                  providerInstanceId: targetInstanceId,
                },
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
    if (scenario === "compact") {
      const sent = yield* messages.sendToThread({ ...input, contextPolicy: "compact" });
      expect(sent.delivery).toBe("queued");
      expect(sent.run.afterCompactionMessageId).toBe(MessageId.make(`${input.messageId}:compact`));
      const replay = yield* messages.sendToThread({ ...input, contextPolicy: "compact" });
      expect(replay.run.id).toBe(sent.run.id);
      const stored = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      expect(stored.messages.filter((message) => message.text === "/compact")).toHaveLength(1);
      expect(stored.messages.filter((message) => message.id === input.messageId)).toHaveLength(1);
      return;
    }
    if (queuedContextPolicies) {
      const senderThreadId = ThreadId.make("thread:agent-report-sender");
      const send = (
        label: string,
        overrides: Partial<ThreadManagement.ThreadManagementSendInput> = {},
      ) =>
        messages.sendToThread({
          ...input,
          commandId: CommandId.make("send:" + label),
          messageId: MessageId.make("message:" + label),
          text: label,
          senderThreadId,
          ...overrides,
        });
      const firstReport = yield* send("first report");
      const secondReport = yield* send("second report");
      const keep = yield* send("retain full history", { contextPolicy: "keep", mode: "auto" });
      const later = yield* send("later report");
      const compact = yield* send("resume after compaction", {
        contextPolicy: "compact",
        senderThreadId: threadId,
      });
      const fresh = yield* send("new context", { freshContext: true });
      const outputSchema = { type: "object", properties: {} };
      const structured = yield* send("structured output", { outputSchema });
      expect(keep.delivery).toBe("queued");
      expect(keep.run.deliveryIntent).toBeUndefined();
      expect(keep.message.atToolBoundary).toBeUndefined();
      expect(compact.delivery).toBe("queued");
      expect(compact.run.afterCompactionMessageId).toBe(
        MessageId.make("message:resume after compaction:compact"),
      );
      expect(fresh.run.freshContext).toBe(true);
      expect(structured.run.outputSchema).toEqual(outputSchema);

      const persisted = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      const batch = queuedAgentReportBatch(persisted, firstReport.run, firstReport.message);
      expect(batch.map(({ run }) => run.id)).toEqual([secondReport.run.id]);
      const suffix = {
        ...persisted,
        runs: persisted.runs.filter((run) => run.id === later.run.id),
      };
      for (const policy of [keep, compact, fresh, structured]) {
        const lead = { ...policy.run, status: "running" as const };
        expect(queuedAgentReportBatch(suffix, lead, policy.message)).toEqual([]);
      }
      return;
    }
    if (scenario === "busy-self-compact") {
      // The calling agent's own turn is the busy run: compact after it, then deliver.
      const sent = yield* messages.sendToThread({
        ...input,
        mode: "steer",
        senderThreadId: threadId,
        contextPolicy: "compact",
      });
      expect(sent.delivery).toBe("queued");
      expect(sent.run.deliveryIntent).toBeUndefined();
      const compactId = MessageId.make(`${input.messageId}:compact`);
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
    if (scenario === "busy-preparing") {
      const sent = yield* messages.sendToThread(input);
      expect(sent.run.providerThreadId).toBe(retained.id);
      expect(sent.delivery).toBe("queued");
      expect(
        (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.find(
          (message) => message.id === input.messageId,
        )?.atToolBoundary,
      ).not.toBe(true);
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
      return;
    }
    if (busySameConversation) {
      // A turn still active on the cold conversation re-reads it anyway (2026-11-27 stall).
      const sent = yield* messages.sendToThread(input);
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      expect(sent.delivery).toBe("queued");
      expect(sent.run.providerThreadId).toBe(first.id);
      expect(runs.find((run) => run.id !== sent.run.id)?.providerThreadId).toBe(first.id);
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
          scenario === "busy-same-conversation" ||
          scenario === "busy-self-compact" ||
          scenario === "busy-preparing",
        providerDriver,
      ),
    ),
  ),
);

it.effect.each(["cold", "warm", "off", "never", "snoozed", "issue-watch"] as const)(
  "a server wake into a cold large Claude conversation compacts it first ($0)",
  (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const epoch = DateTime.makeUnsafe(0);
      const retained = providerThread("native:wake", targetInstanceId, 500_000, 1, epoch);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:server-wake"),
        threadId,
        projectId: ProjectId.make("project:server-wake"),
        title: "Server wake",
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
          {
            id: EventId.make("event:wake-provider"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: epoch,
            payload: retained,
          },
          {
            id: EventId.make("event:wake-active"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: epoch,
            payload: {
              ...thread,
              activeProviderThreadId: retained.id,
              ...(scenario === "never" ? { compactBeforeCacheExpires: false } : {}),
              ...(scenario === "snoozed"
                ? { snoozedAt: epoch, snoozedUntil: DateTime.makeUnsafe(10 * 3_600_000) }
                : {}),
            },
          },
        ],
      });
      yield* TestClock.adjust(scenario === "warm" ? "69 minutes" : "70 minutes");
      const messageId = MessageId.make("message:server-wake");
      const notice = {
        commandId: CommandId.make("send:server-wake"),
        threadId,
        messageId,
        text: "Background activity updated",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
      } as const;
      // Watches dispatch their own command types, which must compact the same way.
      yield* orchestrator.dispatch(
        scenario === "issue-watch"
          ? { ...notice, type: "thread.issue-watch.wake" }
          : {
              ...notice,
              type: "message.dispatch",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
            },
      );
      const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      const wake = runs.find((run) => run.userMessageId === messageId);
      const compaction = messages.find((message) => message.text === "/compact");
      if (scenario === "warm" || scenario === "off" || scenario === "never") {
        expect(compaction).toBeUndefined();
        expect(wake?.status).toBe("starting");
        return;
      }
      expect(runs.find((run) => run.userMessageId === compaction?.id)?.status).toBe("starting");
      // A failed compaction must not strand the wake, so it only queues behind it.
      expect(wake).toMatchObject({ status: "queued", providerThreadId: retained.id });
      expect(wake?.afterCompactionMessageId).toBeUndefined();
      if (scenario === "snoozed") {
        const { thread: after } = yield* orchestrator.getThreadRecords(threadId, []);
        expect(after.snoozedUntil).not.toBeNull();
      }
    }).pipe(
      Effect.provide(layerTest(false, driver, scenario === "off" ? { idleCompaction: "off" } : {})),
    ),
);
