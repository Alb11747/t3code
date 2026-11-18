// Fork: a thread's auto-compaction limit comes from its runtime policy (set by agents); without
// one, the instance's per-model `autoCompactLimits` from settings.json applies, and otherwise the
// provider keeps its own setting. Each map entry is checked here, so one bad value is ignored
// instead of failing the whole instance config.
export function resolveAutoCompactLimit(
  threadLimit: number | undefined,
  modelDefaults: Readonly<Record<string, unknown>>,
  modelKeys: ReadonlyArray<string>,
): number | undefined {
  if (threadLimit !== undefined) return threadLimit;
  for (const key of modelKeys) {
    if (!Object.hasOwn(modelDefaults, key)) continue;
    const limit = modelDefaults[key];
    // Codex reads the value as a TOML integer, so it must stay a safe one.
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return undefined;
}
