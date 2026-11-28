import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Tells a task's owner when the task's message is held in its child's queue. Nothing releases it
 * on its own: a person's send or Resume does, and so does a later run that completes there, such
 * as one an agent starts with a restart send (Orchestrator `releaseUnattendedHolds`). Without this
 * notice the owner waits on an `idle` task forever.
 */
export class DelegatedTaskHoldReactor extends Context.Service<
  DelegatedTaskHoldReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskHoldReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeOwner = Effect.fnUntraced(function* (task: OrchestrationV2Subagent) {
    const childThreadId = task.childThreadId;
    if (childThreadId === null) return;
    const { runs } = yield* projections.getThreadRecords(childThreadId, ["runs"], {
      runStatuses: ["queued"],
    });
    const held = runs.find((run) => run.delegatedTaskId === task.id && run.queueHeld === true);
    if (held === undefined) return;
    const { messages } = yield* projections.getThreadRecords(childThreadId, ["messages"], {
      messageIds: [held.userMessageId],
      messageRoles: ["user"],
    });
    // An owner that sent into an already-held queue read so in its send receipt.
    const createdHeld =
      DateTime.toEpochMillis(task.startedAt ?? task.updatedAt) ===
      DateTime.toEpochMillis(task.updatedAt);
    if (createdHeld && messages[0]?.senderThreadId === task.threadId) return;
    const owner = yield* projections.getThread(task.threadId);
    if (owner.archivedAt !== null || owner.deletedAt !== null) return;
    // One notice per hold; the orchestrator drops it once the run is no longer held.
    const key = `${task.id}:${held.id}:${DateTime.toEpochMillis(task.updatedAt)}`;
    const label = reportLabel(task.title?.trim() || task.prompt);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-held:${key}`),
      threadId: task.threadId,
      messageId: MessageId.make(`message:delegated-task-held:${key}`),
      text: `Delegated task ${task.id} has not run: its message is held in the queue of thread ${childThreadId}. T3 holds a thread's queue when the thread is stopped (task_cancel on another of its tasks stops it too) or its provider fails. A person's message or Resume in that thread releases it. You can release it too: a t3_thread_send with mode "restart" to that thread runs ahead of the hold, and once that run completes the held agent messages follow, unless a person's own message is also held there. If the task is no longer needed, cancel it with task_cancel; otherwise restart the thread or tell the user it is waiting.`,
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} is held`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const handle: DelegatedTaskHoldReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "subagent.updated") return;
      const task = event.payload;
      if (
        task.origin !== "app_owned" ||
        task.status !== "idle" ||
        task.result !== null ||
        task.completionDelivery?.state === "disposed"
      )
        return;
      yield* wakeOwner(task);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telling the owner of a held delegated task failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskHoldReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskHoldReactor.start",
  )(function* () {
    // Keyed by owner, so a busy owner's lock delays only its own wakes.
    const ownerReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "subagent.updated"
          ? ownerReactions.run(event.payload.threadId, handle(event))
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task hold event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies DelegatedTaskHoldReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskHoldReactor, make);
