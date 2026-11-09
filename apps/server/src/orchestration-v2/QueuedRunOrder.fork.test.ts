import { expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

it("delivers pending steering before completion notices while explicit Queue keeps its order", () => {
  const projection = {
    messages: [
      { id: "queue-first", text: "First" },
      { id: "completion", text: "Completed", delegatedCompletion: { taskIds: ["child"] } },
      { id: "auto", text: "Auto" },
      { id: "steer", text: "Steer" },
      { id: "queue-last", text: "Last" },
      { id: "goal", text: "/goal finish the work", attachments: [] },
    ],
    runs: [
      { id: "queue-first", userMessageId: "queue-first", ordinal: 1, status: "queued" },
      { id: "completion", userMessageId: "completion", ordinal: 2, status: "queued" },
      { id: "auto", userMessageId: "auto", ordinal: 3, status: "queued", deliveryIntent: "auto" },
      {
        id: "steer",
        userMessageId: "steer",
        ordinal: 4,
        status: "queued",
        deliveryIntent: "steer",
      },
      { id: "queue-last", userMessageId: "queue-last", ordinal: 5, status: "queued" },
      { id: "goal", userMessageId: "goal", ordinal: 6, status: "queued", queuePosition: 1 },
    ],
  } as never;

  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
    "goal",
    "auto",
    "steer",
    "completion",
    "queue-first",
    "queue-last",
  ]);
});
