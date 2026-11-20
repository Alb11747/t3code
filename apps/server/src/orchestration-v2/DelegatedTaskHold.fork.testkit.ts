import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type NodeId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DelegatedTaskHoldReactor from "./DelegatedTaskHoldReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** Seeds a parent whose delegated child has finished its original task. */
export type SeedFinishedChild<E, R> = (
  name: string,
  options: { readonly parentBusy: boolean },
) => Effect.Effect<{ readonly parentThreadId: ThreadId; readonly childThreadId: ThreadId }, E, R>;

const waitForTask = (afterSequence: number, taskId: NodeId, status: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const stored = yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runHead,
    );
    return Option.getOrThrow(stored) satisfies OrchestrationV2StoredEvent;
  });

// A client (no sender thread) sends a follow-up that queues behind the child's running turn;
// Stop on the child, as task_cancel on another of its tasks does, then holds it.
const holdClientFollowUp = <E, R>(
  seed: SeedFinishedChild<E, R>,
  name: string,
  options: { readonly parentBusy: boolean },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const { parentThreadId, childThreadId } = yield* seed(name, options);
    yield* orchestrator.recoverDelegatedTasks;
    const send = (text: string, senderThreadId?: ThreadId) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make(`command:${name}:${text}`),
        threadId: childThreadId,
        ...(senderThreadId === undefined ? {} : { senderThreadId }),
        messageId: MessageId.make(`message:${name}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
    yield* send("active", parentThreadId);
    yield* send("from-client");
    const before = yield* orchestrator.getThreadProjection(childThreadId);
    const active = before.runs.find((run) => run.ordinal === 2)!;
    const queued = before.runs.find((run) => run.ordinal === 3)!;
    assert.equal(queued.status, "queued");
    const taskId = queued.delegatedTaskId!;
    const stopSequence = yield* eventSink.latestSequence();
    yield* orchestrator.dispatch({
      type: "thread.stop",
      threadId: childThreadId,
      commandId: CommandId.make(`command:${name}:stop`),
    });
    const held = yield* waitForTask(stopSequence, taskId, "idle");
    return { parentThreadId, childThreadId, active, queued, taskId, held };
  });

const heldWakes = (projection: Pick<OrchestrationV2ThreadProjection, "messages">, taskId: NodeId) =>
  projection.messages.filter(
    (message) =>
      message.notification?.source.kind === "delegated_task" &&
      message.notification.source.taskIds.includes(taskId),
  );

export const verifyHeldFollowUpWakesOwner = <E, R>(seed: SeedFinishedChild<E, R>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const reactor = yield* DelegatedTaskHoldReactor.DelegatedTaskHoldReactor;
    const { parentThreadId, childThreadId, taskId, held } = yield* holdClientFollowUp(
      seed,
      "held-client-followup",
      { parentBusy: true },
    );
    yield* reactor.handle(held.event);
    // A repeated update for the same hold sends nothing more.
    yield* reactor.handle(held.event);
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const wakes = heldWakes(parent, taskId);
    assert.equal(wakes.length, 1);
    assert.include(wakes[0]!.text, `queue of thread ${childThreadId}`);
    assert.include(wakes[0]!.text, "task_cancel");
    const wakeRun = parent.runs.find((run) => run.userMessageId === wakes[0]!.id)!;
    assert.equal(wakeRun.status, "queued");

    // A person resumes the child, so when the owner's turn ends the notice no longer holds.
    yield* orchestrator.dispatch({
      type: "queue.resume",
      threadId: childThreadId,
      commandId: CommandId.make("command:held-client-followup:resume"),
    });
    const ownerRun = parent.runs.find((run) => run.status === "running")!;
    const now = yield* DateTime.now;
    const endedSequence = yield* eventSink.latestSequence();
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:held-client-followup-owner-ended"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: ownerRun.id,
          occurredAt: now,
          payload: { ...ownerRun, status: "completed", completedAt: now },
        },
      ],
    });
    yield* eventSink.stream({ afterSequence: endedSequence, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === wakeRun.id &&
          stored.event.payload.status === "cancelled",
      ),
      Stream.take(1),
      Stream.runDrain,
    );
  }).pipe(
    // As server.ts wires it.
    Effect.provide(DelegatedTaskHoldReactor.layer.pipe(Layer.provide(ProjectionStore.layer))),
  );

export const verifySettledFollowUpSaysUnread = <E, R>(seed: SeedFinishedChild<E, R>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { parentThreadId, childThreadId, active, taskId } = yield* holdClientFollowUp(
      seed,
      "settled-client-followup",
      { parentBusy: false },
    );
    const endedSequence = yield* eventSink.latestSequence();
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:settled-client-followup-active-ended"),
          type: "run.updated",
          threadId: childThreadId,
          runId: active.id,
          occurredAt: now,
          payload: { ...active, status: "interrupted", startedAt: now, completedAt: now },
        },
      ],
    });
    const activeTask = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
      (row) => row.id === active.delegatedTaskId,
    )!;
    if (activeTask.result === null) {
      yield* waitForTask(endedSequence, active.delegatedTaskId!, "interrupted");
    }
    const settleSequence = yield* eventSink.latestSequence();
    yield* orchestrator.dispatch({
      type: "thread.settle",
      threadId: childThreadId,
      commandId: CommandId.make("command:settled-client-followup:settle"),
    });
    yield* waitForTask(settleSequence, taskId, "cancelled");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
      (row) => row.id === taskId,
    )!;
    assert.equal(
      task.result,
      "The child never read this message: it was cancelled before its run started, while held in the child's queue, when the child's thread settled. Send it again if it is still needed.",
    );
  });
