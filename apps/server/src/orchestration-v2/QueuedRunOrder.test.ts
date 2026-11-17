import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      messages: [
        { id: "message:old", text: "old" },
        { id: "message:moved", text: "moved" },
        { id: "message:earlier-completion", delegatedCompletion, text: "Task completed" },
        { id: "message:later-completion", delegatedCompletion, text: "Task completed" },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });
  it("keeps steers ahead of request-ordered completions and compaction follow-ups next", () => {
    const projection = {
      messages: [
        { id: "message:completion", text: "Done", delegatedCompletion },
        { id: "message:steer", text: "Update" },
        { id: "message:compact", text: "/compact" },
        { id: "message:follow-up", text: "Continue" },
      ],
      runs: [
        {
          id: "run:completion",
          ordinal: 1,
          requestedAt: at("09:00:00"),
          status: "queued",
          userMessageId: "message:completion",
        },
        {
          id: "run:steer",
          ordinal: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:steer",
          deliveryIntent: "steer",
        },
        {
          id: "run:compact",
          ordinal: 3,
          requestedAt: at("10:01:00"),
          status: "running",
          userMessageId: "message:compact",
        },
        {
          id: "run:follow-up",
          ordinal: 4,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:follow-up",
          afterCompactionMessageId: "message:compact",
        },
      ],
    } as never;
    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:follow-up",
      "run:steer",
      "run:completion",
    ]);
  });
});
