import type {
  ServerProvider,
  UsageLimitSourceId,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HubModelAliases from "../provider/HubModelAliases.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { routerProviderOf } from "./cliproxyApi.ts";
import { hubSourceOf } from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

/**
 * Each provider's aliases from the one hub that holds its accounts, as the account picker joins
 * them, and only when the provider's custom endpoint (`auth.endpoint`) is that hub's origin: a
 * provider sending requests elsewhere, or whose endpoint T3 cannot tell, gets none.
 */
export const hubModelAliasesOf = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): HubModelAliases.HubModelAliasMap => {
  const out = new Map<ServerProvider["instanceId"], Readonly<Record<string, string>>>();
  for (const provider of providers) {
    const channel = routerProviderOf(provider.driver);
    const source = channel ? hubSourceOf(provider, sources) : null;
    if (!channel || !source?.origin || source.origin !== provider.auth.endpoint) continue;
    const aliases = source.modelAliases?.[channel];
    if (aliases && Object.keys(aliases).length > 0) out.set(provider.instanceId, aliases);
  }
  return out;
};

/**
 * A failed account read lists no accounts; the source's last good list keeps its providers joined,
 * so one bad read does not unmark and republish every model. Updates `lastAccounts`.
 */
export const withLastAccounts = (
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  lastAccounts: Map<UsageLimitSourceId, UsageLimitSourceSnapshot["accounts"]>,
): ReadonlyArray<UsageLimitSourceSnapshot> =>
  sources.map((source) => {
    if (source.error === undefined) {
      lastAccounts.set(source.id, source.accounts);
      return source;
    }
    const accounts = lastAccounts.get(source.id);
    return accounts === undefined ? source : { ...source, accounts };
  });

const keyOf = (map: HubModelAliases.HubModelAliasMap) =>
  JSON.stringify([...map].toSorted(([a], [b]) => a.localeCompare(b)));

/** Fork: keeps `HubModelAliases` in step with the hub reads `UsageLimitSources` already makes. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const aliases = yield* HubModelAliases.HubModelAliases;
    let last = keyOf(yield* aliases.current);
    const lastAccounts = new Map<UsageLimitSourceId, UsageLimitSourceSnapshot["accounts"]>();
    const sync = Effect.gen(function* () {
      const joined = withLastAccounts(yield* sources.current, lastAccounts);
      const next = hubModelAliasesOf(yield* providers.getProviders, joined);
      const key = keyOf(next);
      if (key === last) return;
      last = key;
      yield* aliases.set(next);
    });
    yield* Stream.merge(providers.streamChanges, sources.streamChanges).pipe(
      Stream.runForEach(() => sync),
      Effect.forkScoped,
    );
  }),
);
