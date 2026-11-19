import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
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

const compactionPair = Effect.fn("compactionPair")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const compactMessageId = MessageId.make("message:compact");
  const messageId = MessageId.make("message:after-compact");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:compaction-pair"),
    threadId,
    projectId: ProjectId.make("project:compaction-pair"),
    title: "Compaction pair",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  for (const [id, text, afterCompactionMessageId] of [
    [compactMessageId, "/compact", undefined],
    [messageId, "Continue", compactMessageId],
  ] as const) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: id,
      text,
      attachments: [],
      ...(afterCompactionMessageId === undefined ? {} : { afterCompactionMessageId }),
      dispatchMode: { type: afterCompactionMessageId ? "queue_after_active" : "defer_start" },
      createdBy: "agent",
      creationSource: "mcp",
    });
  }
  const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
  return { compactMessageId, messageId, compactRun: runs[0]! };
});

const endCompaction = Effect.fn("endCompaction")(function* (
  threadId: ThreadId,
  compactRun: OrchestrationV2Run,
  compacted: boolean,
  commandId?: CommandId,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    ...(commandId === undefined ? {} : { commandId }),
    events: [
      {
        id: EventId.make(`event:compact-ended:${compactRun.id}`),
        type: "run.updated",
        threadId,
        runId: compactRun.id,
        occurredAt: now,
        payload: {
          ...compactRun,
          status: compacted ? "completed" : "failed",
          completedAt: now,
        },
      },
      {
        id: EventId.make(`event:compaction-result:${compactRun.id}`),
        type: "turn-item.updated",
        threadId,
        runId: compactRun.id,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:compaction:${compactRun.id}`),
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
    ],
  });
});

it.effect.each(["child report during compaction", "scheduled prompt as it ends"] as const)(
  "runs a compaction's message before a %s",
  (arrival) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:compaction-order");
      const { messageId, compactRun } = yield* compactionPair(threadId);
      const otherMessageId = MessageId.make("message:other");
      if (arrival === "child report during compaction") {
        const now = yield* DateTime.now;
        const taskIds = [NodeId.make("task:child")];
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:child-delivery"),
              type: "run.updated",
              threadId,
              runId: compactRun.id,
              occurredAt: now,
              payload: {
                ...compactRun,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId: otherMessageId, taskIds },
                },
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:child-report"),
          threadId,
          messageId: otherMessageId,
          text: "Delegated task completed",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: { parentRunId: compactRun.id, generation: 1, taskIds },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      const ended = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
      // The run-end reactor skips reconcile writes, so the prompt below lands before it starts
      // the next run, as a send racing that reactor can.
      yield* endCompaction(
        threadId,
        ended,
        true,
        arrival === "scheduled prompt as it ends"
          ? CommandId.make("command:runtime-reconcile:compaction-ended")
          : undefined,
      );
      if (arrival === "scheduled prompt as it ends") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:scheduled"),
          threadId,
          messageId: otherMessageId,
          text: "Scheduled check",
          attachments: [],
          scheduledTaskId: ScheduledTaskId.make("task:scheduled"),
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      yield* orchestrator.resumeQueuedRuns;
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const statusOf = (id: MessageId) => runs.find((run) => run.userMessageId === id)?.status;
      expect(statusOf(messageId)).toBe("starting");
      expect(statusOf(otherMessageId)).toBe("queued");
    }).pipe(Effect.provide(layerTest)),
);

const sendFromWeb = (
  threadId: ThreadId,
  messageId: MessageId,
  text: string,
  options: { readonly compactFirst?: true; readonly afterCompactionMessageId?: MessageId } = {},
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${messageId}`),
      threadId,
      messageId,
      text,
      attachments: [],
      ...options,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

const holdRuns = Effect.fn("holdRuns")(function* (
  threadId: ThreadId,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    commandId: CommandId.make("command:runtime-reconcile:hold"),
    events: runs.map((run) => ({
      id: EventId.make(`event:hold:${run.id}`),
      type: "run.updated" as const,
      threadId,
      runId: run.id,
      occurredAt: run.requestedAt,
      payload: { ...run, status: "queued" as const, queueHeld: true },
    })),
  });
});

it.effect.each([true, false])(
  "a user's /compact joins a pending compaction and takes over a failed one's messages (succeeds: %s)",
  (compacted) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:compaction-join");
      const { compactMessageId, messageId, compactRun } = yield* compactionPair(threadId);
      const secondMessageId = MessageId.make("message:second-after-compact");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:second-after-compact"),
        threadId,
        messageId: secondMessageId,
        text: "And then",
        attachments: [],
        afterCompactionMessageId: compactMessageId,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      if (!compacted) {
        yield* endCompaction(threadId, compactRun, false);
        yield* orchestrator.resumeQueuedRuns;
      }
      const userCompactId = MessageId.make("message:user-compact");
      const laterMessageId = MessageId.make("message:user-after-compact");
      yield* sendFromWeb(threadId, userCompactId, "/compact");
      yield* sendFromWeb(threadId, laterMessageId, "And this", { compactFirst: true });
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const runOf = (id: MessageId) => runs.find((run) => run.userMessageId === id);
      // One compaction stays ahead of every message: the pending one, or the user's retry.
      const compaction = compacted ? compactMessageId : userCompactId;
      expect(runOf(userCompactId) !== undefined).toBe(!compacted);
      expect(runOf(MessageId.make(`${laterMessageId}:compact`))).toBeUndefined();
      for (const id of [messageId, secondMessageId, laterMessageId]) {
        expect(runOf(id)).toMatchObject({ status: "queued", afterCompactionMessageId: compaction });
        expect(runOf(id)?.queueHeld).not.toBe(true);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("compact and send commits its compaction and message in one command", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:compact-first");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:compact-first"),
      threadId,
      projectId: ProjectId.make("project:compact-first"),
      title: "Compact first",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const messageId = MessageId.make("message:compact-first");
    const sent = yield* sendFromWeb(threadId, messageId, "Continue", { compactFirst: true });
    const compactionMessageId = MessageId.make(`${messageId}:compact`);
    const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
    expect(messages.find((message) => message.id === compactionMessageId)?.text).toBe("/compact");
    expect(runs.find((run) => run.userMessageId === compactionMessageId)?.status).toBe("starting");
    expect(runs.find((run) => run.userMessageId === messageId)).toMatchObject({
      status: "queued",
      afterCompactionMessageId: compactionMessageId,
    });
    expect(sent.storedEvents.filter(({ event }) => event.type === "run.created")).toHaveLength(2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a compaction that finished without compacting does not stall the queue", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:compaction-item-failed");
    const { compactRun, messageId } = yield* compactionPair(threadId);
    const reportId = MessageId.make("message:report");
    const taskIds = [NodeId.make("task:child")];
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:delivery"),
          type: "run.updated",
          threadId,
          runId: compactRun.id,
          occurredAt: yield* DateTime.now,
          payload: {
            ...compactRun,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery: { generation: 1, messageId: reportId, taskIds },
            },
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:report"),
      threadId,
      messageId: reportId,
      text: "Delegated task completed",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: { parentRunId: compactRun.id, generation: 1, taskIds },
      createdBy: "agent",
      creationSource: "server",
    });
    const current = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
      (run) => run.id === compactRun.id,
    )!;
    // Claude can finish a /compact run successfully while its compaction item failed.
    // Reconcile writes skip the run-end reactor, so the queue starts only once both have landed.
    yield* endCompaction(threadId, current, false, CommandId.make("command:runtime-reconcile:a"));
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:b"),
      events: [
        {
          id: EventId.make("event:compact-run-completed"),
          type: "run.updated",
          threadId,
          runId: compactRun.id,
          occurredAt: now,
          payload: { ...current, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.resumeQueuedRuns;
    const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    expect(runs.find((run) => run.userMessageId === messageId)?.queueHeld).toBe(true);
    expect(runs.find((run) => run.userMessageId === reportId)?.status).toBe("starting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a client send that resumes a held queue stays behind a compaction's message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:held-follow-up");
    const { compactRun, messageId } = yield* compactionPair(threadId);
    const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    yield* holdRuns(
      threadId,
      runs.filter((run) => run.userMessageId === messageId),
    );
    yield* endCompaction(
      threadId,
      compactRun,
      true,
      CommandId.make("command:runtime-reconcile:compaction-ended"),
    );
    const laterId = MessageId.make("message:later");
    yield* sendFromWeb(threadId, laterId, "New user message");
    yield* orchestrator.resumeQueuedRuns;
    const current = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
    expect(current.find((run) => run.userMessageId === messageId)?.status).toBe("starting");
    expect(current.find((run) => run.userMessageId === laterId)?.status).toBe("queued");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a user's /compact that joins a held compaction resumes the queue", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:join-held");
    const { compactMessageId } = yield* compactionPair(threadId);
    yield* holdRuns(threadId, (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs);
    yield* sendFromWeb(threadId, MessageId.make("message:user-compact"), "/compact");
    const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.userMessageId === compactMessageId)?.status).not.toBe("queued");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "startup resumes a queue that recovery left unheld unless a restart continuation is pending (%s)",
  (continuing) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`thread:restart-queue-${continuing}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:restart-queue"),
        title: "Restart queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const cutId = MessageId.make(`${threadId}:cut`);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${cutId}`),
        threadId,
        messageId: cutId,
        text: "Work the restart cut",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const queuedId = MessageId.make(`${threadId}:queued`);
      yield* sendFromWeb(threadId, queuedId, "Sent before the restart");
      const cut = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.userMessageId === cutId,
      )!;
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:runtime-reconcile:${threadId}`);
      yield* sink.writeWithEffects({
        commandId,
        events: [
          {
            id: EventId.make(`${threadId}:cut-interrupted`),
            type: "run.updated",
            threadId,
            runId: cut.id,
            occurredAt: now,
            payload: { ...cut, status: "interrupted", startedAt: now, completedAt: now },
          },
        ],
        effects: continuing
          ? [
              {
                id: `effect:restart-continuation:${cut.id}`,
                commandId,
                threadId,
                request: {
                  type: "provider-runtime.continue",
                  sourceRunId: cut.id,
                  processLossCount: 1,
                },
              },
            ]
          : [],
      });
      yield* orchestrator.resumeQueuedRuns;
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      expect(runs.find((run) => run.userMessageId === queuedId)?.status).toBe(
        continuing ? "queued" : "starting",
      );
    }).pipe(Effect.provide(layerTest)),
);
