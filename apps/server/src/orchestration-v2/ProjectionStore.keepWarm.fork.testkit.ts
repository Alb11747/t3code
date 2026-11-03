import { assert } from "@effect/vitest";
import {
  EventId,
  RunId,
  TurnItemId,
  type ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export const verifyKeepWarmShell = Effect.fn("verifyKeepWarmShell")(function* (threadId: ThreadId) {
  const store = yield* ProjectionStoreV2;
  const initial = yield* store.getThreadProjection(threadId);
  const run = { ...initial.runs[0]!, status: "running" as const, completedAt: null };
  const at = initial.updatedAt;
  yield* store.apply({
    id: EventId.make("keep-warm:run"),
    type: "run.updated",
    threadId,
    occurredAt: at,
    payload: run,
  });
  const notice: Extract<OrchestrationV2TurnItem, { type: "system_notice" }> = {
    ...initial.turnItems[0]!,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    id: TurnItemId.make("keep-warm:notice"),
    runId: run.id,
    type: "system_notice" as const,
    title: "Stalled to keep cache warm",
    status: "running" as const,
    message: "Stalled to keep cache warm",
    keepWarm: {
      resetAt: "2026-11-03T16:00:00Z",
      releaseAt: "2026-11-03T15:59:00Z",
    },
  };
  let sequence = 0;
  const update = (payload: typeof notice) =>
    store.apply({
      id: EventId.make(`keep-warm:notice:${sequence++}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload,
    });
  const assertStalled = Effect.fnUntraced(function* (expected: boolean) {
    const listed = (yield* store.getShellSnapshot()).threads.find((shell) => shell.id === threadId);
    for (const shell of [yield* store.getThreadShell(threadId), listed]) {
      assert.equal(shell?.keepWarmStalled ?? false, expected);
    }
  });
  yield* assertStalled(false);
  yield* update({ ...notice, runId: RunId.make("keep-warm:older-run") });
  yield* assertStalled(false);
  yield* update(notice);
  yield* assertStalled(true);
  yield* update({ ...notice, status: "completed", completedAt: at });
  yield* assertStalled(false);
  yield* update(notice);
  yield* store.apply({
    id: EventId.make("keep-warm:run-completed"),
    type: "run.updated",
    threadId,
    occurredAt: at,
    payload: { ...run, status: "completed", completedAt: at },
  });
  yield* assertStalled(false);
});
