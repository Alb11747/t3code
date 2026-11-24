import {
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { interactionModeRank, runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import type { EventSinkV2 } from "./EventSink.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export class SubagentReparentError extends Schema.TaggedError<SubagentReparentError>()(
  "SubagentReparentError",
  {
    reason: Schema.Literals(["invalid", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isSubagentReparentError = Schema.is(SubagentReparentError);
const invalid = (detail: string) => new SubagentReparentError({ reason: "invalid", detail });

export interface SubagentReparentResult {
  readonly previousParentThreadId: ThreadId;
  readonly taskIds: ReadonlyArray<NodeId>;
}

export interface SubagentReparentInput {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  /** The thread asking, which must be the child's current or new parent; none for a client. */
  readonly callerThreadId?: ThreadId | undefined;
}

// Deep enough for any real delegation chain; a longer walk means a broken lineage.
const MAX_LINEAGE_DEPTH = 64;

/**
 * Fork: moves an app-owned subagent thread (a delegated task's child) under another parent, so
 * its task records, completion wakes, follow-ups and sidebar place follow the new parent. The
 * orchestrator builds it with the same locks its dispatch takes.
 */
export const makeSubagentReparent = (deps: {
  readonly projections: ProjectionStoreV2["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
  /** Runs once the move commits and its locks are released, for the former parent. */
  readonly afterMove: (previousParentThreadId: ThreadId) => Effect.Effect<void>;
}) => {
  const { projections, eventSink, idAllocator, threadDispatch, afterMove } = deps;

  const ancestors = Effect.fn("SubagentReparent.ancestors")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    const chain: Array<ThreadId> = [];
    let parentId = thread.lineage.parentThreadId;
    while (parentId !== null) {
      if (chain.includes(parentId) || chain.length >= MAX_LINEAGE_DEPTH) {
        return yield* invalid("The new parent's lineage loops.");
      }
      chain.push(parentId);
      parentId = (yield* projections.findThread(parentId))?.lineage.parentThreadId ?? null;
    }
    return chain;
  });

  // Active threads below the child that share its root follow it to the new root, nearest first.
  // Archived ones keep the old root; ownership checks that compare roots then skip them.
  const descendantsSharingRoot = Effect.fn("SubagentReparent.descendantsSharingRoot")(function* (
    child: OrchestrationV2AppThread,
  ) {
    const index = yield* projections.listActiveShellIndex();
    const below: Array<ThreadId> = [];
    for (let level: ReadonlyArray<ThreadId> = [child.id]; level.length > 0;) {
      const next = index
        .filter(
          (entry) =>
            entry.lineage.parentThreadId !== null &&
            level.includes(entry.lineage.parentThreadId) &&
            !below.includes(entry.id),
        )
        .map((entry) => entry.id);
      below.push(...next);
      level = next;
    }
    return below.filter(
      (id) =>
        index.find((entry) => entry.id === id)?.lineage.rootThreadId === child.lineage.rootThreadId,
    );
  });

  /** Everything the move changes, read and checked under every lock it takes. */
  const plan = Effect.fn("SubagentReparent.plan")(function* (input: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly previousParentThreadId: ThreadId;
    readonly callerThreadId: ThreadId | undefined;
    readonly descendants: ReadonlyArray<ThreadId>;
  }) {
    const child = yield* projections.findThread(input.childThreadId);
    const parent = yield* projections.findThread(input.parentThreadId);
    if (child === null || child.deletedAt !== null) {
      return yield* invalid("The subagent thread was not found.");
    }
    if (parent === null || parent.deletedAt !== null || parent.archivedAt !== null) {
      return yield* invalid("The new parent thread was not found, or is archived.");
    }
    if (child.lineage.parentThreadId !== input.previousParentThreadId) {
      return yield* invalid("The subagent moved while this move was starting. Try again.");
    }
    // Checked here, against the lineage the move holds, so a parent that lost it cannot move it.
    if (
      input.callerThreadId !== undefined &&
      input.callerThreadId !== parent.id &&
      input.callerThreadId !== input.previousParentThreadId
    ) {
      return yield* invalid("Only the subagent's current or new parent thread can move it.");
    }
    // Stop and task_cancel check the parent's modes against the child's whole tree.
    if (
      runtimeModeRank(child.runtimeMode) > runtimeModeRank(parent.runtimeMode) ||
      interactionModeRank(child.interactionMode) > interactionModeRank(parent.interactionMode)
    ) {
      return yield* invalid("The new parent runs with narrower modes than the subagent.");
    }
    const { subagents } = yield* projections.getThreadRecords(
      input.previousParentThreadId,
      ["subagents"],
      { subagentChildThreadIds: [child.id] },
    );
    const tasks = subagents.filter(
      (task) => task.origin === "app_owned" && task.childThreadId === child.id,
    );
    if (tasks.length === 0) {
      return yield* invalid("The subagent's parent holds no task for it.");
    }
    if (tasks.some((task) => task.remoteChild !== undefined)) {
      return yield* invalid("A task running on a linked environment cannot move.");
    }
    // An unfinished follow-up is also `pending`; only a finished result waits on delivery.
    if (
      tasks.some(
        (task) =>
          task.completionDelivery?.state === "claimed" ||
          (task.completionDelivery?.state === "pending" && task.completedAt !== null),
      )
    ) {
      return yield* invalid(
        "The subagent's result is being delivered to its current parent. Try again after that turn.",
      );
    }
    const { runtimeRequests } = yield* projections.getThreadRecords(child.id, ["runtimeRequests"], {
      runtimeRequestStatuses: ["pending"],
    });
    if (runtimeRequests.some((request) => request.kind === "user_input")) {
      return yield* invalid(
        "The subagent is waiting on a question. Answer it with t3_pending_request on its thread, then move it.",
      );
    }
    // A question or hold notice about this child queued in the old parent would still run there.
    const unstarted = (yield* projections.getThreadRecords(input.previousParentThreadId, ["runs"], {
      runStatuses: ["preparing", "queued", "starting"],
    })).runs.filter(
      (run) => run.status === "preparing" || run.status === "queued" || run.status === "starting",
    );
    const notices =
      unstarted.length === 0
        ? []
        : (yield* projections.getThreadRecords(input.previousParentThreadId, ["messages"], {
            messageRoles: ["user"],
            messageRunIds: unstarted.map((run) => run.id),
          })).messages;
    if (
      notices.some(
        (message) =>
          message.notification?.source.kind === "delegated_task" &&
          message.notification.source.childThreadId === child.id,
      )
    ) {
      return yield* invalid(
        "A notice about the subagent is queued in its current parent. Move it after that notice runs, or cancel the notice with t3_queue.",
      );
    }
    // The wake for a later result joins the new parent's latest run, as if it had delegated there.
    const [latestRun] = (yield* projections.getThreadRecords(parent.id, ["runs"], {
      latestRunLimit: 1,
    })).runs.toSorted((left, right) => right.ordinal - left.ordinal);
    if (
      latestRun === undefined ||
      (latestRun.delegatedCompletion !== undefined &&
        latestRun.delegatedCompletion.disposition !== "open")
    ) {
      return yield* invalid(
        "The new parent has no turn that can receive the subagent's results. Send it a message first.",
      );
    }
    const taskIds = new Set<string>(tasks.map((task) => task.id));
    // Each task's card in the old parent: a node and a turn item that share its id.
    const { nodes, turnItems } = yield* projections.getThreadRecords(
      input.previousParentThreadId,
      ["nodes", "turnItems"],
      {
        nodeIds: tasks.map((task) => task.id),
        turnItemNodeIds: tasks.map((task) => task.id),
        turnItemTypes: ["subagent"],
      },
    );
    const now = yield* DateTime.now;
    const movedNote = `Moved to thread "${parent.title}" (${parent.id}).`;
    const rootThreadId = parent.lineage.rootThreadId;
    const reRooted =
      rootThreadId === child.lineage.rootThreadId
        ? []
        : yield* Effect.forEach(input.descendants, (threadId) => projections.findThread(threadId));
    const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [
      {
        type: "thread.metadata-updated",
        threadId: child.id,
        providerInstanceId: child.providerInstanceId,
        occurredAt: now,
        payload: {
          ...child,
          lineage: { ...child.lineage, parentThreadId: parent.id, rootThreadId },
          updatedAt: now,
        },
      },
      ...reRooted.flatMap((thread) =>
        thread === null || thread.lineage.rootThreadId !== child.lineage.rootThreadId
          ? []
          : [
              {
                type: "thread.metadata-updated" as const,
                threadId: thread.id,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...thread,
                  lineage: { ...thread.lineage, rootThreadId },
                  updatedAt: now,
                },
              },
            ],
      ),
      // Same ids: the child's `forkedFrom` and runs name these tasks. An unfinished task always
      // wakes its new parent: the blocking wait `settled_only` relies on stayed with the old one.
      ...tasks.map((task) => ({
        type: "subagent.updated" as const,
        threadId: parent.id,
        runId: latestRun.id,
        nodeId: task.id,
        driver: task.driver,
        occurredAt: now,
        payload: {
          ...task,
          threadId: parent.id,
          runId: latestRun.id,
          ...(task.completedAt === null
            ? {
                completionWake: "always" as const,
                // An old parent's Stop disposed of a wake its new parent still needs.
                ...(task.completionDelivery !== undefined &&
                task.completionDelivery.state !== "pending"
                  ? { completionDelivery: { state: "pending" as const, observedByRunId: null } }
                  : {}),
              }
            : {}),
          updatedAt: now,
        },
      })),
      // The old parent keeps its task cards as history; a running one would otherwise spin on.
      ...nodes
        .filter((node) => taskIds.has(node.id) && isOrchestrationV2WorkActive(node.status))
        .map((node) => ({
          type: "node.updated" as const,
          threadId: input.previousParentThreadId,
          ...(node.runId === null ? {} : { runId: node.runId }),
          nodeId: node.id,
          occurredAt: now,
          payload: { ...node, status: "interrupted" as const, completedAt: now },
        })),
      ...turnItems.flatMap((item) =>
        item.type === "subagent" &&
        taskIds.has(item.subagentId) &&
        isOrchestrationV2WorkActive(item.status)
          ? [
              {
                type: "turn-item.updated" as const,
                threadId: input.previousParentThreadId,
                ...(item.runId === null ? {} : { runId: item.runId }),
                ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
                occurredAt: now,
                payload: {
                  ...item,
                  status: "interrupted" as const,
                  result: movedNote,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ]
          : [],
      ),
    ];
    return { events, taskIds: tasks.map((task) => task.id) };
  });

  const depth = Effect.fn("SubagentReparent.depth")(function* (threadId: ThreadId) {
    const thread = yield* projections.findThread(threadId);
    return thread === null ? 0 : (yield* ancestors(thread)).length;
  });

  const locked = Effect.fn("SubagentReparent.locked")(function* (input: SubagentReparentInput) {
    const child = yield* projections.findThread(input.childThreadId);
    const parent = yield* projections.findThread(input.parentThreadId);
    if (child === null || child.deletedAt !== null) {
      return yield* invalid("The subagent thread was not found.");
    }
    if (parent === null || parent.deletedAt !== null) {
      return yield* invalid("The new parent thread was not found.");
    }
    const previousParentThreadId = child.lineage.parentThreadId;
    if (
      child.lineage.relationshipToParent !== "subagent" ||
      previousParentThreadId === null ||
      child.forkedFrom?.type !== "node" ||
      child.creationSource === "provider" ||
      child.delegatedFrom != null
    ) {
      return yield* invalid(
        "Only a delegated task's child thread on this environment can move. A provider's own subagent stays with the session that runs it.",
      );
    }
    if (previousParentThreadId === parent.id) {
      return { previousParentThreadId, taskIds: [] };
    }
    if (parent.projectId !== child.projectId) {
      return yield* invalid("The new parent must be in the subagent's project.");
    }
    const previousParent = yield* projections.findThread(previousParentThreadId);
    // Archive locks a parent's side chats in its own order, which ancestor-first cannot match.
    if (parent.lineage.sideChat === true || previousParent?.lineage.sideChat === true) {
      return yield* invalid("A subagent cannot move to or from a side chat.");
    }
    const parentAncestors = yield* ancestors(parent);
    if (parent.id === child.id || parentAncestors.includes(child.id)) {
      return yield* invalid("A thread cannot move under itself or its own subagent.");
    }
    // Only moves change lineage, and each holds the deletion lock, so this graph stays as read.
    // Every thread locks after its ancestors, as follow-up intake locks a parent before its
    // child, so a move cannot deadlock with intake, Stop or another move.
    const previousDepth = yield* depth(previousParentThreadId);
    const withLocks = <A, E, R>(
      locks: ReadonlyArray<{ readonly id: ThreadId; readonly depth: number }>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      locks
        .toSorted((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))
        .reduceRight((inner, { id }) => threadDispatch.withLock(id, inner), effect);
    // Descendants are listed under the child's lock, so none can be delegated in between.
    const commit = Effect.gen(function* () {
      const descendants = yield* descendantsSharingRoot(child);
      const depths = yield* Effect.forEach(descendants, (id) =>
        depth(id).pipe(Effect.map((depth) => ({ id, depth }))),
      );
      return yield* withLocks(
        depths,
        plan({
          childThreadId: child.id,
          parentThreadId: parent.id,
          previousParentThreadId,
          callerThreadId: input.callerThreadId,
          descendants,
        }).pipe(
          Effect.flatMap(({ events, taskIds }) =>
            Effect.forEach(events, (event) =>
              idAllocator.allocate
                .event({ threadId: event.threadId })
                .pipe(Effect.map((id) => ({ ...event, id }) as OrchestrationV2DomainEvent)),
            ).pipe(
              Effect.flatMap((withIds) =>
                eventSink.writeWithEffects({ events: withIds, effects: [] }),
              ),
              Effect.as({ previousParentThreadId, taskIds }),
            ),
          ),
        ),
      );
    });
    return yield* withLocks(
      [
        { id: previousParentThreadId, depth: previousDepth },
        { id: parent.id, depth: parentAncestors.length },
        { id: child.id, depth: previousDepth + 1 },
      ],
      commit,
    );
  });

  return Effect.fn("SubagentReparent.move")(
    function* (input: SubagentReparentInput) {
      const moved = yield* threadDispatch.withDeletionLock(locked(input));
      // The former parent may now have nothing left to wait on, as when its last task ends.
      if (moved.taskIds.length > 0) yield* afterMove(moved.previousParentThreadId);
      return moved;
    },
    Effect.mapError((cause): SubagentReparentError =>
      isSubagentReparentError(cause)
        ? cause
        : new SubagentReparentError({
            reason: "failed",
            detail: "The subagent could not be moved.",
            cause,
          }),
    ),
  );
};
