import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/** A CLIProxyAPI quota router holding a nearly exhausted Claude account's requests to keep its prompt cache warm. */
export const ClaudeKeepWarmHold = Schema.Struct({
  /** When the account's 5-hour window resets. */
  resetAt: IsoDateTime,
  /** When the proxy forwards the held request. */
  releaseAt: IsoDateTime,
  /** The held account: its email, or the proxy's alias for it when the email is unknown. */
  account: Schema.optionalKey(Schema.String),
  /** Set on the ended notice of a hold the user released, while holds stay off (until `resetAt`). */
  released: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeKeepWarmHold = typeof ClaudeKeepWarmHold.Type;

/**
 * What MCP thread summaries report while a running thread's requests are held: the turn is
 * waiting on the provider's usage limit, not hung. About one model step still runs per hour.
 */
export const OrchestratorMcpThreadStall = Schema.Struct({
  kind: Schema.Literal("keep_warm"),
  /** When the usage limit resets and the thread runs at full speed again. */
  resetAt: IsoDateTime,
  /** When the next held request is sent. */
  releaseAt: IsoDateTime,
});

/**
 * `release`: stop holding this conversation until the reset; `restore` undoes it. `switch`: move
 * the conversation to another account, rewriting its cache there. `compact`: stop the turn,
 * compact on the still-warm account, then continue. `pause`: end the turn as a usage-limit
 * failure that resets at `resetAt`.
 */
export const ClaudeKeepWarmAction = Schema.Literals([
  "release",
  "restore",
  "switch",
  "compact",
  "pause",
]);
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
