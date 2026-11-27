import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  UsageLimitSourceId,
  type OrchestrationV2AppThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PacedThreads from "./PacedThreads.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("hub");
const hub = { url: "http://hub.test", managementKey: "key" };

const harness = (driver: "codex" | "claudeAgent", options: { readonly booting?: boolean } = {}) => {
  const instanceId = ProviderInstanceId.make(driver);
  const threadId = ThreadId.make(`thread:paced-${driver}`);
  const state = {
    thread: {
      id: threadId,
      archivedAt: null,
      modelSelection: { instanceId, model: "test" },
      activeProviderThreadId: ProviderThreadId.make("provider-thread"),
      paced: { windows: ["5h"] },
      pacedUntil: null,
    } as unknown as OrchestrationV2AppThread,
    ahead: true,
    listed: true,
    pickFails: false,
    dispatched: [] as Array<string | null | undefined>,
    paced: [] as Array<ReadonlyArray<string>>,
    unpaced: [] as Array<ReadonlyArray<string>>,
  };
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getPacedThreads: () => Effect.succeed(state.listed ? [state.thread] : []),
      getThreadRecords: () =>
        Effect.succeed({
          providerThreads: [
            {
              id: ProviderThreadId.make("provider-thread"),
              driver: ProviderDriverKind.make(driver),
              nativeThreadRef: { nativeId: "native-session" },
            },
          ],
        } as never),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "thread.metadata.update") return { sequence: 0 } as never;
          state.dispatched.push(command.pacedUntil);
          state.thread = { ...state.thread, pacedUntil: command.pacedUntil ?? null };
          return { sequence: 0 } as never;
        }),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed([
        { id: sourceId, accounts: [{ driver: ProviderDriverKind.make(driver) }] } as never,
      ]),
      nextPick: () =>
        Effect.succeed(
          state.pickFails ? null : ({ account: "account-a", current: null, owner: null } as never),
        ),
      hub: () => Effect.succeed(hub),
      routerAlias: () => Effect.succeed((alias: string) => alias),
      control: () =>
        Effect.succeed({
          accounts: [
            {
              account: "account-a",
              provider: "codex",
              pace: {
                "5h": { used: 60, line: 40, ahead: state.ahead, until: "1970-01-01T02:00:00Z" },
              },
            },
          ],
        }),
      pace: (_hub, sessions) => Effect.sync(() => void state.paced.push(sessions)),
      unpace: (_hub, sessions) => Effect.sync(() => void state.unpaced.push(sessions)),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.suspend(() =>
        Effect.succeed(
          options.booting === true
            ? []
            : [
                {
                  instanceId,
                  driver: ProviderDriverKind.make(driver),
                  // Behind a hub, as hubSourceOf requires.
                  auth: { type: "customEndpoint" },
                } as ServerProvider,
              ],
        ),
      ),
    }),
  );
  return { state, layer, threadId };
};

it.effect("holds a paced Codex thread while its account is ahead, then clears the hold", () => {
  const { state, layer } = harness("codex");
  return Effect.gen(function* () {
    yield* PacedThreads.make;
    yield* TestClock.adjust("5 seconds");
    expect(state.dispatched).toEqual(["1970-01-01T02:00:00.000Z"]);

    // An unreadable pick keeps the hold.
    state.pickFails = true;
    yield* TestClock.adjust("60 seconds");
    expect(state.dispatched).toEqual(["1970-01-01T02:00:00.000Z"]);

    // Clearing the hold is what starts the queue (the Orchestrator does it on `pacedUntil: null`).
    state.pickFails = false;
    state.ahead = false;
    yield* TestClock.adjust("60 seconds");
    expect(state.dispatched).toEqual(["1970-01-01T02:00:00.000Z", null]);
    expect(state.paced).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("registers a paced Claude thread's sessions and removes them when pacing ends", () => {
  const { state, layer } = harness("claudeAgent");
  return Effect.gen(function* () {
    yield* PacedThreads.make;
    yield* TestClock.adjust("5 seconds");
    expect(state.paced).toEqual([["native-session"]]);

    // An unchanged thread is not posted again before its renewal is due.
    yield* TestClock.adjust("60 seconds");
    expect(state.paced).toHaveLength(1);

    state.listed = false;
    yield* TestClock.adjust("60 seconds");
    expect(state.unpaced).toEqual([["native-session"]]);
    expect(state.dispatched).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("keeps a Codex hold it cannot check yet, as at startup", () => {
  const { state, layer } = harness("codex", { booting: true });
  state.thread = { ...state.thread, pacedUntil: "1970-01-01T02:00:00.000Z" };
  return Effect.gen(function* () {
    yield* PacedThreads.make;
    yield* TestClock.adjust("5 seconds");
    expect(state.dispatched).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
