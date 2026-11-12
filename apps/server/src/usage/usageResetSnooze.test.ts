import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { accountResetAtMs, soonestHubReset } from "./usageResetSnooze.ts";

const CLAUDE = "claudeAgent" as ProviderDriverKind;
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (hours: number) => iso(NOW + hours * 3_600_000);
const window = (id: string, usedPercent: number, resetsAt?: string): ServerProviderUsageWindow => ({
  id,
  kind: id === "five_hour" ? "session" : "weekly",
  label: id,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});
const limits = (...windows: ServerProviderUsageWindow[]) => ({ checkedAt: at(0), windows });

describe("accountResetAtMs", () => {
  it.each([
    [
      "not blocked: soonest upcoming reset",
      [window("five_hour", 40, at(2)), window("seven_day", 90, at(30))],
      at(2),
    ],
    [
      "blocked weekly outranks a sooner five-hour reset",
      [window("five_hour", 10, at(2)), window("seven_day", 100, at(30))],
      at(30),
    ],
    [
      "both blocked: the later reset",
      [window("five_hour", 100, at(2)), window("seven_day", 100, at(30))],
      at(30),
    ],
    [
      "blocked with an unknown reset is unknown",
      [window("five_hour", 40, at(2)), window("seven_day", 100)],
      null,
    ],
    [
      "a blocking window whose reset passed no longer blocks",
      [window("five_hour", 100, at(-1)), window("seven_day", 50, at(30))],
      at(30),
    ],
    ["no upcoming resets", [window("five_hour", 20)], null],
    [
      "another model's exhausted weekly allowance does not block",
      [window("five_hour", 40, at(2)), window("seven_day_fable", 100, at(30))],
      at(2),
    ],
    [
      "this model's exhausted weekly allowance blocks",
      [window("five_hour", 40, at(2)), window("seven_day_opus", 100, at(30))],
      at(30),
    ],
    [
      "an exhausted extra-usage spend cap does not block",
      [window("five_hour", 40, at(2)), window("monthly_spend", 100)],
      at(2),
    ],
  ] as const)("%s", (_, windows, expected) => {
    const result = accountResetAtMs(CLAUDE, limits(...windows), "claude-opus-5-5", NOW);
    expect(result === null ? null : iso(result)).toBe(expected);
  });

  it("ignores another model family's exhausted Antigravity pool", () => {
    const pools = limits(window("gemini-weekly", 100, at(1)), window("3p-weekly", 100, at(72)));
    const recovery = (model: string) =>
      accountResetAtMs("antigravity" as ProviderDriverKind, pools, model, NOW);
    expect(recovery("gemini-3-pro")).toBe(Date.parse(at(1)));
    expect(recovery("claude-opus-5-5")).toBe(Date.parse(at(72)));
  });

  it("knows no reset when no reported window gates the model", () => {
    const goOnly = limits(window("go_weekly", 40, at(5)));
    expect(
      accountResetAtMs("opencode" as ProviderDriverKind, goOnly, "opencode/big-pickle", NOW),
    ).toBeNull();
  });

  it("uses pools that only gate a model together", () => {
    const pools = limits(window("apiPercentUsed", 40, at(5)), window("autoPercentUsed", 40, at(9)));
    expect(accountResetAtMs("cursor" as ProviderDriverKind, pools, "auto", NOW)).toBe(
      Date.parse(at(5)),
    );
  });

  it("reports a usable model's own next reset, not an unrelated pool's", () => {
    const pools = limits(window("gemini-weekly", 20, at(72)), window("3p-weekly", 100, at(1)));
    expect(accountResetAtMs("antigravity" as ProviderDriverKind, pools, "gemini-3-pro", NOW)).toBe(
      Date.parse(at(72)),
    );
  });

  it("treats unavailable readings as unknown", () => {
    expect(
      accountResetAtMs(
        CLAUDE,
        { ...limits(window("five_hour", 20, at(1))), unavailable: { reason: "probeFailed" } },
        "claude-opus-5-5",
        NOW,
      ),
    ).toBeNull();
  });
});

describe("soonestHubReset", () => {
  const account = (
    id: string,
    resetsAt: string,
    subscriptionEndsAt?: string,
  ): UsageLimitSourceAccount =>
    ({
      id,
      driver: "claudeAgent",
      ...(subscriptionEndsAt ? { subscriptionEndsAt } : {}),
      usageLimits: limits(window("five_hour", 100, resetsAt)),
    }) as unknown as UsageLimitSourceAccount;

  it("picks the account that recovers first", () => {
    expect(
      soonestHubReset(
        [account("claude-a.json", at(4)), account("claude-b.json", at(3))],
        "claude-opus-5-5",
        NOW,
      ),
    ).toEqual({ resetsAtMs: Date.parse(at(3)), accountLabel: "claude-b" });
  });

  it("skips an account whose subscription ends before its reset", () => {
    expect(
      soonestHubReset(
        [account("claude-a.json", at(1), at(0.5)), account("claude-b.json", at(4))],
        "claude-opus-5-5",
        NOW,
      ),
    ).toEqual({ resetsAtMs: Date.parse(at(4)), accountLabel: "claude-b" });
  });
});
