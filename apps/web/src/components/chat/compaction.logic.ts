import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";

function providerSupportsManualCompaction(
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

export function formatContextWindowCompactionMessage(autoCompactThreshold?: number | null): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return "Context compacts automatically when needed.";
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
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "ordinal" | "freshContext" | "status" | "startedAt" | "restartContinuationOfRunId"
    >
  >;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId | null;
}): OrchestrationV2ProviderThread | null {
  // Match Orchestrator's retained root selection across fresh-session boundaries.
  let boundary = 0;
  for (const run of input.runs) {
    const cancelledBeforeStart =
      run.status === "cancelled" &&
      run.startedAt === null &&
      run.restartContinuationOfRunId === undefined;
    if (run.freshContext === true && run.status !== "queued" && !cancelledBeforeStart) {
      boundary = Math.max(boundary, run.ordinal);
    }
  }
  return (
    input.providerThreads
      .filter(
        (thread) =>
          thread.appThreadId === input.threadId &&
          thread.ownerNodeId === null &&
          thread.providerInstanceId === input.instanceId &&
          (boundary === 0 ||
            (thread.firstRunOrdinal !== null && thread.firstRunOrdinal >= boundary)),
      )
      .toSorted(
        (left, right) =>
          (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
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
