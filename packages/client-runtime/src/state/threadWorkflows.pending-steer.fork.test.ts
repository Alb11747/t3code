import { expect, it } from "vite-plus/test";

import { deriveThreadQueueWorkflowState } from "./threadWorkflows.ts";

it.each(["auto", "steer"])(
  "shows retained %s as Pending and explicit Queue as Queued during a handoff",
  (intent) => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        { id: "active", status: "starting", ordinal: 1 },
        { id: "queue", status: "queued", ordinal: 2, userMessageId: "queue" },
        {
          id: "steer",
          status: "queued",
          ordinal: 3,
          userMessageId: "steer",
          deliveryIntent: intent,
        },
      ],
      messages: [
        { id: "queue", text: "Later" },
        { id: "steer", text: "Correction" },
      ],
      providerThreads: [],
      providerTurns: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ text, deliveryLabel }) => ({ text, deliveryLabel }))).toEqual([
      { text: "Later", deliveryLabel: "Queued" },
      { text: "Correction", deliveryLabel: "Pending" },
    ]);
  },
);
