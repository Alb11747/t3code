import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** The usage windows "Snooze until usage resets" offers one option each for. */
export const UsageResetWindowKind = Schema.Literals(["session", "weekly"]);
export type UsageResetWindowKind = typeof UsageResetWindowKind.Type;

/**
 * `modelSelection` is the thread's. Without `window`, the reset after which the thread's account
 * has quota again; with it, that window's reset on the account the thread last used.
 */
export const UsageResetSnoozeInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  window: Schema.optional(UsageResetWindowKind),
});
export type UsageResetSnoozeInput = typeof UsageResetSnoozeInput.Type;

/**
 * `account`: the instance's own subscription. `router`: the account a CLIProxyAPI quota router
 * reports it will route this thread to. `soonest`: the earliest reset across the hub's accounts,
 * for hubs that cannot say which account they will choose.
 */
export const UsageResetSnoozeBasis = Schema.Literals(["account", "router", "soonest"]);
export type UsageResetSnoozeBasis = typeof UsageResetSnoozeBasis.Type;

export const UsageResetSnooze = Schema.Struct({
  resetsAt: IsoDateTime,
  basis: UsageResetSnoozeBasis,
  accountLabel: Schema.optional(TrimmedNonEmptyString),
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
