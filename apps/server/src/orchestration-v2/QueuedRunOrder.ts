import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  parseGoalCommand,
} from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedSteeringRunIds(runs: ReadonlyArray<OrchestrationV2Run>) {
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
            (run.deliveryIntent === "auto" &&
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
  const sorted = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const commandPriority =
        Number(right.queuePosition === 1 && goalMessageIds.has(right.userMessageId)) -
        Number(left.queuePosition === 1 && goalMessageIds.has(left.userMessageId));
      const steeringPriority =
        Number(steeringRunIds.has(right.id)) - Number(steeringRunIds.has(left.id));
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        commandPriority ||
        steeringPriority ||
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
  return withCompactionFollowUpsNext(projection.runs, sorted);
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
