import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it.each([
    "2026-03-07T04:00:00.000Z",
    "2026-03-08T04:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
    "2026-10-31T04:00:00.000Z",
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T04:00:00.000Z",
  ])("keeps 04:00 UTC across Toronto DST and rolls over the exact slot: %s", (instant) => {
    const from = DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(instant), "America/Toronto");
    const schedule = { type: "fixed_time", timeOfDay: "04:00", timeZone: "UTC" } as const;
    const beforeSlot = nextScheduledRunAt(schedule, DateTime.subtract(from, { milliseconds: 1 }));
    expect(beforeSlot && DateTime.formatIso(DateTime.toUtc(beforeSlot))).toBe(instant);
    const next = nextScheduledRunAt(schedule, from);
    expect(next && DateTime.formatIso(DateTime.toUtc(next))).toBe(
      DateTime.formatIso(DateTime.add(DateTime.toUtc(from), { days: 1 })),
    );
  });

  it("evaluates weekdays in the requested zone even when the server's date differs", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "00:30", timeZone: "Asia/Tokyo", weekdays: [1] },
      DateTime.setZoneNamedUnsafe(
        DateTime.makeUnsafe("2026-07-05T15:00:00.000Z"),
        "America/Toronto",
      ),
    );
    expect(next && DateTime.formatIso(DateTime.toUtc(next))).toBe("2026-07-05T15:30:00.000Z");
  });

  it.each([
    ["2026-03-07T09:00:00.000Z", "2026-03-08T08:00:00.000Z"],
    ["2026-10-31T08:00:00.000Z", "2026-11-01T09:00:00.000Z"],
  ])("keeps local DST behavior when timeZone is omitted: %s", (instant, expected) => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "04:00" },
      DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(instant), "America/Toronto"),
    );
    expect(next && DateTime.formatIso(DateTime.toUtc(next))).toBe(expected);
  });

  it("treats a zone-only edit as a schedule change", () => {
    const schedule = { type: "fixed_time", timeOfDay: "04:00", timeZone: "UTC" } as const;
    expect(isSameSchedule(schedule, { ...schedule })).toBe(true);
    expect(isSameSchedule(schedule, { ...schedule, timeZone: "America/Toronto" })).toBe(false);
    expect(isSameSchedule(schedule, { type: "fixed_time", timeOfDay: "04:00" })).toBe(false);
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
