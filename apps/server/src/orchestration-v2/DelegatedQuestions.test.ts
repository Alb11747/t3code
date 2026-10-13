import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedQuestions from "./DelegatedQuestions.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const parentThreadId = ThreadId.make("thread:question-parent");
const childThreadId = ThreadId.make("thread:question-child");
const taskId = NodeId.make("node:question-task");
const requestId = RuntimeRequestId.make("request:question");
const question = {
  id: "approach",
  header: "Approach",
  question: "Which approach?",
  options: [{ label: "Small", description: "Keep it small." }],
};

const task = (completionWake: "always" | "settled_only") =>
  ({
    id: taskId,
    origin: "app_owned",
    childThreadId,
    prompt: "Fix the bug.",
    title: "Bug fix",
    completionWake,
  }) as unknown as OrchestrationV2Subagent;

describe("DelegatedQuestions.relay", () => {
  const relayWith = (input: {
    readonly lineage?: "subagent" | null;
    readonly withItem?: boolean;
    readonly completionWake?: "always" | "settled_only";
  }) =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const child = {
        thread: {
          id: childThreadId,
          lineage: {
            relationshipToParent: input.lineage === undefined ? "subagent" : input.lineage,
            parentThreadId,
          },
        },
        runtimeRequests: [
          {
            id: requestId,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "live" },
          },
        ],
        turnItems:
          input.withItem === false
            ? []
            : [{ type: "user_input_request", requestId, questions: [question] }],
      } as unknown as OrchestrationV2ThreadProjection;
      const parent = {
        thread: { id: parentThreadId, archivedAt: null },
        subagents: [task(input.completionWake ?? "always")],
      } as unknown as OrchestrationV2ThreadProjection;
      const relay = yield* DelegatedQuestions.make.pipe(
        Effect.map((service) => service.relay),
        Effect.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: ((threadId: ThreadId) =>
              Effect.succeed(threadId === childThreadId ? child : parent)) as never,
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return {} as never;
              }),
          }),
        ),
      );
      yield* relay(childThreadId);
      return dispatched;
    });

  it.effect("hands a readable question to an async task's parent", () =>
    Effect.gen(function* () {
      const [command] = yield* relayWith({});
      assert.equal(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.equal(command.threadId, parentThreadId);
      assert.equal(command.commandId, CommandId.make(`server:delegated-question:${requestId}`));
      assert.include(command.text, "Which approach?");
      assert.include(command.text, `requestId: "${requestId}"`);
      assert.deepEqual(command.notification?.source, {
        kind: "delegated_task",
        taskIds: [taskId],
        childThreadId,
      });
    }),
  );

  it.effect("waits for both the request and its question item", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* relayWith({ withItem: false }), 0);
    }),
  );

  it.effect("leaves a blocking wait and non-subagent threads alone", () =>
    Effect.gen(function* () {
      assert.lengthOf(yield* relayWith({ completionWake: "settled_only" }), 0);
      assert.lengthOf(yield* relayWith({ lineage: null }), 0);
    }),
  );
});

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each([
  { interruptsTools: false, stop: false, label: "steers a question into a running parent turn" },
  { interruptsTools: true, stop: false, label: "queues and deduplicates retryable questions" },
  { interruptsTools: true, stop: true, label: "Stop drops question notices from earlier cohorts" },
])("$label", ({ interruptsTools, stop }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`delegated-question-${interruptsTools}-${stop}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const steered: Array<string> = [];
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: true,
          activeSteeringInterruptsTools: interruptsTools,
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
                Effect.sync(() => {
                  steered.push(turn.message.text);
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
        const sink = yield* EventSink.EventSinkV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:delegated-question"),
          title: "Parent",
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
          threadId: parentThreadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event: OrchestrationV2DomainEvent) =>
              event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const now = yield* DateTime.now;
        const delegated: OrchestrationV2Subagent = {
          id: taskId,
          threadId: parentThreadId,
          runId: first.runId,
          parentNodeId: first.rootNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Fix the bug.",
          title: "Bug fix",
          model: null,
          completionWake: "always",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:question-task"),
              type: "subagent.updated",
              threadId: parentThreadId,
              runId: first.runId,
              nodeId: taskId,
              occurredAt: now,
              payload: delegated,
            },
          ],
        });

        const notice = DelegatedQuestions.questionNotification(
          parentThreadId,
          delegated,
          childThreadId,
          { requestId, questions: [question] },
        );
        if (interruptsTools && !stop) {
          yield* sink.commitRejectedCommand({
            commandId: notice.commandId,
            threadId: parentThreadId,
            commandType: "message.dispatch",
            rejectedAt: now,
            error: "Thread has a pending merge-back transfer.",
          });
        }
        yield* orchestrator.dispatch(notice);
        yield* orchestrator.dispatch(notice);
        yield* worker.drain();

        const messageId = MessageId.make(`message:delegated-question:${requestId}`);
        const projection = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.lengthOf(
          projection.messages.filter((message) => message.id === messageId),
          1,
        );
        // Either way the parent's running turn is never restarted for it.
        assert.lengthOf(started, 1);
        if (interruptsTools) {
          assert.lengthOf(steered, 0);
          assert.equal(
            projection.runs.find((run) => run.userMessageId === messageId)?.status,
            "queued",
          );
        } else {
          assert.lengthOf(steered, 1);
          assert.include(steered[0], "Which approach?");
          assert.equal(
            projection.messages.find((message) => message.id === messageId)?.runId,
            first.runId,
          );
        }

        let earlierMessageId: MessageId | undefined;
        if (stop) {
          // Stop must cover an earlier task's queued notice even when its
          // parent run is absent from the available records.
          const earlierChildThreadId = ThreadId.make("thread:earlier-question-child");
          const earlierTask: OrchestrationV2Subagent = {
            ...delegated,
            id: NodeId.make("node:earlier-question-task"),
            runId: RunId.make("run:earlier-parent"),
            childThreadId: earlierChildThreadId,
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:earlier-question-task"),
                type: "subagent.updated",
                threadId: parentThreadId,
                runId: earlierTask.runId!,
                nodeId: earlierTask.id,
                occurredAt: now,
                payload: earlierTask,
              },
            ],
          });
          const earlierNotice = DelegatedQuestions.questionNotification(
            parentThreadId,
            earlierTask,
            earlierChildThreadId,
            { requestId: RuntimeRequestId.make("request:earlier-question"), questions: [question] },
          );
          earlierMessageId = earlierNotice.messageId;
          yield* orchestrator.dispatch(earlierNotice);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-question-parent"),
            threadId: parentThreadId,
            runId: first.runId,
            reason: "User stopped the parent.",
            holdQueue: true,
          });
        } else {
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.dispose",
            commandId: CommandId.make("drop-question-task"),
            parentThreadId,
            taskId,
          });
        }
        const dropped = yield* orchestrator.getThreadProjection(parentThreadId);
        if (interruptsTools) {
          assert.equal(
            dropped.runs.find((run) => run.userMessageId === messageId)?.status,
            "cancelled",
          );
        }
        if (earlierMessageId !== undefined) {
          assert.equal(
            dropped.runs.find((run) => run.userMessageId === earlierMessageId)?.status,
            "cancelled",
          );
        }
        // An already-prepared relay dispatch cannot revive the dropped task.
        const lateNotice = DelegatedQuestions.questionNotification(
          parentThreadId,
          delegated,
          childThreadId,
          { requestId: RuntimeRequestId.make("request:late-question"), questions: [question] },
        );
        const skipped = yield* orchestrator.dispatch(lateNotice);
        assert.lengthOf(skipped.storedEvents, 0);
        assert.isFalse(
          (yield* orchestrator.getThreadProjection(parentThreadId)).messages.some(
            (message) => message.id === lateNotice.messageId,
          ),
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `delegated-question-${interruptsTools}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
