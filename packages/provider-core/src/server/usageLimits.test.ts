import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("merges credit-only changes, preserves omitted balances and clears explicit null", () => {
    const creditBalance = { balance: "10.50", hasCredits: true, unlimited: false };
    const previous = {
      ...published,
      creditBalance,
      extraUsage: { used: 1, limit: 10, currency: "USD" },
    };
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [], creditBalance: { ...creditBalance } },
      }),
    ).toBe(previous);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, usedPercent: 55 }] },
      }),
    ).toMatchObject({ creditBalance, extraUsage: previous.extraUsage });
    const changed = applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [], creditBalance: { ...creditBalance, balance: "0" } },
    });
    expect(changed?.creditBalance?.balance).toBe("0");
    expect(
      applyUsageLimitsUpdate({ previous, checkedAt, update: { windows: [], creditBalance: null } })
        ?.creditBalance,
    ).toBeUndefined();
  });

  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe: published, published: live, probed }),
    ).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const creditBalance = { balance: "3.50", hasCredits: true, unlimited: false };
    const withCredits = { ...probed, creditBalance };
    expect(
      resolveUsageLimitsAfterProbe({
        beforeProbe: published,
        published: { ...live, creditBalance },
        probed,
      })?.creditBalance,
    ).toEqual(creditBalance);
    expect(
      resolveUsageLimitsAfterProbe({ published: live, probed: withCredits, beforeProbe: published })
        ?.creditBalance,
    ).toEqual(creditBalance);
    const oldCredits = { ...creditBalance, balance: "9.00" };
    const beforeProbe = { ...published, creditBalance: oldCredits };
    expect(
      resolveUsageLimitsAfterProbe({
        beforeProbe,
        published: { ...live, creditBalance: oldCredits },
        probed: withCredits,
      })?.creditBalance,
    ).toEqual(creditBalance);
    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe, published: live, probed: withCredits })
        ?.creditBalance,
    ).toBeUndefined();

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe: published, published: live, probed: sameTime }),
    ).toEqual(sameTime);
    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe: published, published: live, probed: newer }),
    ).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe: published, published, probed: failed }),
    ).toBe(published);
    expect(
      resolveUsageLimitsAfterProbe({ beforeProbe: published, published, probed: unsupported }),
    ).toBe(unsupported);
    expect(
      resolveUsageLimitsAfterProbe({
        beforeProbe: undefined,
        published: undefined,
        probed: failed,
      }),
    ).toBe(failed);
  });
});
