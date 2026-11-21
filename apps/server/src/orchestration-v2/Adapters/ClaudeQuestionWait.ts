/**
 * Fork: a Claude question holds its turn open between a minimum and a maximum wait. The maximum
 * stays a minute short of the prompt cache's expiry, so the request that follows still reads it.
 */
import type { OrchestrationV2Actor, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

const MINUTE_MS = 60_000;
// The cache must still be warm when the request after the question is sent.
const CACHE_EXPIRY_MARGIN_MS = MINUTE_MS;
// Claude normally caches the main conversation for an hour.
const ASSUMED_PROMPT_CACHE_TTL_MS = 60 * MINUTE_MS;

export interface ClaudeQuestionInterrupter {
  readonly createdBy: OrchestrationV2Actor;
  readonly senderThreadId?: ThreadId | undefined;
}

export interface ClaudeQuestionWait {
  readonly askedAtMs: number;
  readonly minAtMs: number;
  deadlineMs: number;
  interrupter: ClaudeQuestionInterrupter | undefined;
  wake: Deferred.Deferred<void>;
}

export function claudeQuestionWaitWindow(input: {
  readonly askedAtMs: number;
  /** When the request that asked the question started, which starts its cache lifetime. */
  readonly requestedAtMs: number | undefined;
  readonly promptCacheTtlMs: number | undefined;
  readonly minWaitMinutes: number;
  readonly maxWaitMinutes: number;
}): { readonly minAtMs: number; readonly maxAtMs: number } {
  const configuredMaxAtMs = input.askedAtMs + input.maxWaitMinutes * MINUTE_MS;
  const cacheExpiresAtMs =
    (input.requestedAtMs ?? input.askedAtMs) +
    (input.promptCacheTtlMs ?? ASSUMED_PROMPT_CACHE_TTL_MS);
  // A cache that expires before the question appears is lost either way, so the cap no longer helps.
  // One still warm but inside the margin ends the wait at once.
  const maxAtMs =
    cacheExpiresAtMs > input.askedAtMs
      ? Math.min(
          configuredMaxAtMs,
          Math.max(input.askedAtMs, cacheExpiresAtMs - CACHE_EXPIRY_MARGIN_MS),
        )
      : configuredMaxAtMs;
  return {
    minAtMs: Math.min(input.askedAtMs + input.minWaitMinutes * MINUTE_MS, maxAtMs),
    maxAtMs,
  };
}

export const makeClaudeQuestionWait = Effect.fnUntraced(function* (window: {
  readonly askedAtMs: number;
  readonly minAtMs: number;
  readonly maxAtMs: number;
}) {
  const wait: ClaudeQuestionWait = {
    askedAtMs: window.askedAtMs,
    minAtMs: window.minAtMs,
    deadlineMs: window.maxAtMs,
    interrupter: undefined,
    wake: yield* Deferred.make<void>(),
  };
  return wait;
});

/** A person's message ends the wait now; an agent's or the system's ends it once the minimum has passed. */
export const interruptClaudeQuestionWait = Effect.fnUntraced(function* (
  wait: ClaudeQuestionWait,
  interrupter: ClaudeQuestionInterrupter,
) {
  const nowMs = yield* Clock.currentTimeMillis;
  if (interrupter.createdBy === "user") {
    wait.interrupter = interrupter;
    wait.deadlineMs = Math.min(wait.deadlineMs, nowMs);
  } else if (wait.interrupter === undefined) {
    wait.interrupter = interrupter;
    wait.deadlineMs = Math.min(wait.deadlineMs, Math.max(nowMs, wait.minAtMs));
  } else {
    return;
  }
  const wake = wait.wake;
  wait.wake = yield* Deferred.make<void>();
  yield* Deferred.succeed(wake, undefined);
});

/** Waits until `settled` finishes or the wait's deadline passes, rechecking whenever it is interrupted. */
export const awaitClaudeQuestionWait = Effect.fnUntraced(function* <A>(
  wait: ClaudeQuestionWait,
  settled: Effect.Effect<A>,
) {
  while (true) {
    const remainingMs = wait.deadlineMs - (yield* Clock.currentTimeMillis);
    if (remainingMs <= 0) return { type: "unanswered" as const };
    const outcome = yield* Effect.raceFirst(
      settled.pipe(Effect.map((value) => ({ type: "settled" as const, value }))),
      Deferred.await(wait.wake).pipe(
        Effect.timeoutOption(remainingMs),
        Effect.as({ type: "wake" as const }),
      ),
    );
    if (outcome.type === "settled") return outcome;
  }
});

function formatWaitDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function interrupterDescription(interrupter: ClaudeQuestionInterrupter | undefined): string {
  if (interrupter === undefined) return "no reply arrived within the wait limit";
  if (interrupter.createdBy === "user") return "the user sent a message instead of answering";
  if (interrupter.senderThreadId !== undefined)
    return `the agent in T3 thread ${JSON.stringify(interrupter.senderThreadId)} sent a message`;
  return interrupter.createdBy === "agent"
    ? "an agent sent a message"
    : "T3 Code sent a system message";
}

export function formatClaudeQuestionNoAnswer(input: {
  readonly waitedMs: number;
  readonly interrupter: ClaudeQuestionInterrupter | undefined;
}): string {
  return [
    `No answer after ${formatWaitDuration(input.waitedMs)}: ${interrupterDescription(input.interrupter)}.`,
    " The question stays open in T3 Code, and the user's answer will arrive later as a user message.",
    " Continue with work that does not depend on the answer, or end your turn if the answer is essential.",
  ].join("");
}
