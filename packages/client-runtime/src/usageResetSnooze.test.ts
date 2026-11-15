import type {
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  lastUsedAccountWindows,
  usageResetSnoozeOptionOf,
  usageResetSnoozeOptions,
} from "./usageResetSnooze.ts";

const reading = (
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  windowDurationMins?: number,
): ServerProviderUsageWindow => ({
  id: label,
  kind,
  label,
  usedPercent: 10,
  ...(windowDurationMins ? { windowDurationMins } : {}),
});
const SESSION = reading("session", "Session", 300);
const WEEKLY = reading("weekly", "Weekly", 10_080);

const provider = (usageLimits: object | undefined) =>
  ({ driver: "codex", usageLimits }) as unknown as ServerProvider;
const hub = (windows: ServerProviderUsageWindow[]) =>
  [
    {
      accounts: [
        { driver: "claudeAgent", usageLimits: { windows: [reading("other", "Pool")] } },
        { driver: "codex", usageLimits: { windows } },
      ],
    },
  ] as unknown as UsageLimitSourceSnapshots;
const labels = (target: ServerProvider, sources: UsageLimitSourceSnapshots = []) =>
  usageResetSnoozeOptions(lastUsedAccountWindows(target, sources)).map((option) => option.label);

describe("usageResetSnoozeOptions", () => {
  it.each([
    ["both windows", provider({ windows: [WEEKLY, SESSION] }), [], ["(5h)", "(Weekly)"]],
    [
      "a session of unknown length",
      provider({ windows: [reading("session", "Session")] }),
      [],
      ["(Session)"],
    ],
    [
      "only windows it cannot snooze to",
      provider({ windows: [reading("monthly", "Monthly")] }),
      [],
      [""],
    ],
    ["no readings", provider({ windows: [], unavailable: { reason: "unsupported" } }), [], [""]],
    [
      "no readings behind a hub",
      provider({ windows: [], unavailable: { reason: "unsupported" } }),
      hub([SESSION, WEEKLY]),
      ["(5h)", "(Weekly)"],
    ],
    [
      "its own readings before its hub's",
      provider({ windows: [WEEKLY] }),
      hub([SESSION]),
      ["(Weekly)"],
    ],
  ] as const)("offers %s", (_, target, sources, suffixes) => {
    expect(labels(target, sources)).toEqual(
      suffixes.map((suffix) => `Until usage resets${suffix ? ` ${suffix}` : ""}`),
    );
  });

  it("maps each option's action back to its window", () => {
    const options = usageResetSnoozeOptions([SESSION, WEEKLY]);
    expect(options.map((option) => usageResetSnoozeOptionOf(option.id))).toEqual([
      { window: "session" },
      { window: "weekly" },
    ]);
    expect(usageResetSnoozeOptionOf(usageResetSnoozeOptions([])[0]!.id)).toEqual({});
    expect(usageResetSnoozeOptionOf("snooze:custom")).toBeUndefined();
  });
});
