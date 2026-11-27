import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

export const DEFAULT_PREPARE_RESTART_DOWNTIME_MS = 10 * 60_000;
export const DEFAULT_PREPARE_RESTART_MARGIN_MS = 30 * 60_000;
export const DEFAULT_PREPARE_RESTART_BUDGET_MS = 90_000;

export const PrepareRestartInput = Schema.Struct({
  downtimeMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  marginMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  budgetMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PrepareRestartInput = typeof PrepareRestartInput.Type;

export const PrepareRestartSentStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
  "pending",
]);
export type PrepareRestartSentStatus = typeof PrepareRestartSentStatus.Type;

export const PrepareRestartSentEntry = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  status: PrepareRestartSentStatus,
});
export type PrepareRestartSentEntry = typeof PrepareRestartSentEntry.Type;

export const PrepareRestartSkipReason = Schema.Literals([
  "outside_window",
  "snoozed",
  "busy",
  "not_eligible",
  "budget_exhausted",
]);
export type PrepareRestartSkipReason = typeof PrepareRestartSkipReason.Type;

export const PrepareRestartSkippedEntry = Schema.Struct({
  threadId: ThreadId,
  reason: PrepareRestartSkipReason,
});
export type PrepareRestartSkippedEntry = typeof PrepareRestartSkippedEntry.Type;

export const PrepareRestartResult = Schema.Struct({
  sent: Schema.Array(PrepareRestartSentEntry),
  skipped: Schema.Array(PrepareRestartSkippedEntry),
  timedOut: Schema.Boolean,
});
export type PrepareRestartResult = typeof PrepareRestartResult.Type;
