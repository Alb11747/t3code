import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

type CodexErrorInfo = CodexSchema.ServerNotification__CodexErrorInfo;

// After Codex gives up on capacity, throttling or transport failures, the run
// continues with empty-input turns until one makes progress. Waits start at 10s
// and double up to 3 minutes with no attempt cap; each is drawn from the upper
// half of its step so threads that failed together don't retry in lockstep.
export const codexOverloadRetryDelayMs = (attempt: number) => {
  const step = Math.min(10_000 * 2 ** (attempt - 1), 180_000);
  return Effect.map(Random.next, (draw) => step - Math.floor((draw * step) / 2));
};

const CODEX_RECOVERABLE_FAILURE_CODES = new Set([
  "serverOverloaded",
  "rateLimitExceeded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

function codexErrorCode(errorInfo: CodexErrorInfo | null | undefined): string | null {
  if (typeof errorInfo === "string") return errorInfo;
  return typeof errorInfo === "object" && errorInfo !== null
    ? (Object.keys(errorInfo)[0] ?? null)
    : null;
}

function codexHttpStatus(errorInfo: CodexErrorInfo | null | undefined): number | null {
  const detail =
    typeof errorInfo === "object" && errorInfo !== null ? Object.values(errorInfo)[0] : undefined;
  return detail !== undefined && "httpStatusCode" in detail
    ? (detail.httpStatusCode ?? null)
    : null;
}

/**
 * A client-error HTTP status other than 408 or 429 will fail the same way again.
 * A completion repeating the notified failure may omit the status it reported.
 */
function codexFailureRecoverable(
  errorInfo: CodexErrorInfo | null | undefined,
  notified: CodexErrorInfo | null | undefined,
): boolean {
  const code = codexErrorCode(errorInfo);
  if (code === null || !CODEX_RECOVERABLE_FAILURE_CODES.has(code)) return false;
  const status =
    codexHttpStatus(errorInfo) ??
    (codexErrorCode(notified) === code ? codexHttpStatus(notified) : null);
  return status === null || status < 400 || status >= 500 || status === 408 || status === 429;
}

/** Whether a failed root turn's failure gets an overload retry instead of settling the run. */
export function codexFailureRetryable(input: {
  readonly errorInfo: CodexErrorInfo | null | undefined;
  readonly notified: CodexErrorInfo | null | undefined;
  readonly usageLimitResetAt: string | null;
  readonly nowMs: number;
}): boolean {
  // A usage limit with an upcoming reset waits for limit recovery; without
  // one, nothing would ever resume the run, so it rechecks like a failure.
  const usageLimitWithoutReset =
    codexErrorCode(input.errorInfo) === "usageLimitExceeded" &&
    (input.usageLimitResetAt === null || Date.parse(input.usageLimitResetAt) <= input.nowMs);
  return codexFailureRecoverable(input.errorInfo, input.notified) || usageLimitWithoutReset;
}
