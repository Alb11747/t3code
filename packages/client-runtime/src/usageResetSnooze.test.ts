import type { UsageResetSnooze } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsageResetSnoozeOptions, usageResetSnoozeOptions } from "./usageResetSnooze.ts";

const answer = (windows?: UsageResetSnooze["windows"]): UsageResetSnooze => ({
  resetsAt: "2026-11-16T00:00:00.000Z",
  basis: "account",
  ...(windows ? { windows } : {}),
});
const SESSION = {
  window: "session",
  resetsAt: "2026-11-15T15:00:00.000Z",
  windowDurationMins: 300,
} as const;
const WEEKLY = { window: "weekly", resetsAt: "2026-11-20T00:00:00.000Z" } as const;

describe("usageResetSnoozeOptions", () => {
  it.each([
    [
      "each window of the thread's account",
      answer([SESSION, WEEKLY]),
      [
        {
          id: "snooze:usage-reset:session",
          label: "Until usage resets (5h)",
          snoozedUntil: SESSION.resetsAt,
        },
        {
          id: "snooze:usage-reset:weekly",
          label: "Until usage resets (Weekly)",
          snoozedUntil: WEEKLY.resetsAt,
        },
      ],
    ],
    // An older server sends no windows, and would ignore a requested one.
    [
      "one any-reset option for a server without windows",
      answer(),
      [
        {
          id: "snooze:usage-reset",
          label: "Until usage resets",
          snoozedUntil: "2026-11-16T00:00:00.000Z",
        },
      ],
    ],
    [
      "one any-reset option for an account without windows",
      answer([]),
      [
        {
          id: "snooze:usage-reset",
          label: "Until usage resets",
          snoozedUntil: "2026-11-16T00:00:00.000Z",
        },
      ],
    ],
    [
      "an option that asks again without an answer",
      undefined,
      [{ id: "snooze:usage-reset", label: "Until usage resets" }],
    ],
  ] as const)("offers %s", (_, input, expected) => {
    expect(usageResetSnoozeOptions(input)).toEqual(expected);
  });

  it("merges several threads' options once each, any-reset last", () => {
    const merged = mergeUsageResetSnoozeOptions([
      usageResetSnoozeOptions(answer()),
      usageResetSnoozeOptions(answer([WEEKLY])),
      usageResetSnoozeOptions(answer([SESSION, WEEKLY])),
    ]);
    expect(merged.map((option) => option.id)).toEqual([
      "snooze:usage-reset:session",
      "snooze:usage-reset:weekly",
      "snooze:usage-reset",
    ]);
  });
});
