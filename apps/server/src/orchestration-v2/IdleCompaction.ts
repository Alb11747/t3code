import {
  CodexSettings,
  isCompactionCommandMessage,
  MessageId,
  pendingGuestMessageCount,
  resolveProjectProviderInstanceEnabled,
  TIMED_IDLE_COMPACTION_MESSAGE_PREFIX,
  type RunId,
  type ServerSettings,
  type ThreadId,
  type IdleCompactionMode,
  type IdleCompactionTier,
  type IdleCompactionTierName,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
 * How an idle thread qualifies to compact before its cache expires: "tiers" by its reuse tier, or
 * "forced" by its own setting. An applicable one-shot mark counts as "always" in any mode but off.
 */
export function idleCompactionScope(
  mode: IdleCompactionMode,
  threadOverride: boolean | null | undefined,
  compactOnce = false,
): "forced" | "tiers" | null {
  if (mode === "off" || threadOverride === false) return null;
  if (threadOverride === true || compactOnce) return "forced";
  return mode === "beforeCacheExpires" ? "tiers" : null;
}

const idleCompactionTierCompacts = (tier: IdleCompactionTier, usedTokens: number) =>
  tier.enabled && usedTokens >= tier.minTokens;

/**
 * Whether the window's thread compacts. A forced thread uses the waiting minimum, since its own
 * setting says it will be back. `isWaiting` runs only when sync signals leave the tier open and it
 * changes the outcome, because it reads more history.
 */
export function idleCompactionCompacts<E, R>(
  scope: "forced" | "tiers",
  tiers: Record<IdleCompactionTierName, IdleCompactionTier>,
  window: {
    readonly usedTokens: number;
    readonly settled: boolean;
    readonly hasWakeSignal: boolean;
  },
  isWaiting: Effect.Effect<boolean, E, R>,
): Effect.Effect<boolean, E, R> {
  const waiting = idleCompactionTierCompacts(tiers.waiting, window.usedTokens);
  if (scope === "forced") return Effect.succeed(window.usedTokens >= tiers.waiting.minTokens);
  if (window.hasWakeSignal) return Effect.succeed(waiting);
  const rest = idleCompactionTierCompacts(
    window.settled ? tiers.settled : tiers.open,
    window.usedTokens,
  );
  if (waiting === rest) return Effect.succeed(rest);
  return Effect.map(isWaiting, (isWaitingThread) => (isWaitingThread ? waiting : rest));
}

export interface IdleCompactionPolicy {
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
  const snoozeEndMs =
    thread.snoozedUntil == null ? null : DateTime.toEpochMillis(thread.snoozedUntil);
  const snoozed = snoozeEndMs !== null && snoozeEndMs > nowMs;
  // Fork: delegated tasks are subagents with their own Claude session and are resumed later, so
  // they compact like listed threads. A native subagent has no session of its own and is skipped
  // by the session check below.
  if (thread.lineage.sideChat === true || thread.lineage.workflowStep === true) return null;
  // A removed or steered queued message leaves a cancelled run that never started.
  const latestRun = runs
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  // Fork: a stopped turn leaves its prompt cache as warm as a finished one.
  if (
    (latestRun?.status !== "completed" && latestRun?.status !== "interrupted") ||
    latestRun.completedAt === null
  )
    return null;
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
  const usedTokens = usages[0]?.usedTokens ?? 0;
  // A request served fully from cache creates no cache entry and reports no
  // TTL, but it still refreshes the cache. Treat it as unknown and skip.
  const expiresAt = usages[0]?.promptCacheExpiresAt;
  const endMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (!Number.isFinite(endMs) || nowMs >= endMs) return null;
  // Fork: a snooze's end starts no turn, so a thread unsnoozed before its cache expires is an
  // ordinary idle thread by then. With snoozed threads off, it must end before compaction starts.
  const snoozeHoldsMs = snoozed && !policy.compactSnoozed ? snoozeEndMs : null;
  if (snoozeHoldsMs !== null && snoozeHoldsMs >= endMs - LEAD_MS) return null;
  const wakesMs = policy.scheduledWakesMs;
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
  const delegated = thread.lineage.relationshipToParent === "subagent";
  // Fork: a delegated task waiting on its own background work has not reported yet, and a /compact
  // now would become the run its parent reads the result from.
  if (delegated && backgroundWorkHoldsCompletion(backgroundWork)) return null;
  return {
    runId: latestRun.id,
    startMs: endMs - LEAD_MS,
    endMs,
    usedTokens,
    // Fork: subagents never settle, so a delegated task its parent never resumed counts as settled.
    settled:
      thread.settledAt !== null ||
      thread.settledOverride === "settled" ||
      (delegated && latestRun.ordinal === 1),
    hasWakeSignal:
      wakesMs.length > 0 ||
      // The user means to come back to a snoozed thread.
      snoozed ||
      pendingGuestMessageCount(thread.guestShare) > 0 ||
      runtimeRequests.some(isPendingMessageUserInput) ||
      backgroundWorkHoldsCompletion(backgroundWork) ||
      backgroundWork.some(isPullRequestWatchTask),
  };
}

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export function codexIdleCompactionPolicy(
  settings: ServerSettings,
  thread: IdleCompactionRecords["thread"],
) {
  const instanceId = thread.providerInstanceId;
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  if (
    (instance?.driver ?? instanceId) !== "codex" ||
    !resolveProjectProviderInstanceEnabled(settings, thread.projectId, instanceId)
  )
    return null;
  const config = Option.getOrUndefined(decodeCodexSettings(instance?.config ?? {}));
  if (config === undefined) return null;
  const enabled = thread.compactAfterIdle ?? config.idleCompactionEnabled ?? false;
  return enabled
    ? {
        delayMs: (config.idleCompactionMinutes ?? 20) * 60_000,
        minTokens: config.idleCompactionMinTokens ?? 120_000,
      }
    : null;
}

export const idleCompactionMessageId = (threadId: ThreadId, runId: RunId) =>
  MessageId.make(`${TIMED_IDLE_COMPACTION_MESSAGE_PREFIX}${threadId}:${runId}`);

export const lastStartedOrPendingRun = (runs: IdleCompactionRecords["runs"]) =>
  runs.reduce<(typeof runs)[number] | undefined>(
    (latest, run) =>
      (run.status !== "cancelled" || run.startedAt !== null) &&
      (latest === undefined || run.ordinal > latest.ordinal)
        ? run
        : latest,
    undefined,
  );

export function codexIdleCompactionWindow(
  records: IdleCompactionRecords,
  policy: NonNullable<ReturnType<typeof codexIdleCompactionPolicy>>,
) {
  const { thread, runs, messages, providerThreads, providerTurns, turnItems } = records;
  if (thread.archivedAt !== null || thread.deletedAt !== null || thread.lineage.sideChat === true)
    return null;

  const run = lastStartedOrPendingRun(runs);
  if (
    run === undefined ||
    (run.status !== "completed" && run.status !== "interrupted") ||
    run.completedAt === null ||
    run.startedAt === null
  )
    return null;
  const message = messages.find((candidate) => candidate.id === run.userMessageId);
  if (message === undefined || isCompactionCommandMessage(message)) return null;

  const session = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (
    session?.driver !== "codex" ||
    session.nativeThreadRef?.nativeId == null ||
    session.id !== run.providerThreadId ||
    session.providerInstanceId !== thread.providerInstanceId ||
    run.providerInstanceId !== thread.providerInstanceId
  )
    return null;

  const pending = derivePendingBackgroundWork({
    latestRun: run,
    runs,
    providerThreads,
    turnItems,
    activeProviderThreadId: session.id,
  });
  const usage = providerTurns
    .filter((turn) => turn.providerThreadId === session.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (
    usage === undefined ||
    usage.usedTokens < policy.minTokens ||
    (run.status === "completed" &&
      Date.parse(usage.updatedAt) < DateTime.toEpochMillis(run.startedAt))
  )
    return null;

  return {
    runId: run.id,
    // The projection is touched when tracked work starts or ends, even between timer checks.
    idleAtMs: Math.max(
      DateTime.toEpochMillis(run.completedAt),
      DateTime.toEpochMillis(thread.updatedAt),
    ),
    blocked:
      pending.length > 0 ||
      hasBlockingIdleCompactionWork(records) ||
      records.runtimeRequests.some(isPendingMessageUserInput),
  };
}
