import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import { modelSelectionsEqual } from "./model.ts";
import { latestExecutedRun, latestRootProviderFailure } from "./orchestrationV2ThreadError.ts";
import { derivePendingBackgroundWork } from "./orchestrationV2PendingBackgroundWork.ts";

export function isClaudeThinkingPrefixMismatch(failure: OrchestrationV2ProviderFailure): boolean {
  return (
    (failure.class === "provider_error" ||
      failure.class === "validation_error" ||
      failure.class === "transport_error") &&
    (failure.code === null ||
      failure.code === "invalid_request" ||
      failure.code === "invalid_request_error" ||
      failure.code === "api_error_400") &&
    /Invalid [`']?signature[`']? in [`']?(?:thinking|redacted_thinking)[`']? block\./i.test(
      failure.message,
    ) &&
    /The block is bound to a different conversation\./i.test(failure.message)
  );
}

export function claudeThinkingRecoveryTarget(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    | "thread"
    | "runs"
    | "attempts"
    | "providerThreads"
    | "runtimeRequests"
    | "turnItems"
    | "subagents"
  >,
) {
  const { thread } = projection;
  const run = latestExecutedRun(projection.runs);
  const failure = latestRootProviderFailure(run, projection.turnItems);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run?.providerThreadId,
  );
  const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
  if (
    run?.status !== "failed" ||
    attempt?.status !== "failed" ||
    failure === null ||
    !isClaudeThinkingPrefixMismatch(failure) ||
    providerThread?.driver !== "claudeAgent" ||
    providerThread.ownerNodeId !== null ||
    providerThread.nativeThreadRef === null ||
    providerThread.providerSessionId === null ||
    thread.activeProviderThreadId !== providerThread.id ||
    thread.providerInstanceId !== run.providerInstanceId ||
    !modelSelectionsEqual(thread.modelSelection, run.modelSelection) ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    isProviderNativeSubagentThread(thread) ||
    projection.subagents.some(
      (subagent) =>
        subagent.status === "pending" ||
        subagent.status === "running" ||
        subagent.status === "waiting",
    ) ||
    derivePendingBackgroundWork({
      latestRun: run,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
      runs: projection.runs,
    }).length > 0 ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return null;
  return { runId: run.id, attemptId: attempt.id };
}

/** Whether the attempt that failed at `nodeId` was followed by a retry that dropped its thinking. */
export function retriedWithDroppedThinking(
  attempts: ReadonlyArray<OrchestrationV2RunAttempt>,
  runId: RunId,
  nodeId: NodeId | null,
): boolean {
  const failed = attempts.find(
    (attempt) => attempt.runId === runId && attempt.rootNodeId === nodeId,
  );
  return (
    failed !== undefined &&
    attempts.some(
      (attempt) =>
        attempt.runId === runId &&
        attempt.attemptOrdinal === failed.attemptOrdinal + 1 &&
        attempt.recovery === "drop_thinking",
    )
  );
}
