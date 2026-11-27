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
  type PrepareRestartInput,
  type PrepareRestartResult,
  type PrepareRestartSkipReason,
  type ProviderInstanceId,
  type ProviderThreadId,
  type RunId,
  type ScheduledTask,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  codexIdleCompactionPolicy,
  codexIdleCompactionWindow,
  compactOnceApplies,
  hasBlockingIdleCompactionWork,
  idleCompactionCompacts,
  idleCompactionMessageId,
  idleCompactionScope,
  idleCompactionWindow,
  isPendingMessageUserInput,
  lastStartedOrPendingRun,
} from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  makePrepareRestart,
  type ClaudeIdleEvaluation,
  type PrepareRestartError,
} from "./PrepareRestart.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class IdleCompactionService extends Context.Service<
  IdleCompactionService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly prepareRestart: (
      input: PrepareRestartInput,
    ) => Effect.Effect<PrepareRestartResult, PrepareRestartError>;
  }
>()("t3/orchestration-v2/IdleCompactionService") {}

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
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService;
  // A null clock keeps a blocked candidate subscribed until its pending work changes.
  const codexClocks = new Map<
    ThreadId,
    { readonly runId: RunId; readonly sinceMs: number } | null
  >();

  const isClaudeInstance = (current: ServerSettings, providerInstanceId: ProviderInstanceId) =>
    Object.hasOwn(current.providerInstances, providerInstanceId)
      ? current.providerInstances[providerInstanceId]?.driver === "claudeAgent"
      : providerInstanceId === "claudeAgent";

  const scopeOf = (
    current: ServerSettings,
    selected: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly compactBeforeCacheExpires?: boolean | null | undefined;
    },
    compactOnce: boolean,
  ) =>
    idleCompactionScope(
      resolveIdleCompaction(current, selected.providerInstanceId),
      selected.compactBeforeCacheExpires,
      compactOnce,
    );

  const loadRecords = Effect.fn("IdleCompactionService.loadRecords")(function* (
    threadId: ThreadId,
    activeProviderThreadId: ProviderThreadId | null,
    runId: RunId | undefined,
  ) {
    const activeProviderThreadIds = activeProviderThreadId === null ? [] : [activeProviderThreadId];
    return yield* projections.getThreadRecords(
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
  });

  const evaluateClaude = Effect.fn("IdleCompactionService.evaluateClaude")(function* (
    threadId: ThreadId,
    initialRunId: RunId | undefined,
    options?: {
      readonly horizonMs?: number;
      readonly tasks?: ReadonlyArray<ScheduledTask>;
    },
  ) {
    const skip = (
      reason: Exclude<PrepareRestartSkipReason, "budget_exhausted">,
    ): ClaudeIdleEvaluation => ({ kind: "skip", reason });

    let runId = initialRunId;
    while (true) {
      const current = yield* settings.getSettings;
      const thread = yield* projections.getThread(threadId);
      const claudeInstance = isClaudeInstance(current, thread.providerInstanceId);
      // Staleness needs the runs, so any mark passes this pre-filter.
      const likelyScope = scopeOf(current, thread, thread.compactOnceRequestedAt != null);
      if (
        !claudeInstance ||
        likelyScope === null ||
        (likelyScope === "tiers" &&
          !Object.values(idleCompactionTiersOf(current)).some((tier) => tier.enabled)) ||
        !resolveProjectProviderInstanceEnabled(current, thread.projectId, thread.providerInstanceId)
      ) {
        return skip("not_eligible");
      }

      const records = yield* loadRecords(threadId, thread.activeProviderThreadId, runId);
      if (
        !resolveProjectProviderInstanceEnabled(
          current,
          records.thread.projectId,
          records.thread.providerInstanceId,
        )
      ) {
        return skip("not_eligible");
      }
      if (hasBlockingIdleCompactionWork(records)) return skip("busy");

      const latestRun = lastStartedOrPendingRun(records.runs);
      if (
        latestRun === undefined ||
        latestRun.completedAt === null ||
        (latestRun.status !== "completed" && latestRun.status !== "interrupted")
      ) {
        return skip("not_eligible");
      }
      if (latestRun.id !== runId) {
        runId = latestRun.id;
        continue;
      }

      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const scope = scopeOf(
        current,
        records.thread,
        compactOnceApplies(records.thread.compactOnceRequestedAt, records.runs),
      );
      if (scope === null) return skip("not_eligible");

      const compactSnoozed = compactSnoozedThreadsOf(current);
      if (records.thread.deletedAt !== null || records.thread.archivedAt !== null) {
        return skip("not_eligible");
      }
      // Pulling a snoozed thread forward while still snoozed would bypass compactSnoozed=false,
      // which normally relies on sleeping until window.startMs after the snooze ends.
      if (
        options?.horizonMs !== undefined &&
        !compactSnoozed &&
        records.thread.snoozedUntil != null &&
        DateTime.toEpochMillis(records.thread.snoozedUntil) > nowMs
      ) {
        return skip("snoozed");
      }

      const tasks = options?.tasks ?? (yield* scheduledTasks.list()).tasks;
      const wakes = tasks.filter(
        (task) => task.threadId === threadId && task.enabled && task.blockedByPolicy === undefined,
      );
      const window = idleCompactionWindow(records, nowMs, {
        compactSnoozed,
        scheduledWakesMs: wakes.flatMap((task) =>
          task.nextRunAt === null ? [] : [Date.parse(task.nextRunAt)],
        ),
      });
      if (window === null || window.runId !== runId) return skip("not_eligible");

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
      if (!compacts) return skip("not_eligible");

      if (nowMs >= window.startMs) {
        return { kind: "dispatch" as const, runId, endMs: window.endMs };
      }
      if (options?.horizonMs !== undefined) {
        return window.endMs <= options.horizonMs
          ? { kind: "dispatch" as const, runId, endMs: window.endMs }
          : skip("outside_window");
      }
      return { kind: "sleep" as const, runId, sleepMs: window.startMs - nowMs };
    }
  });

  const dispatchClaude = Effect.fn("IdleCompactionService.dispatchClaude")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      // One compaction per completed run, even across duplicate events.
      commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
      messageId: MessageId.make(`idle-compact:${threadId}:${runId}`),
      threadId,
      text: IDLE_COMPACTION_TEXT,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      idleCompaction: "beforeCacheExpires",
      dispatchMode: { type: "start_immediately" },
    });
  });

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    // Without a run, takes the latest completed run.
    function* (threadId: ThreadId, completedRunId: RunId | undefined) {
      let runId = completedRunId;
      // Loops after the wait or a retarget: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const codexPolicy = codexIdleCompactionPolicy(current, thread);
        if (codexPolicy === null) {
          codexClocks.delete(threadId);
          const decision = yield* evaluateClaude(threadId, runId);
          if (decision.kind === "skip") return;
          if (decision.kind === "sleep") {
            runId = decision.runId;
            yield* Effect.sleep(Duration.millis(decision.sleepMs));
            continue;
          }
          yield* dispatchClaude(threadId, decision.runId);
          return;
        }
        const records = yield* loadRecords(threadId, thread.activeProviderThreadId, runId);
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
        if (
          latestRun === undefined ||
          latestRun.completedAt === null ||
          (latestRun.status !== "completed" && latestRun.status !== "interrupted")
        ) {
          if (codexClocks.has(threadId)) codexClocks.set(threadId, null);
          return;
        }
        if (latestRun.id !== runId) {
          runId = latestRun.id;
          continue;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
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
        const startMs = Math.max(idleSinceMs, window.idleAtMs) + policy.delayMs;
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
          idleSinceMs,
          dispatchMode: { type: "start_immediately" },
        });
        codexClocks.delete(threadId);
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
        if (
          event.type === "run.updated" &&
          (event.payload.status === "completed" || event.payload.status === "interrupted")
        )
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
          canAddIdleWake(event) ||
          // Fork: a queued run or a blocking request held the check, and its end rearms nothing.
          (event.type === "run.updated" && event.payload.status === "cancelled") ||
          (event.type === "runtime-request.updated" && event.payload.status !== "pending")
        )
          return recheck(event.threadId);
        return Effect.void;
      }),
    );
    // Fork: timers live in memory, so after a restart every thread whose cache can still be warm
    // gets its check again; without it each restart let those caches expire uncompacted.
    yield* projections.getRecoveryThreadIds("idle-compactions").pipe(
      Effect.flatMap((threadIds) => Effect.forEach(threadIds, recheck, { discard: true })),
      Effect.catch((cause) =>
        Effect.logWarning("idle compaction could not resume timers after start", { cause }),
      ),
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

  const prepareRestart = makePrepareRestart({
    orchestrator,
    projections,
    scheduledTasks,
    evaluateClaude,
    dispatchClaude,
  });

  return IdleCompactionService.of({ start, prepareRestart });
});

export const layer = Layer.effect(IdleCompactionService, make);
