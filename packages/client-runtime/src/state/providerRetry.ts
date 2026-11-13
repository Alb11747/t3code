import type { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructureTurnItem } from "./models.ts";

// Fork: mirrors the server's ProviderRetryWindow, where overload retries stop a day after progress.
const PROVIDER_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ActiveProviderRetry {
  readonly attempt: number;
  readonly message: string;
  /** Null while the retry attempt is running. */
  readonly nextAttemptAt: string | null;
  readonly givesUpAt: string | null;
}

/**
 * The active run's open T3 overload retry. The provider's own bounded retries
 * (with `maxAttempts`) are brief and stay in the work log only.
 */
export function activeProviderRetry(
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  activeRunId: RunId | null,
): ActiveProviderRetry | null {
  if (activeRunId === null) return null;
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.type !== "error" || item.runId !== activeRunId || item.retry === undefined) continue;
    if (item.status !== "running" || item.retry.maxAttempts !== null) return null;
    const { retryDelayMs } = item.retry;
    return {
      attempt: item.retry.attempt,
      message: item.failure.message,
      nextAttemptAt:
        retryDelayMs === null || retryDelayMs === 0
          ? null
          : DateTime.formatIso(DateTime.add(item.updatedAt, { milliseconds: retryDelayMs })),
      givesUpAt:
        item.startedAt === null
          ? null
          : DateTime.formatIso(
              DateTime.add(item.startedAt, { milliseconds: PROVIDER_RETRY_WINDOW_MS }),
            ),
    };
  }
  return null;
}

/** Shared banner copy; `formatTime` renders an ISO instant for the client. */
export function providerRetryNotice(
  active: ActiveProviderRetry,
  formatTime: (iso: string) => string,
): { readonly title: string; readonly description: string } {
  const message = /[.!?]$/u.test(active.message) ? active.message : `${active.message}.`;
  const next =
    active.nextAttemptAt === null
      ? "Retrying now."
      : `Next attempt ${formatTime(active.nextAttemptAt)}.`;
  const limit =
    active.givesUpAt === null
      ? ""
      : ` Gives up ${formatTime(active.givesUpAt)} unless it recovers.`;
  return {
    title: `Retrying provider (attempt ${active.attempt})`,
    description: `${message} ${next}${limit}`,
  };
}
