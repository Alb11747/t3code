import {
  CommandId,
  threadAccountChoiceFor,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type ThreadId,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { EventSinkV2Shape } from "../orchestration-v2/EventSink.ts";
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
 * Only a compaction of this provider thread counts; another provider's compaction leaves it intact.
 */
export function accountMoveDropsThinking(
  accountMovedAt: string | null | undefined,
  compactions: ReadonlyArray<OrchestrationV2TurnItem>,
  providerThreadId: ProviderThreadId,
): boolean {
  if (!accountMovedAt) return false;
  const movedAt = Date.parse(accountMovedAt);
  return !compactions.some(
    (item) =>
      item.type === "compaction" &&
      item.providerThreadId === providerThreadId &&
      item.status === "completed" &&
      item.completedAt !== null &&
      DateTime.toEpochMillis(item.completedAt) > movedAt,
  );
}

export const accountMoveCommandId = (threadId: ThreadId, movedAt: number) =>
  CommandId.make(`thread-account:${threadId}:${movedAt}`);

export const readLegacyAccountMove = (
  thread: Pick<OrchestrationV2AppThread, "id" | "accountMovedAt">,
  providerThread: Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">,
  attempts: ReadonlyArray<
    Pick<
      OrchestrationV2RunAttempt,
      "providerThreadId" | "providerInstanceId" | "nativeThreadId" | "startedAt"
    >
  >,
  readByCommandId: EventSinkV2Shape["readByCommandId"],
): Effect.Effect<string | undefined> => {
  const movedAt = thread.accountMovedAt;
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (movedAt == null || nativeId == null) return Effect.undefined;
  const timestamp = Date.parse(movedAt);
  const historical = attempts.flatMap((attempt) => {
    if (attempt.startedAt === null) return [];
    const startedAt = DateTime.toEpochMillis(attempt.startedAt);
    return startedAt <= timestamp ? [{ ...attempt, startedAt }] : [];
  });
  const latest = historical.reduce<(typeof historical)[number] | undefined>((latest, attempt) => {
    if (attempt.providerThreadId !== providerThread.id) return latest;
    return latest === undefined || attempt.startedAt > latest.startedAt ? attempt : latest;
  }, undefined);
  if (latest?.nativeThreadId !== nativeId) return Effect.undefined;
  // An older event has no native ID. Use the then-active session only when the attempt history
  // confirms it and the selected instance did not also have a separate conversation to pin.
  return readByCommandId({ commandId: accountMoveCommandId(thread.id, timestamp) }).pipe(
    Stream.filter(({ event }) => {
      if (
        event.type !== "thread.metadata-updated" ||
        event.threadId !== thread.id ||
        event.payload.accountMovedAt !== movedAt ||
        event.payload.activeProviderThreadId !== providerThread.id
      )
        return false;
      const instance = event.payload.accountChoice?.instanceId;
      return (
        instance !== undefined &&
        (instance === latest.providerInstanceId ||
          !historical.some(
            (attempt) =>
              attempt.providerInstanceId === instance &&
              attempt.providerThreadId !== providerThread.id,
          ))
      );
    }),
    Stream.runHead,
    Effect.map((event) => (Option.isSome(event) ? movedAt : undefined)),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read a legacy account move.", {
        threadId: thread.id,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
};

interface PrepareTurnInput<E> {
  readonly appThread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly loadLegacyAccountMove?: Effect.Effect<string | undefined>;
  readonly loadCompactions: Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, E>;
}

/** Fork: renews a thread's quota-router account choice when a turn starts. */
export class ThreadAccountRouting extends Context.Reference<{
  /** Pins the thread's chosen account; returns whether the turn must drop moved thinking. */
  readonly prepareTurn: <E>(input: PrepareTurnInput<E>) => Effect.Effect<boolean>;
  /** Whether the latest turn could not pin a choice that waits for its account. */
  readonly pinFailed: (threadId: ThreadId) => Effect.Effect<boolean>;
}>("t3/provider/ThreadAccountRouting", {
  defaultValue: () => ({
    prepareTurn: () => Effect.succeed(false),
    pinFailed: () => Effect.succeed(false),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const settingsService = yield* Settings.ServerSettingsService;
  // In memory: a failed pin only matters until the next turn start pins again.
  const failedWaitingPins = new Set<ThreadId>();

  const prepareTurn = Effect.fn("ThreadAccountRouting.prepareTurn")(function* <E>(
    input: PrepareTurnInput<E>,
  ) {
    const choice = threadAccountChoiceFor(
      input.appThread.accountChoice,
      input.providerThread.providerInstanceId,
    );
    const session = input.providerThread.nativeThreadRef?.nativeId;
    const moves = input.appThread.accountMovedAtByProviderThread;
    const conversation = input.providerThread.id;
    const sessionMoves =
      moves !== undefined && Object.hasOwn(moves, conversation) ? moves[conversation] : undefined;
    const movedAt =
      session != null && sessionMoves !== undefined && Object.hasOwn(sessionMoves, session)
        ? sessionMoves[session]
        : yield* input.loadLegacyAccountMove ?? Effect.undefined;
    const drops =
      movedAt != null &&
      accountMoveDropsThinking(
        movedAt,
        // An unreadable history keeps dropping: it only removes thinking the new account cannot use.
        yield* input.loadCompactions.pipe(Effect.orElseSucceed(() => [])),
        input.providerThread.id,
      );
    const routerProvider = routerProviderOf(input.providerThread.driver);
    if (!choice || !session || !routerProvider) {
      failedWaitingPins.delete(input.appThread.id);
      return drops;
    }
    const stall = routerProvider === "claude" && choice.stall;
    if (!stall) failedWaitingPins.delete(input.appThread.id);
    yield* Effect.gen(function* () {
      const hub = yield* sources.hub(choice.sourceId);
      if (hub === null) {
        if (stall) failedWaitingPins.add(input.appThread.id);
        return;
      }
      yield* sources.pin(hub, {
        sessions: [session],
        account: (yield* sources.routerAlias(choice.sourceId))(choice.account),
        stall,
        expiresAt: controlExpiry(yield* DateTime.now),
        renew: true,
        move: drops,
      });
      failedWaitingPins.delete(input.appThread.id);
    }).pipe(
      Effect.timeout(TURN_PIN_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not pin the thread's chosen account.", {
          threadId: input.appThread.id,
          cause,
        }).pipe(
          // A waiting choice's exclusivity is broken for this turn, which agents need to see.
          Effect.andThen(
            Effect.sync(() => {
              if (stall) failedWaitingPins.add(input.appThread.id);
            }),
          ),
        ),
      ),
    );
    return drops;
  });

  const pinFailed = (threadId: ThreadId) => Effect.sync(() => failedWaitingPins.has(threadId));

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
          const rename = yield* sources.routerAlias(sourceId as UsageLimitSourceId);
          yield* Effect.forEach(
            accounts,
            (account) => sources.steer(hub, rename(account), expiresAt),
            { discard: true },
          );
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

  return { prepareTurn, pinFailed } satisfies (typeof ThreadAccountRouting)["Service"];
});

export const layer = Layer.effect(ThreadAccountRouting, make);
