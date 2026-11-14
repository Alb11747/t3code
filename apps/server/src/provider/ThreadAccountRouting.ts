import {
  threadAccountChoiceFor,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import { routerProviderOf } from "../usage/cliproxyApi.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";

// The router rejects pins and steers that expire more than seven days ahead.
const CONTROL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
const STEER_RENEWAL = "6 hours";
// Turn starts share a few effect-worker slots, so a dead hub must not hold them; a missed renewal
// only lets the week-long pin run a little closer to expiry.
const TURN_PIN_TIMEOUT = "3 seconds";

export const controlExpiry = (now: DateTime.Utc) =>
  DateTime.formatIso(DateTime.add(now, { milliseconds: CONTROL_LIFETIME_MS }));

/**
 * Whether a turn must drop thinking that an account move left in the conversation: Claude resends
 * the old account's thinking blocks with every request until a compaction replaces the history.
 */
export function accountMoveDropsThinking(
  accountMovedAt: string | null | undefined,
  compactions: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  if (!accountMovedAt) return false;
  const movedAt = Date.parse(accountMovedAt);
  return !compactions.some(
    (item) =>
      item.type === "compaction" &&
      item.status === "completed" &&
      item.completedAt !== null &&
      DateTime.toEpochMillis(item.completedAt) > movedAt,
  );
}

interface PrepareTurnInput<E> {
  readonly appThread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly loadCompactions: Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, E>;
}

/** Fork: applies a thread's quota-router account choice at each turn start; pins expire. */
export class ThreadAccountRouting extends Context.Reference<{
  /** Pins the thread's chosen account; returns whether the turn must drop moved thinking. */
  readonly prepareTurn: <E>(input: PrepareTurnInput<E>) => Effect.Effect<boolean>;
}>("t3/provider/ThreadAccountRouting", {
  defaultValue: () => ({ prepareTurn: () => Effect.succeed(false) }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const settingsService = yield* Settings.ServerSettingsService;

  const prepareTurn = Effect.fn("ThreadAccountRouting.prepareTurn")(function* <E>(
    input: PrepareTurnInput<E>,
  ) {
    const drops =
      !!input.appThread.accountMovedAt &&
      accountMoveDropsThinking(
        input.appThread.accountMovedAt,
        // An unreadable history keeps dropping: it only removes thinking the new account cannot use.
        yield* input.loadCompactions.pipe(Effect.orElseSucceed(() => [])),
      );
    const choice = threadAccountChoiceFor(
      input.appThread.accountChoice,
      input.providerThread.providerInstanceId,
    );
    const session = input.providerThread.nativeThreadRef?.nativeId;
    if (!choice || !session || !routerProviderOf(input.providerThread.driver)) return drops;
    yield* Effect.gen(function* () {
      const hub = yield* sources.hub(choice.sourceId);
      if (hub === null) return;
      yield* sources.pin(hub, {
        sessions: [session],
        account: choice.account,
        stall: choice.stall,
        expiresAt: controlExpiry(yield* DateTime.now),
        // Each pin replaces the last; a plain one would end the move that subagents still follow.
        move: drops,
      });
    }).pipe(
      Effect.timeout(TURN_PIN_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not pin the thread's chosen account.", {
          threadId: input.appThread.id,
          cause,
        }),
      ),
    );
    return drops;
  });

  // Steers expire like pins, so T3 renews the ones saved in settings.
  const renewSteers = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const expiresAt = controlExpiry(yield* DateTime.now);
    yield* Effect.forEach(
      Object.entries(settings.usageLimitSources),
      ([sourceId, config]) =>
        Effect.gen(function* () {
          const accounts = Object.values(config.steers ?? {}).filter(
            (account): account is string => account !== undefined,
          );
          if (!config.enabled || accounts.length === 0) return;
          const hub = yield* sources.hub(sourceId as UsageLimitSourceId);
          if (hub === null) return;
          yield* Effect.forEach(accounts, (account) => sources.steer(hub, account, expiresAt), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not renew a quota-router steer.", { cause }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  yield* renewSteers.pipe(
    Effect.andThen(Effect.sleep(STEER_RENEWAL)),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => renewSteers),
    Effect.forkScoped,
  );

  return { prepareTurn } satisfies (typeof ThreadAccountRouting)["Service"];
});

export const layer = Layer.effect(ThreadAccountRouting, make);
