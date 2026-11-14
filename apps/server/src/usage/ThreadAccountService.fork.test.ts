import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ServerCommand,
  ServerProvider,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccountService from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const OWNER = "account-1111111111111111";
const OTHER = "account-2222222222222222";
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const threadId = "thread-1" as never;

const provider = {
  instanceId: "claude",
  driver: "claudeAgent",
  auth: { status: "authenticated", type: "customEndpoint" },
} as unknown as ServerProvider;
const hubAccount = (routerAlias: string) => ({
  id: `${routerAlias}.json`,
  driver: "claudeAgent",
  routerAlias,
  usageLimits: { checkedAt: "2026-11-14T12:00:00.000Z", windows: [] },
});
const snapshots = [
  {
    id: "hub",
    kind: "cliproxy",
    label: "Hub",
    checkedAt: "2026-11-14T12:00:00.000Z",
    accounts: [hubAccount(OWNER), hubAccount(OTHER)],
  },
] as unknown as ReadonlyArray<UsageLimitSourceSnapshot>;

const modelSelection = { instanceId: "claude", model: "claude-sonnet-5-5" };

function testLayer(input: {
  readonly owner?: string | null;
  readonly heldRunId?: string;
  readonly pins?: Array<Parameters<UsageLimitSources.UsageLimitSources["Service"]["pin"]>[1]>;
  readonly commands?: OrchestrationV2ServerCommand[];
  readonly control?: Effect.Success<
    ReturnType<UsageLimitSources.UsageLimitSources["Service"]["control"]>
  >;
  readonly storedThreads?: ReadonlyArray<unknown>;
  readonly nativeIds?: Record<string, string>;
  readonly settings?: unknown;
  readonly knownSessions?: ReadonlyArray<{ nativeId: string; id: string; title: string }>;
  readonly controls?: Array<unknown>;
  readonly settingsPatches?: Array<unknown>;
  readonly accountChoice?: unknown;
}) {
  return Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([provider]),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed(snapshots),
      hub: () => Effect.succeed({ url: "http://hub.test", managementKey: "key" }),
      nextPick: () =>
        Effect.succeed({ account: OWNER, owner: input.owner ?? null, resetsAt: null }),
      pin: (_hub, pin) => Effect.sync(() => void input.pins?.push(pin)),
      unpin: (_hub, sessions) => Effect.sync(() => void input.controls?.push({ unpin: sessions })),
      control: () => Effect.succeed(input.control ?? {}),
      steer: (_hub, account, expiresAt) =>
        Effect.sync(() => void input.controls?.push({ steer: account, expiresAt })),
      margin: (_hub, margin) => Effect.sync(() => void input.controls?.push({ margin })),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: { modelSelection, accountChoice: input.accountChoice },
          providerThreads: [
            { nativeThreadRef: { nativeId: "native-session" } },
            { nativeThreadRef: { nativeId: "older-session" } },
            { nativeThreadRef: null },
          ],
        } as never),
      resolveMessageProviderThread: (id) =>
        Effect.succeed({
          nativeThreadRef: { nativeId: input.nativeIds?.[id] ?? "native-session" },
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          input.commands?.push(command);
          return { sequence: input.commands?.length ?? 0 } as never;
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithAccountChoices: () => Effect.succeed((input.storedThreads ?? []) as never),
      getThreadsByNativeIds: (ids) =>
        Effect.succeed(
          (input.knownSessions ?? []).filter((row) => ids.includes(row.nativeId)) as never,
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed((input.settings ?? { usageLimitSources: {} }) as never),
      updateSettings: (patch) =>
        Effect.sync(() => {
          input.settingsPatches?.push(patch);
          return {} as never;
        }),
    }),
    Layer.succeed(ClaudeKeepWarm.ClaudeKeepWarm, {
      register: () => Effect.void,
      release: () => Effect.void,
      find: () =>
        Effect.succeed(
          input.heldRunId === undefined
            ? null
            : ({ turn: { runId: input.heldRunId, hold: {} } } as never),
        ),
    }),
  );
}

function setAccount(input: {
  readonly owner: string | null;
  readonly account?: string | null;
  readonly stall?: boolean | undefined;
  readonly dropThinking?: boolean;
  readonly heldRunId?: string;
  readonly accountChoice?: unknown;
}) {
  const pins: Array<Parameters<UsageLimitSources.UsageLimitSources["Service"]["pin"]>[1]> = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const controls: Array<unknown> = [];
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const service = yield* ThreadAccountService.make;
    const stall = "stall" in input ? input.stall : true;
    const result = yield* service
      .set({
        threadId,
        account: (input.account === undefined ? OTHER : input.account) as never,
        ...(stall === undefined ? {} : { stall }),
        ...(input.dropThinking === undefined ? {} : { dropThinking: input.dropThinking }),
      })
      .pipe(Effect.result);
    return { result, pins, commands, controls };
  }).pipe(Effect.provide(testLayer({ ...input, pins, commands, controls })));
}

describe("ThreadAccountService.set", () => {
  it.effect("refuses to move an owned conversation without dropThinking", () =>
    Effect.gen(function* () {
      const { result, pins, commands } = yield* setAccount({ owner: OWNER });
      expect(Result.isFailure(result) && result.failure.requiresDropThinking).toBe(true);
      expect(pins).toEqual([]);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("moves an owned conversation once acknowledged and marks its thinking dropped", () =>
    Effect.gen(function* () {
      const { result, pins, commands } = yield* setAccount({ owner: OWNER, dropThinking: true });
      expect(Result.isSuccess(result)).toBe(true);
      expect(pins).toMatchObject([
        { sessions: ["native-session"], account: OTHER, stall: true, move: true },
      ]);
      expect(commands).toMatchObject([
        {
          type: "thread.account-choice.set",
          accountChoice: { sourceId: "hub", account: OTHER, stall: true, instanceId: "claude" },
          accountMovedAt: "2026-11-14T12:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("pins an unowned conversation without a move and continues a held turn", () =>
    Effect.gen(function* () {
      const { pins, commands } = yield* setAccount({ owner: null, heldRunId: "run-7" });
      expect(pins).toMatchObject([{ account: OTHER, move: false }]);
      expect(commands[0]).not.toHaveProperty("accountMovedAt");
      expect(commands.slice(1)).toMatchObject([
        { type: "message.dispatch", text: "Continue where you left off." },
        { type: "run.interrupt", runId: "run-7" },
      ]);
    }),
  );

  it.effect.each([
    {
      name: "keeps the stored wait setting when only the account changes",
      account: OTHER,
      stall: true,
    },
    { name: "falls back by default on a newly chosen account", account: OWNER, stall: false },
  ])("$name", ({ account, stall }) =>
    Effect.gen(function* () {
      const { pins } = yield* setAccount({
        owner: null,
        account,
        stall: undefined,
        accountChoice: { sourceId: "hub", account: OTHER, stall: true },
      });
      expect(pins).toMatchObject([{ account, stall }]);
    }),
  );

  it.effect("clears a choice by unpinning every session the thread has had", () =>
    Effect.gen(function* () {
      const { controls, commands } = yield* setAccount({
        owner: null,
        account: null,
        accountChoice: { sourceId: "hub", account: OTHER, stall: true },
      });
      expect(controls).toEqual([{ unpin: ["native-session", "older-session"] }]);
      expect(commands).toMatchObject([{ type: "thread.account-choice.set", accountChoice: null }]);
    }),
  );
});

describe("ThreadAccountService.routing", () => {
  it.effect("joins router controls to threads by native session and keeps unlisted choices", () =>
    Effect.gen(function* () {
      const service = yield* ThreadAccountService.make;
      const routing = yield* service.routing({ sourceId: "hub" as never });
      expect(routing).toEqual({
        steers: [
          {
            provider: "claude",
            account: OWNER,
            active: true,
            expiresAt: "2026-11-20T00:00:00.000Z",
          },
          { provider: "codex", account: OTHER, active: false },
        ],
        pins: [
          {
            account: OTHER,
            stall: true,
            active: true,
            expiresAt: "2026-11-20T00:00:00.000Z",
            thread: { id: "thread-1", title: "Pinned" },
            session: null,
          },
          { account: OWNER, stall: false, active: true, thread: null, session: "outside1" },
          {
            account: OWNER,
            stall: false,
            active: true,
            thread: { id: "thread-3", title: "Pinned elsewhere" },
            session: null,
          },
          {
            account: OWNER,
            stall: false,
            active: false,
            thread: { id: "thread-2", title: "Expired" },
            session: null,
          },
        ],
        held: [
          {
            account: OTHER,
            kind: "pin",
            releaseAt: "2026-11-14T12:30:00.000Z",
            resetAt: null,
            thread: { id: "thread-1", title: "Pinned" },
            session: null,
          },
        ],
        margins: [
          {
            headroomScale: 0,
            expiresAt: "2026-11-14T13:00:00.000Z",
            actor: "T3 Code",
            thread: { id: "thread-3", title: "Pinned elsewhere" },
            session: null,
          },
        ],
        ends: [{ account: OTHER, endsAt: "2026-12-01T00:00:00.000Z" }],
      });
    }).pipe(
      Effect.provide(
        testLayer({
          control: {
            pins: [
              {
                session: "native-1",
                account: OTHER,
                stall: true,
                expires_at: "2026-11-20T00:00:00Z",
              },
              { session: "outside1-session", account: OWNER },
              { session: "claude:native-3", account: OWNER },
            ],
            steers: [{ provider: "claude", account: OWNER, expires_at: "2026-11-20T00:00:00Z" }],
            // A conversation's subagents each hold a request; the section shows the conversation once.
            held: [
              { session: "native-1", account: OTHER, release_at: "2026-11-14T12:30:00Z" },
              { session: "native-1", account: OTHER, release_at: "2026-11-14T12:31:00Z" },
            ],
            margins: [
              {
                session: "native-3",
                headroom_scale: 0,
                expires_at: "2026-11-14T13:00:00Z",
                actor: "T3 Code",
              },
            ],
            ends: [{ account: OTHER, provider: "claude", ends_at: "2026-12-01T00:00:00Z" }],
          },
          knownSessions: [{ nativeId: "native-3", id: "thread-3", title: "Pinned elsewhere" }],
          storedThreads: [
            {
              id: "thread-1",
              title: "Pinned",
              modelSelection,
              accountChoice: { sourceId: "hub", account: OTHER, stall: true },
            },
            {
              id: "thread-2",
              title: "Expired",
              modelSelection,
              accountChoice: { sourceId: "hub", account: OWNER, stall: false },
            },
          ],
          nativeIds: { "thread-1": "native-1", "thread-2": "native-2" },
          settings: { usageLimitSources: { hub: { steers: { claude: OWNER, codex: OTHER } } } },
        }),
      ),
    ),
  );
});

describe("ThreadAccountService agent controls", () => {
  it.effect("steers new threads by account alone and saves the steer for renewal", () => {
    const controls: Array<unknown> = [];
    const settingsPatches: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* ThreadAccountService.make;
      yield* service.steer({ account: OTHER });
      expect(controls).toEqual([{ steer: OTHER, expiresAt: "2026-11-21T11:00:00.000Z" }]);
      expect(settingsPatches).toEqual([
        { usageLimitSources: { hub: { url: "http://hub.test", steers: { claude: OTHER } } } },
      ]);
    }).pipe(
      Effect.provide(
        testLayer({
          controls,
          settingsPatches,
          settings: { usageLimitSources: { hub: { url: "http://hub.test" } } },
        }),
      ),
    );
  });

  it.effect("sets a thread's margin on its native session for an hour by default", () => {
    const controls: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* ThreadAccountService.make;
      yield* service.margin({ threadId, headroomScale: 0 });
      const late = yield* service
        .margin({ threadId, headroomScale: 0.5, until: "2026-11-22T12:00:00.000Z" })
        .pipe(Effect.result);
      expect(controls).toEqual([
        {
          margin: {
            sessions: ["native-session"],
            headroomScale: 0,
            expiresAt: "2026-11-14T13:00:00.000Z",
            actor: "T3 Code",
          },
        },
      ]);
      expect(Result.isFailure(late)).toBe(true);
    }).pipe(Effect.provide(testLayer({ controls })));
  });
});
