import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { pacedUntil } from "../usage/pacedSessions.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test" };
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "paced-hold" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Paced tests must not open a provider process"),
    } as ProviderAdapter.ProviderAdapterV2["Service"],
  ]),
  { runEffectWorker: false },
);

it.effect("a paced hold keeps the next turn queued until it is cleared", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:paced-hold");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:paced-hold"),
      projectId: ProjectId.make("project:paced-hold"),
      threadId,
      title: "Paced hold",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      paced: { windows: ["5h"] },
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`dispatch:${id}`),
        messageId: MessageId.make(id),
        threadId,
        text: "Low-importance work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    yield* send("first-turn");
    const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:paced-first-turn-done"),
          type: "run.updated",
          threadId,
          runId: first.id,
          occurredAt: now,
          payload: { ...first, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    const later = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("hold:paced-hold"),
      threadId,
      pacedUntil: later,
    });
    yield* send("paced-message");
    const held = yield* orchestrator.getThreadProjection(threadId);
    expect(held.thread.paced).toEqual({ windows: ["5h"] });
    expect(held.runs.map((run) => run.status)).toEqual(["completed", "queued"]);

    // Send now is the user's override; the hold stays for later turns.
    const queued = held.runs.find((run) => run.status === "queued")!;
    yield* orchestrator.dispatch({
      type: "queued-run.start",
      commandId: CommandId.make("send-now:paced-hold"),
      threadId,
      runId: queued.id,
    });
    const sentNow = yield* orchestrator.getThreadProjection(threadId);
    expect(sentNow.runs.map((run) => run.status)).toEqual(["completed", "starting"]);
    expect(sentNow.thread.pacedUntil).toBe(later);
    const second = sentNow.runs[1]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:paced-second-turn-done"),
          type: "run.updated",
          threadId,
          runId: second.id,
          occurredAt: now,
          payload: { ...second, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* send("paced-again");

    // Turning pacing off ends the hold and starts the queue.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("unpace:paced-hold"),
      threadId,
      paced: null,
    });
    const released = yield* orchestrator.getThreadProjection(threadId);
    expect(released.thread.pacedUntil).toBeNull();
    expect(released.runs.map((run) => run.status)).toEqual(["completed", "completed", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it("names the latest time an account ahead in a chosen window is back on pace", () => {
  const now = "2026-11-27T10:00:00.000Z";
  const pace = {
    "5h": { ahead: true, until: "2026-11-27T11:00:00Z" },
    "7d": { ahead: true, until: "2026-11-27T12:30:00.123456789Z" },
  };
  expect(pacedUntil(pace, ["5h"], now)).toBe("2026-11-27T11:00:00.000Z");
  expect(pacedUntil(pace, ["5h", "7d"], now)).toBe("2026-11-27T12:30:00.123Z");
  expect(pacedUntil({ "5h": { ahead: false, until: "2026-11-27T11:00:00Z" } }, ["5h"], now)).toBe(
    null,
  );
  // A time already past, or none at all, fails open.
  expect(pacedUntil({ "5h": { ahead: true, until: "2026-11-27T09:00:00Z" } }, ["5h"], now)).toBe(
    null,
  );
  expect(pacedUntil({ "5h": { ahead: true } }, ["5h"], now)).toBe(null);
  expect(pacedUntil(undefined, ["5h"], now)).toBe(null);
});
