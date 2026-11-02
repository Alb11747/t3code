import { DateTime } from "effect";

export function claudeGatewayQuotaFailure(result: string, completedAtMs: number) {
  const limit = /\bquota_admission_limited: (Usage limit reached\b[^"\r\n]*)/.exec(result);
  if (limit === null) return null;
  const reset =
    /resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\./.exec(
      limit[1]!,
    );
  const resetMs = reset === null ? NaN : Date.parse(reset[1]!);
  return {
    message: limit[1]!.trim(),
    resetAt:
      Number.isFinite(resetMs) && resetMs > completedAtMs
        ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
        : null,
  };
}
