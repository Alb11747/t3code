import {
  CommandId,
  compactSnoozedThreadsOf,
  smartIdleCompactionOf,
  IDLE_COMPACTION_TEXT,
  MessageId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
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
import { idleCompactionScope, idleCompactionWindow } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Beta: when a run completes on a Claude instance set to compact before the
 * cache expires (or a thread set to), waits until shortly before its prompt cache
 * expires and sends `/compact` as a visible T3 Code turn. Timers live in
 * memory, so a server restart skips compactions that were still waiting.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService;

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    // Without a run, takes the latest completed run.
    function* (threadId: ThreadId, completedRunId: RunId | undefined) {
      let runId = completedRunId;
      // Loops after the wait or a retarget: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const claudeInstance = Object.hasOwn(current.providerInstances, thread.providerInstanceId)
          ? current.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
          : thread.providerInstanceId === "claudeAgent";
        const scopeOf = (selected: typeof thread) =>
          idleCompactionScope(
            resolveIdleCompaction(current, selected.providerInstanceId),
            smartIdleCompactionOf(current),
            selected.compactBeforeCacheExpires,
          );
        if (
          !claudeInstance ||
          scopeOf(thread) === null ||
          !resolveProjectProviderInstanceEnabled(
            current,
            thread.projectId,
            thread.providerInstanceId,
          )
        )
          return;
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
            // The latest run, active runs that hold background work, and rolled-back runs whose
            // items it ignores.
            runStatuses: ["preparing", "starting", "running", "rolled_back"],
            includeLatestRun: true,
            // Without an active provider thread there is no session to compact.
            providerThreadIds: activeProviderThreadIds,
            providerTurnThreadIds: activeProviderThreadIds,
            latestProviderTurnUsageOnly: true,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        const scope = scopeOf(records.thread);
        if (
          scope === null ||
          !resolveProjectProviderInstanceEnabled(
            current,
            records.thread.projectId,
            records.thread.providerInstanceId,
          )
        )
          return;
        const latestRun = records.runs
          .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
          .reduce<(typeof records.runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          );
        // A late update for an earlier run replaced the latest run's timer, so take it over.
        if (latestRun?.status === "completed" && latestRun.id !== runId) {
          runId = latestRun.id;
          continue;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const { tasks } = yield* scheduledTasks.list();
        const window = idleCompactionWindow(records, nowMs, {
          scope,
          compactSnoozed: compactSnoozedThreadsOf(current),
          scheduledWakesMs: tasks.flatMap((task) =>
            task.threadId === threadId &&
            task.enabled &&
            task.blockedByPolicy === undefined &&
            task.nextRunAt !== null
              ? [Date.parse(task.nextRunAt)]
              : [],
          ),
        });
        if (window === null || window.runId !== runId) return;
        if (nowMs < window.startMs) {
          yield* Effect.sleep(Duration.millis(window.startMs - nowMs));
          continue;
        }
        yield* orchestrator.dispatch({
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
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("idle compaction skipped", { threadId, cause })),
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
        if (event.type === "run.updated" && event.payload.status === "completed")
          return FiberMap.run(
            timers,
            event.threadId,
            compactWhenDue(event.threadId, event.payload.id),
          );
        if (
          event.type === "thread.metadata-updated" ||
          event.type === "thread.snoozed" ||
          event.type === "thread.pull-request-link-updated"
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
