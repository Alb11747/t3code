import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/** A CLIProxyAPI quota router holding a nearly exhausted Claude account's requests to keep its prompt cache warm. */
export const ClaudeKeepWarmHold = Schema.Struct({
  /** When the account's 5-hour window resets. */
  resetAt: IsoDateTime,
  /** When the proxy forwards the held request. */
  releaseAt: IsoDateTime,
});
export type ClaudeKeepWarmHold = typeof ClaudeKeepWarmHold.Type;

/**
 * `release`: stop holding this conversation until the reset. `compact`: stop the turn, compact on
 * the still-warm account, then continue. `pause`: end the turn as a usage-limit failure that resets at `resetAt`.
 */
export const ClaudeKeepWarmAction = Schema.Literals(["release", "compact", "pause"]);
export type ClaudeKeepWarmAction = typeof ClaudeKeepWarmAction.Type;

export const ClaudeKeepWarmActionInput = Schema.Struct({
  threadId: ThreadId,
  action: ClaudeKeepWarmAction,
});
export type ClaudeKeepWarmActionInput = typeof ClaudeKeepWarmActionInput.Type;

export class ClaudeKeepWarmActionError extends Schema.TaggedError<ClaudeKeepWarmActionError>()(
  "ClaudeKeepWarmActionError",
  {
    threadId: ThreadId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
