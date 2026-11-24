import { assert } from "@effect/vitest";
import { CommandId, EventId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { SeedFinishedChild } from "./DelegatedTaskHold.fork.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * A child whose run ended before its result reached a parent moves to a new coordinator; the
 * result, its wake and the task then belong to the new parent, and the old one hears nothing.
 */
export const verifyReparentedChildReportsToNewParent = <E, R>(seed: SeedFinishedChild<E, R>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { parentThreadId, childThreadId } = yield* seed("reparented-child", {
      parentBusy: false,
    });
    const previous = yield* orchestrator.getThreadProjection(parentThreadId);
    const task = previous.subagents.find((row) => row.childThreadId === childThreadId)!;
    const newParentThreadId = ThreadId.make("thread:reparented-child-new-parent");
    const newParentRunId = RunId.make("run:reparented-child-new-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:reparented-child:new-parent"),
      threadId: newParentThreadId,
      projectId: previous.thread.projectId,
      title: "New coordinator",
      modelSelection: previous.thread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const { delegatedCompletion: _cohort, ...previousRun } = previous.runs[0]!;
    yield* eventSink.write({
      // A reconcile write, so no run reaction races the move.
      commandId: CommandId.make("command:runtime-reconcile:reparented-child-new-parent"),
      events: [
        {
          id: EventId.make("event:reparented-child:new-parent-run"),
          type: "run.updated",
          threadId: newParentThreadId,
          runId: newParentRunId,
          occurredAt: now,
          payload: {
            ...previousRun,
            id: newParentRunId,
            threadId: newParentThreadId,
            providerThreadId: null,
            userMessageId: MessageId.make("message:reparented-child:new-parent"),
            rootNodeId: null,
            status: "completed",
            completedAt: now,
          },
        },
      ],
    });

    const refused = yield* Effect.flip(
      orchestrator.reparentSubagent({ childThreadId, parentThreadId: childThreadId }),
    );
    assert.equal(refused.reason, "invalid");
    const moved = yield* orchestrator.reparentSubagent({
      childThreadId,
      parentThreadId: newParentThreadId,
    });
    assert.deepEqual(moved, { previousParentThreadId: parentThreadId, taskIds: [task.id] });
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    assert.equal(child.thread.lineage.parentThreadId, newParentThreadId);
    assert.equal(child.thread.lineage.rootThreadId, newParentThreadId);
    assert.isUndefined(
      (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (row) => row.id === task.id,
      ),
    );

    // The former parent no longer owns the task, so its cancel stops nothing.
    const staleCancel = yield* Effect.flip(
      orchestrator.cancelDelegatedTask({
        parentThreadId,
        taskId: task.id,
        command: {
          type: "thread.stop",
          threadId: childThreadId,
          commandId: CommandId.make("command:reparented-child:stale-cancel"),
        },
        stopDescendants: () => Effect.void,
      }),
    );
    assert.equal(staleCancel._tag, "OrchestratorCommandRejectedError");

    yield* orchestrator.recoverDelegatedTasks;
    const adopted = yield* orchestrator.getThreadProjection(newParentThreadId);
    const adoptedTask = adopted.subagents.find((row) => row.id === task.id)!;
    assert.equal(adoptedTask.status, "completed");
    assert.equal(adoptedTask.runId, newParentRunId);
    assert.deepEqual(
      adopted.runs.find((run) => run.id === newParentRunId)?.delegatedCompletion?.delivery?.taskIds,
      [task.id],
    );
    const transfers = (yield* orchestrator.getThreadProjection(childThreadId)).contextTransfers;
    assert.deepEqual(
      transfers
        .filter((transfer) => transfer.type === "subagent_result")
        .map((transfer) => transfer.targetThreadId),
      [newParentThreadId],
    );
  });
