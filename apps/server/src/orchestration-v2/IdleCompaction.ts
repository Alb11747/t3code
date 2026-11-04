import {
  isListedThreadLineage,
  type IdleCompactionMode,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@t3tools/shared/claudeCompaction";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
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
 * Which idle threads compact before their cache expires. "waiting" (Smart) takes only
 * threads something will wake after the cache expires; a thread's own setting wins.
 */
export function idleCompactionScope(
  mode: IdleCompactionMode,
  smart: boolean,
  threadOverride: boolean | null | undefined,
): "all" | "waiting" | null {
  if (mode === "off" || threadOverride === false) return null;
  if (threadOverride === true) return "all";
  if (mode !== "beforeCacheExpires") return null;
  return smart ? "waiting" : "all";
}

export interface IdleCompactionPolicy {
  readonly scope: "all" | "waiting";
  readonly compactSnoozed: boolean;
  /** When scheduled tasks will next send to this thread. */
  readonly scheduledWakesMs: ReadonlyArray<number>;
}

const ALL_THREADS: IdleCompactionPolicy = {
  scope: "all",
  compactSnoozed: false,
  scheduledWakesMs: [],
};

/**
 * When an idle Claude thread should compact, or null when it should not. The
 * window ends when the prompt cache of Claude's last request expires (1h on
 * subscriptions, 5m on API keys); compacting after that pays a full uncached
 * read.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
  policy: IdleCompactionPolicy = ALL_THREADS,
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
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
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  )
    return null;
  // Watches and awaited work wake the thread later; their reports queue behind the compaction
  // turn. Smart compacts only threads with such a wake.
  const backgroundWork = derivePendingBackgroundWork({
    latestRun,
    runs,
    providerThreads,
    turnItems,
    activeProviderThreadId: thread.activeProviderThreadId,
    pullRequests: thread.pullRequests,
    issueWatches: thread.issueWatches,
  });
  const awaitedWork = backgroundWorkHoldsCompletion(backgroundWork);
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
  if ((usages[0]?.usedTokens ?? 0) < MIN_CONTEXT_TOKENS) return null;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  const wakesMs = [...policy.scheduledWakesMs, ...(snoozed ? [snoozeEndMs] : [])];
  // A wake before the cache expires reuses it, and its own run schedules the next check.
  if (wakesMs.some((wakeMs) => wakeMs < endMs)) return null;
  if (policy.scope === "waiting" && !awaitedWork && wakesMs.length === 0) return null;
  return { runId: latestRun.id, startMs: endMs - LEAD_MS, endMs };
}
