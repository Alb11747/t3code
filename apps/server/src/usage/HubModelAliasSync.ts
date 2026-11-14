import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HubModelAliases from "../provider/HubModelAliases.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { routerProviderOf } from "./cliproxyApi.ts";
import { hubSourceOf } from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

/** Each provider's aliases from the one hub that holds its accounts, as the account picker joins them. */
export const hubModelAliasesOf = (
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): HubModelAliases.HubModelAliasMap => {
  const out = new Map<ServerProvider["instanceId"], Readonly<Record<string, string>>>();
  for (const provider of providers) {
    const channel = routerProviderOf(provider.driver);
    const aliases = channel && hubSourceOf(provider, sources)?.modelAliases?.[channel];
    if (aliases && Object.keys(aliases).length > 0) out.set(provider.instanceId, aliases);
  }
  return out;
};

const keyOf = (map: HubModelAliases.HubModelAliasMap) =>
  JSON.stringify([...map].toSorted(([a], [b]) => a.localeCompare(b)));

/** Fork: keeps `HubModelAliases` in step with the hub reads `UsageLimitSources` already makes. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const aliases = yield* HubModelAliases.HubModelAliases;
    let last = keyOf(yield* aliases.current);
    const sync = Effect.gen(function* () {
      const next = hubModelAliasesOf(yield* providers.getProviders, yield* sources.current);
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
