import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  type ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import {
  compactOnceApplies,
  idleCompactionScope,
  idleCompactionWindow,
  type IdleCompactionPolicy,
  type IdleCompactionRecords,
} from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: { readonly usedTokens?: number; readonly cacheExpiresInMs?: number } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
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
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
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
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
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
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

describe("idleCompactionWindow", () => {
  it("skips small contexts, unknown expiry, other providers, switched threads, compactions, and side chats", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 199_999 }), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records(), NOW_MS)).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS)).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS)).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS)).toBeNull();
    const steered = records(cache);
    steered.runs = [
      ...steered.runs,
      {
        ...steered.runs[0]!,
        id: RunId.make("run-2"),
        ordinal: 2,
        userMessageId: MessageId.make("message-2"),
        status: "cancelled",
        startedAt: null,
      },
    ];
    expect(idleCompactionWindow(steered, NOW_MS)?.runId).toBe(runId);
    // A turn Claude itself reported as cancelled did run, so it stays the latest.
    steered.runs = steered.runs.map((run) => ({ ...run, startedAt: at(-MINUTE_MS) }));
    expect(idleCompactionWindow(steered, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
    const sideChat = records(cache);
    expect(idleCompactionWindow(sideChat, NOW_MS)).not.toBeNull();
    sideChat.thread = {
      ...sideChat.thread,
      lineage: { ...sideChat.thread.lineage, relationshipToParent: "fork", sideChat: true },
    };
    expect(idleCompactionWindow(sideChat, NOW_MS)).toBeNull();
  });

  it("resolves the scope from the mode, Smart, and the thread's own setting", () => {
    expect(idleCompactionScope("beforeCacheExpires", true, null)).toBe("waiting");
    expect(idleCompactionScope("beforeCacheExpires", false, undefined)).toBe("all");
    expect(idleCompactionScope("onReturn", true, null)).toBeNull();
    expect(idleCompactionScope("onReturn", true, true)).toBe("all");
    expect(idleCompactionScope("beforeCacheExpires", true, false)).toBeNull();
    expect(idleCompactionScope("off", true, true)).toBeNull();
    expect(idleCompactionScope("beforeCacheExpires", true, null, true)).toBe("all");
    expect(idleCompactionScope("onReturn", true, null, true)).toBe("all");
    expect(idleCompactionScope("beforeCacheExpires", false, false, true)).toBeNull();
    expect(idleCompactionScope("off", false, null, true)).toBeNull();
  });

  it("keeps a one-shot mark until a run starts after it", () => {
    const { runs } = records();
    const iso = (offset: number) => DateTime.formatIso(at(offset));
    expect(compactOnceApplies(null, runs)).toBe(false);
    // Set during the run it follows.
    expect(compactOnceApplies(iso(-MINUTE_MS / 2), runs)).toBe(true);
    // A reply, a queued message, or the compaction started after it.
    expect(compactOnceApplies(iso(-2 * MINUTE_MS), runs)).toBe(false);
    // A removed queued message never started.
    expect(compactOnceApplies(iso(-2 * MINUTE_MS), [{ ...runs[0]!, startedAt: null }])).toBe(true);
  });

  it.each([
    { name: "nothing will wake it", waits: {}, compacts: false },
    { name: "an issue watch", waits: { issueWatch: true }, compacts: true },
    { name: "an awaited subagent", waits: { task: "subagent" }, compacts: true },
    { name: "only an unawaited command", waits: { task: "command" }, compacts: false },
    { name: "a scheduled wake after expiry", waits: { scheduledInMs: 90 }, compacts: true },
    { name: "a scheduled wake before expiry", waits: { scheduledInMs: 30 }, compacts: false },
    { name: "a snooze when snoozed threads are off", waits: { snoozeInMs: 90 }, compacts: false },
    {
      name: "a snooze past expiry",
      waits: { snoozeInMs: 90, compactSnoozed: true },
      compacts: true,
    },
    {
      name: "a snooze ending before expiry",
      waits: { snoozeInMs: 30, compactSnoozed: true },
      compacts: false,
    },
  ] as const)("Smart compacts a thread with $name: $compacts", ({ waits, compacts }) => {
    const data = records({ cacheExpiresInMs: 60 * MINUTE_MS });
    if ("issueWatch" in waits) {
      data.thread = {
        ...data.thread,
        issueWatches: [
          {
            host: "github.com",
            repository: "owner/repo",
            number: 1,
            url: "https://github.com/owner/repo/issues/1",
            startedAt: DateTime.formatIso(at()),
            commentsThrough: DateTime.formatIso(at()),
            commentIds: [],
            wakes: 0,
          },
        ],
      };
    }
    if ("task" in waits) {
      data.providerThreads = [
        {
          ...data.providerThreads[0]!,
          pendingBackgroundTasks: [{ taskId: "task-1", kind: waits.task }],
        },
      ];
    }
    if ("snoozeInMs" in waits) {
      data.thread = { ...data.thread, snoozedUntil: at(waits.snoozeInMs * MINUTE_MS) };
    }
    const policy: IdleCompactionPolicy = {
      scope: "waiting",
      compactSnoozed: "compactSnoozed" in waits,
      scheduledWakesMs: "scheduledInMs" in waits ? [NOW_MS + waits.scheduledInMs * MINUTE_MS] : [],
    };
    expect(idleCompactionWindow(data, NOW_MS, policy) !== null).toBe(compacts);
  });
});

const noScheduledTasks = Layer.mock(ScheduledTaskService)({
  list: () => Effect.succeed({ tasks: [] }),
  subscribeList: () => Stream.empty,
});

describe("IdleCompactionService", () => {
  it.effect.each([
    { mode: "onReturn", reads: 0 },
    { mode: "off", reads: 0 },
    { mode: "beforeCacheExpires", reads: 1 },
    { mode: "beforeCacheExpires", override: "off", reads: 0 },
    { mode: "onReturn", override: "beforeCacheExpires", reads: 1 },
    { mode: "beforeCacheExpires", projectDisabled: true, reads: 0 },
    { mode: "beforeCacheExpires", enabled: false, reads: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "codex", reads: 0 },
    { mode: "beforeCacheExpires", driver: "codex", instance: "custom-codex", reads: 0 },
    { mode: "beforeCacheExpires", driver: "claudeAgent", instance: "custom-claude", reads: 1 },
    { mode: "beforeCacheExpires", unconfigured: true, reads: 1 },
    { mode: "beforeCacheExpires", smart: true, reads: 1, dispatches: 0 },
    { mode: "beforeCacheExpires", smart: true, threadOverride: true, reads: 1 },
    { mode: "onReturn", threadOverride: true, reads: 1 },
    { mode: "beforeCacheExpires", threadOverride: false, reads: 0 },
    { mode: "off", threadOverride: true, reads: 0 },
    { mode: "beforeCacheExpires", smart: true, compactOnce: "set", reads: 1 },
    { mode: "onReturn", compactOnce: "set", reads: 1 },
    { mode: "beforeCacheExpires", smart: true, compactOnce: "stale", reads: 1, dispatches: 0 },
    { mode: "beforeCacheExpires", threadOverride: false, compactOnce: "set", reads: 0 },
    { mode: "off", compactOnce: "set", reads: 0 },
  ] as const)(
    "loads history only for eligible idle compaction: $mode/$override/$enabled/$projectDisabled/$instance/$unconfigured/$threadOverride/$compactOnce",
    (scenario) => {
      const test = {
        override: "default",
        enabled: true,
        projectDisabled: false,
        smart: false,
        threadOverride: null,
        ...scenario,
      } as const;
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const selectedInstance = ProviderInstanceId.make(
          "instance" in test ? test.instance : "claudeAgent",
        );
        const driver = ProviderDriverKind.make("driver" in test ? test.driver : "claudeAgent");
        const base = records({ cacheExpiresInMs: 2 * MINUTE_MS });
        const data: OrchestrationV2ThreadProjection = {
          ...base,
          thread: {
            ...base.thread,
            providerInstanceId: selectedInstance,
            modelSelection: { ...base.thread.modelSelection, instanceId: selectedInstance },
            compactBeforeCacheExpires: test.threadOverride,
            // The run started a minute ago; a stale mark predates it.
            ...("compactOnce" in test
              ? {
                  compactOnceRequestedAt: DateTime.formatIso(
                    at(test.compactOnce === "set" ? -MINUTE_MS / 2 : -2 * MINUTE_MS),
                  ),
                }
              : {}),
          },
          runs: base.runs.map((run) => ({
            ...run,
            providerInstanceId: selectedInstance,
            modelSelection: { ...run.modelSelection, instanceId: selectedInstance },
          })),
          providerThreads: base.providerThreads.map((thread) => ({
            ...thread,
            driver,
            providerInstanceId: selectedInstance,
          })),
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
        let historyReads = 0;
        let dispatches = 0;
        const done = yield* Deferred.make<void>();
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (...args) => {
              end(...args);
              if (span.name === "IdleCompactionService.compactWhenDue")
                Deferred.doneUnsafe(done, Effect.void);
            };
            return span;
          },
        });
        const dependencies = Layer.mergeAll(
          noScheduledTasks,
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.make({
              id: EventId.make("idle-completed"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: at(),
              payload: data.runs[0]!,
            }),
            dispatch: () =>
              Effect.sync(() => {
                dispatches++;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(data.thread),
            getThreadRecords: () =>
              Effect.sync(() => {
                historyReads++;
                return data;
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              idleCompaction: test.mode,
              smartIdleCompaction: test.smart,
              providerInstances:
                "unconfigured" in test
                  ? {}
                  : {
                      [selectedInstance]: {
                        driver,
                        enabled: test.enabled,
                        config: { idleCompaction: test.override },
                      },
                    },
              projectSettingsOverrides: test.projectDisabled
                ? {
                    [data.thread.projectId]: {
                      providerInstances: { [selectedInstance]: { enabled: false } },
                    },
                  }
                : {},
            }),
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          yield* service.start();
          yield* Deferred.await(done);
        }).pipe(Effect.provide(dependencies), Effect.withTracer(tracer));
        expect(historyReads).toBe(test.reads);
        expect(dispatches).toBe("dispatches" in test ? test.dispatches : test.reads);
      });
    },
  );

  // Runs the service over `events` for a thread snoozed past its 10-minute cache expiry and
  // returns what it dispatched once the compaction window opens.
  const snoozedThreadDispatches = (
    events: Stream.Stream<OrchestrationV2DomainEvent>,
    scheduledTasks: Layer.Layer<ScheduledTaskService> = noScheduledTasks,
    beforeRead: () => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const base = records({ cacheExpiresInMs: 10 * MINUTE_MS });
      const data: OrchestrationV2ThreadProjection = {
        ...base,
        thread: { ...base.thread, snoozedUntil: at(90 * MINUTE_MS) },
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
      const dispatched: Array<string> = [];
      const dependencies = Layer.mergeAll(
        scheduledTasks,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: events,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.commandId);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(data.thread),
          getThreadRecords: (_threadId, _keys, options) =>
            beforeRead().pipe(
              Effect.as({
                ...data,
                messages: data.messages.filter(
                  (message) =>
                    message.runId !== null &&
                    (options?.messageRunIds ?? []).includes(message.runId),
                ),
              }),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            idleCompaction: "beforeCacheExpires",
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* TestClock.adjust(9 * MINUTE_MS);
      }).pipe(Effect.provide(dependencies));
      return dispatched;
    });

  it.effect("arms Smart compaction when a thread is snoozed after its run completed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = records();
        const dispatched = yield* snoozedThreadDispatches(
          Stream.make({
            id: EventId.make("snoozed"),
            type: "thread.snoozed" as const,
            threadId,
            occurredAt: at(),
            payload: { ...base.thread, snoozedUntil: at(90 * MINUTE_MS) },
          }),
        );
        expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
      }),
    ),
  );

  it.effect("replaces an in-flight check when another wake arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<void>();
        const base = records();
        const event = {
          id: EventId.make("snoozed"),
          type: "thread.snoozed" as const,
          threadId,
          occurredAt: at(),
          payload: { ...base.thread, snoozedUntil: at(90 * MINUTE_MS) },
        };
        let reads = 0;
        const dispatched = yield* snoozedThreadDispatches(
          Stream.concat(
            Stream.make(event),
            Stream.fromEffect(Deferred.await(firstRead).pipe(Effect.as(event))),
          ),
          noScheduledTasks,
          () =>
            ++reads === 1
              ? Deferred.succeed(firstRead, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        );
        expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
      }),
    ),
  );

  it.effect.each(["deleted", "retargeted", "subscription failed"] as const)(
    "rechecks a task's former thread when %s",
    (change) =>
      Effect.scoped(
        Effect.gen(function* () {
          // An earlier scheduled wake suppresses compaction until the task moves or disappears.
          const task: ScheduledTask = {
            id: ScheduledTaskId.make("task-1"),
            title: "Check CI",
            prompt: "Check CI",
            enabled: true,
            schedule: { type: "webhook", signature: null },
            projectId: ProjectId.make("project"),
            threadId,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: DateTime.formatIso(at()),
            updatedAt: DateTime.formatIso(at()),
            nextRunAt: DateTime.formatIso(at(5 * MINUTE_MS)),
            lastRunAt: null,
            lastRunStatus: "never",
            lastRunError: null,
            runCount: 0,
          };
          const deletedAtMs = NOW_MS + MINUTE_MS;
          const tasksNow = Clock.currentTimeMillis.pipe(
            Effect.map((nowMs) => ({
              tasks:
                nowMs < deletedAtMs
                  ? [task]
                  : change === "retargeted"
                    ? [{ ...task, threadId: ThreadId.make("other-thread") }]
                    : [],
            })),
          );
          const dispatched = yield* snoozedThreadDispatches(
            Stream.empty,
            Layer.mock(ScheduledTaskService)({
              list: () => tasksNow,
              subscribeList: () =>
                Stream.concat(
                  Stream.fromEffect(tasksNow),
                  Stream.fromEffect(
                    Effect.sleep(Duration.minutes(1)).pipe(
                      Effect.andThen(
                        change === "subscription failed"
                          ? Effect.fail(new ScheduledTaskError({ message: "database locked" }))
                          : tasksNow,
                      ),
                    ),
                  ),
                ).pipe(Stream.concat(Stream.never)),
            }),
          );
          expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-1"]);
        }),
      ),
  );

  it.effect("keeps the latest run's compaction when an earlier run reports completed again", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const base = records({ cacheExpiresInMs: 10 * MINUTE_MS });
      const laterRunId = RunId.make("run-2");
      const laterMessageId = MessageId.make("message-2");
      const earlierRun = base.runs[0]!;
      const laterRun = {
        ...earlierRun,
        id: laterRunId,
        ordinal: 2,
        userMessageId: laterMessageId,
      };
      const cancelledRun = {
        ...earlierRun,
        id: RunId.make("run-3"),
        ordinal: 3,
        userMessageId: MessageId.make("message-3"),
        status: "cancelled" as const,
        startedAt: null,
      };
      const data: OrchestrationV2ThreadProjection = {
        ...base,
        runs: [earlierRun, laterRun, cancelledRun],
        messages: [
          ...base.messages,
          { ...base.messages[0]!, id: laterMessageId, runId: laterRunId, text: "Keep going" },
        ],
        providerThreads: [{ ...base.providerThreads[0]!, lastRunOrdinal: 2 }],
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
      const completed = (run: typeof earlierRun) => ({
        id: EventId.make(`completed-${run.id}`),
        type: "run.updated" as const,
        threadId,
        runId: run.id,
        occurredAt: at(),
        payload: run,
      });
      const dispatched: Array<string> = [];
      const streamDone = yield* Deferred.make<void>();
      const dependencies = Layer.mergeAll(
        noScheduledTasks,
        Layer.mock(Orchestrator.OrchestratorV2)({
          // A delegated completion on the earlier run lands after the later run completed.
          streamDomainEvents: Stream.make(completed(laterRun), completed(earlierRun)).pipe(
            Stream.ensuring(Deferred.succeed(streamDone, undefined)),
          ),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.commandId);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(data.thread),
          getThreadRecords: (_threadId, _keys, options) =>
            Effect.succeed({
              ...data,
              messages: data.messages.filter(
                (message) =>
                  options?.messageRunIds === undefined ||
                  (message.runId !== null && options.messageRunIds.includes(message.runId)),
              ),
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            idleCompaction: "beforeCacheExpires",
            smartIdleCompaction: false,
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* Deferred.await(streamDone);
        yield* TestClock.adjust(9 * MINUTE_MS);
      }).pipe(Effect.provide(dependencies));
      expect(dispatched).toEqual(["server:idle-compact:idle-thread:run-2"]);
    }),
  );
});
