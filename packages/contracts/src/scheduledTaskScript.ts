import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ScheduledTaskId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Fork: a JavaScript check that runs on the server before each scheduled, manual or webhook run
 * of a task. It can skip the run, replace the prompt or model, move the next run, and keep JSON state.
 */
export const MAX_SCHEDULED_TASK_SCRIPT_CHARS = 32_000;
export const MAX_SCHEDULED_TASK_SCRIPT_STATE_CHARS = 16_000;

export const ScheduledTaskScriptSource = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SCHEDULED_TASK_SCRIPT_CHARS),
);

export const ScheduledTaskScriptOutcome = Schema.Literals(["run", "skip", "error"]);
export type ScheduledTaskScriptOutcome = typeof ScheduledTaskScriptOutcome.Type;

export const ScheduledTaskScriptCheck = Schema.Struct({
  at: IsoDateTime,
  // Any string, so an outcome added later doesn't hide a client's whole task.
  outcome: Schema.Union([ScheduledTaskScriptOutcome, Schema.String]),
  /** The script's `reason`, or why it failed. */
  message: Schema.NullOr(Schema.String),
  /** Console output, truncated. */
  logs: Schema.String,
  durationMs: Schema.Number,
});
export type ScheduledTaskScriptCheck = typeof ScheduledTaskScriptCheck.Type;

export const ScheduledTaskScript = Schema.Struct({
  source: Schema.String,
  /** The persisted `ctx.state` as JSON text, or null before the first save. */
  state: Schema.NullOr(Schema.String),
  lastCheck: Schema.NullOr(ScheduledTaskScriptCheck),
});
export type ScheduledTaskScript = typeof ScheduledTaskScript.Type;

/** What a check decided, as a dry run reports it. */
export const ScheduledTaskScriptDecision = Schema.Struct({
  run: Schema.Boolean,
  prompt: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(IsoDateTime),
  reason: Schema.NullOr(Schema.String),
  /** The state the run would save, as JSON text. */
  state: Schema.NullOr(Schema.String),
  /** The model the script chose for this run, checked against the server's providers. */
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type ScheduledTaskScriptDecision = typeof ScheduledTaskScriptDecision.Type;

export const ScheduledTaskTestScriptInput = Schema.Struct({
  source: ScheduledTaskScriptSource,
  /** An existing task supplies its state, schedule, run history and bound thread. */
  id: Schema.optional(ScheduledTaskId),
  prompt: Schema.optional(Schema.String),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** The editor's model, which a script's bare model slug is resolved against. */
  modelSelection: Schema.optional(ModelSelection),
});
export type ScheduledTaskTestScriptInput = typeof ScheduledTaskTestScriptInput.Type;

export const ScheduledTaskTestScriptResult = Schema.Struct({
  outcome: Schema.Union([ScheduledTaskScriptOutcome, Schema.String]),
  decision: Schema.NullOr(ScheduledTaskScriptDecision),
  error: Schema.NullOr(Schema.String),
  logs: Schema.String,
  durationMs: Schema.Number,
  /** The `ctx` the script received, as JSON text, so authors can see what is available. */
  context: Schema.String,
});
export type ScheduledTaskTestScriptResult = typeof ScheduledTaskTestScriptResult.Type;
