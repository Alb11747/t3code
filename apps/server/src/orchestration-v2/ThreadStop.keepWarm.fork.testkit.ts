import { assert } from "@effect/vitest";
import { CommandId, EventId, ProviderTurnId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as ClaudeKeepWarmActions from "./ClaudeKeepWarmActions.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const verifyKeepWarmCompaction = Effect.fn("verifyKeepWarmCompaction")(function* (
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
  const parentRun = parent.runs[0]!;
  const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
  const task = parent.subagents.find((task) => task.childThreadId === childThreadId)!;
  const now = yield* DateTime.now;
  const providerTurnId = ProviderTurnId.make("keep-warm:turn");
  const attempt = parent.attempts.find((attempt) => attempt.id === parentRun.activeAttemptId)!;
  yield* store.apply({
    id: EventId.make("keep-warm:parent-attempt-running"),
    type: "run-attempt.updated",
    threadId: parentThreadId,
    occurredAt: now,
    payload: { ...attempt, status: "running" },
  });
  yield* store.apply({
    id: EventId.make("keep-warm:parent-running"),
    type: "run.updated",
    threadId: parentThreadId,
    occurredAt: now,
    payload: { ...parentRun, status: "running", startedAt: now },
  });
  yield* store.apply({
    id: EventId.make("keep-warm:parent-turn-running"),
    type: "provider-turn.updated",
    threadId: parentThreadId,
    occurredAt: now,
    payload: {
      id: providerTurnId,
      providerThreadId: parentRun.providerThreadId!,
      nodeId: parentRun.rootNodeId!,
      runAttemptId: parentRun.activeAttemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make("keep-warm:child-running"),
    type: "run.updated",
    threadId: childThreadId,
    occurredAt: now,
    payload: { ...childRun, status: "running", startedAt: now },
  });
  yield* store.apply({
    id: EventId.make("keep-warm:task-running"),
    type: "subagent.updated",
    threadId: parentThreadId,
    occurredAt: now,
    payload: { ...task, status: "running", updatedAt: now },
  });
  const taskItem = parent.turnItems.find(
    (item) => item.type === "subagent" && item.subagentId === task.id,
  )!;
  yield* store.apply({
    id: EventId.make("keep-warm:task-item-running"),
    type: "turn-item.updated",
    threadId: parentThreadId,
    occurredAt: now,
    payload: { ...taskItem, status: "running", updatedAt: now },
  });
  const turn = {
    threadId: parentThreadId,
    runId: parentRun.id,
    providerTurnId,
    session: "keep-warm:session",
    hold: { resetAt: "2026-11-04T02:00:00Z", releaseAt: "2026-11-04T01:59:00Z" },
  };
  const session: ClaudeKeepWarm.ClaudeKeepWarmSession = {
    turn: Effect.succeed(turn),
    show: () => Effect.void,
    restore: () => Effect.void,
    pause: () => Effect.die("Compaction must not pause until reset"),
  };
  const actions = yield* ClaudeKeepWarmActions.make.pipe(
    Effect.provideService(ClaudeKeepWarm.ClaudeKeepWarm, {
      register: () => Effect.void,
      find: () => Effect.succeed({ session, turn }),
      release: () => Effect.die("Compaction must read the warm account"),
    }),
  );
  yield* actions.run({ threadId: parentThreadId, action: "compact" });
  const stopped = yield* orchestrator.getThreadProjection(parentThreadId);
  assert.isTrue(
    stopped.turnItems.some(
      (item) => item.type === "run_interrupt_request" && item.preserveDelegatedTasks === true,
    ),
  );
  assert.equal(stopped.runs.find((run) => run.id === parentRun.id)?.status, "interrupted");
  assert.equal((yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.status, "running");
  assert.equal(stopped.subagents.find((row) => row.id === task.id)?.status, "running");
  assert.notEqual(
    stopped.subagents.find((row) => row.id === task.id)?.completionDelivery?.state,
    "disposed",
  );
  assert.equal(
    stopped.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion?.disposition,
    parentRun.delegatedCompletion?.disposition,
  );
  assert.equal(stopped.turnItems.find((item) => item.id === taskItem.id)?.status, "running");
  assert.isTrue(stopped.messages.some((message) => message.text === "/compact"));

  yield* orchestrator.dispatch({
    type: "thread.background-work.settle",
    commandId: CommandId.make("keep-warm:interrupt-acknowledged"),
    threadId: parentThreadId,
    providerThreadId: parentRun.providerThreadId!,
    providerTurnId,
  });
  assert.equal(
    (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.find(
      (item) => item.id === taskItem.id,
    )?.status,
    "running",
  );

  yield* store.apply({
    id: EventId.make("keep-warm:child-completed"),
    type: "run.updated",
    threadId: childThreadId,
    occurredAt: now,
    payload: { ...childRun, status: "completed", startedAt: now, completedAt: now },
  });
  yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: childRun.id });
  const finished = yield* orchestrator.getThreadProjection(parentThreadId);
  assert.equal(finished.subagents.find((row) => row.id === task.id)?.status, "completed");
  assert.notEqual(
    finished.subagents.find((row) => row.id === task.id)?.completionDelivery?.state,
    "disposed",
  );
  assert.isTrue(
    finished.runs
      .find((run) => run.id === parentRun.id)
      ?.delegatedCompletion?.delivery?.taskIds.includes(task.id),
  );
});
