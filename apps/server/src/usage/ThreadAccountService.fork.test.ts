import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ServerCommand,
  ServerProvider,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
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
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccountService from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const OWNER = "account-1111111111111111";
const OTHER = "account-2222222222222222";
const ELSEWHERE = "account-3333333333333333";
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
      hubAccount(OTHER, "spare@example.com"),
      hubAccount(ELSEWHERE, "work@elsewhere.test"),
    ],
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
  readonly redemptions?: Array<unknown>;
  readonly picks?: Array<unknown>;
  readonly oldRouter?: boolean;
  // What the hub's router calls an alias now, as UsageLimitSources.routerAlias answers.
  readonly renamed?: Record<string, string>;
  readonly dispatched?: Deferred.Deferred<void>;
  // The stored choice per thread now, where it differs from `accountChoice`.
  readonly choices?: Record<string, unknown>;
}) {
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
      getProviders: Effect.succeed([provider]),
    }),
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      current: Effect.succeed(snapshots),
      streamChanges: Stream.make(snapshots),
      routerAlias: () => Effect.succeed((alias) => input.renamed?.[alias] ?? alias),
      removedEndAlias: (_sourceId, _hub, alias) => Effect.succeed(input.renamed?.[alias] ?? alias),
      hub: () => Effect.succeed({ url: "http://hub.test", managementKey: "key" }),
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
      unpin: (_hub, sessions) => Effect.sync(() => void input.controls?.push({ unpin: sessions })),
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
      getThreadRecords: (id) =>
        Effect.succeed({
          thread: {
            modelSelection,
            accountChoice: input.choices?.[id] ?? input.accountChoice,
          },
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
  readonly renamed?: Record<string, string>;
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
    { name: "a full email whose local part is shared", account: "work@example.com", pinned: OWNER },
    {
      name: "a shared local part",
      account: "work",
      error:
        '"work" matches several accounts: work@example.com (account-1111111111111111), work@elsewhere.test (account-3333333333333333). Use the email or alias.',
    },
    {
      name: "an unknown name",
      account: "nobody",
      error:
        'No account on this thread\'s CLI Proxy hub is named "nobody". Choose one of: work@example.com (account-1111111111111111), spare@example.com (account-2222222222222222), work@elsewhere.test (account-3333333333333333).',
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
        'No account on the CLI Proxy hub of claude is named "someone@other-hub.test". Choose one of: work@example.com (account-1111111111111111), spare@example.com (account-2222222222222222), work@elsewhere.test (account-3333333333333333).',
    },
    {
      name: "refuses an instance that does not route through a hub",
      instanceId: "codex",
      account: OTHER,
      error:
        "Provider instance codex does not route through one CLI Proxy quota router with several accounts, so it takes no account.",
    },
  ])("$name", ({ instanceId, account, choice, error }) =>
    Effect.gen(function* () {
      const service = yield* ThreadAccountService.make;
      const result = yield* service
        .launchChoice({ instanceId: instanceId as never, account, stall: true })
        .pipe(Effect.result);
      if (error === undefined) expect(result).toEqual(Result.succeed(choice));
      else expect(Result.isFailure(result) && result.failure.detail).toBe(error);
    }).pipe(Effect.provide(testLayer({}))),
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
        email: "work@example.com",
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
      expect(usage.thread).toMatchObject({ next: OWNER, afterCompaction: OTHER });
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
