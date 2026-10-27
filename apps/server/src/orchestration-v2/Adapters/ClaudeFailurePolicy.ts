import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import { field, text } from "../unknownField.ts";

export const CLAUDE_PERMANENT_FAILURE_CODES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "cloud_credential_error",
  "max_output_tokens",
  "executable_launch_failed",
  "executable_not_found",
  "configuration_error",
  "aborted",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOEXEC",
  "ENOTDIR",
  "EINVAL",
]);

export function claudeFailureRecoverable(
  failure: OrchestrationV2ProviderFailure,
  previous?: OrchestrationV2ProviderFailure,
): boolean {
  if (
    failure.class === "usage_limit" ||
    failure.retryable === false ||
    (failure.code !== null && CLAUDE_PERMANENT_FAILURE_CODES.has(failure.code))
  )
    return false;
  return (
    claudeTransientEvidence(failure) ??
    (failure.retryable === true ||
      failure.class === "transport_error" ||
      (previous !== undefined && claudeFailureRecoverable(previous)))
  );
}

/** Whether the failure names an HTTP status or network error; undefined when it names neither. */
function claudeTransientEvidence(failure: OrchestrationV2ProviderFailure): boolean | undefined {
  const status =
    /^api_error_(\d+)$/.exec(failure.code ?? "")?.[1] ??
    /API Error:\s*(?:Repeated\s+)?(\d{3})\b/i.exec(failure.message)?.[1];
  if (status !== undefined) return Number(status) === 408 || Number(status) >= 500;
  return /connection error|connection (?:failed|closed|reset|refused)|request timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network error/i.test(
    failure.message,
  )
    ? true
    : undefined;
}

/** `sdkError` says whether `cause` is the query runner's error wrapping the native one. */
export function claudeQueryErrorFailure(
  cause: unknown,
  sdkError: boolean,
  receivedInit: boolean,
): OrchestrationV2ProviderFailure {
  const nativeError = sdkError ? field(cause, "cause") : cause;
  const status = field(nativeError, "status");
  const errorClass = text(field(nativeError, "errorClass"));
  const nativeCode = text(field(nativeError, "code"));
  const permanentCode = [errorClass, nativeCode].find(
    (code) => code !== undefined && CLAUDE_PERMANENT_FAILURE_CODES.has(code),
  );
  const failure = makeProviderFailure({
    cause,
    class:
      status === 429
        ? "usage_limit"
        : sdkError || cause === undefined
          ? "transport_error"
          : "provider_error",
    code:
      permanentCode ??
      (typeof status === "number" ? `api_error_${status}` : (errorClass ?? nativeCode)),
    retryable: !sdkError || field(nativeError, "startupFatal") === true ? false : null,
  });
  // A crash before init is permanent unless its output names a transient network or server error.
  if (
    errorClass === "process_exited_nonzero" &&
    !receivedInit &&
    claudeTransientEvidence({
      ...failure,
      message: text(field(nativeError, "message")) ?? failure.message,
    }) !== true
  ) {
    return { ...failure, retryable: false };
  }
  return { ...failure, retryable: claudeFailureRecoverable(failure) };
}

export const claudeOverloadRetryDelayMs = (attempt: number) => {
  const step = Math.min(10_000 * 2 ** (attempt - 1), 180_000);
  return Effect.map(Random.next, (draw) => step - Math.floor((draw * step) / 2));
};
