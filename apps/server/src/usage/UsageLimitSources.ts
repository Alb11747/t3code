import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  HttpQuotaResponse,
  type HttpQuotaRefreshInput,
  type HttpQuotaRefreshResult,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { hubRoutes } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/http/HttpClientError";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import {
  type CliproxyApi,
  type CliproxyHub,
  makeCliproxyApi,
  type RouterListing,
} from "./cliproxyApi.ts";

const decodeHttpQuotaJson = Schema.decodeUnknownEffect(Schema.fromJsonString(HttpQuotaResponse));
const decodeHttpQuotaResponse = Effect.fn("UsageLimitSources.decodeHttpQuotaResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  let bytes = 0;
  const text = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return bytes > 1024 * 1024
        ? Effect.fail(
            new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "HTTP quota response exceeds 1 MiB.",
            }),
          )
        : Effect.succeed(chunk);
    }),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );
  return yield* decodeHttpQuotaJson(text);
});

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly refreshHttpQuota: (
      input: HttpQuotaRefreshInput,
    ) => Effect.Effect<typeof HttpQuotaRefreshResult.Type, UsageLimitSourceError>;
    /**
     * Fork: re-reads only each hub's model aliases, at most once a minute, for an opened model
     * picker; the full refresh's per-account usage reads cost far more.
     */
    readonly refreshModelAliases: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    /** The source's quota-router pick preview; null when it is disabled or cannot preview picks. */
    readonly nextPickReset: (input: {
      readonly sourceId: UsageLimitSourceId;
      readonly provider: "claude" | "codex";
      readonly session?: string;
      readonly model?: string;
    }) => Effect.Effect<{ readonly resetsAt: string | null; readonly lastAccount: string } | null>;
    /** Fork: the enabled source's hub with its management key, or null. */
    readonly hub: (sourceId: UsageLimitSourceId) => Effect.Effect<CliproxyHub | null>;
    /** Fork: the router's controls; a changed account listing re-reads the source's accounts. */
    readonly control: (
      sourceId: UsageLimitSourceId,
      hub: CliproxyHub,
    ) => ReturnType<CliproxyApi["control"]>;
    /**
     * Fork: maps an alias T3 stored, was given or read from the router to the one the source's
     * router uses now: legacy to current, or current to legacy after a rollback. Others pass.
     */
    readonly routerAlias: (
      sourceId: UsageLimitSourceId,
    ) => Effect.Effect<(alias: string) => string>;
    /**
     * Fork: `routerAlias` for an end to remove, except that a router rolled back from 0.28.0
     * deletes an end only by the alias it lists, so a listed end for the account keeps that alias.
     */
    readonly removedEndAlias: (
      sourceId: UsageLimitSourceId,
      hub: CliproxyHub,
      alias: string,
    ) => Effect.Effect<string>;
  } & Pick<
    CliproxyApi,
    | "nextPick"
    | "pin"
    | "unpin"
    | "pace"
    | "unpace"
    | "steer"
    | "unsteer"
    | "margin"
    | "subscriptionEnd"
  >
>()("t3/usage/UsageLimitSources") {}

const LISTING_TIMEOUT = "3 seconds";
// The background refresh runs only for a foreground client on an unlocked host, but agents read
// accounts with nobody watching (a launch that names one resolves it here), so a snapshot this old
// refreshes regardless. Without it, a startup read whose router had not listed its aliases yet
// stayed for hours and refused every account-named launch.
const IDLE_REFRESH_MS = 15 * 60_000;
// Bounds a whole refresh, which holds the refresh lock; each hub call has its own shorter limit.
const REFRESH_TIMEOUT = "2 minutes";

/** A listing's account names; pace numbers in it change on every read. */
const listingNames = (listing: RouterListing) =>
  JSON.stringify(
    listing?.map((entry) => [
      entry.account,
      entry.provider,
      entry.auth_index,
      entry.legacy_account,
    ]) ?? listing,
  );

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A refused read of one account keeps its last good reading, as provider probes keep their bars
 * (see ServerProviderUsageLimits); a reading with none to keep stays listed as unreadable.
 */
function keepLastGoodReadings(
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
  next: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  return next.map((source) => {
    if (source.kind === "http") return source;
    // Auth file names can be reused, so only the same hub and login may lend a reading.
    const before = previous.find(
      (candidate) => candidate.id === source.id && candidate.endpoint === source.endpoint,
    );
    if (!before) return source;
    return {
      ...source,
      accounts: source.accounts.map((account) => {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
        // Without a listed login, a reused auth file name cannot be told apart from the old one.
        if (account.email === undefined && account.workspaceId === undefined) return account;
        const last = before.accounts.find(
          (candidate) =>
            candidate.id === account.id &&
            candidate.driver === account.driver &&
            // Fingerprinted Antigravity readings omit the listed identity, so they are never lent.
            candidate.usageLimits.credentialFingerprint === undefined &&
            candidate.email === account.email &&
            candidate.workspaceId === account.workspaceId,
        );
        if (!last || last.usageLimits.unavailable) return account;
        // Only the reading is lent; an unread model list stays unknown.
        return { ...last, models: account.models };
      }),
    };
  });
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const http = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const scope = yield* Scope.Scope;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const httpConfigs = new WeakMap<UsageLimitSourceSnapshot, UsageLimitSourceConfig>();
  // Fork: each source's last account listing from its router, and every current-to-legacy alias
  // pair it has published, so a router rolled back to before 0.28.0 still gets legacy aliases.
  // In memory: after a restart, a rolled-back router's stored new aliases are unknown to it.
  const routerNames = new Map<
    UsageLimitSourceId,
    { readonly listing: RouterListing; readonly legacyOf: ReadonlyMap<string, string> }
  >();
  // Whether the listing's account names changed from an earlier one.
  const observe = (sourceId: UsageLimitSourceId, listing: RouterListing) => {
    const previous = routerNames.get(sourceId);
    const legacyOf = new Map(previous?.legacyOf);
    for (const entry of listing ?? []) {
      if (entry.legacy_account) legacyOf.set(entry.account, entry.legacy_account);
    }
    routerNames.set(sourceId, { listing, legacyOf });
    return previous !== undefined && listingNames(previous.listing) !== listingNames(listing);
  };
  // A failed or slow read keeps the last listing; a hub never read (or without a router) computes
  // aliases. Bounded like other control reads, since every account read of the refresh waits on it.
  const listingOf = (sourceId: UsageLimitSourceId, hub: CliproxyHub) =>
    api.control(hub).pipe(
      Effect.timeout(LISTING_TIMEOUT),
      Effect.option,
      Effect.map((control) => {
        if (Option.isSome(control)) observe(sourceId, control.value.accounts);
        return routerNames.get(sourceId)?.listing;
      }),
    );
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  // Fork: each hub's `oauth-model-alias` map, read like the router listing: bounded, and a failed
  // or slow read keeps the last map, so one bad read does not reshuffle model pickers.
  const modelAliasMaps = new Map<UsageLimitSourceId, UsageLimitSourceSnapshot["modelAliases"]>();
  const modelAliasesOf = (sourceId: UsageLimitSourceId, hub: CliproxyHub) =>
    api.modelAliases(hub).pipe(
      Effect.timeout(LISTING_TIMEOUT),
      Effect.option,
      Effect.map((read) => {
        if (Option.isSome(read)) modelAliasMaps.set(sourceId, read.value);
        return modelAliasMaps.get(sourceId);
      }),
    );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(config.kind === "cliproxy" && url && /^https?:$/.test(url.protocol)
        ? {
            origin: url.origin,
            endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
          }
        : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (config.kind === "http") {
      if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
        return { ...base, accounts: [], error: "Invalid HTTP quota source URL." };
      }
      if (typeof config.managementKey !== "string" && !managementKey) {
        return { ...base, accounts: [], error: "Could not resolve the quota source token." };
      }
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
      );
      const result = yield* http
        .execute(
          managementKey
            ? request.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${managementKey}`))
            : request,
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeHttpQuotaResponse),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.timeout("10 seconds"),
          Effect.result,
        );
      if (result._tag !== "Success") {
        return { ...base, accounts: [], error: "Could not read the HTTP quota source." };
      }
      const snapshot = { ...base, accounts: [], quotaAccounts: result.success.accounts };
      httpConfigs.set(snapshot, config);
      return snapshot;
    }
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const hub = { url: config.url, managementKey };
    const [accounts, modelAliases] = yield* Effect.all(
      [api.readAccounts(hub, listingOf(id, hub)).pipe(Effect.result), modelAliasesOf(id, hub)],
      { concurrency: 2 },
    );
    const aliases = modelAliases === undefined ? {} : { modelAliases };
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail, ...aliases };
    }
    return { ...base, accounts: accounts.success, ...aliases };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  let refreshedAt = Number.NEGATIVE_INFINITY;
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(keepLastGoodReadings(yield* Ref.get(stateRef), snapshots));
    refreshedAt = yield* Clock.currentTimeMillis;
  }).pipe(
    Effect.timeout(REFRESH_TIMEOUT),
    refreshLock.withPermits(1),
    Effect.ignoreCause({ log: "Warn", message: "Could not refresh usage limit sources." }),
  );

  const refreshHttpQuota = Effect.fn("UsageLimitSources.refreshHttpQuota")(function* ({
    sourceId,
    accountId,
  }: HttpQuotaRefreshInput) {
    const unavailable = new UsageLimitSourceError({
      detail: "Could not refresh the HTTP quota source.",
    });
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(() => unavailable));
    const config = settings.usageLimitSources[sourceId];
    const advertised = (yield* Ref.get(stateRef)).find((source) => source.id === sourceId);
    if (
      !config?.enabled ||
      config.kind !== "http" ||
      !advertised?.quotaAccounts?.some(
        (account) => account.id === accountId && account.refreshable,
      ) ||
      !Equal.equals(httpConfigs.get(advertised), config)
    ) {
      return yield* unavailable;
    }
    const url = URL.parse(config.url);
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
      return yield* unavailable;
    }
    const key = yield* readManagementKey(config);
    if (!key) return yield* unavailable;

    const response = yield* http
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("Accept", "application/json"),
          HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
          HttpClientRequest.bodyJsonUnsafe({ accountId }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            const feed = response.status === 200 ? yield* decodeHttpQuotaResponse(response) : null;
            return { status: response.status, feed };
          }),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("110 seconds"),
        Effect.option,
      );

    const result = Option.getOrUndefined(response);
    // An unsuccessful request can still have started the CLI, so re-read its cooldown.
    const snapshot = yield* Effect.gen(function* () {
      const latest = yield* settingsService.getSettings;
      if (!Equal.equals(latest.usageLimitSources[sourceId], config)) return;
      const next: UsageLimitSourceSnapshot = result?.feed
        ? {
            ...advertised,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            quotaAccounts: result.feed.accounts,
          }
        : yield* readSource(sourceId, config);
      if (!next.quotaAccounts) return;
      httpConfigs.set(next, config);
      const previous = yield* Ref.get(stateRef);
      yield* publish(previous.map((source) => (source.id === sourceId ? next : source)));
      return next;
    }).pipe(
      refreshLock.withPermits(1),
      Effect.mapError(() => unavailable),
    );

    if (result?.status === 409) return { outcome: "busy" } as const;
    if (result?.status === 429) {
      const retryAt = snapshot?.quotaAccounts?.find(
        (account) => account.id === accountId,
      )?.refreshAfter;
      return { outcome: "rate-limited", ...(retryAt ? { retryAt } : {}) } as const;
    }
    if (
      !result?.feed?.accounts.some((account) => account.id === accountId && account.readAt) ||
      !snapshot
    ) {
      return yield* unavailable;
    }
    return { outcome: "refreshed" } as const;
  });

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || config.kind !== "cliproxy") {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    // A redemption changes the reading, so a refused re-read must not bring back the one before it.
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  let aliasesReadAt = Number.NEGATIVE_INFINITY;
  const refreshModelAliases = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - aliasesReadAt < 60_000) return;
    aliasesReadAt = now;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const previous = yield* Ref.get(stateRef);
    const next = yield* Effect.forEach(
      previous,
      (source) =>
        Effect.gen(function* () {
          const config = settings?.usageLimitSources[source.id];
          if (!config?.enabled || config.kind !== "cliproxy") return source;
          const managementKey = yield* readManagementKey(config).pipe(
            Effect.orElseSucceed(() => ""),
          );
          if (managementKey.length === 0) return source;
          const modelAliases = yield* modelAliasesOf(source.id, {
            url: config.url,
            managementKey,
          });
          return modelAliases === undefined ? source : { ...source, modelAliases };
        }),
      { concurrency: 4 },
    );
    yield* publish(next);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const hub = Effect.fn("UsageLimitSources.hub")(function* (sourceId: UsageLimitSourceId) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const config = settings?.usageLimitSources[sourceId];
    if (!config?.enabled || config.kind !== "cliproxy") return null;
    const managementKey = yield* readManagementKey(config).pipe(Effect.orElseSucceed(() => ""));
    if (managementKey.length === 0) return null;
    return { url: config.url, managementKey };
  });

  const control = Effect.fn("UsageLimitSources.control")(function* (
    sourceId: UsageLimitSourceId,
    config: CliproxyHub,
  ) {
    const value = yield* api.control(config);
    if (observe(sourceId, value.accounts)) yield* Effect.forkIn(refresh, scope);
    return value;
  });

  const routerAlias = (sourceId: UsageLimitSourceId) =>
    Effect.sync(() => {
      const names = routerNames.get(sourceId);
      const listing = names?.listing;
      return (alias: string) =>
        listing === undefined
          ? (names?.legacyOf.get(alias) ?? alias)
          : (listing?.find((entry) => entry.legacy_account === alias)?.account ?? alias);
    });

  const removedEndAlias = Effect.fn("UsageLimitSources.removedEndAlias")(function* (
    sourceId: UsageLimitSourceId,
    config: CliproxyHub,
    alias: string,
  ) {
    const rename = yield* routerAlias(sourceId);
    const target = rename(alias);
    const names = routerNames.get(sourceId);
    if (names === undefined || names.listing !== undefined || names.legacyOf.size === 0) {
      return target;
    }
    const current = yield* control(sourceId, config).pipe(Effect.option);
    if (Option.isNone(current)) return target;
    const ends = current.value.ends ?? [];
    return ends.find((end) => rename(end.account) === target)?.account ?? target;
  });

  const nextPickReset = Effect.fn("UsageLimitSources.nextPickReset")(function* (
    input: Parameters<UsageLimitSources["Service"]["nextPickReset"]>[0],
  ) {
    const config = yield* hub(input.sourceId);
    if (config === null) return null;
    const { sourceId: _, ...pick } = input;
    return yield* api.nextPickReset(config, pick);
  });

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) => shouldRun || now - refreshedAt >= IDLE_REFRESH_MS,
        ),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    refreshHttpQuota,
    consumeResetCredit,
    nextPickReset,
    hub,
    refreshModelAliases,
    // Fork: the quota router's controls.
    nextPick: api.nextPick,
    control,
    routerAlias,
    removedEndAlias,
    pin: api.pin,
    unpin: api.unpin,
    pace: api.pace,
    unpace: api.unpace,
    steer: api.steer,
    unsteer: api.unsteer,
    margin: api.margin,
    subscriptionEnd: api.subscriptionEnd,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub returns a usage limit only when every account it routes the model to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  const routes = hubRoutes(sources, driver, model);
  for (const account of sources.flatMap((source) => source.accounts).filter(routes)) {
    // An unread account may be the one still blocked, so its refill is unknown.
    if (account.usageLimits.unavailable) return null;
    const spent = account.usageLimits.windows.filter(
      (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
    );
    if (spent.length === 0) return null;
    const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((reset) => !Number.isFinite(reset))) return null;
    const recoversAt = Math.max(...resets);
    if (recoversAt <= now) return null;
    earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
