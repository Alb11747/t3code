import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** `modelSelection` is what the thread's next message would use: the composer's unsent choice, else the thread's. */
export const UsageResetSnoozeInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  /** The composer has a fresh session armed, so the next message starts a new native session. */
  freshContext: Schema.optional(Schema.Boolean),
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
