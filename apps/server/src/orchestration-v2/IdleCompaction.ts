import {
  DEFAULT_IDLE_COMPACTION_MIN_TOKENS,
  isListedThreadLineage,
  pendingGuestMessageCount,
  type IdleCompactionMode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import { isActiveRun } from "./CommandPolicy.ts";

// Start this long before the cache expires: enough for the session to resume
// and send the compaction while the cache is still warm.
const LEAD_MS = 2 * 60_000;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * A one-shot mark covers the idle spell after the run it was set in. Any run that starts
 * after it (a reply, a queued message, the compaction itself) makes it stale.
 */
export function compactOnceApplies(
  requestedAt: string | null | undefined,
  runs: ReadonlyArray<{ readonly startedAt: DateTime.Utc | null }>,
): boolean {
  if (requestedAt == null) return false;
  const requestedMs = Date.parse(requestedAt);
  return !runs.some(
    (run) => run.startedAt !== null && DateTime.toEpochMillis(run.startedAt) > requestedMs,
  );
}

/**
 * Which idle threads compact before their cache expires. "waiting" (Smart) takes only
 * threads something will wake after the cache expires; a thread's own setting wins, and an
 * applicable one-shot mark counts as "always" in any mode but off.
 */
export function idleCompactionScope(
  mode: IdleCompactionMode,
  smart: boolean,
  threadOverride: boolean | null | undefined,
  compactOnce = false,
): "all" | "waiting" | null {
  if (mode === "off" || threadOverride === false) return null;
  if (threadOverride === true || compactOnce) return "all";
  if (mode !== "beforeCacheExpires") return null;
  return smart ? "waiting" : "all";
}

export interface IdleCompactionPolicy {
  readonly minTokens?: number | undefined;
  readonly compactSnoozed: boolean;
  /** When scheduled tasks will next send to this thread. */
  readonly scheduledWakesMs: ReadonlyArray<number>;
}

const DEFAULT_POLICY: IdleCompactionPolicy = {
  compactSnoozed: false,
  scheduledWakesMs: [],
};

export function isPendingMessageUserInput(request: OrchestrationV2RuntimeRequest): boolean {
  return (
    request.status === "pending" &&
    request.kind === "user_input" &&
    request.responseCapability.type === "message"
  );
}

export function hasBlockingIdleCompactionWork({
  runs,
  runtimeRequests,
  contextTransfers,
  thread,
}: Pick<
  IdleCompactionRecords,
  "runs" | "runtimeRequests" | "contextTransfers" | "thread"
>): boolean {
  return (
    // A secret card is only answerable while its run is live, including checkpoint wait.
    runs.some((run) => run.status === "queued" || isActiveRun(run)) ||
    runtimeRequests.some(
      (request) => request.status === "pending" && !isPendingMessageUserInput(request),
    ) ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  );
}

/**
 * When an idle Claude thread should compact, or null when it should not. The
 * window ends when the prompt cache of Claude's last request expires (1h on
 * subscriptions, 5m on API keys); compacting after that pays a full uncached
 * read.
 */
export function idleCompactionWindow(
  records: IdleCompactionRecords,
  nowMs: number,
  policy: IdleCompactionPolicy = DEFAULT_POLICY,
) {
  const { thread, runs, messages, providerThreads, providerTurns, runtimeRequests, turnItems } =
    records;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  const snoozeEndMs =
    thread.snoozedUntil == null ? null : DateTime.toEpochMillis(thread.snoozedUntil);
  const snoozed = snoozeEndMs !== null && snoozeEndMs > nowMs;
  if (snoozed && !policy.compactSnoozed) return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  // A removed or steered queued message leaves a cancelled run that never started.
  const latestRun = runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || message.text.trim().toLowerCase() === "/compact") return null;
  if (hasBlockingIdleCompactionWork(records)) return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this Claude session.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const minTokens = policy.minTokens ?? DEFAULT_IDLE_COMPACTION_MIN_TOKENS;
  if ((usages[0]?.usedTokens ?? 0) < minTokens) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  const wakesMs = [...policy.scheduledWakesMs, ...(snoozed ? [snoozeEndMs] : [])];
  // A wake before the cache expires reuses it, and its own run schedules the next check.
  if (wakesMs.some((wakeMs) => wakeMs < endMs)) return null;
  const backgroundWork = derivePendingBackgroundWork({
    latestRun,
    runs,
    providerThreads,
    turnItems,
    activeProviderThreadId: thread.activeProviderThreadId,
    pullRequests: thread.pullRequests,
    issueWatches: thread.issueWatches,
  });
  return {
    runId: latestRun.id,
    startMs: endMs - LEAD_MS,
    endMs,
    hasWakeSignal:
      wakesMs.length > 0 ||
      pendingGuestMessageCount(thread.guestShare) > 0 ||
      runtimeRequests.some(isPendingMessageUserInput) ||
      backgroundWorkHoldsCompletion(backgroundWork) ||
      backgroundWork.some(isPullRequestWatchTask),
  };
}
