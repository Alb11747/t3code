import * as DateTime from "effect/DateTime";

// Fork: overload retries give up a day after the run's last progress, so an
// outage or a request that never succeeds cannot hold a run open forever.
const PROVIDER_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const providerRetryWindowExpired = (startedAt: DateTime.Utc, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(startedAt) >= PROVIDER_RETRY_WINDOW_MS;

/** Shortens a backoff so the next attempt starts no later than the window's end. */
export const clampToProviderRetryWindow = (
  delayMs: number,
  startedAt: DateTime.Utc,
  now: DateTime.Utc,
) =>
  Math.max(
    0,
    Math.min(
      delayMs,
      DateTime.toEpochMillis(startedAt) + PROVIDER_RETRY_WINDOW_MS - DateTime.toEpochMillis(now),
    ),
  );
