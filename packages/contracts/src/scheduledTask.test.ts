import { vi } from "vite-plus/test";
import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
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
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

const encodeUpsertSchedule = Schema.encodeSync(ScheduledTaskUpsertSchedule);

const decodeSchedules = Schema.decodeUnknownSync(ForwardCompatibleArray(ScheduledTaskSchedule));

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

it("accepts null to clear a zone only on writes", () => {
  const schedule = { type: "fixed_time", timeOfDay: "04:00", timeZone: null };
  expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
  expect(encodeUpsertSchedule(decodeUpsertSchedule(schedule))).toEqual(schedule);
  expect(() => decodeSchedule(schedule)).toThrow();
});

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
