import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
  type IdleCompactionMode,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as TestClock from "effect/testing/TestClock";

import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PrepareRestartHttp from "./PrepareRestartHttp.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offsetMs = 0) => DateTime.makeUnsafe(NOW_MS + offsetMs);
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function makeProjection(
  id: string,
  options: {
    readonly cacheExpiresInMs?: number;
    readonly usedTokens?: number;
    readonly busy?: boolean;
    readonly snoozeInMs?: number;
    readonly settled?: boolean;
    readonly archived?: boolean;
    readonly compactBeforeCacheExpires?: boolean | null;
    readonly driver?: "claudeAgent" | "codex";
  } = {},
): OrchestrationV2ThreadProjection {
  const threadId = ThreadId.make(id);
  const runId = RunId.make(`run-${id}`);
  const messageId = MessageId.make(`msg-${id}`);
  const nodeId = NodeId.make(`node-${id}`);
  const providerThreadId = ProviderThreadId.make(`pt-${id}`);
  const driver = ProviderDriverKind.make(options.driver ?? "claudeAgent");
  const selectedInstance = ProviderInstanceId.make(options.driver ?? "claudeAgent");
  const selection = {
    instanceId: selectedInstance,
    model: options.driver === "codex" ? "gpt-6.2-sol" : "claude-opus-5-5",
  };
  const runs: Array<OrchestrationV2Run> = [
    {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: selectedInstance,
      modelSelection: selection,
      providerThreadId,
      userMessageId: messageId,
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at(-MINUTE_MS),
      startedAt: at(-MINUTE_MS),
      completedAt: at(),
      checkpointId: null,
      contextHandoffId: null,
    },
  ];
  if (options.busy) {
    runs.push({
      id: RunId.make(`run-active-${id}`),
      threadId,
      ordinal: 2,
      providerInstanceId: selectedInstance,
      modelSelection: selection,
      providerThreadId,
      userMessageId: MessageId.make(`msg-active-${id}`),
      rootNodeId: NodeId.make(`node-active-${id}`),
      activeAttemptId: null,
      status: "running",
      requestedAt: at(),
      startedAt: at(),
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
  }
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: `Thread ${id}`,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: selectedInstance,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: options.archived ? at() : null,
      settledOverride: options.settled ? "settled" : null,
      settledAt: options.settled ? at() : null,
      ...(options.snoozeInMs === undefined ? {} : { snoozedUntil: at(options.snoozeInMs) }),
      ...(options.compactBeforeCacheExpires === undefined
        ? {}
        : { compactBeforeCacheExpires: options.compactBeforeCacheExpires }),
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs,
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Continue working",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: selectedInstance,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make(`turn-${id}`),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: options.usedTokens ?? 250_000,
          ...(options.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(options.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    plans: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

function makeCompactRun(threadId: ThreadId, runId: RunId, status: OrchestrationV2Run["status"]) {
  return {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make(`pt-${threadId}`),
    userMessageId: MessageId.make(`idle-compact:${threadId}`),
    rootNodeId: NodeId.make(`compact-node-${runId}`),
    activeAttemptId: null,
    status,
    requestedAt: at(),
    startedAt: at(),
    completedAt: status === "completed" ? at() : null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

/** Replays stored events strictly after `afterSequence` and streams subsequent live events. */
function makeEventLog() {
  return Effect.gen(function* () {
    const storedLog: Array<OrchestrationV2StoredEvent> = [];
    const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    let sequence = 0;

    const append = (
      event: OrchestrationV2DomainEvent,
      commandId: OrchestrationV2StoredEvent["commandId"] = null,
    ) => {
      const stored: OrchestrationV2StoredEvent = {
        sequence: ++sequence,
        commandId,
        event,
      };
      storedLog.push(stored);
      return PubSub.publish(live, stored).pipe(Effect.as(stored));
    };

    const streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"] =
      (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const afterSequence = input?.afterSequence ?? 0;
            const matches = (stored: OrchestrationV2StoredEvent) =>
              (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
              (input?.eventType === undefined || stored.event.type === input.eventType);
            const subscription = yield* PubSub.subscribe(live);
            const highWater = sequence;
            const replay = storedLog.filter(
              (stored) =>
                stored.sequence > afterSequence && stored.sequence <= highWater && matches(stored),
            );
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (stored) =>
                    stored.sequence > Math.max(highWater, afterSequence) && matches(stored),
                ),
              ),
            );
          }),
        );

    const streamDomainEvents = Stream.fromPubSub(live).pipe(Stream.map((stored) => stored.event));

    return { append, streamStoredEventsFrom, streamDomainEvents };
  });
}

const noScheduledTasks = Layer.mock(ScheduledTaskService)({
  list: () => Effect.succeed({ tasks: [] }),
  subscribeList: () => Stream.empty,
});

function makeSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return Layer.mock(ServerSettingsService.ServerSettingsService)({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      idleCompaction: "beforeCacheExpires",
      compactSnoozedThreads: false,
      idleCompactionWaiting: { enabled: true, minTokens: 60_000 },
      idleCompactionOpen: { enabled: true, minTokens: 150_000 },
      idleCompactionSettled: { enabled: false, minTokens: 500_000 },
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: { idleCompaction: "default" },
        },
      },
      ...overrides,
    }),
  });
}

describe("PrepareRestart", () => {
  it.effect(
    "selects threads inside the downtime window, orders soonest first, and skips ineligible threads with coarse reasons",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const threads = new Map<ThreadId, OrchestrationV2ThreadProjection>([
          [
            ThreadId.make("later-inside"),
            makeProjection("later-inside", { cacheExpiresInMs: 35 * MINUTE_MS }),
          ],
          [
            ThreadId.make("soon-inside"),
            makeProjection("soon-inside", { cacheExpiresInMs: 12 * MINUTE_MS }),
          ],
          [
            ThreadId.make("outside"),
            makeProjection("outside", { cacheExpiresInMs: 55 * MINUTE_MS }),
          ],
          [
            ThreadId.make("busy"),
            makeProjection("busy", { cacheExpiresInMs: 10 * MINUTE_MS, busy: true }),
          ],
          [
            ThreadId.make("snoozed-short"),
            // Snooze ends BEFORE window.startMs (15m < 28m); still must NOT be pulled forward while snoozed.
            makeProjection("snoozed-short", {
              cacheExpiresInMs: 30 * MINUTE_MS,
              snoozeInMs: 15 * MINUTE_MS,
            }),
          ],
          [
            ThreadId.make("settled"),
            makeProjection("settled", { cacheExpiresInMs: 15 * MINUTE_MS, settled: true }),
          ],
          [
            ThreadId.make("archived"),
            makeProjection("archived", { cacheExpiresInMs: 15 * MINUTE_MS, archived: true }),
          ],
          [
            ThreadId.make("opted-out"),
            makeProjection("opted-out", {
              cacheExpiresInMs: 15 * MINUTE_MS,
              compactBeforeCacheExpires: false,
            }),
          ],
          [ThreadId.make("codex"), makeProjection("codex", { driver: "codex" })],
          [
            ThreadId.make("rejected"),
            makeProjection("rejected", { cacheExpiresInMs: 20 * MINUTE_MS }),
          ],
        ]);

        const log = yield* makeEventLog();
        const dispatchedOrder: Array<ThreadId> = [];

        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          makeSettingsLayer(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed(Array.from(threads.keys())),
            getThread: (id) => Effect.succeed(threads.get(id)!.thread),
            getThreadRecords: (id) => Effect.succeed(threads.get(id)!),
            hasIdleCompactionWait: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamStoredEventsFrom: log.streamStoredEventsFrom,
            streamDomainEvents: log.streamDomainEvents,
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type !== "message.dispatch") {
                  return { sequence: 0, storedEvents: [] };
                }
                dispatchedOrder.push(command.threadId);
                if (command.threadId === ThreadId.make("rejected")) {
                  return { sequence: 0, storedEvents: [] };
                }
                const compactRunId = RunId.make(`compact-${command.threadId}`);
                const createdStored = yield* log.append(
                  {
                    id: EventId.make(`created-${compactRunId}`),
                    type: "run.created",
                    threadId: command.threadId,
                    runId: compactRunId,
                    occurredAt: at(),
                    payload: makeCompactRun(command.threadId, compactRunId, "running"),
                  },
                  command.commandId,
                );
                yield* log.append({
                  id: EventId.make(`done-${compactRunId}`),
                  type: "run.updated",
                  threadId: command.threadId,
                  runId: compactRunId,
                  occurredAt: at(),
                  payload: makeCompactRun(command.threadId, compactRunId, "completed"),
                });
                return { sequence: createdStored.sequence, storedEvents: [createdStored] };
              }),
          }),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          return yield* service.prepareRestart({
            downtimeMs: 10 * MINUTE_MS,
            marginMs: 30 * MINUTE_MS,
            budgetMs: 60_000,
          });
        }).pipe(Effect.provide(dependencies));

        expect(result.timedOut).toBe(false);
        expect(dispatchedOrder).toEqual([
          ThreadId.make("soon-inside"),
          ThreadId.make("rejected"),
          ThreadId.make("later-inside"),
        ]);
        expect(result.sent).toEqual([
          {
            threadId: ThreadId.make("soon-inside"),
            runId: RunId.make("compact-soon-inside"),
            status: "completed",
          },
          {
            threadId: ThreadId.make("later-inside"),
            runId: RunId.make("compact-later-inside"),
            status: "completed",
          },
        ]);
        expect(result.skipped).toEqual(
          expect.arrayContaining([
            { threadId: ThreadId.make("outside"), reason: "outside_window" },
            { threadId: ThreadId.make("busy"), reason: "busy" },
            { threadId: ThreadId.make("snoozed-short"), reason: "snoozed" },
            { threadId: ThreadId.make("settled"), reason: "not_eligible" },
            { threadId: ThreadId.make("archived"), reason: "not_eligible" },
            { threadId: ThreadId.make("opted-out"), reason: "not_eligible" },
            { threadId: ThreadId.make("codex"), reason: "not_eligible" },
            { threadId: ThreadId.make("rejected"), reason: "not_eligible" },
          ]),
        );
      }),
  );

  it.effect.each(["off", "onReturn"] as ReadonlyArray<IdleCompactionMode>)(
    "does not pull forward threads when idle compaction mode is %s",
    (mode) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const id = ThreadId.make("candidate");
        const projection = makeProjection("candidate", { cacheExpiresInMs: 10 * MINUTE_MS });
        let dispatches = 0;

        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          makeSettingsLayer({ idleCompaction: mode }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([id]),
            getThread: () => Effect.succeed(projection.thread),
            getThreadRecords: () => Effect.succeed(projection),
            hasIdleCompactionWait: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamStoredEventsFrom: () => Stream.empty,
            streamDomainEvents: Stream.empty,
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          return yield* service.prepareRestart({
            downtimeMs: 10 * MINUTE_MS,
            marginMs: 30 * MINUTE_MS,
            budgetMs: 60_000,
          });
        }).pipe(Effect.provide(dependencies));

        expect(dispatches).toBe(0);
        expect(result).toEqual({
          sent: [],
          skipped: [{ threadId: id, reason: "not_eligible" }],
          timedOut: false,
        });
      }),
  );

  it.effect(
    "rechecks queued candidates fresh at dispatch so a thread archived before its slot is not compacted",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const ids = ["t1", "t2", "t3", "stale"].map((id) => ThreadId.make(id));
        const threads = new Map(
          ids.map((id, index) => [
            id,
            makeProjection(id, { cacheExpiresInMs: (5 + index * 2) * MINUTE_MS }),
          ]),
        );
        const log = yield* makeEventLog();
        const dispatched = yield* Queue.unbounded<ThreadId>();

        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          makeSettingsLayer(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed(ids),
            getThread: (id) => Effect.succeed(threads.get(id)!.thread),
            getThreadRecords: (id) => Effect.succeed(threads.get(id)!),
            hasIdleCompactionWait: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamStoredEventsFrom: log.streamStoredEventsFrom,
            streamDomainEvents: log.streamDomainEvents,
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type !== "message.dispatch") {
                  return { sequence: 0, storedEvents: [] };
                }
                const compactRunId = RunId.make(`compact-${command.threadId}`);
                const createdStored = yield* log.append(
                  {
                    id: EventId.make(`created-${compactRunId}`),
                    type: "run.created",
                    threadId: command.threadId,
                    runId: compactRunId,
                    occurredAt: at(),
                    payload: makeCompactRun(command.threadId, compactRunId, "running"),
                  },
                  command.commandId,
                );
                yield* Queue.offer(dispatched, command.threadId);
                return { sequence: createdStored.sequence, storedEvents: [createdStored] };
              }),
          }),
        );

        const fiber = yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          return yield* service.prepareRestart({
            downtimeMs: 10 * MINUTE_MS,
            marginMs: 30 * MINUTE_MS,
            budgetMs: 30_000,
          });
        }).pipe(Effect.provide(dependencies), Effect.forkChild({ startImmediately: true }));

        expect([
          yield* Queue.take(dispatched),
          yield* Queue.take(dispatched),
          yield* Queue.take(dispatched),
        ]).toEqual([ThreadId.make("t1"), ThreadId.make("t2"), ThreadId.make("t3")]);

        // Archive the 4th thread before its slot opens.
        const staleId = ThreadId.make("stale");
        const stale = threads.get(staleId)!;
        threads.set(staleId, { ...stale, thread: { ...stale.thread, archivedAt: at() } });

        for (const id of [ThreadId.make("t1"), ThreadId.make("t2"), ThreadId.make("t3")]) {
          const runId = RunId.make(`compact-${id}`);
          yield* log.append({
            id: EventId.make(`done-${runId}`),
            type: "run.updated",
            threadId: id,
            runId,
            occurredAt: at(),
            payload: makeCompactRun(id, runId, "completed"),
          });
        }

        const result = yield* Fiber.join(fiber);
        expect(result.timedOut).toBe(false);
        expect(result.sent.map((entry) => entry.threadId)).toEqual([
          ThreadId.make("t1"),
          ThreadId.make("t2"),
          ThreadId.make("t3"),
        ]);
        expect(result.skipped).toEqual([{ threadId: staleId, reason: "not_eligible" }]);
      }),
  );

  it.effect(
    "replays a terminal run.updated that landed before streamStoredEventsFrom starts without waiting out the budget",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const id = ThreadId.make("fast-replay");
        const base = makeProjection("fast-replay", { cacheExpiresInMs: 10 * MINUTE_MS });
        const compactRunId = RunId.make("compact-fast-replay");
        const log = yield* makeEventLog();
        let observedAfterSequence: number | undefined;

        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          makeSettingsLayer(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([id]),
            getThread: () => Effect.succeed(base.thread),
            getThreadRecords: () => Effect.succeed(base),
            hasIdleCompactionWait: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: log.streamDomainEvents,
            streamStoredEventsFrom: (input) => {
              observedAfterSequence = input?.afterSequence;
              return log.streamStoredEventsFrom(input);
            },
            dispatch: (command) =>
              Effect.gen(function* () {
                const createdStored = yield* log.append(
                  {
                    id: EventId.make("created-fast-replay"),
                    type: "run.created",
                    threadId: id,
                    runId: compactRunId,
                    occurredAt: at(),
                    payload: makeCompactRun(id, compactRunId, "running"),
                  },
                  command.commandId,
                );
                // Terminal event is already stored BEFORE dispatch returns and before streamStoredEventsFrom starts.
                yield* log.append({
                  id: EventId.make("done-fast-replay"),
                  type: "run.updated",
                  threadId: id,
                  runId: compactRunId,
                  occurredAt: at(),
                  payload: makeCompactRun(id, compactRunId, "completed"),
                });
                return { sequence: createdStored.sequence, storedEvents: [createdStored] };
              }),
          }),
        );

        // No TestClock.adjust: must resolve immediately via replay from afterSequence.
        const result = yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          return yield* service.prepareRestart({
            downtimeMs: 10 * MINUTE_MS,
            marginMs: 30 * MINUTE_MS,
            budgetMs: 60_000,
          });
        }).pipe(Effect.provide(dependencies));

        expect(observedAfterSequence).toBe(1);
        expect(result).toEqual({
          sent: [{ threadId: id, runId: compactRunId, status: "completed" }],
          skipped: [],
          timedOut: false,
        });
      }),
  );

  it.effect("falls back to a projection read by runIds when streamStoredEventsFrom fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const id = ThreadId.make("stream-error");
      const base = makeProjection("stream-error", { cacheExpiresInMs: 10 * MINUTE_MS });
      const compactRunId = RunId.make("compact-stream-error");
      const completedRun = makeCompactRun(id, compactRunId, "completed");
      const requestedRunIds: Array<ReadonlyArray<RunId>> = [];
      let dispatched = false;

      const dependencies = Layer.mergeAll(
        noScheduledTasks,
        makeSettingsLayer(),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([id]),
          getThread: () => Effect.succeed(base.thread),
          getThreadRecords: (_id, _fields, filter) =>
            Effect.sync(() => {
              if (filter?.runIds !== undefined) requestedRunIds.push(filter.runIds);
              return dispatched ? { ...base, runs: [...base.runs, completedRun] } : base;
            }),
          hasIdleCompactionWait: () => Effect.succeed(false),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          streamStoredEventsFrom: () =>
            Stream.fail(
              new Orchestrator.OrchestratorDomainEventStreamError({
                cause: new Error("stream dropped"),
              }),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched = true;
              return {
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: command.commandId,
                    event: {
                      id: EventId.make("created-stream-error"),
                      type: "run.created",
                      threadId: id,
                      runId: compactRunId,
                      occurredAt: at(),
                      payload: makeCompactRun(id, compactRunId, "running"),
                    },
                  },
                ],
              };
            }),
        }),
      );

      const result = yield* Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        return yield* service.prepareRestart({
          downtimeMs: 10 * MINUTE_MS,
          marginMs: 30 * MINUTE_MS,
          budgetMs: 60_000,
        });
      }).pipe(Effect.provide(dependencies));

      expect(requestedRunIds).toEqual([[compactRunId]]);
      expect(result).toEqual({
        sent: [{ threadId: id, runId: compactRunId, status: "completed" }],
        skipped: [],
        timedOut: false,
      });
    }),
  );

  it.effect(
    "preserves the normal sleeping timer if prepareRestart is interrupted before dispatch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const id = ThreadId.make("survives-abort");
          const projection = makeProjection("survives-abort", {
            cacheExpiresInMs: 20 * MINUTE_MS,
          });
          const log = yield* makeEventLog();
          const recheckStarted = yield* Deferred.make<void>();
          let blockPrepareEval = false;
          let dispatches = 0;

          const dependencies = Layer.mergeAll(
            noScheduledTasks,
            makeSettingsLayer(),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([id]),
              getThread: () => Effect.succeed(projection.thread),
              getThreadRecords: () =>
                blockPrepareEval
                  ? Deferred.succeed(recheckStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed(projection),
              hasIdleCompactionWait: () => Effect.succeed(false),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamStoredEventsFrom: log.streamStoredEventsFrom,
              streamDomainEvents: log.streamDomainEvents,
              dispatch: (command) =>
                Effect.gen(function* () {
                  dispatches++;
                  const compactRunId = RunId.make(`compact-${dispatches}`);
                  const createdStored = yield* log.append(
                    {
                      id: EventId.make(`created-${compactRunId}`),
                      type: "run.created",
                      threadId: id,
                      runId: compactRunId,
                      occurredAt: at(),
                      payload: makeCompactRun(id, compactRunId, "running"),
                    },
                    command.commandId,
                  );
                  return { sequence: createdStored.sequence, storedEvents: [createdStored] };
                }),
            }),
          );

          yield* Effect.gen(function* () {
            const service = yield* IdleCompactionService.make;
            // Arms the normal sleeping timer for window.startMs (18m from NOW_MS).
            yield* service.start();
            yield* TestClock.adjust("1 second");
            expect(dispatches).toBe(0);

            // Interrupt prepareRestart mid-scan before it dispatches.
            blockPrepareEval = true;
            const prepareFiber = yield* service
              .prepareRestart({
                downtimeMs: 10 * MINUTE_MS,
                marginMs: 30 * MINUTE_MS,
                budgetMs: 60_000,
              })
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(recheckStarted);
            yield* Fiber.interrupt(prepareFiber);
            blockPrepareEval = false;
            expect(dispatches).toBe(0);

            // Advancing to window.startMs (18m) proves the normal timer is still alive and fires.
            yield* TestClock.adjust("18 minutes");
            expect(dispatches).toBe(1);
          }).pipe(Effect.provide(dependencies));
        }),
      ),
  );

  it.effect(
    "stops starting new sends at budget expiry and reports in-flight runs as pending without waiting",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const ids = ["t1", "t2", "t3", "t4", "t5"].map((id) => ThreadId.make(id));
        const threads = new Map(
          ids.map((id, index) => [
            id,
            makeProjection(id, { cacheExpiresInMs: (5 + index * 2) * MINUTE_MS }),
          ]),
        );
        const log = yield* makeEventLog();
        const dispatched = yield* Queue.unbounded<ThreadId>();

        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          makeSettingsLayer(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed(ids),
            getThread: (id) => Effect.succeed(threads.get(id)!.thread),
            getThreadRecords: (id) => Effect.succeed(threads.get(id)!),
            hasIdleCompactionWait: () => Effect.succeed(false),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamStoredEventsFrom: log.streamStoredEventsFrom,
            streamDomainEvents: log.streamDomainEvents,
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type !== "message.dispatch") {
                  return { sequence: 0, storedEvents: [] };
                }
                const compactRunId = RunId.make(`compact-${command.threadId}`);
                const createdStored = yield* log.append(
                  {
                    id: EventId.make(`created-${compactRunId}`),
                    type: "run.created",
                    threadId: command.threadId,
                    runId: compactRunId,
                    occurredAt: at(),
                    payload: makeCompactRun(command.threadId, compactRunId, "running"),
                  },
                  command.commandId,
                );
                yield* Queue.offer(dispatched, command.threadId);
                return { sequence: createdStored.sequence, storedEvents: [createdStored] };
              }),
          }),
        );

        const fiber = yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          return yield* service.prepareRestart({
            downtimeMs: 10 * MINUTE_MS,
            marginMs: 30 * MINUTE_MS,
            budgetMs: 10_000,
          });
        }).pipe(Effect.provide(dependencies), Effect.forkChild({ startImmediately: true }));

        const firstBatch = [
          yield* Queue.take(dispatched),
          yield* Queue.take(dispatched),
          yield* Queue.take(dispatched),
        ];
        expect(firstBatch).toEqual([ThreadId.make("t1"), ThreadId.make("t2"), ThreadId.make("t3")]);

        yield* log.append({
          id: EventId.make("complete-t1"),
          type: "run.updated",
          threadId: ThreadId.make("t1"),
          runId: RunId.make("compact-t1"),
          occurredAt: at(),
          payload: makeCompactRun(ThreadId.make("t1"), RunId.make("compact-t1"), "completed"),
        });
        expect(yield* Queue.take(dispatched)).toBe(ThreadId.make("t4"));

        yield* TestClock.adjust("10 seconds");
        const result = yield* Fiber.join(fiber);

        expect(result.timedOut).toBe(true);
        expect(result.sent).toEqual([
          {
            threadId: ThreadId.make("t1"),
            runId: RunId.make("compact-t1"),
            status: "completed",
          },
          {
            threadId: ThreadId.make("t2"),
            runId: RunId.make("compact-t2"),
            status: "pending",
          },
          {
            threadId: ThreadId.make("t3"),
            runId: RunId.make("compact-t3"),
            status: "pending",
          },
          {
            threadId: ThreadId.make("t4"),
            runId: RunId.make("compact-t4"),
            status: "pending",
          },
        ]);
        expect(result.skipped).toEqual([
          { threadId: ThreadId.make("t5"), reason: "budget_exhausted" },
        ]);
      }),
  );

  it.effect("enforces environment:maintain scope on POST /api/server/prepare-restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<{ readonly downtimeMs: number; readonly budgetMs: number }> = [];
        let grantedScopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope];

        const authMiddleware = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("sess-1"),
                subject: "cli",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(grantedScopes),
              }),
            ),
          ),
        );

        const MaintenanceTestApi = HttpApi.make(EnvironmentHttpApi.identifier)
          .add(EnvironmentHttpApi.groups.maintenance)
          .annotateMerge(EnvironmentHttpApi.annotations);

        const api = HttpApiBuilder.layer(MaintenanceTestApi).pipe(
          Layer.provide(PrepareRestartHttp.layer),
          Layer.provide(authMiddleware),
          Layer.provide(
            Layer.mock(IdleCompactionService.IdleCompactionService)({
              prepareRestart: (input) =>
                Effect.sync(() => {
                  calls.push({ downtimeMs: input.downtimeMs, budgetMs: input.budgetMs });
                  return { sent: [], skipped: [], timedOut: false };
                }),
            }),
          ),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Etag.layerWeak),
          Layer.provide(NodeServices.layer),
        );

        const { handler, dispose } = HttpRouter.toWebHandler(api, { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(dispose));

        const forbidden = yield* Effect.promise(() =>
          handler(
            new Request("http://127.0.0.1/api/server/prepare-restart", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ downtimeMs: 600_000, budgetMs: 90_000 }),
            }),
          ),
        );
        expect(forbidden.status).toBe(403);
        expect(calls).toHaveLength(0);

        grantedScopes = [AuthEnvironmentMaintainScope];
        const ok = yield* Effect.promise(() =>
          handler(
            new Request("http://127.0.0.1/api/server/prepare-restart", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ downtimeMs: 600_000, budgetMs: 90_000 }),
            }),
          ),
        );
        expect(ok.status).toBe(200);
        expect(yield* Effect.promise(() => ok.json())).toEqual({
          sent: [],
          skipped: [],
          timedOut: false,
        });
        expect(calls).toEqual([{ downtimeMs: 600_000, budgetMs: 90_000 }]);
      }),
    ),
  );
});
