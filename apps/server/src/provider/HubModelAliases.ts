import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Retired model ID -> the model a CLI Proxy hub answers it with, per provider instance. */
export type HubModelAliasMap = ReadonlyMap<ProviderInstanceId, Readonly<Record<string, string>>>;

const EMPTY: HubModelAliasMap = new Map();

/**
 * Fork: the hub alias maps for providers behind a CLI Proxy hub. Provided below the provider
 * registry and adapters, which read it; the usage layer above them writes it (`HubModelAliasSync`).
 */
export class HubModelAliases extends Context.Reference<{
  readonly current: Effect.Effect<HubModelAliasMap>;
  readonly changes: Stream.Stream<HubModelAliasMap>;
  readonly set: (next: HubModelAliasMap) => Effect.Effect<void>;
}>("t3/provider/HubModelAliases", {
  defaultValue: () => ({
    current: Effect.succeed(EMPTY),
    changes: Stream.empty,
    set: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  HubModelAliases,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(EMPTY);
    return {
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      set: Effect.fn("HubModelAliases.set")(function* (next: HubModelAliasMap) {
        yield* SubscriptionRef.set(ref, next);
      }),
    };
  }),
);

export const servedByOf = (
  aliases: Readonly<Record<string, string>> | undefined,
  slug: string | undefined,
): string | undefined =>
  aliases !== undefined && slug !== undefined && Object.hasOwn(aliases, slug)
    ? aliases[slug]
    : undefined;

/**
 * Marks each listed model the hub answers with another model, and clears stale marks. A target the
 * provider does not list unmarked is skipped: with `fork: false` the proxy renames the model, so the
 * alias is then the only ID that works.
 */
export const withServedModels = (
  provider: ServerProvider,
  aliases: Readonly<Record<string, string>> | undefined,
): ServerProvider => {
  const listed = new Set(
    provider.models
      .filter((model) => servedByOf(aliases, model.slug) === undefined)
      .map((model) => model.slug),
  );
  let changed = false;
  const models = provider.models.map((model) => {
    const target = model.isCustom ? undefined : servedByOf(aliases, model.slug);
    const servedBy = target !== undefined && listed.has(target) ? target : undefined;
    if (model.servedBy === servedBy) return model;
    changed = true;
    if (servedBy === undefined) {
      const { servedBy: _servedBy, ...rest } = model;
      return rest;
    }
    return { ...model, servedBy };
  });
  return changed ? { ...provider, models } : provider;
};
