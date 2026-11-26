import type { ProviderInstanceId, UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import type { HubModelAliasMap } from "../provider/HubModelAliases.ts";

/**
 * Fork: counts a record of an ID the CLI Proxy hub answers with another model under that model.
 * The hub's map is only current, so a record moves only once the history holds a record of the
 * target by its own name at or before it; hubs that disagree on an ID leave it alone.
 */
export function makeServedUsageModel(
  aliases: HubModelAliasMap,
  providerOf: (instanceId: ProviderInstanceId) => UsageProviderKind | undefined,
  history: Iterable<{
    readonly provider: UsageProviderKind;
    readonly records: readonly UsageRecord[];
    readonly tailRecords: readonly UsageRecord[];
  }>,
): ((record: UsageRecord) => UsageRecord) | undefined {
  const byProvider = new Map<UsageProviderKind, Map<string, string | null>>();
  for (const [instanceId, map] of aliases) {
    const provider = providerOf(instanceId);
    if (provider === undefined) continue;
    let merged = byProvider.get(provider);
    if (merged === undefined) byProvider.set(provider, (merged = new Map()));
    for (const [from, to] of Object.entries(map)) {
      if (from === to) continue;
      const known = merged.get(from);
      merged.set(from, known === undefined || known === to ? to : null);
    }
  }
  // Earliest record of each target by its own name, per provider; absent until one is seen.
  const firstSeen = new Map<UsageProviderKind, Map<string, number>>();
  for (const [provider, map] of byProvider) {
    const targets = new Map<string, number>();
    for (const to of map.values()) if (to !== null) targets.set(to, Infinity);
    if (targets.size > 0) firstSeen.set(provider, targets);
  }
  if (firstSeen.size === 0) return undefined;
  for (const entry of history) {
    const targets = firstSeen.get(entry.provider);
    if (targets === undefined) continue;
    for (const records of [entry.records, entry.tailRecords]) {
      for (const record of records) {
        const seen = targets.get(record.model);
        if (seen !== undefined && record.timestampMs < seen) {
          targets.set(record.model, record.timestampMs);
        }
      }
    }
  }

  return (record) => {
    const target = byProvider.get(record.provider)?.get(record.model);
    if (target == null) return record;
    const since = firstSeen.get(record.provider)?.get(target) ?? Infinity;
    if (record.timestampMs < since) return record;
    // The requested ID's provider-specific rate name no longer applies.
    const { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model: target };
  };
}
