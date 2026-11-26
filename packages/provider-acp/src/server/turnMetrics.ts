import type {
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Deferred from "effect/Deferred";
import type * as AcpSchema from "effect-acp/compat";

export interface AcpTurnMetrics {
  readonly startedAt: number;
  readonly model: string;
  readonly effort: string | null;
  readonly kind: "prompt" | "compact";
  readonly dispatches: Array<Deferred.Deferred<void>>;
  usageRepliesReceived: number;
  firstOutputAt: number | null;
  promptResponseAt: number | null;
  stopReason: AcpSchema.StopReason | null;
  lastUsageUpdate: { readonly used: number; readonly size: number } | null;
}

const formatTimestamp = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export function acpInputTokens(usage: AcpSchema.Usage, geminiUsage: boolean): number {
  return usage.inputTokens + (geminiUsage ? (usage.cachedReadTokens ?? 0) : 0);
}

export function acpTurnLogRecord(input: {
  readonly threadId: ThreadId;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly metrics: AcpTurnMetrics;
  readonly promptsDispatched: number;
  readonly completedAt: number;
  readonly usage: AcpSchema.Usage | undefined;
  readonly geminiUsage: boolean;
}) {
  const { metrics, usage, completedAt } = input;
  const cachedRead = usage?.cachedReadTokens;
  const inputTokens = usage === undefined ? 0 : acpInputTokens(usage, input.geminiUsage);
  const usageComplete = metrics.usageRepliesReceived === input.promptsDispatched;
  return {
    threadId: input.threadId,
    providerTurnId: input.providerTurnId,
    providerInstanceId: input.providerInstanceId,
    driver: input.driver,
    model: metrics.model,
    effort: metrics.effort,
    kind: metrics.kind,
    startedAt: formatTimestamp(metrics.startedAt),
    firstOutputAt: metrics.firstOutputAt === null ? null : formatTimestamp(metrics.firstOutputAt),
    promptResponseAt:
      metrics.promptResponseAt === null ? null : formatTimestamp(metrics.promptResponseAt),
    completedAt: formatTimestamp(completedAt),
    durationMs: Math.max(0, completedAt - metrics.startedAt),
    ttfoMs:
      metrics.firstOutputAt === null
        ? null
        : Math.max(0, metrics.firstOutputAt - metrics.startedAt),
    status: input.status,
    stopReason: metrics.stopReason,
    promptsDispatched: input.promptsDispatched,
    usageRepliesReceived: metrics.usageRepliesReceived,
    usageCoverage: usageComplete ? "complete" : "partial",
    usage:
      usage === undefined
        ? null
        : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            cachedReadTokens: usage.cachedReadTokens,
            cachedWriteTokens: usage.cachedWriteTokens,
            thoughtTokens: usage.thoughtTokens,
          },
    ...(usageComplete
      ? { cacheReadRate: cachedRead == null || inputTokens === 0 ? null : cachedRead / inputTokens }
      : {}),
    lastUsageUpdate: metrics.lastUsageUpdate,
  };
}
