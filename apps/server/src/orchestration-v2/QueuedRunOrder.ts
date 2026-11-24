import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  parseGoalCommand,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import { hasClaudeSkillMention } from "../provider/Drivers/ClaudeSkillDispatch.ts";
import { ordinaryAgentReportText } from "./AgentMessageBatch.ts";

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
  const messages = queued.filter((run) => !automaticCompletionMessageIds.has(run.userMessageId));
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
        withBoundarySteersFirst(projection, queued, steeringRunIds, [
          ...ordered,
          ...completions.slice(completionIndex),
          ...messages.slice(messageIndex),
        ]).toSorted((left, right) => {
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

export function queuedAgentReportBatch(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  first: OrchestrationV2Run,
  message: OrchestrationV2ConversationMessage,
) {
  const firstReport = queuedAgentReportText(
    first.status === "queued" ? first : { ...first, startedAt: null },
    message,
  );
  if (
    firstReport === undefined ||
    !projection.runs.some((run) => run.id !== first.id && run.status === "queued")
  )
    return [];
  const ordered = queuedRunsInDeliveryOrder(projection);
  if (first.status === "queued" && ordered[0]?.id !== first.id) return [];

  const messages = new Map(projection.messages.map((row) => [row.id, row]));
  const members: Array<{ run: OrchestrationV2Run; message: OrchestrationV2ConversationMessage }> =
    [];
  let prompt = firstReport;
  for (const run of first.status === "queued" ? ordered.slice(1) : ordered) {
    if (
      run.providerThreadId !== first.providerThreadId ||
      !modelSelectionsEqual(run.modelSelection, first.modelSelection)
    )
      break;
    const member = messages.get(run.userMessageId);
    const report = queuedAgentReportText(run, member);
    // A pinned report can diverge from one that follows a later model change.
    if (
      member === undefined ||
      report === undefined ||
      (member.followsThreadSelection === true) !== (message.followsThreadSelection === true)
    )
      break;
    const candidate = `${prompt}\n\n${report}`;
    if (candidate.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) break;
    const expanded = projectComposerContextForProvider({ text: candidate, records: [] });
    if (expanded.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS || hasClaudeSkillMention(expanded))
      break;
    members.push({ run, message: member });
    prompt = candidate;
  }
  return members;
}

function queuedAgentReportText(
  run: OrchestrationV2Run,
  message: OrchestrationV2ConversationMessage | undefined,
) {
  if (
    message === undefined ||
    run.startedAt !== null ||
    run.queuedReportMessageIds !== undefined ||
    message.senderThreadId === run.threadId ||
    message.context !== undefined ||
    message.delegatedCompletion !== undefined ||
    message.notification !== undefined ||
    message.scheduledTaskId !== undefined ||
    message.idleCompaction !== undefined ||
    run.queueHeld === true ||
    run.boundaryOffer !== undefined ||
    run.afterCompactionMessageId !== undefined ||
    run.keepFullHistory === true ||
    run.freshContext === true ||
    run.outputSchema !== undefined ||
    run.delegatedTaskId !== undefined ||
    run.sourcePlanRef !== undefined ||
    run.workspacePreparation !== undefined ||
    run.manualContinuationOfRunId !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.usageLimitContinuationOfRunId !== undefined
  )
    return undefined;
  return ordinaryAgentReportText(message);
}

/**
 * A steer that missed its tool boundary moves ahead of the plain messages committed before it.
 * Completions keep their place, so one never passes a message committed before it. Like Auto, a
 * steer stops at a fresh context.
 */
function withBoundarySteersFirst(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  queued: ReadonlyArray<OrchestrationV2Run>,
  steeringRunIds: ReadonlySet<OrchestrationV2Run["id"]>,
  merged: ReadonlyArray<OrchestrationV2Run>,
): Array<OrchestrationV2Run> {
  const boundaryMessageIds = new Set(
    projection.messages
      .filter(
        (message) => message.atToolBoundary === true && message.delegatedCompletion === undefined,
      )
      .map((message) => message.id),
  );
  const completionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const boundarySteerIds = queuedSteeringRunIds(queued, boundaryMessageIds);
  const result: Array<OrchestrationV2Run> = [];
  let firstPlain = -1;
  for (const run of merged) {
    if (boundarySteerIds.has(run.id) && !steeringRunIds.has(run.id)) {
      if (firstPlain === -1) result.push(run);
      else result.splice(firstPlain++, 0, run);
      continue;
    }
    if (
      firstPlain === -1 &&
      !steeringRunIds.has(run.id) &&
      !completionMessageIds.has(run.userMessageId)
    )
      firstPlain = result.length;
    result.push(run);
  }
  return result;
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
