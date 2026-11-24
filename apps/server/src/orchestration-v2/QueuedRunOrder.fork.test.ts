import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { queuedAgentReportBatch, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

it.each([
  { label: "follows the reordered queue", text: "Earlier report", expected: ["earlier"] },
  {
    label: "stops before a report that follows a different model policy",
    text: "Earlier report",
    followsThreadSelection: true,
    expected: [],
  },
  { label: "stops before inline skills", text: "Please $review the diff", expected: [] },
  {
    label: "stops before quotes make the batch too long",
    text:
      "x".repeat(15_000) +
      serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("assistant"),
        text: "\u0001".repeat(8_000),
        start: 0,
        end: 8_000,
        prefix: "",
        suffix: "",
      }),
    expected: [],
  },
])("$label when batching queued reports", ({ text, expected, followsThreadSelection }) => {
  const messages = [
    { id: "earlier", text, followsThreadSelection },
    { id: "later", text: "y".repeat(65_000) },
  ].map((message) => ({
    ...message,
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: "sender",
    attachments: [],
  }));
  const runs = messages.map((message, index) => ({
    id: message.id,
    userMessageId: message.id,
    threadId: "receiver",
    providerThreadId: "provider",
    ordinal: index + 1,
    queuePosition: 2 - index,
    startedAt: null,
    requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    modelSelection: { instanceId: "claude", model: "model" },
    status: "queued",
  }));

  const batch = queuedAgentReportBatch(
    { runs, messages } as never,
    runs[1] as never,
    messages[1] as never,
  );
  expect(batch.map(({ message }) => message.id)).toEqual(expected);
});

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
    ].map((run) => ({ ...run, requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") })),
  } as never;

  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
    "goal",
    "auto",
    "steer",
    // Requested in the same millisecond: commit order.
    "queue-first",
    "completion",
    "queue-last",
  ]);
});

it("starts a steer that missed its tool boundary ahead of an older queued message", () => {
  const projection = {
    messages: [
      { id: "queued", text: "Queued earlier" },
      { id: "steer", text: "Missed the boundary", atToolBoundary: true },
    ],
    runs: [
      { id: "queued", userMessageId: "queued", ordinal: 1, status: "queued" },
      { id: "steer", userMessageId: "steer", ordinal: 2, status: "queued" },
    ].map((run, index) => ({
      ...run,
      requestedAt: DateTime.makeUnsafe(`2026-01-01T00:00:0${index}Z`),
    })),
  } as never;

  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual(["steer", "queued"]);
});

it("breaks a same-millisecond tie between a message and a completion by commit order", () => {
  const projection = {
    messages: [
      { id: "steer", text: "Steer", atToolBoundary: true },
      {
        id: "completion",
        text: "Completed",
        atToolBoundary: true,
        delegatedCompletion: { taskIds: ["child"] },
      },
    ],
    runs: [
      { id: "steer", userMessageId: "steer", ordinal: 1, status: "queued" },
      { id: "completion", userMessageId: "completion", ordinal: 2, status: "queued" },
    ].map((run) => ({ ...run, requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") })),
  } as never;

  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
    "steer",
    "completion",
  ]);
});

it("lifts a missed-boundary steer past older messages without moving a completion past them", () => {
  const projection = {
    messages: [
      { id: "queued", text: "Queued first" },
      { id: "completion", text: "Completed", delegatedCompletion: { taskIds: ["child"] } },
      { id: "steer", text: "Missed the boundary", atToolBoundary: true },
    ],
    runs: [
      { id: "queued", userMessageId: "queued", ordinal: 1, status: "queued" },
      { id: "completion", userMessageId: "completion", ordinal: 2, status: "queued" },
      { id: "steer", userMessageId: "steer", ordinal: 3, status: "queued" },
    ].map((run, index) => ({
      ...run,
      requestedAt: DateTime.makeUnsafe(`2026-01-01T00:00:0${index}Z`),
    })),
  } as never;

  expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
    "steer",
    "queued",
    "completion",
  ]);
});
