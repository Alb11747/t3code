import {
  CommandId,
  compactSnoozedThreadsOf,
  IDLE_COMPACTION_TEXT,
  idleCompactionTiersOf,
  MessageId,
  pendingGuestMessageCount,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  codexIdleCompactionPolicy,
  codexIdleCompactionWindow,
  compactOnceApplies,
  EARLY_IDLE_COMPACTION_MESSAGE_PREFIX,
  idleCompactionCompacts,
  idleCompactionMessageId,
  idleCompactionScope,
  idleCompactionWindow,
  isPendingMessageUserInput,
  lastStartedOrPendingRun,
} from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const EARLY_IDLE_MS = 5 * 60_000;

function canAddIdleWake(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "thread.guest-share-updated":
      return pendingGuestMessageCount(event.payload.guestShare) > 0;
    case "runtime-request.updated":
      return isPendingMessageUserInput(event.payload);
    case "plan.updated":
      return event.payload.kind === "proposed_plan" && event.payload.status === "active";
    default:
      return false;
  }
}

function canChangeCodexIdleWork(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "provider-thread.updated":
    case "runtime-request.updated":
    case "subagent.updated":
    case "context-transfer.updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
      return true;
    case "run.created":
    case "run.updated":
      return event.payload.status !== "completed";
    case "turn-item.updated":
      return (
        event.payload.type === "command_execution" ||
        event.payload.type === "dynamic_tool" ||
        event.payload.type === "subagent"
      );
    default:
      return false;
  }
}

/**
 * Schedules a visible `/compact` turn by Claude cache expiry or elapsed Codex idle time.
 * Timers live in memory and are rearmed by thread events.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService;
  // A null clock keeps a blocked candidate subscribed until its pending work changes.
  const codexClocks = new Map<
    ThreadId,
    { readonly runId: RunId; readonly sinceMs: number } | null
  >();

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    // Without a run, takes the latest completed run.
    function* (threadId: ThreadId, completedRunId: RunId | undefined) {
      let runId = completedRunId;
      let checkedEarlyRunId: RunId | undefined;
      // Loops after the wait or a retarget: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const claudeInstance = Object.hasOwn(current.providerInstances, thread.providerInstanceId)
          ? current.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
          : thread.providerInstanceId === "claudeAgent";
        const scopeOf = (selected: typeof thread, compactOnce: boolean) =>
          idleCompactionScope(
            resolveIdleCompaction(current, selected.providerInstanceId),
            selected.compactBeforeCacheExpires,
            compactOnce,
          );
        // Staleness needs the runs, so any mark passes this pre-filter.
        const likelyScope = scopeOf(thread, thread.compactOnceRequestedAt != null);
        const codexPolicy = codexIdleCompactionPolicy(current, thread);
        if (
          codexPolicy === null &&
          (!claudeInstance ||
            likelyScope === null ||
            (likelyScope === "tiers" &&
              !Object.values(idleCompactionTiersOf(current)).some((tier) => tier.enabled)) ||
            !resolveProjectProviderInstanceEnabled(
              current,
              thread.projectId,
              thread.providerInstanceId,
            ))
        ) {
          codexClocks.delete(threadId);
          return;
        }
        const activeProviderThreadIds =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          [
            "runs",
            "messages",
            "providerThreads",
            "providerTurns",
            "runtimeRequests",
            "turnItems",
            "contextTransfers",
          ],
          {
            messageRunIds: runId === undefined ? [] : [runId],
            turnItemStatuses: ["pending", "running", "waiting"],
            // Include older runs that can still block compaction, and rolled-back runs whose
            // background items should be ignored.
            runStatuses: ["queued", "preparing", "starting", "running", "waiting", "rolled_back"],
            includeLatestRun: true,
            // Without an active provider thread there is no session to compact.
            providerThreadIds: activeProviderThreadIds,
            providerTurnThreadIds: activeProviderThreadIds,
            latestProviderTurnUsageOnly: true,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        if (
          !resolveProjectProviderInstanceEnabled(
            current,
            records.thread.projectId,
            records.thread.providerInstanceId,
          )
        )
          return;
        const latestRun = lastStartedOrPendingRun(records.runs);
        // A late update for an earlier run replaced the latest run's timer, so take it over.
        if (latestRun?.status !== "completed" || latestRun.completedAt === null) {
          if (codexClocks.has(threadId)) codexClocks.set(threadId, null);
          return;
        }
        if (latestRun.id !== runId) {
          runId = latestRun.id;
          continue;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (codexPolicy !== null) {
          const policy = codexIdleCompactionPolicy(current, records.thread);
          const window = policy === null ? null : codexIdleCompactionWindow(records, policy);
          if (window === null || policy === null) {
            codexClocks.delete(threadId);
            return;
          }
          if (window.blocked) {
            codexClocks.set(threadId, null);
            return;
          }
          const clock = codexClocks.get(threadId);
          const idleSinceMs = clock?.runId === runId ? clock.sinceMs : nowMs;
          codexClocks.set(threadId, { runId, sinceMs: idleSinceMs });
          const startMs = idleSinceMs + policy.delayMs;
          if (nowMs < startMs) {
            yield* Effect.sleep(Duration.millis(startMs - nowMs));
            continue;
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}:${idleSinceMs}`),
            messageId: idleCompactionMessageId(threadId, runId),
            threadId,
            text: IDLE_COMPACTION_TEXT,
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            idleCompaction: "afterIdle",
            idleSinceMs,
            dispatchMode: { type: "start_immediately" },
          });
          codexClocks.delete(threadId);
          return;
        }
        const { tasks } = yield* scheduledTasks.list();
        const wakes = tasks.filter(
          (task) =>
            task.threadId === threadId && task.enabled && task.blockedByPolicy === undefined,
        );
        const earlyAttempt = records.messages.some(
          (message) =>
            message.id === latestRun.userMessageId &&
            message.id.startsWith(EARLY_IDLE_COMPACTION_MESSAGE_PREFIX),
        );
        const compaction = earlyAttempt
          ? yield* projections.getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: [latestRun.id],
              turnItemTypes: ["compaction"],
              turnItemStatuses: ["cancelled"],
            })
          : null;
        const window = idleCompactionWindow(
          compaction === null
            ? records
            : { ...records, turnItems: [...records.turnItems, ...compaction.turnItems] },
          nowMs,
          {
            compactSnoozed: compactSnoozedThreadsOf(current),
            scheduledWakesMs: wakes.flatMap((task) =>
              task.nextRunAt === null ? [] : [Date.parse(task.nextRunAt)],
            ),
          },
        );
        if (window === null || window.runId !== runId) return;
        const scope = scopeOf(
          records.thread,
          compactOnceApplies(
            records.thread.compactOnceRequestedAt,
            window.retryingEarlySkip
              ? records.runs.filter((run) => run.id !== runId)
              : records.runs,
          ),
        );
        if (scope === null) return;
        const compacts = yield* idleCompactionCompacts(
          scope,
          idleCompactionTiersOf(current),
          {
            ...window,
            hasWakeSignal:
              window.hasWakeSignal || wakes.some((task) => task.schedule.type === "webhook"),
          },
          projections.hasIdleCompactionWait(threadId),
        );
        if (!compacts) return;
        let expedite = false;
        if (nowMs < window.startMs) {
          const session = records.providerThreads.find(
            (candidate) => candidate.id === records.thread.activeProviderThreadId,
          )?.nativeThreadRef;
          const earlyAt = DateTime.toEpochMillis(latestRun.completedAt) + EARLY_IDLE_MS;
          if (
            session?.strength === "strong" &&
            session.nativeId !== null &&
            !window.retryingEarlySkip &&
            earlyAt < window.startMs &&
            checkedEarlyRunId !== runId &&
            orchestrator.shouldExpediteIdleCompaction !== undefined
          ) {
            if (nowMs < earlyAt) {
              yield* Effect.sleep(Duration.millis(earlyAt - nowMs));
              continue;
            }
            checkedEarlyRunId = runId;
            expedite = yield* orchestrator.shouldExpediteIdleCompaction(
              records.thread,
              session.nativeId,
              DateTime.formatIso(DateTime.makeUnsafe(window.startMs)),
            );
          }
          if (!expedite) {
            yield* Effect.sleep(Duration.millis(window.startMs - nowMs));
            continue;
          }
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          // One compaction per completed run, even across duplicate events.
          commandId: CommandId.make(
            `server:${expedite ? "idle-compact-early" : "idle-compact"}:${threadId}:${runId}`,
          ),
          messageId: MessageId.make(
            `${expedite ? EARLY_IDLE_COMPACTION_MESSAGE_PREFIX : "idle-compact:"}${threadId}:${runId}`,
          ),
          threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          idleCompaction: "beforeCacheExpires",
          dispatchMode: { type: "start_immediately" },
        });
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => {
          codexClocks.delete(threadId);
          return Effect.logWarning("idle compaction skipped", { threadId, cause });
        }),
      ),
  );

  const start = Effect.fn("IdleCompactionService.start")(function* () {
    // Keyed by thread: a newer completed run replaces the waiting timer.
    const timers = yield* FiberMap.make<ThreadId>();
    // A wake may appear after the run completed. Rechecks replace the thread's timer rather
    // than defer to it, so a change seen mid-check is never dropped; checks are idempotent.
    const recheck = (threadId: ThreadId) =>
      FiberMap.run(timers, threadId, compactWhenDue(threadId, undefined));
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (codexClocks.has(event.threadId) && canChangeCodexIdleWork(event)) {
          codexClocks.set(event.threadId, null);
          return recheck(event.threadId);
        }
        if (event.type === "run.updated" && event.payload.status === "completed")
          return FiberMap.run(
            timers,
            event.threadId,
            compactWhenDue(event.threadId, event.payload.id),
          );
        if (
          event.type === "thread.metadata-updated" ||
          event.type === "thread.snoozed" ||
          event.type === "thread.settled" ||
          event.type === "thread.unsettled" ||
          event.type === "thread.pull-request-link-updated" ||
          (event.type === "thread.pull-request-synced" &&
            event.payload.pullRequests?.some((pr) => pr.watch !== undefined) === true) ||
          canAddIdleWake(event)
        )
          return recheck(event.threadId);
        return Effect.void;
      }),
    );
    // Removing or retargeting a task can make its former thread eligible, so recheck both lists.
    let boundThreadIds = new Set<ThreadId>();
    yield* forkParked(
      Stream.runForEach(scheduledTasks.subscribeList(), ({ tasks }) => {
        const previous = boundThreadIds;
        boundThreadIds = new Set(
          tasks.flatMap((task) => (task.threadId === null ? [] : [task.threadId])),
        );
        return Effect.forEach(new Set([...previous, ...boundThreadIds]), recheck, {
          discard: true,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("idle compaction lost scheduled task updates; resubscribing", {
            cause,
          }),
        ),
        Effect.andThen(Effect.sleep(Duration.minutes(1))),
        Effect.forever,
      ),
    );
  });
  return { start };
});
