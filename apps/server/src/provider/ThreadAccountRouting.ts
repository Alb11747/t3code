import {
  CommandId,
  type MessageId,
  threadAccountChoiceFor,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type ThreadAccountError,
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
// Applying a move reads the router's pick, pins and records the choice: a few hub round trips.
const MOVE_TIMEOUT = "10 seconds";

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

/**
 * Where an account move's own compaction stands: `live` while its run is still to run or running,
 * `compacted` once that run completed a compaction, and `ended` when it ended without one (failed,
 * interrupted, skipped, or cancelled from the queue).
 */
export type MoveCompactionState = "live" | "compacted" | "ended";

/** An account move waiting for the compaction it queued; see `deferMove`. */
export interface DeferredAccountMove {
  readonly threadId: ThreadId;
  /** The `/compact` message the move queued; a later move reuses it while it is still to run. */
  readonly compactionMessageId: MessageId;
  /** False until the compaction's dispatch committed, before which it has no run to read. */
  readonly dispatched: boolean;
  /** For reads: the account's name and its wait-when-out setting. */
  readonly account: string;
  readonly waitWhenOut: boolean;
  readonly compaction: Effect.Effect<MoveCompactionState>;
  /** Pins and records the new account. */
  readonly apply: Effect.Effect<void, ThreadAccountError>;
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
  /**
   * Holds an account move until the compaction it queued completes: the first turn start after
   * that applies the move before pinning. The compaction runs warm-only (`movesAfter`), so the new
   * account writes only the compacted context. Replaces the thread's earlier pending move.
   * In memory: a restart drops the move, and the thread stays on its account.
   */
  readonly deferMove: (move: DeferredAccountMove) => Effect.Effect<void>;
  /** Marks the pending move queuing that compaction as dispatched, if it still is the thread's. */
  readonly markDispatched: (
    threadId: ThreadId,
    compactionMessageId: MessageId,
  ) => Effect.Effect<void>;
  /** Drops the thread's pending move if it still waits on that compaction. */
  readonly cancelMove: (threadId: ThreadId, compactionMessageId: MessageId) => Effect.Effect<void>;
  readonly pendingMove: (threadId: ThreadId) => Effect.Effect<DeferredAccountMove | undefined>;
  /**
   * Whether the message is a pending move's compaction. Its turn then runs as a warm-only
   * compaction: the quota router serves it only from the account whose cache is warm, or skips it.
   */
  readonly movesAfter: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<boolean>;
}>("t3/provider/ThreadAccountRouting", {
  defaultValue: () => ({
    prepareTurn: () => Effect.succeed(false),
    pinFailed: () => Effect.succeed(false),
    deferMove: () => Effect.void,
    markDispatched: () => Effect.void,
    cancelMove: () => Effect.void,
    pendingMove: () => Effect.undefined,
    movesAfter: () => Effect.succeed(false),
  }),
}) {}

/** @public */
export const make = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const settingsService = yield* Settings.ServerSettingsService;
  // In memory: a failed pin only matters until the next turn start pins again.
  const failedWaitingPins = new Set<ThreadId>();
  const pendingMoves = new Map<ThreadId, DeferredAccountMove>();

  // Applies a pending move once its own compaction completed; true when it pinned the new account.
  const applyPendingMove = Effect.fn("ThreadAccountRouting.applyPendingMove")(function* (
    threadId: ThreadId,
  ) {
    const pending = pendingMoves.get(threadId);
    if (pending === undefined || !pending.dispatched) return false;
    const state = yield* pending.compaction;
    // A move replaced meanwhile is the newer move's to settle.
    if (state === "live" || pendingMoves.get(threadId) !== pending) return false;
    pendingMoves.delete(threadId);
    if (state === "ended") {
      // The thread stays on its account rather than moving with its whole context.
      yield* Effect.logWarning("Dropped an account move whose compaction did not complete.", {
        threadId,
        account: pending.account,
      });
      return false;
    }
    // One attempt: a failed move leaves the thread on its account rather than retrying each turn.
    return yield* pending.apply.pipe(
      Effect.timeout(MOVE_TIMEOUT),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not apply the account move after compaction.", {
          threadId,
          account: pending.account,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
  });

  const prepareTurn = Effect.fn("ThreadAccountRouting.prepareTurn")(function* <E>(
    input: PrepareTurnInput<E>,
  ) {
    // The move pinned and recorded the new account itself; this turn's thread record predates it.
    // Like any move's next turn, it drops thinking the old account signed.
    if (yield* applyPendingMove(input.appThread.id)) {
      failedWaitingPins.delete(input.appThread.id);
      return true;
    }
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

  const deferMove = (move: DeferredAccountMove) =>
    Effect.sync(() => {
      pendingMoves.set(move.threadId, move);
    });
  const markDispatched = (threadId: ThreadId, compactionMessageId: MessageId) =>
    Effect.sync(() => {
      const pending = pendingMoves.get(threadId);
      if (pending?.compactionMessageId === compactionMessageId)
        pendingMoves.set(threadId, { ...pending, dispatched: true });
    });
  const cancelMove = (threadId: ThreadId, compactionMessageId: MessageId) =>
    Effect.sync(() => {
      if (pendingMoves.get(threadId)?.compactionMessageId === compactionMessageId)
        pendingMoves.delete(threadId);
    });
  const pendingMove = (threadId: ThreadId) => Effect.sync(() => pendingMoves.get(threadId));
  const movesAfter = (threadId: ThreadId, messageId: MessageId) =>
    Effect.sync(() => pendingMoves.get(threadId)?.compactionMessageId === messageId);

  return {
    prepareTurn,
    pinFailed,
    deferMove,
    markDispatched,
    cancelMove,
    pendingMove,
    movesAfter,
  } satisfies (typeof ThreadAccountRouting)["Service"];
});

export const layer = Layer.effect(ThreadAccountRouting, make);
