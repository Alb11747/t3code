import type { PacedWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Fork: the quota router's paced-session fields (0.47+). T3 reads and writes them only through
 * this module, so a router rename touches one place.
 */

const RouterPaceWindow = Schema.Struct({
  used: Schema.optional(Schema.Number),
  line: Schema.optional(Schema.Number),
  ahead: Schema.optional(Schema.Boolean),
  until: Schema.optional(Schema.NullOr(Schema.String)),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/** `accounts[].pace` in GET control, keyed by window ("5h", "7d"). */
export const RouterAccountPace = Schema.optional(
  Schema.NullOr(Schema.Record(Schema.String, RouterPaceWindow)),
);
export type RouterAccountPace = typeof RouterAccountPace.Type;

/** `paced[]` in GET control: the registered sessions and what each waits for. */
export const RouterPacedSessions = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        session: Schema.String,
        windows: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        expires_at: Schema.optional(Schema.String),
        waiting: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              account: Schema.optional(Schema.String),
              window: Schema.optional(Schema.String),
              until: Schema.optional(Schema.NullOr(Schema.String)),
              since: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
);

export const PACED_PATH = "control/paced";

// T3 and the router name the windows alike.
export const pacedBody = (
  sessions: ReadonlyArray<string>,
  windows: ReadonlyArray<PacedWindow>,
  expiresAt: string,
) => ({ sessions, windows, expires_at: expiresAt });

export const unpacedBody = (sessions: ReadonlyArray<string>) => ({ sessions });

// Go writes RFC3339 with nanoseconds or offsets; T3 compares ISO strings.
const iso = (value: string | null | undefined) =>
  value ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.formatIso)) : null;

/**
 * When an account ahead of pace in one of `windows` is back on pace; null when it is on pace in
 * all of them, or the router names no time (pacing then fails open).
 */
export function pacedUntil(
  pace: RouterAccountPace,
  windows: ReadonlyArray<PacedWindow>,
  nowIso: string,
): string | null {
  let until: string | null = null;
  for (const window of windows) {
    const entry = pace?.[window];
    if (entry?.ahead !== true) continue;
    const at = iso(entry.until) ?? iso(entry.reset_at);
    if (at === null || at <= nowIso) continue;
    if (until === null || at > until) until = at;
  }
  return until;
}

/** The pace the router lists for one account. */
export const accountPace = (
  accounts:
    | ReadonlyArray<{ readonly account: string; readonly pace?: RouterAccountPace }>
    | null
    | undefined,
  account: string,
): RouterAccountPace => (accounts ?? []).find((entry) => entry.account === account)?.pace;

/** Each listed account's pace per window, for `t3_usage`. */
export function accountPaceRows(
  accounts: ReadonlyArray<{ readonly account: string; readonly pace?: RouterAccountPace }>,
) {
  return accounts.flatMap((entry) =>
    (["5h", "7d"] as const).flatMap((window) => {
      const pace = entry.pace?.[window];
      if (pace?.used === undefined || pace.line === undefined) return [];
      return [
        {
          account: entry.account,
          window,
          used: pace.used,
          line: pace.line,
          ahead: pace.ahead === true,
          until: pace.ahead === true ? iso(pace.until) : null,
        },
      ];
    }),
  );
}
