import { assert, it } from "@effect/vitest";
import { claudeGatewayQuotaFailure } from "./claudeGatewayQuota.ts";

it.each([
  { reset: "2026-11-02T15:10:00Z", expected: "2026-11-02T15:10:00.000Z" },
  { reset: "2026-11-02T10:10:00-05:00", expected: "2026-11-02T15:10:00.000Z" },
  { reset: "2026-11-02T11:00:00Z", expected: null },
  { reset: "unknown", expected: null },
  { reset: "2026-11-02T15:10:00", expected: null },
])("reads the assigned-account gateway reset $reset", ({ reset, expected }) => {
  const message = `Usage limit reached (5h); resets at ${reset}. Retry after this reset.`;
  const result = `API Error: 503 ${JSON.stringify({ error: { type: "server_error", message: `quota_admission_limited: ${message}` } })}`;
  assert.deepEqual(claudeGatewayQuotaFailure(result, Date.parse("2026-11-02T12:00:00Z")), {
    message,
    resetAt: expected,
  });
});

it("keeps an unknown assigned-account reset unknown", () => {
  assert.deepEqual(
    claudeGatewayQuotaFailure(
      "API Error: 503 quota_admission_limited: Usage limit reached; retry after quota resets.",
      0,
    ),
    { message: "Usage limit reached; retry after quota resets.", resetAt: null },
  );
  assert.isNull(
    claudeGatewayQuotaFailure("API Error: 503 internal_server_error: service unavailable", 0),
  );
});
