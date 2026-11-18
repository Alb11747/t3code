import type {
  ModelSelection,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

// Fork: a thread's auto-compaction limit rides in its model options, so threads, launches,
// delegations and the traits pickers carry it like effort. "default" falls back to the
// instance's per-model `autoCompactLimits`, then to the provider's own config.
const AUTO_COMPACT_LIMIT_OPTION_ID = "autoCompactLimit";
const AUTO_COMPACT_LIMITS = [100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000];
const AUTO_COMPACT_LIMIT_IDS = AUTO_COMPACT_LIMITS.map(String);

export interface AutoCompactRange {
  readonly min: number;
  readonly max: number;
}
export const CODEX_AUTO_COMPACT_RANGE: AutoCompactRange = { min: 10_000, max: 10_000_000 };
/** Claude takes the value as its auto-compact window, which it accepts only in this range. */
export const CLAUDE_AUTO_COMPACT_RANGE: AutoCompactRange = { min: 100_000, max: 1_000_000 };

type AutoCompactLimits = Readonly<Record<string, unknown>>;

const formatTokens = (tokens: number) => `${tokens / 1000}k`;

// Entries are checked one at a time, so a bad one is ignored instead of disabling the instance.
function modelLimit(limits: AutoCompactLimits, model: string, range: AutoCompactRange) {
  if (!Object.hasOwn(limits, model)) return undefined;
  const limit = limits[model];
  return typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= range.min &&
    limit <= range.max
    ? limit
    : undefined;
}

function autoCompactLimitDescriptor(
  modelDefault: number | undefined,
): SelectProviderOptionDescriptor {
  return {
    id: AUTO_COMPACT_LIMIT_OPTION_ID,
    label: "Auto-compact",
    description: "Compact this thread at about this many tokens.",
    type: "select",
    options: [
      {
        id: "default",
        label: modelDefault === undefined ? "Default" : `Default (${formatTokens(modelDefault)})`,
        isDefault: true,
      },
      ...AUTO_COMPACT_LIMITS.map((limit) => ({ id: String(limit), label: formatTokens(limit) })),
    ],
  };
}

/** Adds the option, or refreshes its default label, on every model. */
export function withAutoCompactLimitOption(
  models: ReadonlyArray<ServerProviderModel>,
  limits: AutoCompactLimits,
  range: AutoCompactRange,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: [
        ...(model.capabilities?.optionDescriptors ?? []).filter(
          (descriptor) => descriptor.id !== AUTO_COMPACT_LIMIT_OPTION_ID,
        ),
        autoCompactLimitDescriptor(modelLimit(limits, model.slug, range)),
      ],
    },
  }));
}

/** Why a selection's auto-compact value cannot apply, or undefined when it can. */
export function invalidAutoCompactLimit(selection: ModelSelection): string | undefined {
  const values = (selection.options ?? [])
    .filter((option) => option.id === AUTO_COMPACT_LIMIT_OPTION_ID)
    .map((option) => option.value);
  return values.length <= 1 &&
    values.every((value) => value === "default" || AUTO_COMPACT_LIMIT_IDS.includes(String(value)))
    ? undefined
    : `Option ${AUTO_COMPACT_LIMIT_OPTION_ID} must be given once, as one of: default, ${AUTO_COMPACT_LIMIT_IDS.join(", ")}.`;
}

/**
 * Tokens to compact at, or undefined to leave the provider's own setting alone. `modelSlug`
 * is the catalog slug when the selection names an alias, so defaults keyed by slug apply.
 */
export function resolveAutoCompactLimit(
  selection: ModelSelection | null | undefined,
  limits: AutoCompactLimits,
  range: AutoCompactRange,
  modelSlug = selection?.model,
): number | undefined {
  const picked = getModelSelectionStringOptionValue(selection, AUTO_COMPACT_LIMIT_OPTION_ID);
  if (picked !== undefined && AUTO_COMPACT_LIMIT_IDS.includes(picked)) return Number(picked);
  if (selection == null || modelSlug === undefined) return undefined;
  return (
    modelLimit(limits, modelSlug, range) ??
    (modelSlug === selection.model ? undefined : modelLimit(limits, selection.model, range))
  );
}
