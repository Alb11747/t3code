import { describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ForwardCompatibleArray } from "./baseSchemas.ts";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeSchedules = Schema.decodeUnknownSync(ForwardCompatibleArray(ScheduledTaskSchedule));
const encodeUpsertSchedule = Schema.encodeSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("reads and resaves zones unsupported by the client's time-zone database", () => {
    const schedule = {
      type: "fixed_time",
      timeOfDay: "04:00",
      timeZone: "America/Coyhaique",
    } as const;
    const intl = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new RangeError("Time zone unavailable on this client");
    });
    try {
      expect(decodeSchedules([schedule])).toEqual([schedule]);
      expect(encodeUpsertSchedule(decodeUpsertSchedule(schedule))).toEqual(schedule);
    } finally {
      intl.mockRestore();
    }
  });

  it("keeps zoned tasks in lists decoded with the pre-timeZone schedule shape", () => {
    const legacySchedule = Schema.Struct({
      type: Schema.Literal("fixed_time"),
      timeOfDay: Schema.String,
      weekdays: Schema.optional(Schema.Array(Schema.Int)),
    });
    expect(
      Schema.decodeUnknownSync(ForwardCompatibleArray(legacySchedule))([
        { type: "fixed_time", timeOfDay: "04:00", timeZone: "UTC" },
      ]),
    ).toEqual([{ type: "fixed_time", timeOfDay: "04:00" }]);
  });

  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it.each([undefined, "UTC", "America/Toronto"])("accepts timeZone %s", (timeZone) => {
    const schedule = {
      type: "fixed_time",
      timeOfDay: "04:00",
      ...(timeZone ? { timeZone } : {}),
    };
    expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
    expect(decodeSchedule(schedule)).toEqual(schedule);
  });

  it("rejects an empty timeZone", () => {
    expect(() =>
      decodeUpsertSchedule({ type: "fixed_time", timeOfDay: "04:00", timeZone: "" }),
    ).toThrow();
  });

  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});
