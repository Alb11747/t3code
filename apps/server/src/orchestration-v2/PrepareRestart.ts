import {
  DEFAULT_PREPARE_RESTART_MARGIN_MS,
  type OrchestrationV2RunStatus,
  type PrepareRestartInput,
  type PrepareRestartResult,
  type PrepareRestartSentEntry,
  type PrepareRestartSentStatus,
  type PrepareRestartSkippedEntry,
  type PrepareRestartSkipReason,
  type RunId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

const PREPARE_RESTART_EVALUATE_CONCURRENCY = 4;
const PREPARE_RESTART_DISPATCH_CONCURRENCY = 3;

export class PrepareRestartError extends Schema.TaggedError<PrepareRestartError>()(
  "PrepareRestartError",
  {
    stage: Schema.Literals(["list_candidates", "list_scheduled_tasks"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare restart (${this.stage}).`;
  }
}

export type ClaudeIdleEvaluation =
  | {
      readonly kind: "skip";
      readonly reason: Exclude<PrepareRestartSkipReason, "budget_exhausted">;
    }
  | { readonly kind: "sleep"; readonly runId: RunId; readonly sleepMs: number }
  | { readonly kind: "dispatch"; readonly runId: RunId; readonly endMs: number };

type TerminalRunStatus = Exclude<PrepareRestartSentStatus, "pending">;

function terminalRunStatusOf(status: OrchestrationV2RunStatus): TerminalRunStatus | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return status;
    default:
      return undefined;
  }
}

export interface PrepareRestartDependencies<EvalError, DispatchError> {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly scheduledTasks: ScheduledTaskService["Service"];
  readonly evaluateClaude: (
    threadId: ThreadId,
    initialRunId: RunId | undefined,
    options?: {
      readonly horizonMs?: number;
      readonly tasks?: ReadonlyArray<ScheduledTask>;
    },
  ) => Effect.Effect<ClaudeIdleEvaluation, EvalError>;
  readonly dispatchClaude: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, DispatchError>;
}

export function makePrepareRestart<EvalError, DispatchError>(
  deps: PrepareRestartDependencies<EvalError, DispatchError>,
) {
  const { orchestrator, projections, scheduledTasks, evaluateClaude, dispatchClaude } = deps;

  return Effect.fn("IdleCompactionService.prepareRestart")(function* (
    input: PrepareRestartInput,
  ): Effect.fn.Return<PrepareRestartResult, PrepareRestartError> {
    const startNowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const marginMs = input.marginMs ?? DEFAULT_PREPARE_RESTART_MARGIN_MS;
    const horizonMs = startNowMs + input.downtimeMs + marginMs;

    const skipped: Array<PrepareRestartSkippedEntry> = [];
    const eligible: Array<{
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly endMs: number;
    }> = [];
    const sentOrder: Array<RunId> = [];
    const sentByRun = new Map<RunId, PrepareRestartSentEntry>();
    const dispatchSkipped: Array<PrepareRestartSkippedEntry> = [];
    let unscanned: ReadonlyArray<ThreadId> = [];

    const readProjectedTerminal = (threadId: ThreadId, runId: RunId) =>
      projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
        Effect.map((records) => {
          const run = records.runs.find((item) => item.id === runId);
          return run === undefined ? undefined : terminalRunStatusOf(run.status);
        }),
        Effect.orElseSucceed(() => undefined),
      );

    const runCandidate = Effect.fnUntraced(function* (candidate: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const { threadId, runId } = candidate;
      // Recheck fresh right before dispatching, reusing the known runId to avoid a double read.
      const fresh = yield* evaluateClaude(threadId, runId, { horizonMs }).pipe(Effect.result);
      if (Result.isFailure(fresh)) {
        yield* Effect.logWarning("prepare-restart recheck failed", {
          threadId,
          cause: fresh.failure,
        });
        dispatchSkipped.push({ threadId, reason: "not_eligible" });
        return;
      }
      if (fresh.success.kind !== "dispatch") {
        dispatchSkipped.push({
          threadId,
          reason: fresh.success.kind === "skip" ? fresh.success.reason : "outside_window",
        });
        return;
      }

      const dispatched = yield* dispatchClaude(threadId, fresh.success.runId).pipe(Effect.result);
      if (Result.isFailure(dispatched)) {
        yield* Effect.logWarning("prepare-restart compaction dispatch failed", {
          threadId,
          cause: dispatched.failure,
        });
        dispatchSkipped.push({ threadId, reason: "not_eligible" });
        return;
      }

      const runCreated = dispatched.success.storedEvents.find(
        (stored) => stored.event.type === "run.created",
      );
      if (runCreated === undefined || runCreated.event.type !== "run.created") {
        dispatchSkipped.push({ threadId, reason: "not_eligible" });
        return;
      }

      const createdRunId = runCreated.event.payload.id;
      sentOrder.push(createdRunId);
      sentByRun.set(createdRunId, { threadId, runId: createdRunId, status: "pending" });

      const immediateTerminal = dispatched.success.storedEvents.reduce<
        TerminalRunStatus | undefined
      >((acc, stored) => {
        if (stored.event.type !== "run.updated" || stored.event.payload.id !== createdRunId) {
          return acc;
        }
        return terminalRunStatusOf(stored.event.payload.status) ?? acc;
      }, undefined);
      if (immediateTerminal !== undefined) {
        sentByRun.set(createdRunId, { threadId, runId: createdRunId, status: immediateTerminal });
        return;
      }

      // EventSink.stream subscribes before reading highWater and replays everything after
      // dispatched.sequence, so a terminal run.updated that landed immediately cannot be missed.
      const terminal = yield* orchestrator
        .streamStoredEventsFrom({
          threadId,
          eventType: "run.updated",
          afterSequence: dispatched.success.sequence,
        })
        .pipe(
          Stream.filterMap((stored) => {
            if (stored.event.type !== "run.updated" || stored.event.payload.id !== createdRunId) {
              return Result.failVoid;
            }
            const status = terminalRunStatusOf(stored.event.payload.status);
            return status === undefined ? Result.failVoid : Result.succeed(status);
          }),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.catch((cause) =>
            Effect.logWarning("prepare-restart run stream failed; checking projection", {
              threadId,
              runId: createdRunId,
              cause,
            }).pipe(Effect.andThen(readProjectedTerminal(threadId, createdRunId))),
          ),
        );
      if (terminal !== undefined) {
        sentByRun.set(createdRunId, { threadId, runId: createdRunId, status: terminal });
      }
    });

    // Bound both the pre-dispatch scan and dispatch/wait phase by the single budget deadline.
    const completed = yield* Effect.gen(function* () {
      const candidateThreadIds = yield* projections
        .getRecoveryThreadIds("idle-compactions")
        .pipe(
          Effect.mapError((cause) => new PrepareRestartError({ stage: "list_candidates", cause })),
        );
      unscanned = candidateThreadIds;
      if (candidateThreadIds.length === 0) return;

      const { tasks } = yield* scheduledTasks
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new PrepareRestartError({ stage: "list_scheduled_tasks", cause }),
          ),
        );

      const initialScan = yield* Effect.forEach(
        candidateThreadIds,
        (threadId) =>
          evaluateClaude(threadId, undefined, { horizonMs, tasks }).pipe(
            Effect.result,
            Effect.map((evaluation) => ({ threadId, evaluation })),
          ),
        { concurrency: PREPARE_RESTART_EVALUATE_CONCURRENCY },
      );

      for (const { threadId, evaluation } of initialScan) {
        if (Result.isFailure(evaluation)) {
          yield* Effect.logWarning("prepare-restart could not evaluate thread", {
            threadId,
            cause: evaluation.failure,
          });
          skipped.push({ threadId, reason: "not_eligible" });
          continue;
        }
        if (evaluation.success.kind === "dispatch") {
          eligible.push({
            threadId,
            runId: evaluation.success.runId,
            endMs: evaluation.success.endMs,
          });
        } else if (evaluation.success.kind === "skip") {
          skipped.push({ threadId, reason: evaluation.success.reason });
        }
      }
      unscanned = [];
      eligible.sort((left, right) => left.endMs - right.endMs);
      if (eligible.length === 0) return;

      yield* Effect.forEach(eligible, runCandidate, {
        concurrency: PREPARE_RESTART_DISPATCH_CONCURRENCY,
        discard: true,
      });
    }).pipe(Effect.timeoutOption(Duration.millis(input.budgetMs)));

    const timedOut = Option.isNone(completed);
    const sent = sentOrder.map((runId) => sentByRun.get(runId)!);
    const accountedThreads = new Set<ThreadId>([
      ...skipped.map((entry) => entry.threadId),
      ...sent.map((entry) => entry.threadId),
      ...dispatchSkipped.map((entry) => entry.threadId),
    ]);
    const remaining = unscanned.length > 0 ? unscanned : eligible.map(({ threadId }) => threadId);
    const budgetExhausted: Array<PrepareRestartSkippedEntry> = remaining
      .filter((threadId) => !accountedThreads.has(threadId))
      .map((threadId) => ({ threadId, reason: "budget_exhausted" }));

    return {
      sent,
      skipped: [...skipped, ...dispatchSkipped, ...budgetExhausted],
      timedOut,
    };
  });
}
