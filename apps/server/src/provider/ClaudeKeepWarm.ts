import {
  UsageLimitSourceError,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type ClaudeKeepWarmHold,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as Settings from "../serverSettings.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import { makeCliproxyApi, type RouterListing } from "../usage/cliproxyApi.ts";

// A CLIProxyAPI quota router holds requests marked with this header when their Claude account is
// nearly out of its 5-hour window, forwarding each just before the prompt cache would expire.
const KEEP_WARM_HEADER = "X-T3-Keep-Warm: 1";
const POLL_INTERVAL = "30 seconds";
const READ_TTL_MS = 10_000;
// The router re-places a switched conversation's held requests within milliseconds of the command.
const SWITCH_SETTLE = "1 second";

export function keepWarmClaudeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const customHeaders = environment.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    // Claude's event watchdog is separate from API_TIMEOUT_MS; proxy heartbeats cover byte idle.
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: "3600000",
    ...environment,
    ANTHROPIC_CUSTOM_HEADERS: customHeaders
      ? `${customHeaders}\n${KEEP_WARM_HEADER}`
      : KEEP_WARM_HEADER,
  };
}

/** A Claude session's active turn; `session` is its native Claude Code session ID. */
export interface ClaudeKeepWarmTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerTurnId: ProviderTurnId;
  readonly session: string;
  /** The hold its stall notice shows, or the `released` hold the user ended, if any. */
  readonly hold: ClaudeKeepWarmHold | null;
}

/** One Claude provider session, as the adapter exposes it. */
export interface ClaudeKeepWarmSession {
  readonly turn: Effect.Effect<ClaudeKeepWarmTurn | null>;
  /** Opens, updates or (with null, or a `released` hold) completes the turn's stall notice. */
  readonly show: (turn: ClaudeKeepWarmTurn, hold: ClaudeKeepWarmHold | null) => Effect.Effect<void>;
  /** Clears the `released` mark that `show` left on the turn's notice. */
  readonly restore: (turn: ClaudeKeepWarmTurn) => Effect.Effect<void>;
  /** Stops the turn so it fails as a usage limit that resets with `hold`. */
  readonly pause: (
    turn: ClaudeKeepWarmTurn,
    hold: ClaudeKeepWarmHold,
  ) => Effect.Effect<void, Error>;
}

export class ClaudeKeepWarm extends Context.Reference<{
  readonly register: (session: ClaudeKeepWarmSession) => Effect.Effect<void, never, Scope.Scope>;
  readonly find: (threadId: ThreadId) => Effect.Effect<{
    readonly session: ClaudeKeepWarmSession;
    readonly turn: ClaudeKeepWarmTurn & { readonly hold: ClaudeKeepWarmHold };
  } | null>;
  /** Makes the next poll read the router again, after a change the hold may not survive. */
  readonly forget: Effect.Effect<void>;
  /**
   * Stops holding the session until `until`, or with `switchAccount` moves it to another account
   * instead, failing when none can take it; a null `until` lets the proxy hold it again.
   */
  readonly release: (
    session: string,
    until: string | null,
    switchAccount?: boolean,
  ) => Effect.Effect<void, UsageLimitSourceError>;
}>("t3/provider/ClaudeKeepWarm", {
  defaultValue: () => ({
    register: () => Effect.void,
    find: () => Effect.succeed(null),
    forget: Effect.void,
    release: () =>
      Effect.fail(new UsageLimitSourceError({ detail: "Keep-warm control is unavailable." })),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const sessions = new Set<ClaudeKeepWarmSession>();
  // The router names accounts by alias only; emails come from the hub's account list. Keyed per
  // hub, since two hubs sharing a management key give different accounts the same alias.
  const accountNames = new Map<string, string>();
  const nameKey = (config: { readonly url: string }, alias: string) => `${config.url}\n${alias}`;
  let cached: {
    readonly at: number;
    readonly holds: ReadonlyArray<{ readonly session: string } & ClaudeKeepWarmHold>;
  } | null = null;

  const sources = settingsService.getSettings.pipe(
    Effect.map((settings) =>
      Object.values(settings.usageLimitSources).filter((config) => config.enabled),
    ),
    Effect.orElseSucceed(() => []),
    Effect.flatMap((configs) =>
      Effect.forEach(configs, (config) =>
        resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config).pipe(
          Effect.map((resolved) => ({
            url: resolved.url,
            managementKey: settingsSecretLiteral(resolved.managementKey),
          })),
        ),
      ),
    ),
    Effect.map((configs) => configs.filter((config) => config.managementKey.length > 0)),
  );

  // An alias without an email keeps naming itself.
  const nameAccounts = Effect.fn("ClaudeKeepWarm.nameAccounts")(function* (
    config: { readonly url: string; readonly managementKey: string },
    aliases: ReadonlyArray<string>,
    listing: RouterListing,
  ) {
    for (const file of yield* api.authFiles(config)) {
      const alias = yield* api.routerAliasOf(config, file, listing);
      if (alias === undefined || !file.email) continue;
      // Until the router has renamed its stored controls, a hold can name the legacy alias.
      const legacy = listing?.find((entry) => entry.account === alias)?.legacy_account;
      for (const name of legacy ? [alias, legacy] : [alias]) {
        accountNames.set(nameKey(config, name), file.email);
      }
    }
    for (const alias of aliases) {
      if (!accountNames.has(nameKey(config, alias)))
        accountNames.set(nameKey(config, alias), alias);
    }
  });

  const readSourceHolds = Effect.fn("ClaudeKeepWarm.readSourceHolds")(function* (config: {
    readonly url: string;
    readonly managementKey: string;
  }) {
    const { holds, listing } = yield* api.keepWarmHolds(config);
    const unnamed = holds.flatMap(({ account }) =>
      account === undefined || accountNames.has(nameKey(config, account)) ? [] : [account],
    );
    if (unnamed.length > 0) {
      yield* nameAccounts(config, unnamed, listing).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("claude keep-warm account names unavailable", { cause }),
        ),
      );
    }
    return holds.map(({ account, ...hold }) => ({
      ...hold,
      ...(account === undefined
        ? {}
        : { account: accountNames.get(nameKey(config, account)) ?? account }),
    }));
  });

  // Shared by every running Claude turn: at most one control read per source per interval.
  const readHolds = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cached !== null && now - cached.at < READ_TTL_MS) return cached.holds;
    const holds = yield* Effect.forEach(
      yield* sources,
      (config) =>
        readSourceHolds(config).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("claude keep-warm control read failed", { cause }).pipe(Effect.as([])),
          ),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((perSource) => perSource.flat()));
    cached = { at: now, holds };
    return holds;
  });

  const check = Effect.gen(function* () {
    const active = (yield* Effect.forEach([...sessions], (session) =>
      session.turn.pipe(Effect.map((turn) => ({ session, turn }))),
    )).flatMap(({ session, turn }) => (turn === null ? [] : [{ session, turn }]));
    if (active.length === 0) return;
    const holds = yield* readHolds;
    yield* Effect.forEach(
      active,
      ({ session, turn }) => {
        // A subagent's hold reports its root session (its pin's, for an inherited pin). A pin hold
        // blocks the turn outright, so it shows first; else the earliest release is the next send.
        const pinFirst = (candidate: ClaudeKeepWarmHold) => (candidate.kind === "pin" ? 0 : 1);
        const held = holds
          .filter((candidate) => candidate.session === turn.session)
          .toSorted(
            (left, right) =>
              pinFirst(left) - pinFirst(right) || left.releaseAt.localeCompare(right.releaseAt),
          )[0];
        if (held === undefined) return session.show(turn, null);
        const { session: _session, ...hold } = held;
        return session.show(turn, hold);
      },
      { discard: true },
    );
  });
  yield* check.pipe(
    Effect.delay(POLL_INTERVAL),
    Effect.ignoreCause({ log: true }),
    Effect.forever,
    Effect.forkScoped,
  );

  const register = (session: ClaudeKeepWarmSession) =>
    Effect.acquireRelease(
      Effect.sync(() => sessions.add(session)),
      () => Effect.sync(() => sessions.delete(session)),
    ).pipe(Effect.asVoid);

  const find = Effect.fn("ClaudeKeepWarm.find")(function* (threadId: ThreadId) {
    for (const session of sessions) {
      const turn = yield* session.turn;
      if (turn?.threadId === threadId && turn.hold !== null) {
        return { session, turn: { ...turn, hold: turn.hold } };
      }
    }
    return null;
  });

  // The session's account is unknown here, so every source records the release.
  const release = Effect.fn("ClaudeKeepWarm.release")(function* (
    session: string,
    until: string | null,
    switchAccount?: boolean,
  ) {
    const configs = yield* sources;
    if (configs.length === 0) {
      return yield* new UsageLimitSourceError({ detail: "No usage limit source is enabled." });
    }
    const results = yield* Effect.forEach(
      configs,
      (config) =>
        (until === null
          ? api.restoreKeepWarm(config, [session])
          : api.releaseKeepWarm(config, [session], until, switchAccount)
        ).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    cached = null;
    const failure = results.find((result) => result._tag === "Failure");
    if (failure !== undefined && results.every((result) => result._tag === "Failure")) {
      return yield* failure.failure;
    }
    if (until === null || !switchAccount) return;
    // The router accepts a switch before it knows whether an account can take the conversation,
    // so a request it still holds afterwards could not move.
    const accepted = configs.filter((_, index) => results[index]?._tag === "Success");
    yield* Effect.sleep(SWITCH_SETTLE);
    const held = yield* Effect.forEach(accepted, (config) => api.keepWarmHolds(config), {
      concurrency: "unbounded",
    }).pipe(
      Effect.map((perSource) =>
        perSource.some(({ holds }) =>
          holds.some((hold) => hold.session === session && hold.kind !== "pin"),
        ),
      ),
      Effect.result,
    );
    cached = null;
    if (held._tag === "Success" && !held.success) return;
    // Unmoved or unconfirmed: withdraw it, so the conversation cannot move later unasked.
    const withdrawals = yield* Effect.forEach(
      accepted,
      (config) => api.restoreKeepWarm(config, [session]).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    return yield* new UsageLimitSourceError({
      detail: [
        held._tag === "Success"
          ? "No other Claude account can take this conversation right now."
          : "Could not confirm that the conversation switched accounts.",
        ...(withdrawals.some((result) => result._tag === "Failure")
          ? ["The switch could not be cancelled, so the conversation may still move later."]
          : []),
      ].join(" "),
    });
  });

  const forget = Effect.sync(() => {
    cached = null;
  });

  return { register, find, forget, release } satisfies (typeof ClaudeKeepWarm)["Service"];
});

export const layer = Layer.effect(ClaudeKeepWarm, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

function formatWait(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// Timeline text stays true while the hold lasts; the banner shows its times.
export function describeKeepWarmHold(hold: ClaudeKeepWarmHold): string {
  if (hold.kind === "pin") {
    return `Waiting for ${hold.account ?? "the chosen account"} to reset (this thread is set to wait for it).`;
  }
  return "Claude is nearly out of its 5-hour limit. Holding requests about once an hour to keep the prompt cache warm until the limit resets.";
}

export function describeKeepWarmHoldEnd(
  hold: ClaudeKeepWarmHold,
  startedAtMs: number,
  nowMs: number,
): string {
  const waited = formatWait(nowMs - startedAtMs);
  if (hold.kind === "pin") return `Waited ${waited} for ${hold.account ?? "the chosen account"}.`;
  return `Held Claude's requests for ${waited} to keep the prompt cache warm.`;
}
