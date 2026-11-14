import {
  type ChatAttachment,
  type RunId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";

import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

it.effect.each(
  (
    [
      [false, "during delivery"],
      [false, "during delivery", "claudeAgent"],
      [false, "before dispatch"],
      [true, "after delivery"],
      [true, "without native steering"],
      [true, "with interrupting native steering"],
      [true, "settled only"],
      [false, "during continuation"],
      ["question", "during delivery"],
    ] as const
  ).map(([kind, timing, provider = "codex"]) => ({
    mailbox: kind === true,
    question: kind === "question",
    timing,
    provider,
    label:
      kind === "question" ? "delegated task question" : kind ? "mailbox notification" : "steering",
  })),
)(
  "delivers $label when completion wins $timing ($provider)",
  ({ mailbox, question, timing, provider }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make(provider);
        const instanceId = ProviderInstanceId.make(provider);
        const modelSelection = { instanceId, model: "test-model" };
        const cwd = yield* checkpointWorkspace(
          `steering-completion-${timing.replaceAll(" ", "-")}`,
        );
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        const steerEntered = yield* Deferred.make<void>();
        const rejectSteer = yield* Deferred.make<void>();
        let steerCalls = 0;
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: {
            ...CodexProviderCapabilitiesV2.turns,
            supportsActiveSteering: timing !== "without native steering",
            activeSteeringInterruptsTools: timing === "with interrupting native steering",
          },
        };
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: (turn) =>
                  Effect.gen(function* () {
                    steerCalls += 1;
                    if (timing === "after delivery" || timing === "during continuation") return;
                    yield* Deferred.succeed(steerEntered, undefined);
                    yield* Deferred.await(rejectSteer);
                    return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause: "turn already completed",
                    });
                  }),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:steering-completion");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:steering-completion"),
            title: "Steering race",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("message:first"),
            text: "first",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* worker.drain();
          yield* Fiber.join(running);
          const first = started[0]!;
          const messageId = MessageId.make("message:steering");
          const taskId = NodeId.make("task:mailbox");
          if (mailbox) {
            const sink = yield* EventSink.EventSinkV2;
            const current = yield* orchestrator.getThreadProjection(threadId);
            const parentRun = current.runs.find((run) => run.id === first.runId)!;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("mailbox:cohort"),
                  type: "run.updated",
                  threadId,
                  runId: first.runId,
                  occurredAt: now,
                  payload: {
                    ...parentRun,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("mailbox:task"),
                  type: "subagent.updated",
                  threadId,
                  runId: first.runId,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: first.runId,
                    parentNodeId: first.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Do background work",
                    title: "Background test",
                    model: null,
                    completionWake: timing === "settled only" ? "settled_only" : "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: "done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
          }
          if (question) {
            const { thread } = yield* orchestrator.getThreadProjection(threadId);
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:composer-selection"),
                  type: "thread.model-selection-updated",
                  threadId,
                  providerInstanceId: instanceId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...thread, modelSelection: composerSelection },
                },
              ],
            });
          }
          const dispatchSteer = orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId,
            text: "fix the popover",
            attachments: [
              {
                type: "image",
                id: "steering-screenshot",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
            dispatchMode:
              mailbox || question
                ? { type: "queue_after_active" }
                : { type: "steer_active", targetRunId: first.runId },
            createdBy: mailbox || question ? "agent" : "user",
            creationSource: mailbox || question ? "server" : "web",
            ...(question
              ? {
                  notification: {
                    source: { kind: "delegated_task", taskIds: [taskId] },
                    outcome: "updated",
                    summary: "Delegated task has a question",
                  },
                }
              : {}),
            ...(mailbox
              ? {
                  delegatedCompletion: {
                    parentRunId: first.runId,
                    generation: 1,
                    taskIds: [taskId],
                  },
                }
              : {}),
          });
          if (timing !== "before dispatch") yield* dispatchSteer;
          if (timing === "during continuation") {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const turn = projection.providerTurns[0]!;
            const failed = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "failed",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
            });
            yield* Fiber.join(failed);
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            assert.lengthOf(started, 1);
            const continued = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(continued.runs[0]?.status, "running");
            assert.equal(
              continued.messages.find((message) => message.id === messageId)?.runId,
              first.runId,
            );
            return;
          }
          if (timing === "after delivery") yield* worker.drain();
          const delivery =
            timing === "during delivery" ? yield* worker.runOnce().pipe(Effect.forkScoped) : null;
          if (delivery !== null) yield* Deferred.await(steerEntered);
          const completed = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(completed);
          if (delivery !== null) {
            yield* Deferred.succeed(rejectSteer, undefined);
            yield* Fiber.join(delivery);
          }
          if (delivery !== null && !question) {
            const requeued = yield* orchestrator.getThreadProjection(threadId);
            assert.isTrue(requeued.runs.some((run) => run.status === "queued"));
            assert.isFalse(
              requeued.visibleTurnItems.some(
                ({ item }) => item.type === "user_message" && item.messageId === messageId,
              ),
              "a steer that fell back to the queue must not appear delivered",
            );
            const item = requeued.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.equal(item?.status, "pending");
            assert.isNull(item?.startedAt);
            assert.isNull(item?.completedAt);
          }
          if (timing === "before dispatch") yield* dispatchSteer;
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (timing === "after delivery") {
            assert.equal(steerCalls, 1);
            assert.equal(started.length, 1);
            if (mailbox) {
              const delivered = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
              assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
              assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
              assert.equal(
                delivered.turnItems.filter((item) => item.type === "notification").length,
                1,
              );
              yield* orchestrator.dispatch({
                type: "notification.delivery.accept",
                commandId: CommandId.make("duplicate-acceptance"),
                threadId,
                messageId,
              });
              yield* worker.drain();
              assert.equal(steerCalls, 1);
              yield* orchestrator.dispatch({
                type: "delegated_task.completion-delivery.acknowledge",
                commandId: CommandId.make("read-result"),
                parentThreadId: threadId,
                taskId,
                observedByRunId: first.runId,
              });
              const acknowledged = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
            }
            return;
          }
          assert.equal(started.length, 2);
          assert.equal(started[1]?.message.messageId, messageId);
          if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
          else assert.equal(started[1]?.message.text, "fix the popover");
          assert.deepEqual(started[1]?.message.attachments, [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ]);
          assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
          const final = yield* orchestrator.getThreadProjection(threadId);
          if (question) {
            assert.deepEqual(final.thread.modelSelection, composerSelection);
            assert.deepEqual(started[1]?.modelSelection, composerSelection);
          }
          if (!mailbox && !question) {
            assert.equal(
              final.turnItems.find(
                (item) => item.type === "user_message" && item.messageId === messageId,
              )?.status,
              "completed",
            );
          }
          assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
          assert.equal(
            final.messages.find((message) => message.id === messageId)?.runId,
            started[1]?.runId,
          );
          assert.equal(
            final.turnItems.filter((item) =>
              mailbox || question
                ? item.type === "notification"
                : item.type === "user_message" && item.messageId === messageId,
            ).length,
            1,
          );
          if (!mailbox && !question) {
            assert.equal(
              final.visibleTurnItems.filter(
                ({ item }) => item.type === "user_message" && item.messageId === messageId,
              ).length,
              1,
            );
          }
          yield* worker.drain();
          assert.equal(started.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `steering-completion-${timing}` },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  {
    canRestart = false,
    canSteer = true,
    activeSteeringInterruptsTools = false,
    beforeInterrupt = Effect.void,
    interruptTurn = Effect.void,
    steeringAcceptsAttachments = true,
    nativeGoals,
    runContinuationWorker = true,
    onSteer = () => Effect.void,
    extraAdapters = [],
  }: {
    canRestart?: boolean;
    canSteer?: boolean;
    activeSteeringInterruptsTools?: boolean;
    beforeInterrupt?: Effect.Effect<void>;
    interruptTurn?: Effect.Effect<void>;
    steeringAcceptsAttachments?: boolean;
    nativeGoals?: boolean | undefined;
    runContinuationWorker?: boolean;
    onSteer?: (
      turn: ProviderAdapter.ProviderAdapterV2SteerInput,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
    extraAdapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  } = {},
) {
  const driver = ProviderDriverKind.make(nativeGoals === undefined ? "codex" : "opencode");
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const steeredSelections: Array<ModelSelection | undefined> = [];
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: canSteer,
      supportsSteeringByInterruptRestart: canRestart,
      activeSteeringInterruptsTools,
      activeSteeringAcceptsAttachments: steeringAcceptsAttachments,
      ...(nativeGoals === undefined ? {} : { supportsNativeGoals: nativeGoals }),
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
              steeredSelections.push(turn.modelSelection);
            }).pipe(Effect.andThen(onSteer(turn))),
          interruptTurn: ({ providerTurnId }) =>
            beforeInterrupt.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  interrupted.push(providerTurnId);
                }),
              ),
              Effect.andThen(interruptTurn),
              Effect.andThen(
                Effect.forEach(
                  started.filter(
                    (turn) =>
                      ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                  ),
                  (turn) =>
                    turnUpdated(turn, "interrupted").pipe(
                      Effect.andThen(
                        Queue.offer(events, {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          status: "interrupted",
                          failure: null,
                          threadDisposition: "reusable",
                        }),
                      ),
                    ),
                  { discard: true },
                ),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const databaseLayer = SqlitePersistence.layerMemory;
  const layerRuntime = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter, ...extraAdapters]),
    { runEffectWorker: false, runContinuationWorker, databaseLayer },
  );
  const layer = ThreadManagement.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer))),
    Layer.provideMerge(layerRuntime),
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    // Ingestion checks turn ownership under this lock after committing the running turn.
    yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(threadId, Effect.void);
    return threadId;
  });
  return { cwd, events, started, steered, steeredSelections, interrupted, layer, startFirstTurn };
});

it.effect.each([
  {
    notice: "delegated task question",
    goal: null,
    steers: true,
    activeSteeringInterruptsTools: false,
  },
  {
    notice: "background command",
    goal: "active",
    steers: true,
    activeSteeringInterruptsTools: false,
  },
  { notice: "background command", goal: null, steers: false, activeSteeringInterruptsTools: false },
  { notice: "background command", goal: null, steers: false, activeSteeringInterruptsTools: true },
] as const)(
  "a $notice notice steers into the running turn: $steers (goal $goal)",
  ({ notice, goal, steers, activeSteeringInterruptsTools }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `notice-steer-${notice.replaceAll(" ", "-")}-${goal ?? "none"}`,
          { activeSteeringInterruptsTools },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const { thread } = yield* orchestrator.getThreadProjection(threadId);
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("event:composer-selection"),
                type: "thread.model-selection-updated",
                threadId,
                providerInstanceId: instanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...thread, modelSelection: composerSelection },
              },
            ],
          });
          if (goal !== null) {
            const providerThread = (yield* orchestrator.getThreadProjection(threadId))
              .providerThreads[0]!;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:goal-active"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...providerThread, goal: { objective: "Ship it", status: goal } },
                },
              ],
            });
          }
          const messageId = MessageId.make(
            notice === "delegated task question"
              ? "message:delegated-task-question:child-question"
              : "message:notice",
          );
          const notification =
            notice === "delegated task question"
              ? {
                  source: {
                    kind: "delegated_task" as const,
                    taskIds: [NodeId.make("task:question")],
                    childThreadId: ThreadId.make("thread:question-child"),
                  },
                  outcome: "updated" as const,
                  summary: "Delegated task has a question",
                }
              : {
                  source: { kind: "command" as const },
                  outcome: "completed" as const,
                  summary: "Background command finished",
                };
          if (notification.source.kind === "delegated_task") {
            const now = yield* DateTime.now;
            const first = started[0]!;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:question-task"),
                  type: "subagent.updated",
                  threadId,
                  runId: first.runId,
                  nodeId: notification.source.taskIds[0]!,
                  occurredAt: now,
                  payload: {
                    id: notification.source.taskIds[0]!,
                    threadId,
                    runId: first.runId,
                    parentNodeId: first.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: instanceId,
                    providerThreadId: null,
                    childThreadId: notification.source.childThreadId,
                    nativeTaskRef: null,
                    prompt: "Do background work",
                    title: null,
                    model: null,
                    completionWake: "always",
                    status: "running",
                    result: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                  },
                },
              ],
            });
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("notice-wake"),
            threadId,
            messageId,
            text: `${notification.summary}\nexit 0: built 12 files`,
            notification,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          });
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            steered,
            steers ? [`${notification.summary}\nexit 0: built 12 files`] : [],
          );
          assert.lengthOf(started, 1);
          assert.equal(
            after.runs.some((run) => run.status === "queued"),
            !steers,
          );
          const message = after.messages.find((candidate) => candidate.id === messageId);
          assert.deepEqual(message?.notification, notification);
          if (notice === "background command" && goal === null) {
            assert.isNotTrue(message?.atToolBoundary);
          }
          if (steers) assert.equal(message?.runId, started[0]?.runId);
          assert.deepEqual(after.thread.modelSelection, composerSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("sends a selected held message once and preserves the remaining queue order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-held-message");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* Effect.forEach(["queued-first", "selected", "queued-last"], (text) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(text),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        const before = yield* orchestrator.getThreadProjection(threadId);
        const selected = before.runs.find(
          (run) => run.userMessageId === MessageId.make("message:selected"),
        )!;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        // Restart recovery cancels the active run and holds every queued message.
        yield* sink.write({
          events: [
            ...before.runs.map((run) => ({
              id: EventId.make(`restart:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload:
                run.status === "queued"
                  ? { ...run, queueHeld: true }
                  : { ...run, status: "cancelled" as const, completedAt: now },
            })),
            ...before.providerTurns.map((turn) => ({
              id: EventId.make(`restart:${turn.id}`),
              type: "provider-turn.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "cancelled" as const, completedAt: now },
            })),
          ],
        });
        const command = {
          type: "queued-run.start" as const,
          commandId: CommandId.make("send-selected"),
          threadId,
          runId: selected.id,
        };
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === selected.id)?.status, "running");
        assert.deepEqual(
          started.map((input) => input.message.text),
          ["first", "selected"],
        );
        assert.equal(started[1]?.runId, selected.id);
        assert.equal(started[1]?.message.messageId, selected.userMessageId);
        assert.deepEqual(started[1]?.modelSelection, runSelection);
        assert.deepEqual(steered, []);
        assert.lengthOf(
          after.messages.filter((message) => message.id === selected.userMessageId),
          1,
        );
        assert.deepEqual(
          after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:queued-first"), MessageId.make("message:queued-last")],
        );
        assert.isFalse(after.runs.some((run) => run.status === "queued" && run.queueHeld));
        const duplicate = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("send-selected-again"),
          })
          .pipe(Effect.flip);
        assert.equal(duplicate._tag, "OrchestratorDispatchError");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(
  (["preparing", "starting", "running"] as const).flatMap((status) =>
    [false, true].map((direct) => ({ status, direct })),
  ),
)("delivers a deferred steer for a $status run (direct: $direct)", ({ status, direct }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const restarting = status === "starting" && !direct;
      const { started, steered, layer, startFirstTurn, events } = yield* nextTurnSelectionHarness(
        `deferred-steer-${status}-${direct}`,
        { canRestart: restarting, canSteer: !restarting },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const before = yield* orchestrator.getThreadProjection(threadId);
        const run = before.runs[0]!;
        const turn = before.providerTurns[0]!;
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("setup-run"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status },
            },
            {
              id: EventId.make("setup-turn"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "pending" },
            },
          ],
        });
        if (status === "preparing" && !direct) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("edited-steer"),
            threadId,
            messageId: MessageId.make("message:edited-steer"),
            text: "edit this steer",
            attachments: [],
            deliveryIntent: "steer",
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const edited = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.userMessageId === MessageId.make("message:edited-steer"),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make("edit-steer-to-compact"),
            threadId,
            runId: edited.id,
            text: "/compact",
          });
        }
        if (direct) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("earlier-queue"),
            threadId,
            messageId: MessageId.make("message:earlier-queue"),
            text: "earlier queued selection",
            modelSelection: composerSelection,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          threadId,
          messageId: MessageId.make("message:steer-after-setup"),
          text: "steer after setup",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(direct ? { deliveryIntent: "steer" as const } : {}),
          createdBy: "user",
          creationSource: "web",
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.userMessageId === MessageId.make("message:steer-after-setup"),
        )!;
        assert.deepEqual(queued.modelSelection, runSelection);
        for (const text of ["/compact", "/logout"]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queue-${text}`),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const maintenance = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.userMessageId === MessageId.make(`message:${text}`),
          )!;
          const error = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make(`promote-${text}`),
              threadId,
              queuedRunId: maintenance.id,
              targetRunId: run.id,
            })
            .pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
        }
        const command = {
          type: "queued-message.promote-to-steer" as const,
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queued.id,
          targetRunId: run.id,
        };
        if (!direct) {
          yield* orchestrator.dispatch(command);
          yield* orchestrator.dispatch(command);
        }
        let secondQueuedId: typeof queued.id | undefined;
        if (restarting) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("second"),
            threadId,
            messageId: MessageId.make("message:second"),
            text: "second steer",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          secondQueuedId = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.userMessageId === MessageId.make("message:second"),
          )!.id;
          yield* orchestrator.dispatch({
            ...command,
            commandId: CommandId.make("promote-second"),
            queuedRunId: secondQueuedId,
          });
        }
        const secondReDeferred = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === secondQueuedId &&
              event.payload.status === "queued",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const secondPromoted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === secondQueuedId &&
              event.payload.status === "cancelled",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        assert.deepEqual(steered, []);
        const promoted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status === "cancelled",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("ready-run"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: run,
            },
          ],
        });
        yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn: turn });
        yield* Fiber.join(promoted);
        if (restarting) yield* Fiber.join(secondReDeferred);
        yield* worker.drain();
        if (restarting) {
          yield* Fiber.join(secondPromoted);
          yield* worker.drain();
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "steer after setup", "second steer"],
          );
        } else {
          assert.deepEqual(steered, ["steer after setup"]);
          assert.lengthOf(started, 1);
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.messages.find((message) => message.id === queued.userMessageId)?.runId,
          run.id,
        );
        assert.equal(after.runs.find((candidate) => candidate.id === run.id)?.status, "running");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("force sends multiple queued messages and can force send a requeued message again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "multiple-promoted-messages",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queue = (text: string, commandId: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(commandId),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        for (const text of ["one", "two", "remaining"]) yield* queue(text, `queue-${text}`);
        const promote = Effect.fn("test.promote")(function* (text: string, commandId: string) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const queued = projection.runs.find(
            (run) =>
              run.status === "queued" && run.userMessageId === MessageId.make(`message:${text}`),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(commandId),
            threadId,
            queuedRunId: queued.id,
            targetRunId: started[0]!.runId,
          });
        });
        yield* promote("one", "promote-one");
        yield* promote("two", "promote-two");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two"]);

        // The completion-race fallback redispatches the same message into the queue.
        yield* queue("one", "requeue-one");
        const requeued = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          requeued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === "message:one",
          )?.status,
          "pending",
        );
        yield* promote("one", "promote-one-again");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two", "one"]);
        assert.lengthOf(started, 1);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          final.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:remaining")],
        );
        for (const text of ["one", "two"]) {
          const items = final.turnItems.filter(
            (item) => item.type === "user_message" && item.messageId === `message:${text}`,
          );
          assert.lengthOf(items, 1);
          assert.equal(items[0]?.status, "completed");
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a message queued when send now races with a running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-queued-race");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.find((run) => run.status === "queued")!;
        const error = yield* orchestrator
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("send-now"),
            threadId,
            runId: queued.id,
          })
          .pipe(Effect.flip);
        yield* worker.drain();
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(started.length, 1);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.runs, before.runs);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #19210 a provider that can restart the turn must still steer, since restarting ends its native subagents
it.effect(
  "steers a changed turn-scoped selection into a running turn the provider could restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, steeredSelections, layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("steering-selection-change", { canRestart: true });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          // The adapter gets each steer's selection so it can switch the live turn, and back.
          assert.deepEqual(steeredSelections, [composerSelection, runSelection, runSelection]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("restarts the turn for an image when native steering takes text only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-text-only-attachment",
        { canRestart: true, steeringAcceptsAttachments: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-image"),
          threadId,
          messageId: MessageId.make("message:steer-image"),
          text: "look at this",
          attachments: [
            {
              type: "image",
              id: ChatAttachmentId.make("steer-image"),
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
          modelSelection: runSelection,
          dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        assert.deepEqual(steered, []);
        assert.deepEqual(
          started.map((turn) => [turn.message.text, turn.message.attachments.length]),
          [
            ["first", 0],
            ["look at this", 1],
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
        const messages = projection.turnItems.filter(
          (item) =>
            item.type === "user_message" && item.messageId === MessageId.make("message:steer"),
        );
        assert.lengthOf(messages, 1);
        assert.equal(messages[0]!.runId, started[1]!.runId);
        assert.isAtLeast(messages[0]!.ordinal, started[1]!.runOrdinal * 1_000_000);
        assert.isAbove(
          messages[0]!.ordinal,
          Math.max(
            ...projection.turnItems
              .filter((item) => item.runId === first.runId)
              .map((item) => item.ordinal),
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a steer that missed its turn stays pending and starts ahead of the queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-follow-up-pending",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const send = (id: "steer" | "queued") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            dispatchMode:
              id === "steer"
                ? { type: "steer_active", targetRunId: first.runId }
                : { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("steer");
        yield* send("queued");
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["first", "steer"],
        );
        assert.equal(
          projection.runs.find((run) => run.userMessageId === MessageId.make("message:queued"))
            ?.status,
          "queued",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
it.effect.each(["complete", "stop-before-decline", "stop-after-decline", "queued-model"] as const)(
  "persists a declined steer without blocking the worker: %s",
  (timing) =>
    Effect.scoped(
      Effect.gen(function* () {
        let beforeDecline: Effect.Effect<void> = Effect.void;
        const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `steering-declined-${timing}`,
          {
            canRestart: false,
            canSteer: true,
            interruptTurn: Effect.void,
            steeringAcceptsAttachments: true,
            nativeGoals: undefined,
            onSteer: (turn) =>
              Effect.suspend(() => beforeDecline).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterSteerDeclinedError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                    }),
                  ),
                ),
              ),
          },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const stop = orchestrator
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("stop"),
              threadId,
              runId: first.runId,
              holdQueue: true,
            })
            .pipe(Effect.asVoid, Effect.orDie);
          if (timing === "stop-before-decline") beforeDecline = stop;
          const steerSelection = { ...runSelection, model: "steer-model" };
          if (timing === "queued-model") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queued-model"),
              threadId,
              messageId: MessageId.make("message:queued-model"),
              text: "already queued",
              attachments: [],
              modelSelection: composerSelection,
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            beforeDecline = Effect.forEach(["queued-later", "steer-later", "queued-last"], (id) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                dispatchMode:
                  id === "steer-later"
                    ? { type: "steer_active", targetRunId: first.runId }
                    : { type: "queue_after_active" },
                createdBy: "user",
                creationSource: "web",
              }),
            ).pipe(Effect.asVoid, Effect.orDie);
          }
          const messageId = MessageId.make("message:declined");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId,
            text: "follow up",
            attachments: [],
            ...(timing === "queued-model" ? { modelSelection: steerSelection } : {}),
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const pending = yield* orchestrator.getThreadProjection(threadId);
          const queued = pending.runs.find(
            (run) => run.userMessageId === messageId && run.id !== first.runId,
          );
          const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make("steer"),
          );
          assert.deepEqual(
            effects.map((effect) => [effect.request.type, effect.status]),
            [["provider-turn.steer", "succeeded"]],
          );
          assert.equal(started.length, 1);
          if (timing === "stop-before-decline") {
            assert.isUndefined(queued);
            return;
          }
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.userMessageId, messageId);
          if (timing === "queued-model") {
            assert.deepEqual(queued?.modelSelection, steerSelection);
            assert.deepEqual(
              pending.runs
                .filter((run) => run.status === "queued")
                .toSorted(
                  (left, right) =>
                    (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
                )
                .map((run) => run.userMessageId),
              [
                MessageId.make("message:queued-model"),
                messageId,
                MessageId.make("message:queued-later"),
                MessageId.make("message:steer-later"),
                MessageId.make("message:queued-last"),
              ],
            );
            return;
          }
          if (timing === "stop-after-decline") {
            yield* stop;
            yield* worker.drain();
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
            const held = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(held.runs.find((run) => run.id === queued?.id)?.queueHeld, true);
            assert.equal(started.length, 1);
            return;
          }
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = pending.providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(started.length, 2);
          assert.equal(started[1]?.message.messageId, messageId);
          assert.equal(started[1]?.runId, queued?.id);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: #26695 cancelling a Copilot prompt to steer it kills its background agents
it.effect("queues a steer until the turn ends when the provider cannot steer it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, interrupted, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-unsupported", { canSteer: false });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const messageId = MessageId.make("message:steer");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "follow up",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "steer",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 1);
        assert.equal(held.runs.find((run) => run.id === first.runId)?.status, "running");
        const queued = held.runs.find((run) => run.userMessageId === messageId);
        assert.equal(queued?.status, "queued");

        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = held.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.runId, queued?.id);
        assert.equal(started[1]?.message.text, "follow up");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #33454 a steer that restarts a completion wake run left its cohort claimed forever
const restartCompletionWake = Effect.fn("restartCompletionWake")(function* (
  harness: Pick<
    Effect.Success<ReturnType<typeof nextTurnSelectionHarness>>,
    "events" | "started" | "startFirstTurn"
  >,
  siblingFinishesFirst: boolean,
  userRunBeforeWake = false,
  intentNamesTarget = false,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* harness.startFirstTurn;
  const watchRun = (runId: string, status: string) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  const watchTurnRunning = (ordinal: number) =>
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.payload.status === "running" &&
          event.payload.ordinal === ordinal,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  const finishTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      const providerTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
        (candidate) => candidate.runAttemptId === turn.attemptId,
      )!;
      const settled = yield* watchRun(turn.runId, "waiting");
      yield* Queue.offer(harness.events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          ...providerTurn,
          status: "completed",
          completedAt: yield* DateTime.now,
        },
      });
      yield* Queue.offer(harness.events, {
        type: "turn.terminal",
        driver,
        providerThreadId: providerTurn.providerThreadId,
        providerTurnId: providerTurn.id,
        runOrdinal: turn.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(settled);
      yield* worker.drain();
    });

  const origin = harness.started[0]!;
  const firstTaskId = NodeId.make("task:steered-wake-first");
  const siblingTaskId = NodeId.make("task:steered-wake-sibling");
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [firstTaskId, siblingTaskId].map((taskId) => ({
      id: EventId.make(`event:seed:${taskId}`),
      type: "subagent.updated" as const,
      threadId,
      runId: origin.runId,
      nodeId: taskId,
      occurredAt: now,
      payload: {
        id: taskId,
        threadId,
        runId: origin.runId,
        parentNodeId: origin.rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: null,
        remoteChild: {
          environmentId: EnvironmentId.make("environment:box"),
          threadId: ThreadId.make(`thread:remote:${taskId}`),
          label: "box",
        },
        nativeTaskRef: null,
        prompt: "Do background work",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: { state: "pending" as const, observedByRunId: null },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    })),
  });
  yield* finishTurn(origin);
  // The wake queues behind a user run that started after the origin run finished.
  if (userRunBeforeWake) {
    const userRunning = yield* watchTurnRunning(2);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:user-run"),
      threadId,
      messageId: MessageId.make("message:user-run"),
      text: "unrelated question",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(userRunning);
  }

  const completeTask = (taskId: NodeId) =>
    orchestrator.dispatch({
      type: "delegated_task.remote.complete",
      commandId: CommandId.make(`command:remote-complete:${taskId}`),
      parentThreadId: threadId,
      taskId,
      status: "completed",
      result: `${taskId} finished`,
      stoppedThere: "ran-out",
    });
  yield* completeTask(firstTaskId);
  const firstDelivery = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
    (run) => run.id === origin.runId,
  )!.delegatedCompletion!.delivery!;
  assert.deepEqual(firstDelivery.taskIds, [firstTaskId]);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("command:first-wake"),
    threadId,
    messageId: firstDelivery.messageId,
    text: "Delegated task completed",
    attachments: [],
    modelSelection: runSelection,
    dispatchMode: { type: "queue_after_active" },
    delegatedCompletion: {
      parentRunId: origin.runId,
      generation: firstDelivery.generation,
      taskIds: firstDelivery.taskIds,
    },
    createdBy: "agent",
    creationSource: "server",
  });
  const wakeOrdinal = userRunBeforeWake ? 3 : 2;
  const wakeRunning = yield* watchTurnRunning(wakeOrdinal);
  if (userRunBeforeWake) yield* finishTurn(harness.started[1]!);
  yield* orchestrator.resumeQueuedRuns;
  yield* worker.drain();
  yield* Fiber.join(wakeRunning);
  const wake = harness.started[wakeOrdinal - 1]!;
  assert.equal(wake.message.messageId, firstDelivery.messageId);
  if (userRunBeforeWake) {
    // The wake's run holds a compaction, so the origin run's records are older than the window.
    const compactedAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:wake-compaction"),
          type: "turn-item.updated" as const,
          threadId,
          runId: wake.runId,
          nodeId: wake.rootNodeId,
          occurredAt: compactedAt,
          payload: {
            id: TurnItemId.make("item:wake-compaction"),
            threadId,
            runId: wake.runId,
            nodeId: wake.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1_000,
            status: "completed" as const,
            title: null,
            startedAt: compactedAt,
            completedAt: compactedAt,
            updatedAt: compactedAt,
            type: "compaction" as const,
            driver,
          },
        },
      ],
    });
  }

  if (siblingFinishesFirst) {
    yield* completeTask(siblingTaskId);
  }

  // The provider cannot steer natively, so the steer restarts the wake run.
  const steeredRunning = yield* watchTurnRunning(wakeOrdinal + 1);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("command:steer-wake"),
    threadId,
    messageId: MessageId.make("message:steer-wake"),
    text: "also check the logs",
    attachments: [],
    modelSelection: runSelection,
    ...(intentNamesTarget
      ? { dispatchMode: { type: "start_immediately" as const }, deliveryIntent: "restart" as const }
      : { dispatchMode: { type: "steer_active" as const, targetRunId: wake.runId } }),
    createdBy: "user",
    creationSource: "web",
  });
  yield* worker.drain();
  yield* Fiber.join(steeredRunning);
  const steered = harness.started[wakeOrdinal]!;
  assert.equal(steered.runId, wake.runId);
  assert.equal(
    (yield* orchestrator.getThreadProjection(threadId)).attempts.find(
      (attempt) => attempt.id === steered.attemptId,
    )?.reason,
    "steering_restart",
  );
  return {
    threadId,
    origin,
    wake,
    steered,
    firstTaskId,
    siblingTaskId,
    watchRun,
    finishTurn,
    completeTask,
  };
});

it.effect("wakes the parent for a sibling result after a steer restarts the completion wake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* nextTurnSelectionHarness("steered-completion-wake", {
        canRestart: true,
        canSteer: false,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const {
          threadId,
          origin,
          wake,
          steered,
          firstTaskId,
          siblingTaskId,
          watchRun,
          finishTurn,
          completeTask,
        } = yield* restartCompletionWake(harness, false);

        // A follow-up queued behind the wake starts once the terminal-run listener has settled it.
        const followUp = MessageId.make("message:follow-up");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:follow-up"),
          threadId,
          messageId: followUp,
          text: "follow up",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const followUpRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === followUp,
        )!;
        const followUpStarted = yield* watchRun(followUpRun.id, "starting");
        yield* finishTurn(steered);
        yield* Fiber.join(followUpStarted);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === wake.runId,
          )?.status,
          "completed",
        );

        yield* completeTask(siblingTaskId);
        const final = yield* orchestrator.getThreadProjection(threadId);
        const tasks = new Map(
          final.subagents.map((task) => [task.id, task.completionDelivery?.state]),
        );
        assert.deepInclude(
          final.runs.find((run) => run.id === origin.runId)?.delegatedCompletion?.delivery ?? {},
          { generation: 2, taskIds: [siblingTaskId] },
          "the sibling finished after the steered wake but no new completion wake was reserved",
        );
        assert.equal(tasks.get(siblingTaskId), "claimed");
        assert.equal(
          tasks.get(firstTaskId),
          "delivered",
          "the steered wake run's own task stays claimed after that run completed",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect.each([false, true])(
  "settles a steered completion wake whose parent run is before the last compaction (restart by intent: %s)",
  (intentNamesTarget) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* nextTurnSelectionHarness(
          `steered-wake-after-compaction-${intentNamesTarget}`,
          { canRestart: true, canSteer: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { threadId, steered, firstTaskId, finishTurn } = yield* restartCompletionWake(
            harness,
            false,
            true,
            intentNamesTarget,
          );
          yield* finishTurn(steered);
          const tasks = (yield* orchestrator.getThreadProjection(threadId)).subagents;
          assert.equal(
            tasks.find((task) => task.id === firstTaskId)?.completionDelivery?.state,
            "delivered",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "offers the next completion wake when a steer restarts a wake a sibling finished behind",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* nextTurnSelectionHarness("steered-completion-wake-behind", {
          canRestart: true,
          canSteer: false,
          runContinuationWorker: false,
        });
        const offers: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
        const requests = Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { threadId, origin, firstTaskId, siblingTaskId } = yield* restartCompletionWake(
            harness,
            true,
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const delivery = projection.runs.find((run) => run.id === origin.runId)
            ?.delegatedCompletion?.delivery;
          assert.deepInclude(delivery ?? {}, { generation: 2, taskIds: [siblingTaskId] });
          const tasks = new Map(
            projection.subagents.map((task) => [task.id, task.completionDelivery?.state]),
          );
          assert.equal(tasks.get(firstTaskId), "delivered");
          assert.equal(tasks.get(siblingTaskId), "claimed");
          assert.deepEqual(offers.at(-1)?.delegatedCompletion, {
            parentRunId: origin.runId,
            generation: 2,
            messageId: delivery!.messageId,
          });
        }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(requests))));
      }),
    ),
);

// Codex flushes held drafts after the final answer; reserve their pre-steer position before turn end.
it.effect("keeps a held commentary draft before the steer when turn end flushes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-held-draft");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        const assistantItem = (id: string, text: string, streaming: boolean) =>
          ({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(id),
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: now,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming,
            },
          }) satisfies ProviderAdapter.ProviderAdapterV2Event;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", true));
        const commentaryWritten = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === "commentary",
        );
        yield* Queue.offer(events, assistantItem("commentary", "Checking the popover.", false));
        yield* Fiber.join(commentaryWritten);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "fix the popover",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, assistantItem("answer", "All fixed.", false));
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", false));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message"
              ? [String(item.messageId)]
              : item.type === "assistant_message"
                ? [String(item.id)]
                : [],
          );
        assert.deepEqual(items, [
          "message:first",
          "draft",
          "commentary",
          "message:steer",
          "answer",
        ]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("steers a promoted queued message with the selection it was queued with", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-queued-selection",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["queued"]);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("steers a promoted scheduled delivery with the thread's current selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-scheduled-selection",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        // Bound scheduled tasks send like ScheduledTaskService: no model of their own.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("scheduled"),
          threadId,
          messageId: MessageId.make("message:scheduled"),
          scheduledTaskId: ScheduledTaskId.make("task:scheduled"),
          text: "scheduled",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        assert.deepEqual(queuedRun.modelSelection, runSelection);
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("select-composer"),
          threadId,
          modelSelection: composerSelection,
        });
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["scheduled"]);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

const claudeSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-test",
};
const claudeAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: claudeSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("the Claude instance never starts a turn here"),
};

// Queues a scheduled delivery behind the Codex turn, stops that turn (Stop holds the queue), then
// switches the thread to Claude: a thread changes instance only while no run is active.
const scheduledDeliveryAfterClaudeSwitch = (name: string, text: string) =>
  Effect.gen(function* () {
    const harness = yield* nextTurnSelectionHarness(name, {
      canRestart: false,
      canSteer: true,
      interruptTurn: Effect.void,
      steeringAcceptsAttachments: true,
      nativeGoals: undefined,
      extraAdapters: [claudeAdapter],
    });
    const queueAndSwitch = Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* harness.startFirstTurn;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("scheduled"),
        threadId,
        messageId: MessageId.make("message:scheduled"),
        scheduledTaskId: ScheduledTaskId.make("task:scheduled"),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      )!;
      assert.equal(queuedRun.providerInstanceId, instanceId);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const first = harness.started[0]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop"),
        threadId,
        runId: first.runId,
        holdQueue: true,
      });
      yield* worker.drain();
      const stopped = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.equal(stopped.find((run) => run.id === first.runId)?.status, "interrupted");
      const held = stopped.find((run) => run.id === queuedRun.id);
      assert.equal(held?.status, "queued");
      assert.isTrue(held?.queueHeld);
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("select-claude"),
        threadId,
        modelSelection: claudeSelection,
      });
      return { threadId, queuedRun };
    });
    return { ...harness, queueAndSwitch };
  });

it.effect("checks an edited scheduled /goal against the thread's current provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer, queueAndSwitch } = yield* scheduledDeliveryAfterClaudeSwitch(
        "edit-scheduled-goal",
        "scheduled",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, queuedRun } = yield* queueAndSwitch;
        const editError = yield* orchestrator
          .dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make("edit"),
            threadId,
            runId: queuedRun.id,
            text: "/goal pause",
          })
          .pipe(Effect.flip);

        assert.match(String(editError.cause), /Claude goals cannot be paused or resumed/);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).messages.find(
            (message) => message.id === queuedRun.userMessageId,
          )?.text,
          "scheduled",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("checks a queued scheduled /goal against the thread's current provider at start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, queueAndSwitch } = yield* scheduledDeliveryAfterClaudeSwitch(
        "start-scheduled-goal",
        "/goal pause",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { threadId, queuedRun } = yield* queueAndSwitch;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume"),
          threadId,
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const failure = projection.turnItems.find(
          (item) => item.type === "error" && item.runId === queuedRun.id,
        );
        assert.equal(started.length, 1);
        assert.equal(projection.runs.find((run) => run.id === queuedRun.id)?.status, "failed");
        assert.equal(
          failure?.type === "error" ? failure.failure.code : null,
          "queued_start_failed",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("marks the model switch on a promoted message that restarts the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-restart-switch",
        { canRestart: true, canSteer: false },
      );
      const otherSelection = { ...runSelection, model: "other-model" };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: otherSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const promoted = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "user_message" && item.messageId === "message:queued",
        );
        assert.deepEqual(promoted?.type === "user_message" ? promoted.modelSwitch : undefined, {
          from: runSelection,
          to: otherSelection,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["user", "agent"] as const)(
  "keeps a queued message queued when the %s promotes it into a run that Stop reached",
  (requester) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `steering-after-stop-${requester}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued"),
            threadId,
            messageId: MessageId.make("message:queued"),
            text: "queued",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          )!;
          // The worker has not delivered the interrupt yet, so the run still reads as running.
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          });

          const promoteError = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: first.runId,
              ...(requester === "agent" ? { requestedBy: "agent" as const } : {}),
            })
            .pipe(Effect.flip);
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(promoteError._tag, "OrchestratorDispatchError");
          assert.deepEqual(steered, []);
          const queued = projection.runs.find((run) => run.id === queuedRun.id);
          assert.equal(queued?.status, "queued");
          assert.isTrue(queued?.queueHeld);
          assert.deepEqual(yield* claimAtToolBoundary(threadId, first.runId), []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: #32891 a restart that Stop already reached is lost
it.effect.each([false, true])(
  "refuses a steer after Stop (provider turn ready: %s)",
  (providerTurnReady) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("restart-after-stop");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          // The worker has not delivered the interrupt yet, so the run still reads as running.
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
          });
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          if (!providerTurnReady) {
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("turn-not-ready"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...turn, status: "pending" },
                },
              ],
            });
          }
          const steerError = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId: MessageId.make("message:steer"),
              text: "steer",
              attachments: [],
              modelSelection: runSelection,
              dispatchMode: { type: "steer_active", targetRunId: first.runId },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.flip);
          assert.equal(steerError._tag, "OrchestratorDispatchError");
          assert.include(String(steerError.cause), "is stopping and cannot be steered");
          if (!providerTurnReady) {
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("restore-ready-turn"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: turn,
                },
              ],
            });
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restart"),
            threadId,
            messageId: MessageId.make("message:restart"),
            text: "restart",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "restart_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();

          assert.deepEqual(steered, []);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "restart"],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: #32891 a restart that arrives after the turn ended is lost
it.effect.each([
  { status: "completed", settled: true },
  { status: "completed", settled: false },
  { status: "interrupted", settled: true },
  { status: "interrupted", settled: false },
  { status: "cancelled", settled: false },
] as const)(
  "starts a restart that missed the turn ($status, run settled: $settled) as a new turn",
  ({ status, settled: runSettled }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `restart-after-${status}-${runSettled ? "settled" : "unsettled"}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          const turnEnded = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.id === turn.id &&
                event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status, completedAt: yield* DateTime.now },
          });
          yield* Fiber.join(turnEnded);
          const settleRun = Effect.gen(function* () {
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === first.runId &&
                  event.payload.status !== "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
          });
          if (runSettled) yield* settleRun;

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restart"),
            threadId,
            messageId: MessageId.make("message:restart"),
            text: "restart",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "restart_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          if (!runSettled) {
            const restartLeftQueue = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.userMessageId === "message:restart" &&
                  event.payload.status !== "queued",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* settleRun;
            yield* Fiber.join(restartLeftQueue);
            yield* worker.drain();
          }

          assert.deepEqual(steered, []);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "restart"],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: #32891 a restart into a failed provider turn is lost
it.effect("queues a restart sent into a provider turn that failed before its run settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "restart-after-failed-unsettled",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const turnFailed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === turn.id &&
              event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
        });
        yield* Fiber.join(turnFailed);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "restart",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.runs.find((run) => run.userMessageId === "message:restart")?.status,
          "queued",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "plain-send-after-stop",
        {
          beforeInterrupt: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        const stopping = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        yield* worker.drain();
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

const offerAtToolBoundary = Effect.fn("offerAtToolBoundary")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  const attemptId = projection.runs.find((run) => run.id === runId)?.activeAttemptId;
  // The hook's own turn: the run's latest provider turn.
  const providerTurnId = projection.providerTurns.findLast(
    (turn) => turn.runAttemptId === attemptId,
  )!.id;
  return yield* requests.claimAgentMessages!({ threadId, runId, providerTurnId });
});

const claimAtToolBoundary = (threadId: ThreadId, runId: RunId) =>
  offerAtToolBoundary(threadId, runId).pipe(
    Effect.map((offers) => offers.map((offer) => offer.text)),
  );

/** Claude saved the offers in its session history. */
const receiveAtToolBoundary = Effect.fn("receiveAtToolBoundary")(function* (
  threadId: ThreadId,
  runId: RunId,
  offers: ReadonlyArray<ProviderContinuationRequests.AgentMessageOffer>,
) {
  const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  yield* requests.acknowledgeAgentMessages!({ threadId, runId, offers });
});

const imageAttachment: ChatAttachment = {
  type: "image",
  id: "attachment-1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
};

const sendUpdate = Effect.fn("sendUpdate")(function* (
  threadId: ThreadId,
  createdBy: "agent" | "user",
  mode: "auto" | "steer",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "progress update",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const result = yield* threads.sendToThread({
    projectId: (yield* orchestrator.getThreadProjection(threadId)).thread.projectId,
    commandId: CommandId.make("update"),
    threadId,
    messageId: MessageId.make("message:update"),
    text,
    attachments,
    mode,
    createdBy,
    creationSource: createdBy === "agent" ? "mcp" : "web",
  });
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  return result;
});

it.effect.each([
  { mode: "auto", attachments: [] },
  { mode: "steer", attachments: [] },
  { mode: "auto", attachments: [imageAttachment] },
  { mode: "steer", attachments: [imageAttachment] },
] as const)(
  "queues an agent $mode update behind a turn whose steering cancels tools (attachments=$attachments.length)",
  ({ mode, attachments }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `agent-update-queued-${mode}-${attachments.length}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const result = yield* sendUpdate(threadId, "agent", mode, attachments);
          assert.equal(result.delivery, "queued");
          assert.deepEqual(steered, []);
          const pending = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(pending.runs.find((run) => run.id === first.runId)?.status, "running");

          const completed = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = pending.providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(completed);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.deepEqual(
            started.map((input) => input.message.messageId),
            [MessageId.make("message:first"), MessageId.make("message:update")],
          );
          assert.deepEqual(started[1]?.message.attachments, attachments);
          assert.equal(started[1]?.message.createdBy, "agent");
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each([
  { createdBy: "user", activeSteeringInterruptsTools: false },
  { createdBy: "agent", activeSteeringInterruptsTools: false },
] as const)(
  "steers an update from $createdBy when steering is allowed (interruptsTools=$activeSteeringInterruptsTools)",
  ({ createdBy, activeSteeringInterruptsTools }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `update-steered-${createdBy}-${activeSteeringInterruptsTools}`,
          { activeSteeringInterruptsTools },
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const result = yield* sendUpdate(
            threadId,
            createdBy,
            createdBy === "agent" ? "auto" : "steer",
          );
          assert.equal(result.delivery, "steered");
          assert.deepEqual(steered, ["progress update"]);
          assert.equal(started.length, 1);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("keeps goal control commands queued instead of offering them as hook context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "agent-goal-boundary",
        { activeSteeringInterruptsTools: true },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = yield* startFirstTurn;
        const sent = yield* sendUpdate(threadId, "agent", "auto", [], "/goal clear");
        assert.deepEqual(yield* offerAtToolBoundary(threadId, started[0]!.runId), []);
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === sent.run.id,
        );
        assert.equal(queued?.status, "queued");
        assert.isUndefined(queued?.boundaryOffer);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an agent update joins the running turn at its next tool boundary, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "agent-update-tool-boundary",
        { activeSteeringInterruptsTools: true },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        // The update arrives while a long tool call runs; nothing reaches the provider.
        const sent = yield* sendUpdate(threadId, "agent", "auto");
        assert.equal(sent.delivery, "queued");
        assert.deepEqual(steered, []);

        // A hook of a replaced turn cannot offer into the run's current turn.
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        assert.deepEqual(
          yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: ProviderTurnId.make("provider-turn:replaced"),
          }),
          [],
        );
        const offers = yield* offerAtToolBoundary(threadId, first.runId);
        assert.deepEqual(
          offers.map((offer) => offer.text),
          ["progress update"],
        );
        assert.deepEqual(yield* claimAtToolBoundary(threadId, first.runId), []);
        // Until Claude saves the offer, the update stays queued and nothing else starts it.
        const offered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(offered.runs.find((run) => run.id === sent.run.id)?.status, "queued");
        // A repeated receipt replays the first one.
        yield* receiveAtToolBoundary(threadId, first.runId, offers);
        yield* receiveAtToolBoundary(threadId, first.runId, offers);
        const joined = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          joined.messages.find((message) => message.id === MessageId.make("message:update"))?.runId,
          first.runId,
        );
        assert.isFalse(joined.runs.some((run) => run.status === "queued"));
        // The sender waits on the run it was given; the run that took the update answers.
        const waiting = yield* (yield* ThreadManagement.ThreadManagementService)
          .waitForThread({
            projectId: joined.thread.projectId,
            threadId,
            runId: sent.run.id,
            timeoutMs: 1,
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        const waited = yield* Fiber.join(waiting);
        assert.equal(waited.run?.id, first.runId);
        assert.isTrue(waited.timedOut);

        // The turn ends; the update does not start another one.
        const completed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = joined.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.equal(started.length, 1);
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an update Claude drops unread after its turn ended starts on the idle thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "agent-update-late-withdraw",
        { activeSteeringInterruptsTools: true },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* sendUpdate(threadId, "agent", "auto");
        const offers = yield* offerAtToolBoundary(threadId, first.runId);
        assert.lengthOf(offers, 1);
        const completed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        // Still offered, so nothing starts it.
        assert.equal(started.length, 1);
        yield* requests.withdrawAgentMessages!({ threadId, runId: first.runId, offers });
        yield* worker.drain();
        assert.equal(started.length, 2);
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { offered: false, after: "nothing" },
  { offered: true, after: "nothing" },
  { offered: true, after: "a new user message" },
  { offered: true, after: "cancel" },
  { offered: true, after: "send again" },
] as const)(
  "Stop keeps an agent update recoverable (offered=$offered, then $after)",
  ({ offered, after }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `agent-update-boundary-after-stop-${offered}-${after.replaceAll(" ", "-")}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sent = yield* sendUpdate(threadId, "agent", "auto");
          assert.equal(sent.delivery, "queued");
          const offers = offered ? yield* offerAtToolBoundary(threadId, first.runId) : [];
          assert.lengthOf(offers, offered ? 1 : 0);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          });
          assert.deepEqual(yield* claimAtToolBoundary(threadId, first.runId), []);

          // The stopped turn ends, so no live run keeps the queue behind it any more.
          const ended = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* worker.drain();
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Fiber.join(ended);
          yield* worker.drain();

          const stopped = yield* orchestrator.getThreadProjection(threadId);
          const queued = stopped.runs.find((run) => run.id === sent.run.id);
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.queueHeld, true);
          assert.equal(queued?.boundaryOffer?.id, offers[0]?.id);
          assert.equal(
            stopped.messages.find((message) => message.id === MessageId.make("message:update"))
              ?.text,
            "progress update",
          );
          if (after === "a new user message") {
            // A user message clears the hold and starts; the offered update still never resends.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("next"),
              threadId,
              messageId: MessageId.make("message:next"),
              text: "next",
              attachments: [],
              modelSelection: runSelection,
              dispatchMode: { type: "start_immediately" },
              deliveryIntent: "auto",
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(threadId);
            const next = after.runs.find(
              (run) => run.userMessageId === MessageId.make("message:next"),
            );
            assert.notEqual(next?.status, "queued");
            assert.isFalse(after.runs.find((run) => run.id === sent.run.id)?.queueHeld === true);
            assert.equal(after.runs.find((run) => run.id === sent.run.id)?.status, "queued");
          } else if (after === "cancel") {
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("cancel-offered"),
              threadId,
              runId: sent.run.id,
            });
          } else if (after === "send again") {
            // The adapter settles an offer from Claude's report; nobody can send it twice.
            const refused = yield* orchestrator
              .dispatch({
                type: "queued-run.start",
                commandId: CommandId.make("send-offered"),
                threadId,
                runId: sent.run.id,
              })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "OrchestratorDispatchError");
          }
          if (!offered) return;

          // Claude started the offer before stopping, so its late receipt joins the stopped turn,
          // unless the user already cancelled it.
          yield* receiveAtToolBoundary(threadId, first.runId, offers);
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const message = settled.messages.find(
            (candidate) => candidate.id === MessageId.make("message:update"),
          );
          const item = settled.turnItems.find(
            (candidate) =>
              candidate.type === "user_message" &&
              candidate.messageId === MessageId.make("message:update"),
          );
          if (after === "cancel") {
            assert.notInclude(
              ["queued"],
              settled.runs.find((run) => run.id === sent.run.id)?.status,
            );
            assert.equal(message?.runId, sent.run.id);
            assert.notEqual(item?.providerTurnId, turn.id);
            return;
          }
          assert.equal(settled.runs.find((run) => run.id === sent.run.id)?.status, "cancelled");
          assert.equal(message?.runId, first.runId);
          assert.equal(message?.createdBy, "agent");
          assert.equal(message?.creationSource, "mcp");
          assert.equal(item?.providerTurnId, turn.id);
          assert.equal(item?.nodeId, turn.nodeId);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["auto", "steer"] as const)(
  "a user's %s send waits for the native tool boundary",
  (deliveryIntent) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `user-send-steers-${deliveryIntent}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* startFirstTurn;
          // The client's dispatch shape: the server resolves the intent.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("user-send"),
            threadId,
            messageId: MessageId.make("message:user-send"),
            text: "user update",
            attachments: [],
            deliveryIntent,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "mobile",
          });
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.equal(started.length, 1);
          assert.isTrue(projection.runs.some((run) => run.status === "queued"));
          const offers = yield* offerAtToolBoundary(threadId, started[0]!.runId);
          assert.deepEqual(
            offers.map((offer) => ({
              text: offer.text,
              createdBy: offer.createdBy,
              creationSource: offer.creationSource,
            })),
            [{ text: "user update", createdBy: "user", creationSource: "mobile" }],
          );
          yield* receiveAtToolBoundary(threadId, started[0]!.runId, offers);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each([
  { requester: "agent", attachments: [] },
  { requester: "user", attachments: [] },
  { requester: "agent", attachments: [imageAttachment] },
] as const)(
  "a queue promotion requested by the $requester into a turn whose steering cancels tools (attachments=$attachments.length)",
  ({ requester, attachments }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `queue-promote-${requester}-${attachments.length}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued"),
            threadId,
            messageId: MessageId.make("message:queued"),
            text: "queued",
            attachments,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          )!;
          const promoted = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: first.runId,
              ...(requester === "agent" ? { requestedBy: "agent" as const } : {}),
            })
            .pipe(Effect.result);
          yield* worker.drain();

          assert.equal(promoted._tag, "Success");
          // The agent's promotion waits for the running turn's next tool boundary.
          assert.deepEqual(steered, []);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queuedRun.id,
            )?.status,
            "queued",
          );
          const offers = yield* offerAtToolBoundary(threadId, first.runId);
          assert.deepEqual(
            offers.map((offer) => ({
              text: offer.text,
              createdBy: offer.createdBy,
              attachments: offer.attachments,
            })),
            [{ text: "queued", createdBy: "user", attachments }],
          );
          assert.deepEqual(yield* claimAtToolBoundary(threadId, first.runId), []);
          assert.deepEqual(steered, []);
          assert.equal(started.length, 1);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each([{ canRestart: false }, { canRestart: true }])(
  "steers a changed turn-scoped selection into the running turn (canRestart=$canRestart)",
  ({ canRestart }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `steering-selection-change-${canRestart}`,
          { canRestart },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

const goalHarness = Effect.fn("goalHarness")(function* (
  name: string,
  {
    activeSteeringInterruptsTools = false,
    nativeGoals,
  }: { activeSteeringInterruptsTools?: boolean; nativeGoals?: boolean | undefined } = {},
) {
  const harness = yield* nextTurnSelectionHarness(name, {
    activeSteeringInterruptsTools,
    nativeGoals,
  });
  const send = (
    id: string,
    text: string,
    delivery: "queue" | "auto" | "agent_auto" | "agent_steer",
    freshContext = false,
  ) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (delivery === "agent_auto" || delivery === "agent_steer") {
        return yield* (yield* ThreadManagement.ThreadManagementService).sendToThread({
          projectId: ProjectId.make(`project:${name}`),
          commandId: CommandId.make(id),
          threadId: ThreadId.make(`thread:${name}`),
          messageId: MessageId.make(`message:${id}`),
          text,
          attachments: [],
          mode: delivery === "agent_auto" ? "auto" : "steer",
          createdBy: "agent",
          creationSource: "mcp",
        });
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(`thread:${name}`),
        messageId: MessageId.make(`message:${id}`),
        text,
        attachments: [],
        modelSelection: runSelection,
        ...(freshContext ? { freshContext } : {}),
        ...(delivery === "queue"
          ? { dispatchMode: { type: "queue_after_active" } }
          : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
        createdBy: "user",
        creationSource: "web",
      });
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      const textOf = (run: (typeof projection.runs)[number]) =>
        projection.messages.find((message) => message.id === run.userMessageId)?.text;
      return {
        queue: projection.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
          .map(textOf),
        started: harness.started.map((turn) => turn.message.text),
        stopRequested: projection.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" && item.runId === harness.started[0]?.runId,
        ),
      };
    });
  return { ...harness, send, read };
});

it.effect.each([undefined, false, true])(
  "goal dispatch stops the active turn only with native support: %s",
  (nativeGoals) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-steer", {
          nativeGoals,
        });
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("queued", "queued", "queue");
          const sending = send("goal", "/goal all tests pass", "auto");
          if (nativeGoals === false) {
            yield* Effect.flip(sending);
          } else yield* sending;
          yield* worker.drain();

          assert.deepEqual(steered, []);
          assert.deepEqual(yield* read(threadId), {
            queue: ["queued"],
            started: nativeGoals === false ? ["first"] : ["first", "/goal all tests pass"],
            stopRequested: nativeGoals !== false,
          });
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("starts a goal that names no model on the thread's model ahead of a queued pick", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn, read } = yield* goalHarness("goal-ahead-of-pick");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        for (const [id, text, modelSelection] of [
          ["picked", "picked", composerSelection],
          ["goal", "/goal all tests pass", undefined],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            ...(modelSelection === undefined ? {} : { modelSelection }),
            dispatchMode:
              id === "picked" ? { type: "queue_after_active" } : { type: "start_immediately" },
            ...(id === "picked" ? {} : { deliveryIntent: "auto" as const }),
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* worker.drain();

        assert.deepEqual(yield* read(threadId), {
          queue: ["picked"],
          started: ["first", "/goal all tests pass"],
          stopRequested: true,
        });
        assert.deepEqual(started[1]?.modelSelection, runSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["auto", "agent_auto", "agent_steer"] as const)(
  "queues a goal clear from %s without stopping work when no goal drives it",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-clear", {
          activeSteeringInterruptsTools: true,
        });
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("queued", "queued", "queue");
          yield* send("clear", "/goal clear", delivery);
          yield* worker.drain();

          const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
            threadId,
          );
          assert.isNotTrue(
            projection.messages.find((message) => message.id === MessageId.make("message:clear"))
              ?.atToolBoundary,
          );
          assert.deepEqual(steered, []);
          assert.deepEqual(yield* read(threadId), {
            queue: ["queued", "/goal clear"],
            started: ["first"],
            stopRequested: false,
          });
        }).pipe(Effect.provide(layer));
      }),
    ),
);
it.effect("restarts by stopping the running turn when the provider cannot interrupt-restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } = yield* goalHarness(
        "restart-without-interrupt-restart",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: started[0]!.runId },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "do this instead"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a restart that stops the running turn ahead of an older held queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn, send, read } =
        yield* goalHarness("restart-past-held-queue");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        yield* worker.drain();
        const secondRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("second"),
          threadId,
          messageId: MessageId.make("message:second"),
          text: "second",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(secondRunning);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          dispatchMode: { type: "restart_active", targetRunId: started[1]!.runId },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();

        const { queue, started: startedTexts } = yield* read(threadId);
        assert.deepEqual(
          { queue, started: startedTexts },
          { queue: ["queued"], started: ["first", "second", "do this instead"] },
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("reports a restart that stops the running turn as restarted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* goalHarness("restart-send-delivery");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadManagement = yield* ThreadManagementService.ThreadManagementService;
        const threadId = yield* startFirstTurn;
        const input = {
          projectId: ProjectId.make("project:restart-send-delivery"),
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          mode: "restart",
          createdBy: "agent",
          creationSource: "mcp",
        } as const;
        const sent = yield* threadManagement.sendToThread(input);
        // Stop holds the replacement before it starts; a replay must still report the restart.
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-after-restart"),
          threadId,
        });
        const replayed = yield* threadManagement.sendToThread(input);

        assert.equal(started.length, 1);
        assert.deepEqual([sent.delivery, replayed.delivery], ["restarted", "restarted"]);
      }).pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provideMerge(layer),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        ),
      );
    }),
  ),
);

it.effect("queues a goal clear without stopping work when no goal drives it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-clear");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued", "/goal clear"],
          started: ["first"],
          stopRequested: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("promotes a queued goal by stopping the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } =
        yield* goalHarness("goal-promote");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal ship it", "queue");
        const goalRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("message:goal"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: goalRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal ship it"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// A fresh message skips compaction as its own turn, which steering a running turn would not.
it.effect.each(["next", "/goal ship it", "fresh next"])(
  "promoting %s into a compaction stops it and sends it next",
  (promoted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, layer, send, read, started, steered, startFirstTurn } = yield* goalHarness(
          `compaction-promote-${promoted.length}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("compact", "/compact", "queue");
          yield* send("queued", "queued", "queue");
          yield* send("next", promoted, "queue", promoted.startsWith("fresh"));
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === started[0]!.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const compacting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.runAttemptId !== started[0]!.attemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* Fiber.join(compacting);
          const compactRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:compact"),
          )!;
          const nextRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:next"),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: nextRun.id,
            targetRunId: compactRun.id,
          });
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === compactRun.id,
            ),
          );
          assert.deepEqual((yield* read(threadId)).queue, ["queued"]);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "/compact", promoted],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("stops a turn that is still starting when a goal is sent into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, send, started } = yield* goalHarness("goal-during-start");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:goal-during-start");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:goal-during-start"),
          title: "Goal during start",
          modelSelection: runSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        // The stopped run's end starts the queue, which then needs one more drain.
        const goalStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* send("first", "first", "auto");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();
        yield* Fiber.join(goalStarting);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const statusOf = (text: string) =>
          projection.runs.find(
            (run) =>
              projection.messages.find((message) => message.id === run.userMessageId)?.text ===
              text,
          )?.status;
        assert.equal(statusOf("first"), "interrupted");
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["/goal all tests pass"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(
  (["auto", "agent_auto", "agent_steer"] as const).flatMap((delivery) =>
    ["/goal clear", "/goal ship the fix"].map((text) => ({ delivery, text })),
  ),
)("stops the running turn when $delivery sends $text to an active goal", ({ delivery, text }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, startFirstTurn, send, read, steered } = yield* goalHarness(
        "goal-clear-active",
        { activeSteeringInterruptsTools: true },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const providerThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const goalSeen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-thread.updated" && event.payload.goal?.status === "active",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: {
            ...providerThread,
            goal: { objective: "all tests pass", status: "active" },
          },
        });
        yield* Fiber.join(goalSeen);
        yield* send("clear", text, delivery);
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: [],
          started: ["first", text],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a side chat that opens with /goal gets its context on the next question", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, started, startFirstTurn } = yield* goalHarness("side-chat-goal");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentId = yield* startFirstTurn;
        const sideChatId = ThreadId.make("thread:side-chat-goal-child");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("side-chat"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        const ask = (id: string, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId: sideChatId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const sideChatEvent = (matches: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter((event) => event.threadId === sideChatId && matches(event)),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
        const running = yield* sideChatEvent(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        const settled = yield* sideChatEvent(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* ask("goal", "/goal clear");
        yield* worker.drain();
        yield* Fiber.join(running);
        const turn = (yield* orchestrator.getThreadProjection(sideChatId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: started[1]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* ask("question", "What is the main thread doing?");
        yield* worker.drain();

        const [first, goal, question] = started.map((turn) => turn.message.text);
        assert.deepEqual([first, goal], ["first", "/goal clear"]);
        assert.include(question, "You are in a side chat beside the main thread.");
        assert.include(question, "- User: first");
        assert.isTrue(question?.endsWith("What is the main thread doing?"));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { mode: "auto", turnStatus: "running" },
  { mode: "steer", turnStatus: "running" },
  { mode: "auto", turnStatus: "completed" },
  { mode: "steer", turnStatus: "completed" },
] as const)(
  "rejects an agent $mode update after Stop with a $turnStatus provider turn",
  ({ mode, turnStatus }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `agent-update-after-stop-${mode}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: started[0]!.runId,
            holdQueue: true,
          });
          if (turnStatus === "completed") {
            const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
            const now = yield* DateTime.now;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("completed-after-stop"),
                  type: "provider-turn.updated",
                  threadId,
                  runId: started[0]!.runId,
                  occurredAt: now,
                  payload: { ...turn, status: "completed", completedAt: now },
                },
              ],
            });
          }
          // Nothing was queued before Stop, so a queued update would have no hold
          // and would start on its own once the provider stops.
          const error = yield* sendUpdate(threadId, "agent", mode).pipe(Effect.flip);
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.include(String(error.cause), "stopping");
          assert.deepEqual(steered, []);
          assert.equal(started.length, 1);
          assert.isFalse(projection.runs.some((run) => run.status === "queued"));
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["receipt", "withdraw", "cancel", "retry", "resume"] as const)(
  "keeps native boundary ownership through Stop and %s",
  (settlement) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `native-boundary-${settlement}`,
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sent = yield* sendUpdate(threadId, "user", "auto", [imageAttachment]);
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          assert.deepEqual(
            yield* requests.claimAgentMessages!({
              threadId,
              runId: first.runId,
              providerTurnId: ProviderTurnId.make("replaced-turn"),
            }),
            [],
          );
          const offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
          });
          assert.lengthOf(offers, 1);
          assert.deepEqual(offers[0]?.attachments, [imageAttachment]);
          assert.equal(offers[0]?.messageId, "message:update");
          assert.equal(offers[0]?.createdBy, "user");
          assert.equal(offers[0]?.text, "progress update");
          assert.deepEqual(
            yield* requests.claimAgentMessages!({
              threadId,
              runId: first.runId,
              providerTurnId: turn.id,
            }),
            [],
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === sent.run.id,
            )?.status,
            "queued",
          );
          const edit = yield* orchestrator
            .dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make("edit-offered"),
              threadId,
              runId: sent.run.id,
              text: "changed",
            })
            .pipe(Effect.flip);
          assert.equal(edit._tag, "OrchestratorCommandRejectedError");
          const reordered = yield* orchestrator
            .dispatch({
              type: "queued-run.reorder",
              commandId: CommandId.make("reorder-offered"),
              threadId,
              runId: sent.run.id,
              beforeRunId: null,
            })
            .pipe(Effect.flip);
          assert.equal(reordered._tag, "OrchestratorDispatchError");
          if (settlement === "receipt") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("late-queued"),
              threadId,
              messageId: MessageId.make("message:late-queued"),
              text: "later",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const later = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.userMessageId === "message:late-queued",
            )!;
            const crossed = yield* orchestrator
              .dispatch({
                type: "queued-run.reorder",
                commandId: CommandId.make("cross-offered"),
                threadId,
                runId: later.id,
                beforeRunId: sent.run.id,
              })
              .pipe(Effect.flip);
            assert.equal(crossed._tag, "OrchestratorDispatchError");
            for (const requestedBy of ["agent", undefined] as const) {
              const reoffer = yield* orchestrator
                .dispatch({
                  type: "queued-message.promote-to-steer",
                  commandId: CommandId.make(`reoffer-${requestedBy ?? "human"}`),
                  threadId,
                  queuedRunId: sent.run.id,
                  targetRunId: first.runId,
                  ...(requestedBy === undefined ? {} : { requestedBy }),
                })
                .pipe(Effect.flip);
              assert.equal(reoffer._tag, "OrchestratorDispatchError");
            }
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (run) => run.id === sent.run.id,
              )?.boundaryOffer?.id,
              offers[0]!.id,
            );
          }
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          });
          const ended = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* worker.drain();
          yield* Fiber.join(ended);
          yield* worker.drain();
          if (settlement === "withdraw") {
            yield* requests.withdrawAgentMessages!({ threadId, runId: first.runId, offers });
          } else if (settlement === "cancel") {
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("cancel"),
              threadId,
              runId: sent.run.id,
            });
          } else if (settlement === "retry") {
            for (const requestedBy of ["agent", undefined] as const) {
              const refused = yield* orchestrator
                .dispatch({
                  type: "queued-run.start",
                  commandId: CommandId.make(`retry-${requestedBy ?? "human"}`),
                  threadId,
                  runId: sent.run.id,
                  ...(requestedBy === undefined ? {} : { requestedBy }),
                })
                .pipe(Effect.flip);
              assert.equal(refused._tag, "OrchestratorDispatchError");
            }
          } else if (settlement === "resume") {
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("resume"),
              threadId,
            });
            yield* worker.drain();
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
          }
          if (settlement !== "resume" && settlement !== "withdraw") {
            yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
            yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
          }
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const run = settled.runs.find((run) => run.id === sent.run.id)!;
          const message = settled.messages.find((message) => message.id === "message:update")!;
          if (settlement === "receipt" || settlement === "retry") {
            assert.equal(message.runId, first.runId);
            const item = settled.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === message.id,
            )!;
            assert.equal(item.providerTurnId, turn.id);
            assert.equal(item.nodeId, turn.nodeId);
            assert.equal(message.createdBy, "user");
            assert.deepEqual(message.attachments, [imageAttachment]);
          } else {
            assert.equal(message.runId, sent.run.id);
          }
          if (settlement === "resume" || settlement === "withdraw") {
            assert.equal(run.status, "queued");
            assert.equal(
              run.boundaryOffer?.id,
              settlement === "resume" ? offers[0]!.id : undefined,
            );
            assert.equal(run.queueHeld, settlement === "withdraw");
          }
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "keeps forty simultaneous human and agent boundary updates in committed queue order",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "native-boundary-mixed-batch",
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const projectId = (yield* orchestrator.getThreadProjection(threadId)).thread.projectId;
          const first = started[0]!;
          yield* Effect.forEach(
            Array.from({ length: 40 }, (_, index) => index),
            (index) =>
              threads.sendToThread({
                projectId,
                threadId,
                commandId: CommandId.make(`mixed:${index}`),
                messageId: MessageId.make(`message:mixed:${index}`),
                text: `mixed update ${index}`,
                attachments: index === 17 ? [imageAttachment] : [],
                mode: index % 3 === 0 ? "steer" : "auto",
                createdBy: index % 2 === 0 ? "user" : "agent",
                creationSource: index % 2 === 0 ? "web" : "mcp",
              }),
            { concurrency: "unbounded", discard: true },
          );
          const pending = yield* orchestrator.getThreadProjection(threadId);
          const expected = pending.runs
            .filter((run) => run.status === "queued")
            .toSorted((left, right) => left.queuePosition! - right.queuePosition!)
            .map((run) => pending.messages.find((message) => message.id === run.userMessageId)!);
          assert.lengthOf(expected, 40);
          const turn = pending.providerTurns[0]!;
          const offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
          });
          assert.deepEqual(
            offers.map((offer) => offer.messageId),
            expected.map((message) => message.id),
          );
          assert.deepEqual(
            offers.map((offer) => offer.createdBy),
            expected.map((message) => message.createdBy),
          );
          assert.deepEqual(
            offers.map((offer) => offer.text),
            expected.map((message) => message.text),
          );
          assert.deepEqual(
            offers.map((offer) => offer.attachments),
            expected.map((message) => message.attachments),
          );
          assert.lengthOf(new Set(offers.map((offer) => offer.id)), 40);
          const now = yield* DateTime.now;
          const itemBase = {
            threadId,
            runId: first.runId,
            nodeId: first.rootNodeId,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          };
          const replyId = TurnItemId.make("native-batch-reply");
          const replyCommitted = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn-item.updated" && event.payload.id === replyId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const received = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "message.updated" &&
                event.payload.id === offers.at(-1)!.messageId &&
                event.payload.runId === first.runId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase,
              id: TurnItemId.make("native-batch-tool"),
              type: "command_execution",
              input: "synthetic noisy tool",
              exitCode: 0,
              output: Array.from({ length: 100 }, (_, index) => `noise ${index}`).join("\n"),
            },
          });
          yield* Queue.offer(events, {
            type: "boundary_messages.updated",
            driver,
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
            step: "reserve",
            offers,
          });
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase,
              id: replyId,
              type: "assistant_message",
              messageId: MessageId.make("message:native-batch-reply"),
              text: "Received all forty human and agent updates in order.",
              streaming: false,
            },
          });
          yield* Fiber.join(replyCommitted);
          yield* Queue.offer(events, {
            type: "boundary_messages.updated",
            driver,
            threadId,
            runId: first.runId,
            providerTurnId: turn.id,
            step: "receipt",
            offers,
          });
          yield* Fiber.join(received);
          yield* requests.acknowledgeAgentMessages!({ threadId, runId: first.runId, offers });
          const settled = yield* orchestrator.getThreadProjection(threadId);
          assert.isFalse(settled.runs.some((run) => run.status === "queued"));
          assert.deepEqual(
            settled.turnItems
              .filter((item) => item.runId === first.runId)
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((item) => (item.type === "user_message" ? item.messageId : item.id)),
            [
              MessageId.make("message:first"),
              TurnItemId.make("native-batch-tool"),
              ...offers.map((offer) => offer.messageId),
              replyId,
            ],
          );
          assert.deepEqual(
            settled.turnItems
              .filter((item) => item.type === "user_message" && item.runId === first.runId)
              .toSorted((left, right) => left.ordinal - right.ordinal)
              .map((item) => (item.type === "user_message" ? item.messageId : null)),
            [MessageId.make("message:first"), ...offers.map((offer) => offer.messageId)],
          );
          for (const original of expected) {
            const delivered = settled.messages.find((message) => message.id === original.id)!;
            assert.equal(delivered.runId, first.runId);
            assert.equal(delivered.createdBy, original.createdBy);
            assert.equal(delivered.creationSource, original.creationSource);
            assert.equal(delivered.text, original.text);
            assert.deepEqual(delivered.attachments, original.attachments);
          }
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "a late native receipt uses the saved attempt after the run changes provider and node",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "native-boundary-restarted-identity",
          { activeSteeringInterruptsTools: true },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const sent = yield* sendUpdate(threadId, "agent", "auto");
          const original = yield* orchestrator.getThreadProjection(threadId);
          const originalRun = original.runs.find((run) => run.id === first.runId)!;
          const originalTurn = original.providerTurns[0]!;
          const originalAttempt = original.attempts.find(
            (attempt) => attempt.id === originalRun.activeAttemptId,
          )!;
          const originalNode = original.nodes.find((node) => node.id === originalRun.rootNodeId)!;
          const originalThread = original.providerThreads.find(
            (thread) => thread.id === originalRun.providerThreadId,
          )!;
          const offers = yield* requests.claimAgentMessages!({
            threadId,
            runId: first.runId,
            providerTurnId: originalTurn.id,
          });
          assert.lengthOf(offers, 1);
          const providerInstanceId = ProviderInstanceId.make("replacement-provider");
          const providerThreadId = ProviderThreadId.make("replacement-thread");
          const providerTurnId = ProviderTurnId.make("replacement-turn");
          const rootNodeId = NodeId.make("replacement-root");
          const activeAttemptId = RunAttemptId.make("replacement-attempt");
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("replacement-thread"),
                type: "provider-thread.updated",
                threadId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalThread,
                  id: providerThreadId,
                  providerInstanceId,
                  providerSessionId: null,
                  nativeThreadRef: { driver, nativeId: "replacement-native", strength: "strong" },
                },
              },
              {
                id: EventId.make("replacement-node"),
                type: "node.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalNode,
                  id: rootNodeId,
                  rootNodeId,
                  providerThreadId,
                  providerTurnId,
                },
              },
              {
                id: EventId.make("replacement-attempt"),
                type: "run-attempt.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalAttempt,
                  id: activeAttemptId,
                  attemptOrdinal: originalAttempt.attemptOrdinal + 1,
                  rootNodeId,
                  providerThreadId,
                  providerTurnId,
                  providerInstanceId,
                },
              },
              {
                id: EventId.make("replacement-turn"),
                type: "provider-turn.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalTurn,
                  id: providerTurnId,
                  nodeId: rootNodeId,
                  providerThreadId,
                  runAttemptId: activeAttemptId,
                },
              },
              {
                id: EventId.make("replacement-run"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                nodeId: rootNodeId,
                providerInstanceId,
                occurredAt: now,
                payload: {
                  ...originalRun,
                  rootNodeId,
                  activeAttemptId,
                  providerThreadId,
                  providerInstanceId,
                  modelSelection: { ...originalRun.modelSelection, instanceId: providerInstanceId },
                },
              },
            ],
          });
          const receipt = yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("late-native-receipt"),
            threadId,
            queuedRunId: sent.run.id,
            targetRunId: first.runId,
            boundaryOffer: { id: offers[0]!.id, step: "receipt" },
          });
          const settled = yield* orchestrator.getThreadProjection(threadId);
          const message = settled.messages.find((message) => message.id === "message:update")!;
          const item = settled.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === message.id,
          )!;
          assert.equal(message.nodeId, originalNode.id);
          assert.equal(item.nodeId, originalNode.id);
          assert.equal(item.providerTurnId, originalTurn.id);
          assert.equal(item.providerThreadId, originalThread.id);
          const savedMessage = receipt.storedEvents.find(
            (event) => event.event.type === "message.updated",
          );
          assert.equal(savedMessage?.event.providerInstanceId, originalAttempt.providerInstanceId);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
