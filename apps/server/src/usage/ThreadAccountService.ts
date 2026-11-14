import {
  type AccountUsageSummary,
  agentsCanRedeemResetCreditsOf,
  CommandId,
  MessageId,
  THREAD_ACCOUNT_MOVE_WARNING,
  ThreadAccountError,
  type ModelSelection,
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderInstanceId,
  ProviderSetupError,
  RouterAccountAlias,
  RouterProvider,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ThreadAccountChoice,
  type ThreadAccountEndInput,
  type ThreadAccountMarginInput,
  type ThreadAccountPreview,
  type ThreadAccountPreviewInput,
  type ThreadAccountRouting,
  type ThreadAccountRoutingInput,
  type ThreadAccountSetInput,
  type ThreadAccountState,
  type ThreadAccountStateInput,
  type ThreadAccountSteerInput,
  type ThreadAccountUsage,
  type ThreadAccountUsageInput,
  type ThreadId,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
  UsageLimitSourceError,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UsageResetSnooze,
  threadAccountChoiceFor,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { controlExpiry } from "../provider/ThreadAccountRouting.ts";
import * as Settings from "../serverSettings.ts";
import { routerProviderOf } from "./cliproxyApi.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageResetSnoozeService from "./UsageResetSnoozeService.ts";

const fail = (detail: string) => new ThreadAccountError({ detail });
const isThreadAccountError = Schema.is(ThreadAccountError);
const isRouterAccountAlias = Schema.is(RouterAccountAlias);
const isRouterProvider = Schema.is(RouterProvider);
const NOT_ROUTED =
  "This thread's provider does not route through one CLI Proxy quota router with several accounts.";
const MARGIN_ACTOR = "T3 Code";
const MAX_CONTROL_MS = 7 * 24 * 60 * 60 * 1000;
// Composers poll the preview while visible and check it before each send; one read per hub,
// session, model and kind serves every client and the picker for this long.
const PREVIEW_SHARE_MS = 5_000;
// Like turn-start pins: a dead hub must not hold a send's account check or the chip.
const PREVIEW_TIMEOUT = "3 seconds";
const REDEEM_OFF =
  "The user has not let agents redeem reset credits. They can turn on Settings → Threads → Usage limits → Let agents redeem reset credits.";

/** An agent's redemption: a native instance, or a hub account by its name (see `named`). */
export type ThreadAccountRedeemInput = (
  | { readonly instanceId: ProviderInstanceId }
  | { readonly account: RouterAccountAlias }
) & { readonly creditId?: string };

// Agents name an account by router alias, email (any case) or the part before the `@` when only
// one account has it; the router itself only ever sees the alias.
const named = <T>(
  candidates: ReadonlyArray<T>,
  name: string,
  accountOf: (candidate: T) => UsageLimitSourceAccount,
  where: string,
): Effect.Effect<T, ThreadAccountError> => {
  const lower = name.toLowerCase();
  const exact = candidates.filter((candidate) => accountOf(candidate).routerAlias === name);
  const byEmail = candidates.filter(
    (candidate) => accountOf(candidate).email?.toLowerCase() === lower,
  );
  const matches =
    exact.length > 0
      ? exact
      : byEmail.length > 0
        ? byEmail
        : candidates.filter(
            (candidate) => accountOf(candidate).email?.toLowerCase().split("@")[0] === lower,
          );
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  const list = (entries: ReadonlyArray<T>) =>
    entries
      .map((entry) => {
        const account = accountOf(entry);
        return account.email ? `${account.email} (${account.routerAlias})` : account.routerAlias;
      })
      .join(", ");
  return Effect.fail(
    matches.length === 0
      ? fail(`No account ${where} is named "${name}". Choose one of: ${list(candidates)}.`)
      : fail(`"${name}" matches several accounts: ${list(matches)}. Use the email or alias.`),
  );
};

const isoOf = (value: string | null | undefined) =>
  value ? Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.formatIso)) : undefined;
// The router accepts provider-prefixed session ids; T3 knows the bare native id.
const bareSession = (session: string) => session.replace(/^(claude|codex):/, "");

// Claude marks a gateway as a custom endpoint; Codex marks native usage unsupported for custom
// providers (not for direct API keys). Such a provider's own windows describe whichever hub
// account served its last turn.
export const behindHub = (provider: ServerProvider) =>
  provider.auth.type === "customEndpoint" ||
  (provider.usageLimits?.unavailable?.reason === "unsupported" && provider.auth.type !== "apiKey");

// Hub settings do not name the endpoint they serve, so only a single hub holding the provider's
// accounts identifies where its requests go, as for "Snooze until usage resets".
export const hubSourceOf = (
  provider: ServerProvider,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): UsageLimitSourceSnapshot | null => {
  if (!behindHub(provider)) return null;
  const hubs = sources.filter((source) =>
    source.accounts.some((account) => account.driver === provider.driver),
  );
  return hubs.length === 1 ? hubs[0]! : null;
};

const usageSummary = (limits: ServerProviderUsageLimits) => ({
  checkedAt: limits.checkedAt,
  windows: limits.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
  })),
  ...(limits.usageCredits ? { usageCredits: limits.usageCredits } : {}),
  ...(limits.resetCredits ? { resetCredits: limits.resetCredits.availableCount } : {}),
  ...(limits.resetCredits?.options?.length
    ? {
        resetCreditOptions: limits.resetCredits.options.map((option) => ({
          creditId: option.creditId,
          label: option.label,
          availableCount: option.availableCount,
        })),
      }
    : {}),
  ...(limits.unavailable
    ? { unavailable: limits.unavailable.message ?? limits.unavailable.reason }
    : {}),
});

/** Fork: which quota-router account a thread, or new threads of a provider, use. */
export class ThreadAccounts extends Context.Reference<{
  readonly state: (
    input: ThreadAccountStateInput,
  ) => Effect.Effect<ThreadAccountState, ThreadAccountError>;
  /** Where the thread's next request, or the one after a compaction, would go. */
  readonly preview: (
    input: ThreadAccountPreviewInput,
  ) => Effect.Effect<ThreadAccountPreview, ThreadAccountError>;
  readonly set: (input: ThreadAccountSetInput) => Effect.Effect<void, ThreadAccountError>;
  /**
   * The choice a new thread on `instanceId` stores at launch, its turn start pinning it; `account`
   * is an email or alias on that instance's hub.
   */
  readonly launchChoice: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly account: string;
    readonly stall: boolean;
  }) => Effect.Effect<ThreadAccountChoice, ThreadAccountError>;
  readonly steer: (input: ThreadAccountSteerInput) => Effect.Effect<void, ThreadAccountError>;
  readonly routing: (
    input: ThreadAccountRoutingInput,
  ) => Effect.Effect<ThreadAccountRouting, ThreadAccountError>;
  /** Every account's usage and each hub's routing, from the readings the server already has. */
  readonly usage: (
    input: ThreadAccountUsageInput,
  ) => Effect.Effect<ThreadAccountUsage, ThreadAccountError>;
  readonly margin: (input: ThreadAccountMarginInput) => Effect.Effect<void, ThreadAccountError>;
  readonly end: (input: ThreadAccountEndInput) => Effect.Effect<void, ThreadAccountError>;
  /** Redeems a banked reset for the user, as the Usage page does. */
  readonly consumeResetCredit: (
    input: ProviderConsumeResetCreditInput,
  ) => Effect.Effect<ProviderConsumeResetCreditResult, ProviderSetupError | UsageLimitSourceError>;
  /** An agent's redemption, refused unless the user turned it on in settings. */
  readonly redeem: (
    input: ThreadAccountRedeemInput,
  ) => Effect.Effect<ProviderConsumeResetCreditResult, ThreadAccountError>;
  /** When the account the thread's next message would use gets quota back. */
  readonly usageResetAt: (
    threadId: ThreadId,
  ) => Effect.Effect<UsageResetSnooze, ThreadAccountError>;
  /** A stored choice's account as its hub's router names it now, with its email, for agents. */
  readonly describeChoice: (
    choice: ThreadAccountChoice,
  ) => Effect.Effect<{ readonly account: RouterAccountAlias; readonly email?: string }>;
}>("t3/usage/ThreadAccounts", {
  defaultValue: () => ({
    state: () => Effect.succeed(null),
    preview: () => Effect.succeed(null),
    routing: () => Effect.succeed(null),
    usage: () => Effect.succeed({ agentsCanRedeemResetCredits: false, native: [], hubs: [] }),
    set: () => Effect.fail(fail("Account choice is unavailable.")),
    launchChoice: () => Effect.fail(fail("Account choice is unavailable.")),
    steer: () => Effect.fail(fail("Account choice is unavailable.")),
    margin: () => Effect.fail(fail("Account choice is unavailable.")),
    end: () => Effect.fail(fail("Account choice is unavailable.")),
    consumeResetCredit: () =>
      Effect.fail(new UsageLimitSourceError({ detail: "Reset credits are unavailable." })),
    redeem: () => Effect.fail(fail("Reset credits are unavailable.")),
    usageResetAt: () => Effect.fail(fail("Usage resets are unavailable.")),
    describeChoice: (choice) => Effect.succeed({ account: choice.account }),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
  const settingsService = yield* Settings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const usageResetSnooze = yield* UsageResetSnoozeService.make;
  const api = sources;

  // A snapshot keeps the aliases of its last refresh, which can trail the router's listing.
  const accountsOf = Effect.fn("ThreadAccounts.accountsOf")(function* (
    source: UsageLimitSourceSnapshot,
  ) {
    const rename = yield* sources.routerAlias(source.id);
    return source.accounts.map((account) =>
      account.routerAlias === undefined
        ? account
        : { ...account, routerAlias: rename(account.routerAlias) as RouterAccountAlias },
    );
  });

  const resolveTarget = Effect.fn("ThreadAccounts.resolveTarget")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const routerProvider = provider ? routerProviderOf(provider.driver) : undefined;
    if (!provider || !routerProvider) return null;
    const source = hubSourceOf(provider, yield* sources.current);
    const accounts = (source ? yield* accountsOf(source) : []).filter(
      (account) => account.driver === provider.driver && account.routerAlias !== undefined,
    );
    if (!source || accounts.length < 2) return null;
    const hub = yield* sources.hub(source.id);
    return hub === null ? null : { source, accounts, routerProvider, hub, instanceId };
  });

  const threadOf = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map((records) => records.thread),
      Effect.mapError(() => fail("That thread was not found.")),
    );

  // An account alias names its hub, unless two hubs share a management key.
  const locate = Effect.fn("ThreadAccounts.locate")(function* (
    name: string,
    sourceId?: UsageLimitSourceId,
    provider?: RouterProvider,
  ) {
    const searched = (yield* sources.current).filter(
      (source) => sourceId === undefined || source.id === sourceId,
    );
    const candidates = (yield* Effect.forEach(searched, (source) =>
      accountsOf(source).pipe(
        Effect.map((accounts) =>
          accounts
            .filter(
              (account) =>
                account.routerAlias !== undefined &&
                (provider === undefined || routerProviderOf(account.driver) === provider),
            )
            .map((account) => ({ source, account })),
        ),
      ),
    )).flat();
    // Only the hub whose router renamed a legacy alias knows it.
    const renamed = new Set(
      (yield* Effect.forEach(searched, (source) => sources.routerAlias(source.id)))
        .map((rename) => rename(name))
        .filter((alias) => alias !== name),
    );
    const alias = renamed.size === 1 ? [...renamed][0]! : name;
    if (candidates.filter((entry) => entry.account.routerAlias === alias).length > 1) {
      return yield* fail("Several CLI Proxy hubs list that account.");
    }
    const found = yield* named(candidates, alias, (entry) => entry.account, "on a CLI Proxy hub");
    const hub = yield* sources.hub(found.source.id);
    if (hub === null) return yield* fail("That CLI Proxy hub is disabled or has no key.");
    return { ...found, alias: found.account.routerAlias as RouterAccountAlias, hub };
  });

  const sessionOf = (threadId: ThreadId, modelSelection: ModelSelection) =>
    orchestrator.resolveMessageProviderThread(threadId, modelSelection).pipe(
      Effect.map((providerThread) => providerThread?.nativeThreadRef?.nativeId ?? undefined),
      Effect.orElseSucceed(() => undefined),
    );

  type Target = NonNullable<Effect.Success<ReturnType<typeof resolveTarget>>>;
  type Pick = Effect.Success<ReturnType<typeof api.nextPick>>;
  const pickReads = new Map<string, { readonly at: number; readonly read: Effect.Effect<Pick> }>();
  // Shares one router read per hub, session, model and kind; `fresh` reads again and shares that.
  const sharedPick = Effect.fn("ThreadAccounts.sharedPick")(function* (
    target: Target,
    input: { readonly session: string | undefined; readonly model: string },
    kind: ThreadAccountPreviewInput["kind"],
    fresh: boolean,
  ) {
    // None of these hold a newline.
    const key = [
      target.hub.url,
      target.routerProvider,
      input.session ?? "",
      input.model,
      kind,
    ].join("\n");
    const now = yield* Clock.currentTimeMillis;
    for (const [entryKey, entry] of pickReads) {
      if (now - entry.at >= PREVIEW_SHARE_MS) pickReads.delete(entryKey);
    }
    const shared = pickReads.get(key);
    if (shared !== undefined && !fresh) return yield* shared.read;
    const read = yield* Effect.cached(
      api
        .nextPick(target.hub, {
          provider: target.routerProvider,
          model: input.model,
          ...(input.session ? { session: input.session } : {}),
          ...(kind === "compaction" ? { kind } : {}),
          // T3's Claude processes mark every request for the router's keep-warm holds.
          ...(target.routerProvider === "claude" ? { keepWarm: true } : {}),
        })
        .pipe(
          Effect.timeout(PREVIEW_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logDebug("quota router pick preview failed", { cause }).pipe(Effect.as(null)),
          ),
        ),
    );
    pickReads.set(key, { at: now, read });
    return yield* read;
  });

  const forgetPicks = Effect.sync(() => pickReads.clear());

  // Router answers can still use an alias it renamed, until it lists its accounts.
  const aliasIn = Effect.fn("ThreadAccounts.aliasIn")(function* (target: Target) {
    const rename = yield* sources.routerAlias(target.source.id);
    const known = new Set(target.accounts.map((account) => account.routerAlias));
    return (value: string | null | undefined) =>
      value && known.has(rename(value)) ? (rename(value) as RouterAccountAlias) : null;
  });

  const preview = Effect.fn("ThreadAccounts.preview")(function* (
    input: ThreadAccountPreviewInput,
  ): Effect.fn.Return<ThreadAccountPreview> {
    const target = yield* resolveTarget(input.modelSelection.instanceId);
    if (target === null) return null;
    const session = input.threadId
      ? yield* sessionOf(input.threadId, input.modelSelection)
      : undefined;
    const pick = yield* sharedPick(
      target,
      { session, model: input.modelSelection.model },
      input.kind,
      input.fresh === true,
    );
    if (pick === null) return null;
    const alias = yield* aliasIn(target);
    return {
      account: alias(pick.account),
      current: alias(pick.current),
      basis: pick.basis,
      // Routers that ignore `kind` answer for the next ordinary request.
      approximate: input.kind === "compaction" && pick.kind !== "compaction",
      switchBelowContextTokens: pick.switchBelowContextTokens,
    };
  });

  const state = Effect.fn("ThreadAccounts.state")(function* (
    input: ThreadAccountStateInput,
  ): Effect.fn.Return<ThreadAccountState> {
    const target = yield* resolveTarget(input.modelSelection.instanceId);
    if (target === null) return null;
    const session = input.threadId
      ? yield* sessionOf(input.threadId, input.modelSelection)
      : undefined;
    const [pick, control] = yield* Effect.all(
      [
        sharedPick(target, { session, model: input.modelSelection.model }, "next", false),
        api.control(target.source.id, target.hub).pipe(Effect.option),
      ],
      { concurrency: "unbounded" },
    );
    const alias = yield* aliasIn(target);
    const routerSteer =
      control._tag === "Some"
        ? control.value.steers?.find((steer) => steer.provider === target.routerProvider)?.account
        : undefined;
    return {
      sourceId: target.source.id,
      instanceId: target.instanceId,
      accounts: target.accounts,
      next: alias(pick?.account),
      steer: alias(routerSteer),
      owner: alias(pick?.owner),
    } as ThreadAccountState;
  });

  // Clearing a choice unpins every session the thread has had, since a pin listed for an older
  // provider thread still names this thread.
  const threadSessions = (threadId: ThreadId, current: string | undefined) =>
    orchestrator.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map((records) => records.providerThreads),
      Effect.orElseSucceed(() => []),
      Effect.map((providerThreads) => [
        ...new Set([
          ...(current ? [current] : []),
          ...providerThreads.flatMap((providerThread) =>
            providerThread.nativeThreadRef?.nativeId
              ? [providerThread.nativeThreadRef.nativeId]
              : [],
          ),
        ]),
      ]),
    );

  const set = Effect.fn("ThreadAccounts.set")(function* (input: ThreadAccountSetInput) {
    const thread = yield* threadOf(input.threadId);
    const target = yield* resolveTarget(thread.modelSelection.instanceId);
    const session = yield* sessionOf(input.threadId, thread.modelSelection);
    const now = yield* DateTime.now;
    const commandId = CommandId.make(
      `thread-account:${input.threadId}:${DateTime.toEpochMillis(now)}`,
    );
    if (input.account === null) {
      // A stored choice stays removable after its provider stops routing through the hub.
      const sourceId = target?.source.id ?? thread.accountChoice?.sourceId;
      if (sourceId === undefined) return yield* fail(NOT_ROUTED);
      const hub = target?.hub ?? (yield* sources.hub(sourceId));
      const sessions = yield* threadSessions(input.threadId, session);
      if (hub !== null && sessions.length > 0) yield* api.unpin(hub, sessions);
      yield* orchestrator.dispatch({
        type: "thread.account-choice.set",
        commandId,
        threadId: input.threadId,
        accountChoice: null,
      });
      return;
    }
    if (target === null) return yield* fail(NOT_ROUTED);
    const rename = yield* sources.routerAlias(target.source.id);
    const account = (yield* named(
      target.accounts,
      rename(input.account),
      (entry) => entry,
      "on this thread's CLI Proxy hub",
    )).routerAlias as RouterAccountAlias;
    // Changing only the account keeps the stored wait-when-out setting.
    const current = threadAccountChoiceFor(thread.accountChoice, target.instanceId);
    const stall =
      input.stall ?? (current && rename(current.account) === account ? current.stall : false);
    let moved = false;
    if (session) {
      const pick = yield* api.nextPick(target.hub, {
        provider: target.routerProvider,
        session,
        model: thread.modelSelection.model,
      });
      moved = !!pick?.owner && rename(pick.owner) !== account;
      if (moved && input.dropThinking !== true) {
        return yield* new ThreadAccountError({
          detail: `${THREAD_ACCOUNT_MOVE_WARNING} Confirm with dropThinking: true to switch.`,
          requiresDropThinking: true,
        });
      }
      yield* api.pin(target.hub, {
        sessions: [session],
        account: rename(account),
        stall,
        expiresAt: controlExpiry(now),
        move: moved,
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.account-choice.set",
      commandId,
      threadId: input.threadId,
      accountChoice: {
        sourceId: target.source.id,
        account,
        stall,
        instanceId: target.instanceId,
      },
      ...(moved ? { accountMovedAt: DateTime.formatIso(now) } : {}),
    });
    // A keep-warm hold forwards its request to the account it is held on, so stop the turn (the
    // request never reached the provider) and continue it, which the new pin routes. A pin hold
    // needs neither: the router re-places held requests when their pin changes.
    const held = yield* keepWarm.find(input.threadId);
    if (held === null || held.turn.hold.released === true || held.turn.hold.kind === "pin") return;
    const continueId = `thread-account-continue:${held.turn.runId}`;
    yield* Effect.forEach(
      [
        {
          type: "message.dispatch",
          commandId: CommandId.make(continueId),
          messageId: MessageId.make(continueId),
          threadId: input.threadId,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        },
        {
          type: "run.interrupt",
          commandId: CommandId.make(`${continueId}:stop`),
          threadId: input.threadId,
          runId: held.turn.runId,
          preserveDelegatedTasks: true,
          reason: "Stopped to continue on the chosen account.",
        },
      ] as const,
      (command) => orchestrator.dispatch(command),
      { discard: true },
    );
  });

  const launchChoice = Effect.fn("ThreadAccounts.launchChoice")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly account: string;
    readonly stall: boolean;
  }) {
    const target = yield* resolveTarget(input.instanceId);
    if (target === null) {
      return yield* fail(
        `Provider instance ${input.instanceId} does not route through one CLI Proxy quota router with several accounts, so it takes no account.`,
      );
    }
    const rename = yield* sources.routerAlias(target.source.id);
    const account = (yield* named(
      target.accounts,
      rename(input.account),
      (entry) => entry,
      `on the CLI Proxy hub of ${input.instanceId}`,
    )).routerAlias as RouterAccountAlias;
    return {
      sourceId: target.source.id,
      account,
      stall: input.stall,
      instanceId: target.instanceId,
    } satisfies ThreadAccountChoice;
  });

  const saveSteer = Effect.fn("ThreadAccounts.saveSteer")(function* (
    sourceId: UsageLimitSourceId,
    provider: RouterProvider,
    account: RouterAccountAlias | null,
  ) {
    const settings = yield* settingsService.getSettings;
    const config = settings.usageLimitSources[sourceId];
    if (!config) return;
    const { [provider]: _previous, ...others } = config.steers ?? {};
    const steers = account === null ? others : { ...others, [provider]: account };
    const { steers: _steers, ...rest } = config;
    const next: UsageLimitSourceConfig =
      Object.keys(steers).length === 0 ? rest : { ...rest, steers };
    yield* settingsService.updateSettings({ usageLimitSources: { [sourceId]: next } });
  });

  const steer = Effect.fn("ThreadAccounts.steer")(function* (input: ThreadAccountSteerInput) {
    if (!("instanceId" in input)) {
      if (input.account !== null) {
        const located = yield* locate(input.account, input.sourceId, input.provider);
        const provider = routerProviderOf(located.account.driver);
        if (provider === undefined) {
          return yield* fail("That account is not a Claude or Codex account.");
        }
        yield* api.steer(
          located.hub,
          (yield* sources.routerAlias(located.source.id))(located.alias),
          controlExpiry(yield* DateTime.now),
        );
        return yield* saveSteer(located.source.id, provider, located.alias);
      }
      const provider = input.provider;
      if (provider === undefined) return yield* fail("Name the provider whose steer to clear.");
      const sourceIds =
        input.sourceId !== undefined
          ? [input.sourceId]
          : (yield* sources.current)
              .filter((source) =>
                source.accounts.some((account) => routerProviderOf(account.driver) === provider),
              )
              .map((source) => source.id);
      if (sourceIds.length === 0) {
        return yield* fail("No CLI Proxy hub lists accounts for that provider.");
      }
      return yield* Effect.forEach(
        sourceIds,
        (sourceId) =>
          Effect.gen(function* () {
            const hub = yield* sources.hub(sourceId);
            if (hub === null) return yield* fail("That CLI Proxy hub is disabled or has no key.");
            yield* api.unsteer(hub, provider);
            yield* saveSteer(sourceId, provider, null);
          }),
        { discard: true },
      );
    }
    const target = yield* resolveTarget(input.instanceId);
    if (target === null) return yield* fail(NOT_ROUTED);
    const account =
      input.account === null
        ? null
        : ((yield* named(
            target.accounts,
            (yield* sources.routerAlias(target.source.id))(input.account),
            (entry) => entry,
            "on this provider's CLI Proxy hub",
          )).routerAlias as RouterAccountAlias);
    if (account === null) {
      yield* api.unsteer(target.hub, target.routerProvider);
    } else {
      yield* api.steer(
        target.hub,
        (yield* sources.routerAlias(target.source.id))(account),
        controlExpiry(yield* DateTime.now),
      );
    }
    yield* saveSteer(target.source.id, target.routerProvider, account);
  });

  // The router's list is the truth; T3's stored choices join it by native session id and fill in
  // what it does not list, such as an expired pin that the thread's next turn re-applies.
  const routing = Effect.fn("ThreadAccounts.routing")(function* (input: ThreadAccountRoutingInput) {
    const hub = yield* sources.hub(input.sourceId);
    if (hub === null) return null;
    const [control, threads, settings] = yield* Effect.all(
      [
        api.control(input.sourceId, hub),
        projections
          .getThreadsWithAccountChoices(input.sourceId)
          .pipe(Effect.mapError(() => fail("Could not read the threads' account choices."))),
        settingsService.getSettings.pipe(Effect.mapError(() => fail("Could not read settings."))),
      ],
      { concurrency: "unbounded" },
    );
    const owned = new Map(
      yield* Effect.forEach(threads, (thread) =>
        sessionOf(thread.id, thread.modelSelection).pipe(
          Effect.map((session) => [session ?? `thread:${thread.id}`, thread] as const),
        ),
      ),
    );
    // Pins set outside T3, holds and margins can still name a T3 thread's session.
    const unowned = new Set(
      [...(control.pins ?? []), ...(control.held ?? []), ...(control.margins ?? [])]
        .map((entry) => bareSession(entry.session))
        .filter((session) => !owned.has(session)),
    );
    const known = new Map(
      (yield* projections
        .getThreadsByNativeIds([...unowned])
        .pipe(Effect.orElseSucceed(() => []))).map((row) => [
        row.nativeId,
        { id: row.id, title: row.title },
      ]),
    );
    const routed = (raw: string) => {
      const session = bareSession(raw);
      const stored = owned.get(session);
      const thread = stored ? { id: stored.id, title: stored.title } : (known.get(session) ?? null);
      return { thread, session: thread ? null : session.slice(0, 8) };
    };
    // Stored choices, saved steers and a router's answers before it lists its accounts can
    // still name an account by an alias the router renamed.
    const rename = yield* sources.routerAlias(input.sourceId);
    const alias = (value: string | undefined) => {
      const renamed = value === undefined ? undefined : rename(value);
      return renamed !== undefined && isRouterAccountAlias(renamed) ? renamed : null;
    };

    const listed = new Set<string>();
    const pins: Array<NonNullable<ThreadAccountRouting>["pins"][number]> = [];
    for (const pin of control.pins ?? []) {
      const account = alias(pin.account);
      if (account === null) continue;
      listed.add(bareSession(pin.session));
      const expiresAt = isoOf(pin.expires_at);
      pins.push({
        account,
        stall: pin.stall ?? false,
        active: true,
        ...(expiresAt ? { expiresAt } : {}),
        ...routed(pin.session),
      });
    }
    for (const [session, thread] of owned) {
      const choice = threadAccountChoiceFor(thread.accountChoice, thread.modelSelection.instanceId);
      if (listed.has(session) || !choice) continue;
      pins.push({
        account: alias(choice.account) ?? choice.account,
        stall: choice.stall,
        active: false,
        thread: { id: thread.id, title: thread.title },
        session: null,
      });
    }
    const routerSteers = (control.steers ?? []).flatMap((steer) => {
      const account = alias(steer.account);
      if (!isRouterProvider(steer.provider) || account === null) return [];
      const expiresAt = isoOf(steer.expires_at);
      return [
        {
          provider: steer.provider,
          account,
          active: true,
          ...(expiresAt ? { expiresAt } : {}),
        },
      ];
    });
    const savedSteers = Object.entries(settings.usageLimitSources[input.sourceId]?.steers ?? {})
      .filter(
        (entry): entry is [RouterProvider, RouterAccountAlias] =>
          entry[1] !== undefined && !routerSteers.some((steer) => steer.provider === entry[0]),
      )
      .map(([provider, account]) => ({
        provider,
        account: alias(account) ?? account,
        active: false,
      }));
    // A conversation's subagents share its session, so one row per session, account and kind.
    const held = new Map<string, NonNullable<NonNullable<ThreadAccountRouting>["held"]>[number]>();
    for (const hold of control.held ?? []) {
      const releaseAt = isoOf(hold.release_at);
      const kind = hold.kind ?? "pin";
      const key = `${bareSession(hold.session)}\n${hold.account}\n${kind}`;
      if (releaseAt === undefined || held.has(key)) continue;
      held.set(key, {
        account: alias(hold.account),
        kind,
        releaseAt,
        resetAt: isoOf(hold.reset_at) ?? null,
        ...routed(hold.session),
      });
    }
    const margins = (control.margins ?? []).flatMap((margin) => {
      const expiresAt = isoOf(margin.expires_at);
      return expiresAt === undefined
        ? []
        : [
            {
              headroomScale: margin.headroom_scale,
              expiresAt,
              actor: margin.actor ?? null,
              ...routed(margin.session),
            },
          ];
    });
    const ends = (control.ends ?? []).flatMap((end) => {
      const endsAt = isoOf(end.ends_at);
      const account = alias(end.account);
      return endsAt === undefined || account === null ? [] : [{ account, endsAt }];
    });
    const result: ThreadAccountRouting = {
      steers: [...routerSteers, ...savedSteers],
      pins,
      held: [...held.values()],
      margins,
      ends,
    };
    return result;
  });

  const agentsCanRedeem = settingsService.getSettings.pipe(
    Effect.map(agentsCanRedeemResetCreditsOf),
    Effect.mapError(() => fail("Could not read settings.")),
  );

  const usage = Effect.fn("ThreadAccounts.usage")(function* (input: ThreadAccountUsageInput) {
    const [providerList, snapshots, agentsCanRedeemResetCredits] = yield* Effect.all([
      providers.getProviders,
      sources.current,
      agentsCanRedeem,
    ]);
    const native = providerList.flatMap((provider) =>
      provider.enabled && provider.usageLimits && !behindHub(provider)
        ? [
            {
              instanceId: provider.instanceId,
              driver: provider.driver,
              ...(provider.auth.email ? { email: provider.auth.email } : {}),
              ...usageSummary(provider.usageLimits),
            },
          ]
        : [],
    );
    const hubs = yield* Effect.forEach(
      snapshots,
      (source) =>
        routing({ sourceId: source.id }).pipe(
          // Stock hubs have no quota router to read.
          Effect.orElseSucceed(() => null),
          // After the routing read, which can bring a newer listing.
          Effect.flatMap((routes) =>
            accountsOf(source).pipe(Effect.map((accounts) => ({ routes, accounts }))),
          ),
          Effect.map(({ routes, accounts }) => ({
            sourceId: source.id,
            label: source.label,
            ...(source.error ? { error: source.error } : {}),
            accounts: accounts.map((account): AccountUsageSummary => ({
              driver: account.driver,
              ...(account.routerAlias ? { account: account.routerAlias } : {}),
              ...(account.email ? { email: account.email } : {}),
              ...(account.plan ? { plan: account.plan } : {}),
              ...(account.subscriptionEndsAt
                ? { subscriptionEndsAt: account.subscriptionEndsAt }
                : {}),
              ...usageSummary(account.usageLimits),
            })),
            routing: routes,
          })),
        ),
      { concurrency: "unbounded" },
    );
    if (input.threadId === undefined) return { agentsCanRedeemResetCredits, native, hubs };
    const thread = yield* threadOf(input.threadId);
    const picked = yield* state({ threadId: thread.id, modelSelection: thread.modelSelection });
    const afterCompaction = picked
      ? yield* preview({
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          kind: "compaction",
        })
      : null;
    const chosen = threadAccountChoiceFor(thread.accountChoice, thread.modelSelection.instanceId);
    return {
      agentsCanRedeemResetCredits,
      native,
      hubs,
      thread: {
        threadId: thread.id,
        next: picked?.next ?? null,
        ...(afterCompaction?.account && !afterCompaction.approximate
          ? { afterCompaction: afterCompaction.account }
          : {}),
        owner: picked?.owner ?? null,
        chosen: chosen
          ? {
              account: (yield* sources.routerAlias(chosen.sourceId))(
                chosen.account,
              ) as RouterAccountAlias,
              waitWhenOut: chosen.stall,
            }
          : null,
      },
    };
  });

  const controlUntil = Effect.fn("ThreadAccounts.controlUntil")(function* (
    value: string | undefined,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const until = value === undefined ? now + 60 * 60 * 1000 : Date.parse(value);
    if (!(until > now && until <= now + MAX_CONTROL_MS)) {
      return yield* fail("`until` must be in the future and at most seven days ahead.");
    }
    return DateTime.formatIso(DateTime.makeUnsafe(until));
  });

  const margin = Effect.fn("ThreadAccounts.margin")(function* (input: ThreadAccountMarginInput) {
    const thread = yield* threadOf(input.threadId);
    const target = yield* resolveTarget(thread.modelSelection.instanceId);
    if (target === null) return yield* fail(NOT_ROUTED);
    if (target.routerProvider !== "claude") {
      return yield* fail("Safety-margin overrides apply to Claude threads only.");
    }
    const session = yield* sessionOf(thread.id, thread.modelSelection);
    if (!session) {
      return yield* fail(
        "This thread has no conversation yet; set its margin after its first turn.",
      );
    }
    yield* api.margin(target.hub, {
      sessions: [session],
      headroomScale: input.headroomScale,
      expiresAt: yield* controlUntil(input.until),
      actor: MARGIN_ACTOR,
    });
  });

  const end = Effect.fn("ThreadAccounts.end")(function* (input: ThreadAccountEndInput) {
    const endsAt = input.endsAt === null ? null : (isoOf(input.endsAt) ?? null);
    if (input.endsAt !== null && endsAt === null) {
      return yield* fail("`endsAt` must be an ISO date and time.");
    }
    const located = yield* locate(input.account);
    yield* api.subscriptionEnd(
      located.hub,
      endsAt === null
        ? yield* sources.removedEndAlias(located.source.id, located.hub, located.alias)
        : (yield* sources.routerAlias(located.source.id))(located.alias),
      endsAt,
    );
  });

  const consumeResetCredit = Effect.fn("ThreadAccounts.consumeResetCredit")(function* (
    input: ProviderConsumeResetCreditInput,
  ) {
    if ("sourceId" in input) return yield* sources.consumeResetCredit(input);
    const instance = yield* providerInstances.getInstance(input.instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "consume-reset-credit",
        detail: instance ? "This provider is disabled." : "Provider instance not found.",
      });
    }
    if (instance.consumeResetCredit === undefined) {
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: "consume-reset-credit",
        detail: "This provider does not bank reset credits.",
      });
    }
    const outcome = yield* instance.consumeResetCredit(input.creditId).pipe(
      Effect.mapError(
        (error) =>
          new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "consume-reset-credit",
            detail: error.detail,
            cause: error,
          }),
      ),
    );
    return { outcome };
  });

  const redeem = Effect.fn("ThreadAccounts.redeem")(function* (input: ThreadAccountRedeemInput) {
    if (!(yield* agentsCanRedeem)) return yield* fail(REDEEM_OFF);
    if ("instanceId" in input) {
      const provider = (yield* providers.getProviders).find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      const options = provider?.usageLimits?.resetCredits?.options ?? [];
      if (input.creditId === undefined && options.length > 0) {
        return yield* fail(
          `Pass \`creditId\`, one of: ${options.map((option) => option.creditId).join(", ")}.`,
        );
      }
      return yield* consumeResetCredit(input);
    }
    const located = yield* locate(input.account);
    const creditId = input.creditId ?? located.account.usageLimits.resetCredits?.nextCreditId;
    if (creditId === undefined) return yield* fail("That account has no reset credit to redeem.");
    return yield* consumeResetCredit({
      sourceId: located.source.id,
      accountId: located.account.id,
      creditId,
    });
  });

  const usageResetAt = Effect.fn("ThreadAccounts.usageResetAt")(function* (threadId: ThreadId) {
    const thread = yield* threadOf(threadId);
    return yield* usageResetSnooze.resolve({ threadId, modelSelection: thread.modelSelection });
  });

  // Clients find a thread's choice among the hub's accounts by alias, so once a router renames
  // them (0.28.0 aliases, or a rollback), each stored choice on that hub takes the new alias.
  const renameChoices = Effect.fn("ThreadAccounts.renameChoices")(function* (
    sourceId: UsageLimitSourceId,
  ) {
    const rename = yield* sources.routerAlias(sourceId);
    // Saved steers too: after a management-key change no legacy alias would match them.
    const config = (yield* settingsService.getSettings).usageLimitSources[sourceId];
    if (config?.steers) {
      const steers = Object.fromEntries(
        Object.entries(config.steers).map(([provider, account]) => [
          provider,
          account === undefined ? account : (rename(account) as RouterAccountAlias),
        ]),
      );
      if (!Equal.equals(steers, config.steers)) {
        yield* settingsService.updateSettings({
          usageLimitSources: { [sourceId]: { ...config, steers } },
        });
      }
    }
    const threads = yield* projections.getThreadsWithAccountChoices(sourceId);
    for (const thread of threads) {
      const choice = thread.accountChoice;
      if (!choice) continue;
      const account = rename(choice.account) as RouterAccountAlias;
      if (account === choice.account) continue;
      // A pick made since the read wins over the rename.
      const latest = yield* orchestrator.getThreadRecords(thread.id, []).pipe(Effect.option);
      const stored = Option.isSome(latest) ? latest.value.thread.accountChoice : undefined;
      if (stored?.sourceId !== sourceId || stored.account !== choice.account) continue;
      yield* orchestrator.dispatch({
        type: "thread.account-choice.set",
        commandId: CommandId.make(
          `thread-account-alias:${thread.id}:${DateTime.toEpochMillis(yield* DateTime.now)}`,
        ),
        threadId: thread.id,
        accountChoice: { ...stored, account },
      });
    }
  });
  yield* sources.streamChanges.pipe(
    Stream.map((snapshots) =>
      snapshots.map((source) => [source.id, source.accounts.map((account) => account.routerAlias)]),
    ),
    Stream.changes,
    Stream.runForEach((aliases) =>
      Effect.forEach(
        aliases,
        ([sourceId]) =>
          renameChoices(sourceId as UsageLimitSourceId).pipe(Effect.ignoreCause({ log: true })),
        { discard: true },
      ),
    ),
    Effect.forkScoped,
  );

  const asThreadAccountError = <A, E extends { readonly message: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.mapError((error) => (isThreadAccountError(error) ? error : fail(error.message))),
    );

  return {
    state: (input: ThreadAccountStateInput) => asThreadAccountError(state(input)),
    preview: (input: ThreadAccountPreviewInput) => asThreadAccountError(preview(input)),
    // Pins, steers and margins change the pick, so the next preview reads the router again.
    set: (input: ThreadAccountSetInput) =>
      asThreadAccountError(set(input)).pipe(Effect.ensuring(forgetPicks)),
    launchChoice,
    steer: (input: ThreadAccountSteerInput) =>
      asThreadAccountError(steer(input)).pipe(Effect.ensuring(forgetPicks)),
    routing: (input: ThreadAccountRoutingInput) => asThreadAccountError(routing(input)),
    usage: (input: ThreadAccountUsageInput) => asThreadAccountError(usage(input)),
    margin: (input: ThreadAccountMarginInput) =>
      asThreadAccountError(margin(input)).pipe(Effect.ensuring(forgetPicks)),
    end: (input: ThreadAccountEndInput) => asThreadAccountError(end(input)),
    consumeResetCredit,
    redeem: (input: ThreadAccountRedeemInput) => asThreadAccountError(redeem(input)),
    usageResetAt: (threadId: ThreadId) => asThreadAccountError(usageResetAt(threadId)),
    describeChoice: Effect.fn("ThreadAccounts.describeChoice")(function* (
      choice: ThreadAccountChoice,
    ) {
      const account = (yield* sources.routerAlias(choice.sourceId))(
        choice.account,
      ) as RouterAccountAlias;
      const source = (yield* sources.current).find((entry) => entry.id === choice.sourceId);
      const email = source
        ? (yield* accountsOf(source)).find((entry) => entry.routerAlias === account)?.email
        : undefined;
      return email === undefined ? { account } : { account, email };
    }),
  } satisfies (typeof ThreadAccounts)["Service"];
});

export const layer = Layer.effect(ThreadAccounts, make);
