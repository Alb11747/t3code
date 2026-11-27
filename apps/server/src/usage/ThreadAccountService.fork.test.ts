import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProviderThreadId,
  type ServerProvider,
  UsageLimitSourceError,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadAccountRouting from "../provider/ThreadAccountRouting.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccountService from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const OWNER = "account-1111111111111111";
const OTHER = "account-2222222222222222";
const ELSEWHERE = "account-3333333333333333";
const CODEX_ACCOUNT = "account-4444444444444444";
// The aliases routers before 0.28.0 gave OWNER and OTHER.
const LEGACY_OWNER = "account-aaaaaaaaaaaaaaa1";
const LEGACY_OTHER = "account-aaaaaaaaaaaaaaa2";
const RENAMED = { [LEGACY_OWNER]: OWNER, [LEGACY_OTHER]: OTHER };
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const threadId = "thread-1" as never;

const provider = {
  instanceId: "claude",
  driver: "claudeAgent",
  auth: { status: "authenticated", type: "customEndpoint" },
} as unknown as ServerProvider;
const hubAccount = (routerAlias: string, email: string) => ({
  id: `${routerAlias}.json`,
  driver: "claudeAgent",
  routerAlias,
  email,
  usageLimits: {
    checkedAt: "2026-11-14T12:00:00.000Z",
    windows: [],
    resetCredits: { availableCount: 1, nextCreditId: `grant-${routerAlias}` },
  },
});
const snapshots = [
  {
    id: "hub",
    kind: "cliproxy",
    label: "Hub",
    checkedAt: "2026-11-14T12:00:00.000Z",
    accounts: [
      hubAccount(OWNER, "work@example.com"),
      { ...hubAccount(OTHER, "spare@example.com"), plan: "Pro" },
      hubAccount(ELSEWHERE, "work@elsewhere.test"),
    ],
  },
] as unknown as ReadonlyArray<UsageLimitSourceSnapshot>;

const modelSelection = { instanceId: "claude", model: "claude-sonnet-5-5" };
// A Codex instance behind the same hub, for launches that only Claude supports.
const codexProvider = {
  instanceId: "codex",
  driver: "codex",
  auth: { status: "authenticated", type: "customEndpoint" },
} as unknown as ServerProvider;
const withCodex = snapshots.map((source) => ({
  ...source,
  accounts: [
    ...source.accounts,
    { ...hubAccount(CODEX_ACCOUNT, "codex@example.com"), driver: "codex" },
    { ...hubAccount("account-5555555555555555", "codex2@example.com"), driver: "codex" },
  ],
})) as unknown as ReadonlyArray<UsageLimitSourceSnapshot>;

function testLayer(input: {
  readonly owner?: string | null;
  readonly heldRunId?: string;
  readonly heldCompletedBeforeInterrupt?: boolean;
  // A stall pin's hold, on a router that re-places held requests on a pin change or one before.
  readonly heldByPin?: "moves" | "stays";
  readonly shown?: Array<unknown>;
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
  readonly redemptions?: Array<unknown>;
  readonly picks?: Array<unknown>;
  readonly oldRouter?: boolean;
  // What the hub's router calls an alias now, as UsageLimitSources.routerAlias answers.
  readonly renamed?: Record<string, string>;
  readonly dispatched?: Deferred.Deferred<void>;
  // The stored choice per thread now, where it differs from `accountChoice`.
  readonly choices?: Record<string, unknown>;
  readonly codex?: boolean;
  readonly separateCodexHub?: boolean;
  readonly unpinError?: UsageLimitSourceError;
  readonly previousHubUnavailable?: boolean;
  readonly providerTurns?: ReadonlyArray<unknown>;
  readonly runs?: Array<unknown>;
  readonly turnItems?: Array<{ readonly runId: string }>;
  // Runs inside a dispatch, before it returns.
  readonly onDispatch?: { current?: Effect.Effect<unknown> | undefined };
}) {
  const runsCodex = input.codex || input.separateCodexHub;
  const current = input.separateCodexHub
    ? ([
        ...snapshots,
        {
          ...withCodex[0]!,
          id: "codex-hub",
          accounts: withCodex[0]!.accounts.filter((account) => account.driver === "codex"),
        },
      ] as ReadonlyArray<UsageLimitSourceSnapshot>)
    : input.codex
      ? withCodex
      : snapshots;
  return Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed({
          enabled: true,
          consumeResetCredit: (creditId: string | undefined) =>
            Effect.sync(() => {
              input.redemptions?.push({ native: creditId });
              return "reset" as const;
            }),
        } as never),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(runsCodex ? [provider, codexProvider] : [provider]),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed(current),
      streamChanges: Stream.make(current),
      routerAlias: () => Effect.succeed((alias) => input.renamed?.[alias] ?? alias),
      removedEndAlias: (_sourceId, _hub, alias) => Effect.succeed(input.renamed?.[alias] ?? alias),
      hub: (id) =>
        Effect.succeed(
          input.previousHubUnavailable && id === "hub"
            ? null
            : { url: `http://${id}.test`, managementKey: "key" },
        ),
      nextPick: (_hub, request) =>
        Effect.sync(() => {
          input.picks?.push(request);
          return {
            account: request.kind === "compaction" ? OTHER : OWNER,
            owner: input.owner ?? null,
            resetsAt: null,
            basis: "warm",
            // Older routers ignore `kind` and do not echo it.
            kind: input.oldRouter ? null : (request.kind ?? "next"),
            current: OWNER,
            switchBelowContextTokens: null,
          };
        }),
      pin: (_hub, pin) => Effect.sync(() => void input.pins?.push(pin)),
      unpin: (hub, sessions) =>
        Effect.sync(() => void input.controls?.push({ hub: hub.url, unpin: sessions })).pipe(
          Effect.andThen(input.unpinError ? Effect.fail(input.unpinError) : Effect.void),
        ),
      control: () => Effect.succeed(input.control ?? {}),
      steer: (_hub, account, expiresAt) =>
        Effect.sync(() => void input.controls?.push({ steer: account, expiresAt })),
      margin: (_hub, margin) => Effect.sync(() => void input.controls?.push({ margin })),
      consumeResetCredit: (credit) =>
        Effect.sync(() => {
          input.redemptions?.push(credit);
          return { outcome: "reset" as const };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: (id, _fields, filter) =>
        Effect.succeed({
          thread: {
            modelSelection: runsCodex ? { instanceId: "codex", model: "gpt-5" } : modelSelection,
            accountChoice: input.choices?.[id] ?? input.accountChoice,
          },
          runs: input.heldCompletedBeforeInterrupt
            ? [{ id: input.heldRunId, status: "failed" }]
            : (input.runs ?? []),
          providerTurns: input.providerTurns ?? [],
          turnItems: (input.turnItems ?? []).filter(
            (item) =>
              filter?.turnItemRunIds === undefined ||
              filter.turnItemRunIds.includes(item.runId as never),
          ),
          providerThreads: [
            {
              providerInstanceId: runsCodex ? "codex" : "claude",
              nativeThreadRef: { nativeId: "native-session" },
            },
            { providerInstanceId: "claude", nativeThreadRef: { nativeId: "older-session" } },
            ...(input.codex
              ? [
                  {
                    providerInstanceId: "claude-other",
                    nativeThreadRef: { nativeId: "other-session" },
                  },
                ]
              : []),
            { nativeThreadRef: null },
          ],
        } as never),
      resolveMessageProviderThread: (id) =>
        Effect.succeed({
          id: ProviderThreadId.make("provider-thread:routed"),
          nativeThreadRef: { nativeId: input.nativeIds?.[id] ?? "native-session" },
        } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          input.commands?.push(command);
          if (input.onDispatch?.current) yield* input.onDispatch.current;
          if (input.heldCompletedBeforeInterrupt && command.type === "run.interrupt") {
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          }
          return { sequence: input.commands?.length ?? 0 } as never;
        }).pipe(
          Effect.tap(() =>
            input.dispatched ? Deferred.succeed(input.dispatched, undefined) : Effect.void,
          ),
        ),
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
      streamChanges: Stream.empty,
      updateSettings: (patch) =>
        Effect.sync(() => {
          input.settingsPatches?.push(patch);
          return {} as never;
        }),
    }),
    Layer.succeed(ClaudeKeepWarm.ClaudeKeepWarm, {
      register: () => Effect.void,
      release: () => Effect.void,
      forget: Effect.void,
      find: () =>
        Effect.succeed(
          input.heldRunId === undefined
            ? null
            : ({
                session: {
                  show: (_turn: unknown, hold: unknown) =>
                    Effect.sync(() => void input.shown?.push(hold)),
                },
                turn: {
                  runId: input.heldRunId,
                  hold:
                    input.heldByPin === undefined
                      ? {}
                      : {
                          kind: "pin",
                          ...(input.heldByPin === "stays" ? { staysOnPinChange: true } : {}),
                        },
                },
              } as never),
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
  readonly heldCompletedBeforeInterrupt?: boolean;
  readonly heldByPin?: "moves" | "stays";
  readonly accountChoice?: unknown;
  readonly control?: NonNullable<Parameters<typeof testLayer>[0]["control"]>;
  readonly renamed?: Record<string, string>;
  readonly codex?: boolean;
  readonly separateCodexHub?: boolean;
  readonly unpinError?: UsageLimitSourceError;
  readonly previousHubUnavailable?: boolean;
}) {
  const pins: Array<Parameters<UsageLimitSources.UsageLimitSources["Service"]["pin"]>[1]> = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const controls: Array<unknown> = [];
  const shown: Array<unknown> = [];
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
    return { result, pins, commands, controls, shown };
  }).pipe(Effect.provide(testLayer({ ...input, pins, commands, controls, shown })));
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
          accountMove: {
            providerThreadId: "provider-thread:routed",
            nativeThreadId: "native-session",
            movedAt: "2026-11-14T12:00:00.000Z",
          },
        },
      ]);
    }),
  );

  it.effect("lets the router re-place holds after ordinary pin changes", () =>
    Effect.gen(function* () {
      const { pins, commands } = yield* setAccount({ owner: null, heldRunId: "run-7" });
      expect(pins).toMatchObject([{ account: OTHER, move: false }]);
      expect(commands[0]).not.toHaveProperty("accountMove");
      expect(commands.map((command) => command.type)).toEqual(["thread.account-choice.set"]);
      for (const account of [OTHER, null]) {
        const moves = yield* setAccount({
          owner: null,
          account,
          heldRunId: "run-8",
          heldByPin: "moves",
          accountChoice: { sourceId: "hub", account: OWNER, stall: true },
        });
        expect(moves.commands.map((command) => command.type)).toEqual([
          "thread.account-choice.set",
        ]);
        expect(moves.shown).toEqual([]);
      }
      const stays = yield* setAccount({ owner: null, heldRunId: "run-9", heldByPin: "stays" });
      expect(stays.commands.map((command) => command.type)).toEqual(["thread.account-choice.set"]);
    }),
  );

  it.effect.each([false, true])(
    "restarts a moved held request (already terminal: %s)",
    (heldCompletedBeforeInterrupt) =>
      Effect.gen(function* () {
        const { commands, result } = yield* setAccount({
          owner: OWNER,
          dropThinking: true,
          heldRunId: "run-7",
          heldByPin: "moves",
          heldCompletedBeforeInterrupt,
        });
        expect(Result.isSuccess(result)).toBe(true);
        expect(commands).toMatchObject([
          {
            type: "thread.account-choice.set",
            accountMove: { movedAt: "2026-11-14T12:00:00.000Z" },
          },
          { type: "message.dispatch", text: "Continue where you left off." },
          { type: "run.interrupt", runId: "run-7" },
        ]);
      }),
  );

  it.effect.each([
    { stall: true, writes: false },
    { stall: false, writes: true },
  ])("only rewrites a saved choice when its live pin differs ($stall)", ({ stall, writes }) =>
    Effect.gen(function* () {
      const { pins, commands } = yield* setAccount({
        owner: null,
        heldRunId: "run-7",
        accountChoice: { sourceId: "hub", account: OTHER, stall: true, instanceId: "claude" },
        control: { pins: [{ account: OTHER, session: "claude:native-session", stall }] },
      });
      expect(pins).toHaveLength(writes ? 1 : 0);
      expect(commands.map((command) => command.type)).toEqual(
        writes ? ["thread.account-choice.set"] : [],
      );
    }),
  );

  it.effect.each([
    {
      name: "keeps the stored wait setting when only the account changes",
      account: OTHER,
      stall: true,
    },
    {
      name: "keeps it for a choice stored under the account's legacy alias",
      account: OTHER,
      stored: LEGACY_OTHER,
      stall: true,
    },
    { name: "falls back by default on a newly chosen account", account: OWNER, stall: false },
  ])("$name", ({ account, stored, stall }) =>
    Effect.gen(function* () {
      const { pins } = yield* setAccount({
        owner: null,
        account,
        stall: undefined,
        accountChoice: { sourceId: "hub", account: stored ?? OTHER, stall: true },
        renamed: RENAMED,
      });
      expect(pins).toMatchObject([{ account, stall }]);
    }),
  );

  it.effect.each([
    { name: "an alias", account: OTHER, pinned: OTHER },
    { name: "an alias the router renamed", account: LEGACY_OTHER, pinned: OTHER },
    { name: "an email in any case", account: "Spare@Example.COM", pinned: OTHER },
    { name: "a unique local part", account: "spare", pinned: OTHER },
    { name: "the name t3_usage shows", account: "spare@example.com (pro)", pinned: OTHER },
    {
      name: "the name t3_usage shows beside a same-plan account of the other provider",
      account: "spare@example.com (Pro, Claude)",
      pinned: OTHER,
    },
    { name: "a full email whose local part is shared", account: "work@example.com", pinned: OWNER },
    {
      name: "a shared local part",
      account: "work",
      error:
        '"work" matches several accounts: work@example.com, work@elsewhere.test. Use one of those names.',
    },
    {
      name: "an unknown name",
      account: "nobody",
      error:
        'No account on this thread\'s CLI Proxy hub is named "nobody". Choose one of: work@example.com, spare@example.com (Pro), work@elsewhere.test.',
    },
  ])("resolves $name to an account", ({ account, pinned, error }) =>
    Effect.gen(function* () {
      const { result, pins } = yield* setAccount({ owner: null, account, renamed: RENAMED });
      if (error === undefined) {
        expect(pins).toMatchObject([{ account: pinned }]);
      } else {
        expect(Result.isFailure(result) && result.failure.detail).toBe(error);
        expect(pins).toEqual([]);
      }
    }),
  );

  it.effect("picks by the router's new alias while the snapshot still has the old one", () =>
    Effect.gen(function* () {
      const NEW = "account-4444444444444444";
      const { pins, commands } = yield* setAccount({
        owner: null,
        account: NEW,
        renamed: { [OTHER]: NEW, [OWNER]: "account-5555555555555555" },
      });
      expect(pins).toMatchObject([{ account: NEW }]);
      expect(commands[0]).toMatchObject({ accountChoice: { account: NEW } });
      const state = yield* Effect.gen(function* () {
        const service = yield* ThreadAccountService.make;
        return yield* service.state({ threadId, modelSelection: modelSelection as never });
      }).pipe(Effect.provide(testLayer({ renamed: { [OWNER]: NEW } })));
      // The router's pick (OWNER in the stale snapshot) keeps its "in use" mark.
      expect(state?.next).toBe(NEW);
      expect(state?.accounts.map((account) => account.routerAlias)).toContain(NEW);
    }),
  );

  it.effect.each([
    { separateCodexHub: false, hubs: ["http://hub.test"] },
    { separateCodexHub: true, hubs: ["http://hub.test", "http://codex-hub.test"] },
  ])("unpins current and historical sessions on $hubs", ({ separateCodexHub, hubs }) =>
    Effect.gen(function* () {
      const { controls, commands } = yield* setAccount({
        owner: null,
        account: null,
        accountChoice: { sourceId: "hub", account: OTHER, stall: true },
        separateCodexHub,
      });
      expect(controls).toEqual(
        hubs.map((hub) => ({ hub, unpin: ["native-session", "older-session"] })),
      );
      expect(commands).toMatchObject([{ type: "thread.account-choice.set", accountChoice: null }]);
    }),
  );

  it.effect("rejects Codex wait before changing either hub", () =>
    Effect.gen(function* () {
      const { result, pins, commands, controls } = yield* setAccount({
        owner: null,
        account: CODEX_ACCOUNT,
        stall: true,
        accountChoice: { sourceId: "hub", account: OTHER, stall: true, instanceId: "claude" },
        separateCodexHub: true,
      });
      expect(Result.isFailure(result) && result.failure.detail).toContain(
        "waitWhenOut works only for Claude threads",
      );
      expect(pins).toEqual([]);
      expect(commands).toEqual([]);
      expect(controls).toEqual([]);
    }),
  );

  it.effect("turns off a legacy Codex wait when saving its account again", () =>
    Effect.gen(function* () {
      const { result, pins, commands } = yield* setAccount({
        owner: null,
        account: CODEX_ACCOUNT,
        stall: undefined,
        accountChoice: {
          sourceId: "codex-hub",
          account: CODEX_ACCOUNT,
          stall: true,
          instanceId: "codex",
        },
        separateCodexHub: true,
      });
      expect(Result.isSuccess(result)).toBe(true);
      expect(pins).toMatchObject([{ account: CODEX_ACCOUNT, stall: false }]);
      expect(commands).toMatchObject([
        {
          type: "thread.account-choice.set",
          accountChoice: { account: CODEX_ACCOUNT, stall: false },
        },
      ]);
    }),
  );

  it.effect.each([
    {
      name: "unpins the former instance's sessions on a shared hub",
      instanceId: "claude",
      sessions: ["older-session"],
    },
    {
      name: "clears historical pins for a choice without an instance on a shared hub",
      instanceId: undefined,
      sessions: ["older-session", "other-session"],
    },
    {
      name: "keeps other pins when changing the account within one instance on a shared hub",
      instanceId: "codex",
      sessions: [],
    },
  ])("$name", ({ instanceId, sessions }) =>
    Effect.gen(function* () {
      const { controls, pins, commands, result } = yield* setAccount({
        owner: null,
        account: CODEX_ACCOUNT,
        stall: false,
        codex: true,
        accountChoice: {
          sourceId: "hub",
          account: instanceId === "codex" ? "account-5555555555555555" : OTHER,
          stall: instanceId !== "codex",
          ...(instanceId === undefined ? {} : { instanceId }),
        },
      });
      expect(Result.isSuccess(result)).toBe(true);
      expect(controls).toEqual(
        sessions.length ? [{ hub: "http://hub.test", unpin: sessions }] : [],
      );
      expect(pins).toMatchObject([{ sessions: ["native-session"], account: CODEX_ACCOUNT }]);
      expect(commands).toMatchObject([
        {
          type: "thread.account-choice.set",
          accountChoice: { sourceId: "hub", account: CODEX_ACCOUNT, instanceId: "codex" },
        },
      ]);
    }),
  );

  it.effect.each([
    { name: "clears the previous hub's pins before saving the new choice" },
    {
      name: "keeps the saved choice when the previous hub refuses cleanup",
      unpinError: new UsageLimitSourceError({ detail: "The previous hub rejected the request." }),
    },
    {
      name: "keeps the saved choice when the previous hub cannot be looked up",
      previousHubUnavailable: true,
    },
  ])("$name", ({ unpinError, previousHubUnavailable }) =>
    Effect.gen(function* () {
      const { commands, controls, pins, result } = yield* setAccount({
        owner: null,
        account: CODEX_ACCOUNT,
        stall: false,
        accountChoice: { sourceId: "hub", account: OTHER, stall: true, instanceId: "claude" },
        separateCodexHub: true,
        ...(unpinError === undefined ? {} : { unpinError }),
        ...(previousHubUnavailable === undefined ? {} : { previousHubUnavailable }),
      });
      expect(controls).toEqual(
        previousHubUnavailable
          ? []
          : [{ hub: "http://hub.test", unpin: ["native-session", "older-session"] }],
      );
      if (unpinError || previousHubUnavailable) {
        expect(Result.isFailure(result) && result.failure.detail).toContain(
          unpinError?.detail ?? "The previous CLI Proxy hub is unavailable.",
        );
        expect(pins).toEqual([]);
        expect(commands).toEqual([]);
      } else {
        expect(Result.isSuccess(result)).toBe(true);
        expect(pins).toMatchObject([{ sessions: ["native-session"], account: CODEX_ACCOUNT }]);
        expect(commands).toMatchObject([
          {
            type: "thread.account-choice.set",
            accountChoice: { sourceId: "codex-hub", instanceId: "codex", account: CODEX_ACCOUNT },
          },
        ]);
      }
    }),
  );
});

describe("ThreadAccountService.move", () => {
  it.effect("compacts a large warm conversation on its account before moving it", () => {
    const pins: Array<Parameters<UsageLimitSources.UsageLimitSources["Service"]["pin"]>[1]> = [];
    const commands: OrchestrationV2ServerCommand[] = [];
    const runs: Array<{ id: string; userMessageId: unknown; status: string }> = [];
    const providerThreadId = ProviderThreadId.make("provider-thread:routed");
    const compaction = (runId: string) => ({
      type: "compaction",
      status: "completed",
      runId,
      providerThreadId,
      completedAt: DateTime.makeUnsafe(NOW - 1_000),
    });
    const turnItems = [compaction("run:other")];
    const onDispatch: { current?: Effect.Effect<unknown> | undefined } = {};
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const routing = yield* ThreadAccountRouting.make;
      const service = yield* ThreadAccountService.make.pipe(
        Effect.provideService(ThreadAccountRouting.ThreadAccountRouting, routing),
      );
      const turnStart = routing.prepareTurn({
        appThread: { id: threadId, accountChoice: null } as never,
        providerThread: {
          id: providerThreadId,
          driver: "claudeAgent",
          providerInstanceId: "claude",
          nativeThreadRef: { nativeId: "native-session" },
        } as never,
        loadCompactions: Effect.succeed([]),
      });
      const move = Effect.gen(function* () {
        expect(yield* service.move({ threadId, account: OTHER, stall: true })).toBe("pending");
        const command = commands.at(-1) as unknown as { messageId: never };
        // An agent's /compact never joins another compaction: the move needs this run's own.
        expect(command).toMatchObject({
          type: "message.dispatch",
          text: "/compact",
          createdBy: "agent",
          dispatchMode: { type: "queue_after_active" },
        });
        expect(yield* routing.movesAfter(threadId, command.messageId)).toBe(true);
        const run = {
          id: `run:${runs.length}`,
          userMessageId: command.messageId,
          status: "queued",
        };
        runs.push(run);
        return run;
      });

      const first = yield* move;
      // T3 pins nothing for the compaction: its turn runs warm-only on the router.
      first.status = "running";
      expect(yield* turnStart).toBe(false);
      expect(pins).toEqual([]);
      expect(yield* service.pendingMove(threadId)).toEqual({
        account: "spare@example.com (Pro)",
        waitWhenOut: true,
      });
      // A change that fails leaves the waiting move in place.
      const refused = yield* service
        .set({ threadId, account: OTHER, stall: true })
        .pipe(Effect.result);
      expect(Result.isFailure(refused) && refused.failure.requiresDropThinking).toBe(true);
      // Its run ending without its own compaction drops the move, whatever else compacted.
      first.status = "completed";
      expect(yield* service.pendingMove(threadId)).toBeNull();
      expect(yield* turnStart).toBe(false);
      expect(pins).toEqual([]);

      // A turn starting while the next move's /compact is still being dispatched keeps the move.
      yield* TestClock.adjust("1 second");
      onDispatch.current = turnStart;
      const second = yield* move;
      onDispatch.current = undefined;
      expect(yield* service.pendingMove(threadId)).not.toBeNull();
      second.status = "completed";
      turnItems.push(compaction(second.id));
      // The first turn after its compaction moves before its first request.
      expect(yield* turnStart).toBe(true);
      expect(pins).toMatchObject([
        { sessions: ["native-session"], account: OTHER, stall: true, move: true },
      ]);
      expect(commands.at(-1)).toMatchObject({
        type: "thread.account-choice.set",
        accountChoice: { account: OTHER, stall: true },
      });
      expect(yield* service.pendingMove(threadId)).toBeNull();
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer({
          owner: OWNER,
          pins,
          commands,
          runs,
          turnItems,
          onDispatch,
          providerTurns: [
            {
              providerThreadId,
              tokenUsage: {
                usedTokens: 143_000,
                promptCacheExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + 30 * 60_000)),
                updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
              },
            },
          ],
        }),
      ),
    );
  });
});

describe("ThreadAccountService.launchChoice", () => {
  it.effect.each([
    {
      name: "stores a named account on the instance's hub, waiting when asked",
      instanceId: "claude",
      account: "Spare@Example.com",
      choice: { sourceId: "hub", account: OTHER, stall: true, instanceId: "claude" },
    },
    {
      name: "refuses an account the instance's hub does not list",
      instanceId: "claude",
      account: "someone@other-hub.test",
      error:
        'No account on the CLI Proxy hub of claude is named "someone@other-hub.test". Choose one of: work@example.com, spare@example.com (Pro), work@elsewhere.test.',
    },
    {
      name: "refuses an instance that does not route through a hub",
      instanceId: "codex",
      account: OTHER,
      error:
        "Provider instance codex does not route through one CLI Proxy quota router with several accounts, so it takes no account.",
    },
    {
      name: "refuses waiting on a Codex instance, whose holds T3 does not show",
      instanceId: "codex",
      codex: true,
      account: "codex@example.com",
      error:
        "waitWhenOut works only for Claude threads; codex would look hung while it waits. Omit waitWhenOut.",
    },
    {
      name: "stores a Codex account that falls back",
      instanceId: "codex",
      codex: true,
      stall: false,
      account: "codex@example.com",
      choice: {
        sourceId: "hub",
        account: "account-4444444444444444",
        stall: false,
        instanceId: "codex",
      },
    },
  ])("$name", ({ instanceId, account, choice, error, codex, stall }) =>
    Effect.gen(function* () {
      const service = yield* ThreadAccountService.make;
      const result = yield* service
        .launchChoice({ instanceId: instanceId as never, account, stall: stall ?? true })
        .pipe(Effect.result);
      if (error === undefined) expect(result).toEqual(Result.succeed(choice));
      else expect(Result.isFailure(result) && result.failure.detail).toBe(error);
    }).pipe(Effect.provide(testLayer({ codex: codex === true }))),
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
              // Answered before the router first listed its accounts.
              { session: "outside1-session", account: LEGACY_OWNER },
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
            ends: [{ account: LEGACY_OTHER, provider: "claude", ends_at: "2026-12-01T00:00:00Z" }],
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
              // Stored before the router renamed its accounts.
              accountChoice: { sourceId: "hub", account: LEGACY_OWNER, stall: false },
            },
          ],
          nativeIds: { "thread-1": "native-1", "thread-2": "native-2" },
          settings: {
            usageLimitSources: { hub: { steers: { claude: OWNER, codex: LEGACY_OTHER } } },
          },
          renamed: RENAMED,
        }),
      ),
    ),
  );
});

describe("ThreadAccountService stored aliases", () => {
  it.effect("gives stored choices the alias the router renamed theirs to", () => {
    const legacyChoice = {
      sourceId: "hub",
      account: LEGACY_OWNER,
      stall: true,
      instanceId: "claude",
    };
    const commands: OrchestrationV2ServerCommand[] = [];
    const settingsPatches: Array<unknown> = [];
    const dispatched = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const service = yield* ThreadAccountService.make;
      // Agents reading a choice the rename has not reached yet see the current alias.
      expect(yield* service.describeChoice(legacyChoice as never)).toEqual({
        account: OWNER,
        name: "work@example.com",
      });
      yield* Deferred.await(dispatched);
      // A choice under neither alias may name an account that returns, so it stays, and a pick
      // or wait setting changed after the read is not overwritten.
      expect(commands).toEqual([
        {
          type: "thread.account-choice.set",
          commandId: expect.stringMatching(/^thread-account-alias:thread-2:/),
          threadId: "thread-2",
          accountChoice: { sourceId: "hub", account: OWNER, stall: false, instanceId: "claude" },
        },
      ]);
      expect(settingsPatches).toEqual([
        {
          usageLimitSources: {
            hub: { url: "http://hub.test", steers: { claude: OWNER, codex: OTHER } },
          },
        },
      ]);
    }).pipe(
      Effect.provide(
        testLayer({
          commands,
          dispatched,
          settingsPatches,
          settings: {
            usageLimitSources: {
              hub: { url: "http://hub.test", steers: { claude: LEGACY_OWNER, codex: OTHER } },
            },
          },
          renamed: RENAMED,
          choices: {
            "thread-0": { sourceId: "hub", account: OTHER, stall: false },
            "thread-2": { ...legacyChoice, stall: false },
          },
          storedThreads: [
            {
              id: "thread-0",
              accountChoice: { sourceId: "hub", account: LEGACY_OTHER, stall: false },
            },
            {
              id: "thread-1",
              accountChoice: { sourceId: "hub", account: ELSEWHERE, stall: false },
            },
            { id: "thread-2", accountChoice: legacyChoice },
          ],
        }),
      ),
    );
  });
});

describe("ThreadAccountService agent controls", () => {
  it.effect("steers new threads by account alone and saves the steer for renewal", () => {
    const controls: Array<unknown> = [];
    const settingsPatches: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* ThreadAccountService.make;
      yield* service.steer({ account: OTHER });
      // Across hubs, an agent can name the account the same ways as for one thread.
      yield* service.steer({ account: "SPARE" });
      expect(controls).toEqual([
        { steer: OTHER, expiresAt: "2026-11-21T11:00:00.000Z" },
        { steer: OTHER, expiresAt: "2026-11-21T11:00:00.000Z" },
      ]);
      expect(settingsPatches[0]).toEqual({
        usageLimitSources: { hub: { url: "http://hub.test", steers: { claude: OTHER } } },
      });
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

  it.effect.each([
    { enabled: undefined, input: { account: OTHER }, redemptions: [] },
    { enabled: false, input: { instanceId: "claude" }, redemptions: [] },
    {
      enabled: true,
      input: { account: OTHER },
      redemptions: [{ sourceId: "hub", accountId: `${OTHER}.json`, creditId: `grant-${OTHER}` }],
    },
    { enabled: true, input: { instanceId: "claude" }, redemptions: [{ native: undefined }] },
  ])(
    "redeems a reset for an agent only when the setting is on ($enabled)",
    ({ enabled, input, redemptions }) => {
      const redeemed: Array<unknown> = [];
      return Effect.gen(function* () {
        const service = yield* ThreadAccountService.make;
        const result = yield* service.redeem(input as never).pipe(Effect.result);
        expect(redeemed).toEqual(redemptions);
        if (enabled) {
          expect(result).toEqual(Result.succeed({ outcome: "reset" }));
        } else {
          expect(Result.isFailure(result) && result.failure.detail).toContain(
            "Let agents redeem reset credits",
          );
        }
        const usage = yield* service.usage({});
        expect(usage.agentsCanRedeemResetCredits).toBe(enabled === true);
      }).pipe(
        Effect.provide(
          testLayer({
            redemptions: redeemed,
            settings: {
              usageLimitSources: {},
              ...(enabled === undefined ? {} : { agentsCanRedeemResetCredits: enabled }),
            },
          }),
        ),
      );
    },
  );
});

describe("ThreadAccountService.preview", () => {
  const selection = modelSelection as never;
  it.effect("shares one router read per session, model and kind until it ages out", () => {
    const picks: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* ThreadAccountService.make;
      const next = { threadId, modelSelection: selection, kind: "next" as const };
      const first = yield* service.preview(next);
      // The chip's state shares the preview's read.
      yield* service.state({ threadId, modelSelection: selection });
      yield* service.preview(next);
      const compaction = yield* service.preview({ ...next, kind: "compaction" });
      expect(picks).toHaveLength(2);
      yield* service.preview({ ...next, fresh: true });
      expect(picks).toHaveLength(3);
      yield* TestClock.adjust("5 seconds");
      yield* service.preview(next);
      expect(picks).toHaveLength(4);
      // A pick or steer moves the route, so the chip's next read asks the router again.
      yield* service.steer({ instanceId: "claude" as never, account: OTHER as never });
      yield* service.preview(next);
      expect(picks).toHaveLength(5);
      expect(picks[0]).toEqual({
        provider: "claude",
        model: "claude-sonnet-5-5",
        session: "native-session",
        keepWarm: true,
      });
      expect(first).toEqual({
        account: OWNER,
        current: OWNER,
        basis: "warm",
        approximate: false,
        switchBelowContextTokens: null,
      });
      expect(compaction).toMatchObject({ account: OTHER, approximate: false });
      const usage = yield* service.usage({ threadId });
      expect(usage.thread).toMatchObject({
        current: "work@example.com",
        next: "work@example.com",
        basis: "warm",
        afterCompaction: "spare@example.com (Pro)",
      });
      expect(usage.hubs[0]?.accounts.map((account) => account.account)).toEqual([
        "work@example.com",
        "spare@example.com (Pro)",
        "work@elsewhere.test",
      ]);
      // Router aliases are internal ids; agents read emails and plans.
      expect(JSON.stringify(usage)).not.toMatch(/account-[0-9a-f]{16}/);
    }).pipe(Effect.provide(testLayer({ picks })));
  });

  it.effect("marks a compaction preview approximate when the router ignores the kind", () =>
    Effect.gen(function* () {
      const service = yield* ThreadAccountService.make;
      const compaction = yield* service.preview({
        threadId,
        modelSelection: selection,
        kind: "compaction",
      });
      expect(compaction).toMatchObject({ approximate: true });
      const next = yield* service.preview({ threadId, modelSelection: selection, kind: "next" });
      expect(next).toMatchObject({ approximate: false });
      const usage = yield* service.usage({ threadId });
      expect(usage.thread && "afterCompaction" in usage.thread).toBe(false);
    }).pipe(Effect.provide(testLayer({ oldRouter: true }))),
  );
});

describe("accountNamesIn", () => {
  it("names a hub's accounts by email and plan, adding what tells clashing ones apart", () => {
    const account = (routerAlias: string, driver: string, email?: string, plan?: string) =>
      ({ routerAlias, driver, email, plan }) as never;
    const accounts = [
      account(OWNER, "claudeAgent", "me@example.com", "Pro"),
      account(OTHER, "codex", "ME@example.com", "Pro"),
      account(ELSEWHERE, "claudeAgent", "solo@example.com"),
      account("account-4444444444444444", "claudeAgent"),
      account("account-5555555555555555", "codex", "twin@example.com", "Plus"),
      account("account-6666666666666666", "codex", "twin@example.com", "Plus"),
    ];
    expect(accounts.map(ThreadAccountService.accountNamesIn(accounts))).toEqual([
      "me@example.com (Pro, Claude)",
      "ME@example.com (Pro, Codex)",
      "solo@example.com",
      "account-4444444444444444",
      "account-5555555555555555",
      "account-6666666666666666",
    ]);
  });
});
