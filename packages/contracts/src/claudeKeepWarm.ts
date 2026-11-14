import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * A CLIProxyAPI quota router holding a Claude turn's requests: by default to keep a nearly
 * exhausted account's prompt cache warm, or (`kind: "pin"`) because the thread's pin waits for its
 * account when it runs out. Clients without `kind` read every hold as keep-warm.
 */
export const ClaudeKeepWarmHold = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("pin")),
  /** When the account's blocking window resets; a pin hold with no known reset repeats `releaseAt`. */
  resetAt: IsoDateTime,
  /** Set when the router knows no reset, such as for an account the hub cannot use right now. */
  resetUnknown: Schema.optionalKey(Schema.Boolean),
  /** When the proxy forwards the held request, or for a pin hold checks the account again. */
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
 * What MCP thread summaries report while a running thread waits for the account its pin names: a
 * sibling of `stalled`, so linked environments on older versions still decode the summary.
 */
export const OrchestratorMcpThreadAccountHold = Schema.Struct({
  /** The account's email, or its alias when the email is unknown. */
  account: Schema.String,
  /** When the account gets quota back; null when the router does not know. */
  resetAt: Schema.NullOr(IsoDateTime),
  /** When the router checks the account again. */
  releaseAt: IsoDateTime,
});

/**
 * Keep-warm: `release` stops holding until the reset (`restore` undoes it), `switch` moves to
 * another account, `compact` compacts on the warm account and continues, `pause` ends the turn as
 * a usage limit. Pin hold: `stop_waiting` (or `release`, from older clients) keeps the account but
 * stops waiting for it.
 */
export const ClaudeKeepWarmAction = Schema.Literals([
  "release",
  "restore",
  "switch",
  "compact",
  "pause",
  "stop_waiting",
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
