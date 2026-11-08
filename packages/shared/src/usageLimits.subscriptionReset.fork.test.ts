import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitAccounts } from "./usageLimits.ts";

describe("subscription reset displays", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const early = "2026-09-03T14:00:00.000Z";
  const late = "2026-09-06T12:00:00.000Z";
  it.each([
    {
      end: "2026-09-03T13:00:00.000Z",
      session: "2026-09-03T13:00:00.000Z",
      weekly: "2026-09-03T13:00:00.000Z",
    },
    { end: "2026-09-04T00:00:00.000Z", session: early, weekly: "2026-09-04T00:00:00.000Z" },
    { end: late, session: early, weekly: late },
    { end: undefined, session: early, weekly: late },
  ])("uses the earlier of end $end and each provider reset", ({ end, session, weekly }) => {
    const windows = [
      { id: "5h", kind: "session", label: "Session", usedPercent: 12, resetsAt: early },
      { id: "7d", kind: "weekly", label: "Weekly", usedPercent: 34, resetsAt: late },
      { id: "scoped", kind: "weekly", label: "Scoped", usedPercent: 56 },
      { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 78, resetsAt: late },
    ] as const;
    const limits = { checkedAt, windows };
    const result = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("local"),
          {
            entry: { target: { label: "Local" } },
            serverConfig: {
              providers: [],
              usageLimitSources: [
                {
                  id: UsageLimitSourceId.make("hub"),
                  kind: "cliproxy",
                  label: "Hub",
                  checkedAt,
                  accounts: ["claudeAgent", "codex"].map((driver) => ({
                    id: `${driver}.json`,
                    driver: ProviderDriverKind.make(driver),
                    subscriptionEndsAt: end,
                    usageLimits: limits,
                  })),
                },
              ],
            },
          },
        ],
      ]),
    );
    expect(result.map((account) => account.limits.windows)).toEqual(
      ["claudeAgent", "codex"].map(() => [
        { ...windows[0], resetsAt: session },
        { ...windows[1], resetsAt: weekly },
        { ...windows[2], ...(end ? { resetsAt: end } : {}) },
        windows[3],
      ]),
    );
    expect(limits.windows[1].resetsAt).toBe(late);
  });
});
