import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** The usage windows "Snooze until usage resets" offers one option each for. */
export const UsageResetWindowKind = Schema.Literals(["session", "weekly"]);
export type UsageResetWindowKind = typeof UsageResetWindowKind.Type;

/** `modelSelection` is the thread's. */
export const UsageResetSnoozeInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
});
export type UsageResetSnoozeInput = typeof UsageResetSnoozeInput.Type;

/**
 * `account`: the instance's own subscription. `router`: the account a CLIProxyAPI quota router
 * reports it will route this thread to. `soonest`: the earliest reset across the hub's accounts,
 * for hubs that cannot say which account they will choose.
 */
export const UsageResetSnoozeBasis = Schema.Literals(["account", "router", "soonest"]);
export type UsageResetSnoozeBasis = typeof UsageResetSnoozeBasis.Type;

/** When one window resets on the account the thread last used. */
export const UsageResetSnoozeWindow = Schema.Struct({
  window: UsageResetWindowKind,
  resetsAt: IsoDateTime,
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type UsageResetSnoozeWindow = typeof UsageResetSnoozeWindow.Type;

/**
 * `resetsAt`: when the thread's account has quota again. `windows`: each window's reset on the
 * account the thread last used, when the server knows that account; older servers omit it.
 */
export const UsageResetSnooze = Schema.Struct({
  resetsAt: IsoDateTime,
  basis: UsageResetSnoozeBasis,
  accountLabel: Schema.optional(TrimmedNonEmptyString),
  windows: Schema.optional(Schema.Array(UsageResetSnoozeWindow)),
});
export type UsageResetSnooze = typeof UsageResetSnooze.Type;

export class UsageResetSnoozeError extends Schema.TaggedError<UsageResetSnoozeError>()(
  "UsageResetSnoozeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
