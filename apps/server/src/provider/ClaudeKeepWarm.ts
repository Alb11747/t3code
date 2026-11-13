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
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as Settings from "../serverSettings.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";

// A CLIProxyAPI quota router holds requests marked with this header when their Claude account is
// nearly out of its 5-hour window, forwarding each just before the prompt cache would expire.
const KEEP_WARM_HEADER = "X-T3-Keep-Warm: 1";
const POLL_INTERVAL = "30 seconds";
const encodeAliasInput = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
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
    release: () =>
      Effect.fail(new UsageLimitSourceError({ detail: "Keep-warm control is unavailable." })),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const mac = yield* Mac.Mac;
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

  // The router's alias: "account-" plus 16 hex of HMAC-SHA256, keyed by the management key, over
  // JSON.stringify([provider, auth_index]). An alias without an email keeps naming itself.
  const nameAccounts = Effect.fn("ClaudeKeepWarm.nameAccounts")(function* (
    config: { readonly url: string; readonly managementKey: string },
    aliases: ReadonlyArray<string>,
  ) {
    const utf8 = (value: string) => new TextEncoder().encode(value);
    const key = yield* Mac.key(Mac.hmacSha256, utf8(config.managementKey));
    for (const file of yield* api.authFiles(config)) {
      const signed = yield* encodeAliasInput([file.provider, file.auth_index]);
      const signature = yield* mac.sign(key, utf8(signed));
      const alias = `account-${Hex.encode(signature).slice(0, 16)}`;
      if (file.email) accountNames.set(nameKey(config, alias), file.email);
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
    const holds = yield* api.keepWarmHolds(config);
    const unnamed = holds.flatMap(({ account }) =>
      account === undefined || accountNames.has(nameKey(config, account)) ? [] : [account],
    );
    if (unnamed.length > 0) {
      yield* nameAccounts(config, unnamed).pipe(
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
        // A subagent's hold reports its root session; the earliest release is the next send.
        const held = holds
          .filter((candidate) => candidate.session === turn.session)
          .toSorted((left, right) => left.releaseAt.localeCompare(right.releaseAt))[0];
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
      Effect.map((perSource) => perSource.flat().some((hold) => hold.session === session)),
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

  return { register, find, release } satisfies (typeof ClaudeKeepWarm)["Service"];
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
export function describeKeepWarmHold(): string {
  return "Claude is nearly out of its 5-hour limit. Holding requests about once an hour to keep the prompt cache warm until the limit resets.";
}

export function describeKeepWarmHoldEnd(startedAtMs: number, nowMs: number): string {
  return `Held Claude's requests for ${formatWait(nowMs - startedAtMs)} to keep the prompt cache warm.`;
}
