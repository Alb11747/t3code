import {
  type AccountUsageSummary,
  CommandId,
  MessageId,
  THREAD_ACCOUNT_MOVE_WARNING,
  ThreadAccountError,
  type ModelSelection,
  type ProviderInstanceId,
  RouterAccountAlias,
  RouterProvider,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ThreadAccountEndInput,
  type ThreadAccountMarginInput,
  type ThreadAccountRouting,
  type ThreadAccountRoutingInput,
  type ThreadAccountSetInput,
  type ThreadAccountState,
  type ThreadAccountStateInput,
  type ThreadAccountSteerInput,
  type ThreadAccountUsage,
  type ThreadAccountUsageInput,
  type ThreadId,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageResetSnooze,
  threadAccountChoiceFor,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
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

const isoOf = (value: string | null | undefined) =>
  value ? Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.formatIso)) : undefined;
// The router accepts provider-prefixed session ids; T3 knows the bare native id.
const bareSession = (session: string) => session.replace(/^(claude|codex):/, "");

// Claude marks a gateway as a custom endpoint; Codex marks native usage unsupported for custom
// providers (not for direct API keys). Such a provider's own windows describe whichever hub
// account served its last turn.
const behindHub = (provider: ServerProvider) =>
  provider.auth.type === "customEndpoint" ||
  (provider.usageLimits?.unavailable?.reason === "unsupported" && provider.auth.type !== "apiKey");

const usageSummary = (limits: ServerProviderUsageLimits) => ({
  checkedAt: limits.checkedAt,
  windows: limits.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
  })),
  ...(limits.usageCredits ? { usageCredits: limits.usageCredits } : {}),
  ...(limits.resetCredits ? { resetCredits: limits.resetCredits.availableCount } : {}),
  ...(limits.unavailable
    ? { unavailable: limits.unavailable.message ?? limits.unavailable.reason }
    : {}),
});

/** Fork: which quota-router account a thread, or new threads of a provider, use. */
export class ThreadAccounts extends Context.Reference<{
  readonly state: (
    input: ThreadAccountStateInput,
  ) => Effect.Effect<ThreadAccountState, ThreadAccountError>;
  readonly set: (input: ThreadAccountSetInput) => Effect.Effect<void, ThreadAccountError>;
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
  /** When the account the thread's next message would use gets quota back. */
  readonly usageResetAt: (
    threadId: ThreadId,
  ) => Effect.Effect<UsageResetSnooze, ThreadAccountError>;
}>("t3/usage/ThreadAccounts", {
  defaultValue: () => ({
    state: () => Effect.succeed(null),
    routing: () => Effect.succeed(null),
    usage: () => Effect.succeed({ native: [], hubs: [] }),
    set: () => Effect.fail(fail("Account choice is unavailable.")),
    steer: () => Effect.fail(fail("Account choice is unavailable.")),
    margin: () => Effect.fail(fail("Account choice is unavailable.")),
    end: () => Effect.fail(fail("Account choice is unavailable.")),
    usageResetAt: () => Effect.fail(fail("Usage resets are unavailable.")),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
  const settingsService = yield* Settings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const usageResetSnooze = yield* UsageResetSnoozeService.make;
  const api = sources;

  // Hub settings do not name the endpoint they serve, so only a single hub holding the provider's
  // accounts identifies where its requests go, as for "Snooze until usage resets".
  const resolveTarget = Effect.fn("ThreadAccounts.resolveTarget")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const routerProvider = provider ? routerProviderOf(provider.driver) : undefined;
    if (!provider || !routerProvider || !behindHub(provider)) return null;
    const hubs = (yield* sources.current).filter((source) =>
      source.accounts.some((account) => account.driver === provider.driver),
    );
    const source = hubs.length === 1 ? hubs[0]! : undefined;
    const accounts =
      source?.accounts.filter(
        (account) => account.driver === provider.driver && account.routerAlias !== undefined,
      ) ?? [];
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
    alias: RouterAccountAlias,
    sourceId?: UsageLimitSourceId,
  ) {
    const found = (yield* sources.current).flatMap((source) =>
      sourceId !== undefined && source.id !== sourceId
        ? []
        : source.accounts
            .filter((account) => account.routerAlias === alias)
            .map((account) => ({ source, account })),
    );
    if (found.length === 0) return yield* fail("No CLI Proxy hub lists that account.");
    if (found.length > 1) return yield* fail("Several CLI Proxy hubs list that account.");
    const hub = yield* sources.hub(found[0]!.source.id);
    if (hub === null) return yield* fail("That CLI Proxy hub is disabled or has no key.");
    return { ...found[0]!, hub };
  });

  const sessionOf = (threadId: ThreadId, modelSelection: ModelSelection) =>
    orchestrator.resolveMessageProviderThread(threadId, modelSelection).pipe(
      Effect.map((providerThread) => providerThread?.nativeThreadRef?.nativeId ?? undefined),
      Effect.orElseSucceed(() => undefined),
    );

  const state = Effect.fn("ThreadAccounts.state")(function* (
    input: ThreadAccountStateInput,
  ): Effect.fn.Return<ThreadAccountState> {
    const target = yield* resolveTarget(input.modelSelection.instanceId);
    if (target === null) return null;
    const session = input.threadId
      ? yield* sessionOf(input.threadId, input.modelSelection)
      : undefined;
    const known = new Set(target.accounts.map((account) => account.routerAlias));
    const alias = (value: string | null | undefined) =>
      value && known.has(value) ? (value as NonNullable<typeof value>) : null;
    const [pick, control] = yield* Effect.all(
      [
        api.nextPick(target.hub, {
          provider: target.routerProvider,
          model: input.modelSelection.model,
          ...(session ? { session } : {}),
        }),
        api.control(target.hub).pipe(Effect.option),
      ],
      { concurrency: "unbounded" },
    );
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
    if (!target.accounts.some((account) => account.routerAlias === input.account)) {
      return yield* fail("That account is not on this thread's CLI Proxy hub.");
    }
    // Changing only the account keeps the stored wait-when-out setting.
    const current = threadAccountChoiceFor(thread.accountChoice, target.instanceId);
    const stall = input.stall ?? (current?.account === input.account ? current.stall : false);
    let moved = false;
    if (session) {
      const pick = yield* api.nextPick(target.hub, {
        provider: target.routerProvider,
        session,
        model: thread.modelSelection.model,
      });
      moved = !!pick?.owner && pick.owner !== input.account;
      if (moved && input.dropThinking !== true) {
        return yield* new ThreadAccountError({
          detail: `${THREAD_ACCOUNT_MOVE_WARNING} Confirm with dropThinking: true to switch.`,
          requiresDropThinking: true,
        });
      }
      yield* api.pin(target.hub, {
        sessions: [session],
        account: input.account,
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
        account: input.account,
        stall,
        instanceId: target.instanceId,
      },
      ...(moved ? { accountMovedAt: DateTime.formatIso(now) } : {}),
    });
    // A keep-warm hold forwards its request to the account it is held on, so stop the turn (the
    // request never reached the provider) and continue it, which the new pin routes.
    const held = yield* keepWarm.find(input.threadId);
    if (held === null || held.turn.hold.released === true) return;
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
        const located = yield* locate(input.account, input.sourceId);
        const provider = routerProviderOf(located.account.driver);
        if (provider === undefined || (input.provider && input.provider !== provider)) {
          return yield* fail(
            `That account is not a ${input.provider ?? "Claude or Codex"} account.`,
          );
        }
        yield* api.steer(located.hub, input.account, controlExpiry(yield* DateTime.now));
        return yield* saveSteer(located.source.id, provider, input.account);
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
    if (
      input.account !== null &&
      !target.accounts.some((account) => account.routerAlias === input.account)
    ) {
      return yield* fail("That account is not on this provider's CLI Proxy hub.");
    }
    if (input.account === null) {
      yield* api.unsteer(target.hub, target.routerProvider);
    } else {
      yield* api.steer(target.hub, input.account, controlExpiry(yield* DateTime.now));
    }
    yield* saveSteer(target.source.id, target.routerProvider, input.account);
  });

  // The router's list is the truth; T3's stored choices join it by native session id and fill in
  // what it does not list, such as an expired pin that the thread's next turn re-applies.
  const routing = Effect.fn("ThreadAccounts.routing")(function* (input: ThreadAccountRoutingInput) {
    const hub = yield* sources.hub(input.sourceId);
    if (hub === null) return null;
    const [control, threads, settings] = yield* Effect.all(
      [
        api.control(hub),
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
    const alias = (value: string | undefined) =>
      value !== undefined && isRouterAccountAlias(value) ? value : null;

    const listed = new Set<string>();
    const pins: Array<NonNullable<ThreadAccountRouting>["pins"][number]> = [];
    for (const pin of control.pins ?? []) {
      if (!isRouterAccountAlias(pin.account)) continue;
      listed.add(bareSession(pin.session));
      const expiresAt = isoOf(pin.expires_at);
      pins.push({
        account: pin.account,
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
        account: choice.account,
        stall: choice.stall,
        active: false,
        thread: { id: thread.id, title: thread.title },
        session: null,
      });
    }
    const routerSteers = (control.steers ?? []).flatMap((steer) => {
      if (!isRouterProvider(steer.provider) || !isRouterAccountAlias(steer.account)) return [];
      const expiresAt = isoOf(steer.expires_at);
      return [
        {
          provider: steer.provider,
          account: steer.account,
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
      .map(([provider, account]) => ({ provider, account, active: false }));
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
      return endsAt === undefined || !isRouterAccountAlias(end.account)
        ? []
        : [{ account: end.account, endsAt }];
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

  const usage = Effect.fn("ThreadAccounts.usage")(function* (input: ThreadAccountUsageInput) {
    const [providerList, snapshots] = yield* Effect.all([providers.getProviders, sources.current]);
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
          Effect.map((routes) => ({
            sourceId: source.id,
            label: source.label,
            ...(source.error ? { error: source.error } : {}),
            accounts: source.accounts.map((account): AccountUsageSummary => ({
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
    if (input.threadId === undefined) return { native, hubs };
    const thread = yield* threadOf(input.threadId);
    const picked = yield* state({ threadId: thread.id, modelSelection: thread.modelSelection });
    const chosen = threadAccountChoiceFor(thread.accountChoice, thread.modelSelection.instanceId);
    return {
      native,
      hubs,
      thread: {
        threadId: thread.id,
        next: picked?.next ?? null,
        owner: picked?.owner ?? null,
        chosen: chosen ? { account: chosen.account, waitWhenOut: chosen.stall } : null,
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
    yield* api.subscriptionEnd(located.hub, input.account, endsAt);
  });

  const usageResetAt = Effect.fn("ThreadAccounts.usageResetAt")(function* (threadId: ThreadId) {
    const thread = yield* threadOf(threadId);
    return yield* usageResetSnooze.resolve({ threadId, modelSelection: thread.modelSelection });
  });

  const asThreadAccountError = <A, E extends { readonly message: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.mapError((error) => (isThreadAccountError(error) ? error : fail(error.message))),
    );

  return {
    state: (input: ThreadAccountStateInput) => asThreadAccountError(state(input)),
    set: (input: ThreadAccountSetInput) => asThreadAccountError(set(input)),
    steer: (input: ThreadAccountSteerInput) => asThreadAccountError(steer(input)),
    routing: (input: ThreadAccountRoutingInput) => asThreadAccountError(routing(input)),
    usage: (input: ThreadAccountUsageInput) => asThreadAccountError(usage(input)),
    margin: (input: ThreadAccountMarginInput) => asThreadAccountError(margin(input)),
    end: (input: ThreadAccountEndInput) => asThreadAccountError(end(input)),
    usageResetAt: (threadId: ThreadId) => asThreadAccountError(usageResetAt(threadId)),
  } satisfies (typeof ThreadAccounts)["Service"];
});

export const layer = Layer.effect(ThreadAccounts, make);
