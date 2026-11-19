import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  parseGoalCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

/** `boundaryMessageIds` marks steers waiting for a tool boundary; like Auto, they stop at a fresh context. */
export function queuedSteeringRunIds(
  runs: ReadonlyArray<OrchestrationV2Run>,
  boundaryMessageIds: ReadonlySet<string> = new Set(),
) {
  const firstFreshPosition = Math.min(
    ...runs
      .filter((run) => run.status === "queued" && run.freshContext === true)
      .map((run) => run.queuePosition ?? run.ordinal),
  );
  return new Set(
    runs
      .filter(
        (run) =>
          run.status === "queued" &&
          (run.deliveryIntent === "steer" ||
            ((run.deliveryIntent === "auto" || boundaryMessageIds.has(run.userMessageId)) &&
              (run.queuePosition ?? run.ordinal) < firstFreshPosition)),
      )
      .map((run) => run.id),
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const goalMessageIds = new Set(
    projection.messages
      .filter((message) => parseGoalCommand(message) !== null)
      .map((message) => message.id),
  );
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const steeringRunIds = queuedSteeringRunIds(projection.runs);
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  const completions = queued.filter((run) => automaticCompletionMessageIds.has(run.userMessageId));
  // A steer that missed its tool boundary leads the other messages but keeps request order with
  // completions, so a notice committed first still reaches the same boundary first.
  const boundarySteerIds = queuedSteeringRunIds(
    queued,
    new Set(
      projection.messages
        .filter(
          (message) => message.atToolBoundary === true && message.delegatedCompletion === undefined,
        )
        .map((message) => message.id),
    ),
  );
  const messages = queued
    .filter((run) => !automaticCompletionMessageIds.has(run.userMessageId))
    .toSorted(
      (left, right) =>
        Number(boundarySteerIds.has(right.id)) - Number(boundarySteerIds.has(left.id)),
    );
  // Completions and messages each keep their queue order and interleave by request time,
  // so neither kind can hold the other back while more of it keeps arriving.
  const ordered: Array<OrchestrationV2Run> = [];
  let completionIndex = 0;
  let messageIndex = 0;
  for (;;) {
    const completion = completions[completionIndex];
    const message = messages[messageIndex];
    if (completion === undefined || message === undefined) {
      return withCompactionFollowUpsNext(
        projection.runs,
        [
          ...ordered,
          ...completions.slice(completionIndex),
          ...messages.slice(messageIndex),
        ].toSorted((left, right) => {
          const commandPriority =
            Number(right.queuePosition === 1 && goalMessageIds.has(right.userMessageId)) -
            Number(left.queuePosition === 1 && goalMessageIds.has(left.userMessageId));
          return (
            commandPriority ||
            Number(steeringRunIds.has(right.id)) - Number(steeringRunIds.has(left.id))
          );
        }),
      );
    }
    const completionAt = DateTime.toEpochMillis(completion.requestedAt);
    const messageAt = DateTime.toEpochMillis(message.requestedAt);
    // Same-millisecond requests follow commit order.
    if (
      completionAt < messageAt ||
      (completionAt === messageAt && completion.ordinal < message.ordinal)
    ) {
      ordered.push(completion);
      completionIndex += 1;
    } else {
      ordered.push(message);
      messageIndex += 1;
    }
  }
}

/**
 * A message sent with a compaction is the first turn after it: it follows its queued compaction
 * directly, or leads the queue once that compaction has started. Nothing else, however urgent,
 * runs in between. A follow-up whose compaction failed is held and loses this place.
 */
function withCompactionFollowUpsNext(
  runs: ReadonlyArray<OrchestrationV2Run>,
  sorted: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  const compactionOf = (run: OrchestrationV2Run) =>
    runs.find((candidate) => candidate.userMessageId === run.afterCompactionMessageId);
  const followUps = sorted.filter(
    (run) =>
      run.afterCompactionMessageId !== undefined &&
      run.queueHeld !== true &&
      !ENDED_WITHOUT_COMPACTING.has(compactionOf(run)?.status ?? "queued"),
  );
  if (followUps.length === 0) return sorted;
  const rest = sorted.filter((run) => !followUps.includes(run));
  const ordered = followUps.filter((run) => compactionOf(run)?.status !== "queued");
  for (const run of rest) {
    ordered.push(
      run,
      ...followUps.filter((followUp) => followUp.afterCompactionMessageId === run.userMessageId),
    );
  }
  return ordered;
}

const ENDED_WITHOUT_COMPACTING = new Set<OrchestrationV2Run["status"]>([
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
