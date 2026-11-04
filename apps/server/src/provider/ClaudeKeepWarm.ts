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
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";

// A CLIProxyAPI quota router holds requests marked with this header when their Claude account is
// nearly out of its 5-hour window, forwarding each just before the prompt cache would expire.
const KEEP_WARM_HEADER = "X-T3-Keep-Warm: 1";
const POLL_INTERVAL = "30 seconds";
const READ_TTL_MS = 10_000;

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
  /** The hold its stall notice shows, if any. */
  readonly hold: ClaudeKeepWarmHold | null;
}

/** One Claude provider session, as the adapter exposes it. */
export interface ClaudeKeepWarmSession {
  readonly turn: Effect.Effect<ClaudeKeepWarmTurn | null>;
  /** Opens, updates or (with null) completes the turn's stall notice. */
  readonly show: (turn: ClaudeKeepWarmTurn, hold: ClaudeKeepWarmHold | null) => Effect.Effect<void>;
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
  readonly release: (session: string, until: string) => Effect.Effect<void, UsageLimitSourceError>;
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
  const sessions = new Set<ClaudeKeepWarmSession>();
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

  // Shared by every running Claude turn: at most one control read per source per interval.
  const readHolds = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cached !== null && now - cached.at < READ_TTL_MS) return cached.holds;
    const holds = yield* Effect.forEach(
      yield* sources,
      (config) =>
        api
          .keepWarmHolds(config)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("claude keep-warm control read failed", { cause }).pipe(
                Effect.as([]),
              ),
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
        const hold = holds
          .filter((candidate) => candidate.session === turn.session)
          .toSorted((left, right) => left.releaseAt.localeCompare(right.releaseAt))[0];
        return session.show(
          turn,
          hold === undefined ? null : { resetAt: hold.resetAt, releaseAt: hold.releaseAt },
        );
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
  const release = Effect.fn("ClaudeKeepWarm.release")(function* (session: string, until: string) {
    const configs = yield* sources;
    if (configs.length === 0) {
      return yield* new UsageLimitSourceError({ detail: "No usage limit source is enabled." });
    }
    const results = yield* Effect.forEach(
      configs,
      (config) => api.releaseKeepWarm(config, [session], until).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    cached = null;
    const failure = results.find((result) => result._tag === "Failure");
    if (failure !== undefined && results.every((result) => result._tag === "Failure")) {
      return yield* failure.failure;
    }
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
