import { expect, it } from "@effect/vitest";

import { claudeQuestionWaitWindow } from "./ClaudeQuestionWait.ts";

const minute = 60_000;

it.each([
  { name: "one-hour cache", ttl: 60, requestedAt: 10, minAt: 15, maxAt: 69 },
  { name: "five-minute cache", ttl: 5, requestedAt: 10, minAt: 14, maxAt: 14 },
  { name: "unknown cache lifetime", ttl: undefined, requestedAt: 8, minAt: 15, maxAt: 67 },
  { name: "no request timestamp", ttl: undefined, requestedAt: undefined, minAt: 15, maxAt: 69 },
  { name: "expired cache", ttl: 5, requestedAt: 3, minAt: 15, maxAt: 70 },
  { name: "warm cache inside the margin", ttl: 5, requestedAt: 5.5, minAt: 10, maxAt: 10 },
  { name: "configured limits", ttl: 60, requestedAt: 10, min: 2, max: 20, minAt: 12, maxAt: 30 },
])("bounds the wait with $name", ({ ttl, requestedAt, min, max, minAt, maxAt }) => {
  expect(
    claudeQuestionWaitWindow({
      askedAtMs: 10 * minute,
      requestedAtMs: requestedAt === undefined ? undefined : requestedAt * minute,
      promptCacheTtlMs: ttl === undefined ? undefined : ttl * minute,
      minWaitMinutes: min ?? 5,
      maxWaitMinutes: max ?? 60,
    }),
  ).toEqual({ minAtMs: minAt * minute, maxAtMs: maxAt * minute });
});
