import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  COMPACTION_SUGGESTION_MIN_TOKENS,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../../lib/contextWindow";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export interface ResumeCompaction {
  readonly usedTokens: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly sourceUpdatedAt: number;
}

export function resolveResumeCompactionContext(input: {
  readonly providerThread: OrchestrationV2ProviderThread | null;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly entries: Parameters<typeof deriveLatestContextWindowSnapshot>[0];
}) {
  const { providerThread } = input;
  if (providerThread === null) return null;
  const usage = latestProviderTurnTokenUsage(
    input.providerTurns.filter((turn) => turn.providerThreadId === providerThread.id),
  );
  const context = deriveLatestContextWindowSnapshot(
    input.entries.filter(({ item }) => item.providerThreadId === providerThread.id),
    usage,
    providerThread,
  );
  return context === null
    ? null
    : {
        usedTokens: context.usedTokens,
        updatedAt: context.updatedAt,
        promptCacheTtlMs: usage?.promptCacheTtlMs,
        sourceUpdatedAt: Math.max(
          DateTime.toEpochMillis(providerThread.updatedAt),
          Date.parse(context.updatedAt),
        ),
      };
}

export function resolveResumeCompactionProviderThread(input: {
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId | null;
}): OrchestrationV2ProviderThread | null {
  // Match the retained root conversation chosen by ProviderSwitchService.
  return (
    input.providerThreads
      .filter(
        (thread) =>
          thread.appThreadId === input.threadId &&
          thread.ownerNodeId === null &&
          thread.providerInstanceId === input.instanceId,
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null
  );
}

export function resumeCompactionTokensForSelection(input: {
  readonly resumeCompaction: ResumeCompaction | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId: ProviderInstanceId;
}): number | null {
  const { resumeCompaction } = input;
  return resumeCompaction !== null &&
    input.selectedProvider === "claudeAgent" &&
    input.selectedInstanceId === resumeCompaction.providerInstanceId
    ? resumeCompaction.usedTokens
    : null;
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
  );
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
