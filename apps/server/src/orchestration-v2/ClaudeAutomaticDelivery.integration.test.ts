import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { attachmentRelativePath } from "../attachmentStore.ts";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const sessionId = "automatic-delivery-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const decodeScheduledTask = Schema.decodeEffect(ScheduledTaskUpsertInput);
const refusal =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const statusIds = ["status-1", "status-2", "status-3", "status-4"];
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const batch = frame({
  type: "assistant",
  uuid: "batch",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    id: "tool-batch",
    role: "assistant",
    type: "message",
    model: modelSelection.model,
    content: [
      { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
      ...statusIds.map((id) => ({
        type: "tool_use",
        id,
        name: "mcp__t3-code__task_status",
        input: { taskId: id },
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

const toolResult = (id: string, cancelled: boolean) =>
  frame({
    type: "user",
    uuid: `result-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: cancelled,
          content: cancelled ? refusal : id === "build" ? "build OK" : "Task completed normally",
        },
      ],
    },
    ...(cancelled ? { tool_result_meta: [{ id, non_execution_kind: "cancelled" }] } : {}),
  });

const result = (uuid: string, aborted: boolean) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: aborted ? "aborted_tools" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const deliveries = [
  "child completion",
  "scheduled message",
  "user steering",
  "promoted queued message",
] as const;

it.effect.each(deliveries)(
  "delivers %s without Claude cancelling the pending tool calls in its batch",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-automatic-delivery");
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const offers: SDKUserMessage[] = [];
        const nativeQueue: SDKUserMessage[] = [];
        // @effect-diagnostics-next-line abortControllerInEffect:off - The fake SDK interrupts its batch independently of the test fiber.
        const batchAbort = new AbortController();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(sdkMessages),
                offer: (message) =>
                  Effect.sync(() => {
                    offers.push(message);
                    nativeQueue.push(message);
                    // Claude Code 2.1.289 aborts on now-priority commands even while Bash blocks reads.
                    if (nativeQueue.some((command) => command.priority === "now")) {
                      batchAbort.abort({ kind: "interrupt" });
                    }
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.die("unexpected MCP resource read"),
                callMcpTool: () => Effect.die("unexpected MCP tool call"),
                listPermissionRules: Effect.die("unexpected permission rules read"),
                stopTask: () => Effect.void,
                interrupt: Effect.die("automatic delivery must never interrupt"),
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            subagentModel: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:automatic-delivery");
          const projectId = ProjectId.make("project:automatic-delivery");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            title: "Automatic delivery",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("first"),
            text: "Build and check all four tasks.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const pending = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "status-4",
          );
          yield* Queue.offer(sdkMessages, batch);
          yield* Fiber.join(pending);
          const before = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(before.turnItems.filter((item) => item.status === "running").length, 5);
          const parent = before.runs[0]!;
          if (parent.rootNodeId === null) return yield* Effect.die("parent has no root node");
          const messageId = MessageId.make("automatic-notice");
          if (delivery === "child completion") {
            const taskId = NodeId.make("completed-child");
            const now = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cohort"),
                  type: "run.updated",
                  threadId,
                  runId: parent.id,
                  occurredAt: now,
                  payload: {
                    ...parent,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("child"),
                  type: "subagent.updated",
                  threadId,
                  runId: parent.id,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: parent.id,
                    parentNodeId: parent.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Background work",
                    title: "Child",
                    model: null,
                    completionWake: "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: "done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
            const command = {
              type: "message.dispatch" as const,
              commandId: CommandId.make("completion"),
              threadId,
              messageId,
              text: "Child completed",
              attachments: [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "agent" as const,
              creationSource: "server" as const,
              delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
            };
            yield* orchestrator.dispatch(command);
            yield* orchestrator.dispatch(command);
            yield* orchestrator.recoverDelegatedTasks;
          } else if (delivery === "scheduled message") {
            yield* Effect.gen(function* () {
              const service = yield* ScheduledTaskService.ScheduledTaskService;
              const { task } = yield* service.upsert(
                yield* decodeScheduledTask({
                  title: "Status check",
                  prompt: "Check the four tasks.",
                  enabled: true,
                  schedule: { type: "interval", everyMs: 60_000 },
                  projectId,
                  threadId,
                  workspaceStrategy: { type: "root" },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                }),
              );
              const ran = yield* service.runNow({ id: task.id });
              assert.equal(ran.task.lastRunStatus, "succeeded");
            }).pipe(
              Effect.provide(
                ScheduledTaskService.layer.pipe(
                  Layer.provide(ThreadManagementService.layer),
                  Layer.provide(ServerSettings.layerTest()),
                  Layer.provide(
                    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
                      ensureTranscript: () =>
                        Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
                    }),
                  ),
                  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
                  Layer.provide(ManagedPolicy.layerTest()),
                  Layer.provide(
                    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                      namedProjectsRoot: "/projects",
                      isScratchProject: () => Effect.succeed(false),
                    }),
                  ),
                  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
                  Layer.provide(
                    CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                  ),
                  Layer.provide(
                    Layer.mergeAll(
                      NodeCrypto.layer,
                      Scheduler.layer,
                      SqlitePersistence.layerMemory,
                    ),
                  ),
                ),
              ),
            );
          } else if (delivery === "user steering") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: parent.id },
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queue"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: parent.id,
            });
            const promoted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(promoted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
            assert.equal(
              promoted.messages.find((message) => message.id === messageId)?.runId,
              parent.id,
            );
            const steer = promoted.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.ok(steer?.type === "user_message");
            assert.equal(steer.inputIntent, "promoted_queued_to_steer");
          }
          yield* worker.drain();
          const explicitSteer =
            delivery === "user steering" || delivery === "promoted queued message";
          assert.equal(batchAbort.signal.aborted, false);
          assert.equal(offers.length, explicitSteer ? 2 : 1);
          const finished = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === parent.id &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, toolResult("build", false));
          for (const id of statusIds)
            yield* Queue.offer(sdkMessages, toolResult(id, batchAbort.signal.aborted));
          yield* Queue.offer(sdkMessages, result("completed", false));
          yield* Fiber.join(finished);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (!explicitSteer) {
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            const noticeFinished = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "waiting",
            );
            const delivered =
              delivery === "child completion"
                ? yield* watch(
                    (event) =>
                      event.type === "subagent.updated" &&
                      event.payload.completionDelivery?.state === "delivered",
                  )
                : null;
            yield* Queue.offer(sdkMessages, result("notice-completed", false));
            yield* Fiber.join(noticeFinished);
            yield* worker.drain();
            if (delivered !== null) yield* Fiber.join(delivered);
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          const reads = after.turnItems.filter((item) =>
            statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
          );
          assert.equal(reads.length, 4);
          for (const read of reads) {
            assert.equal(read.status, "completed");
            assert.equal(read.toolNonExecutionKind, undefined);
            assert.equal(read.type === "dynamic_tool" && read.output === refusal, false);
          }
          assert.equal(offers.length, 2);
          assert.equal(offers.filter((offer) => offer.priority === "now").length, 0);
          if (!explicitSteer) {
            assert.equal(after.runs.length, 2);
            if (delivery === "child completion") {
              assert.equal(after.messages.filter((message) => message.id === messageId).length, 1);
              assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
            } else {
              assert.equal(
                after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
                1,
              );
            }
          }
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(offers.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-automatic-delivery" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
);

it.effect("applies an effort change to the running Claude query without waiting for a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-live-effort");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const flagSettings: unknown[] = [];
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: (flags) =>
                Effect.sync(() => {
                  flagSettings.push(flags);
                }),
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              stopTask: () => Effect.void,
              interrupt: Effect.die("an effort change must not interrupt the turn"),
              close: Effect.void,
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:live-effort");
        const high = { ...modelSelection, options: [{ id: "effort", value: "high" }] };
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:live-effort"),
          title: "Live effort",
          modelSelection: high,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Keep working.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        assert.deepEqual(flagSettings, []);

        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("medium"),
          threadId,
          modelSelection: { ...modelSelection, options: [{ id: "effort", value: "medium" }] },
        });
        yield* worker.drain();

        assert.deepEqual(flagSettings, [
          { effortLevel: "medium", fastMode: null, ultracode: null },
        ]);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-live-effort" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  ),
);

const backgroundTaskStarted = (taskId: string) =>
  frame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    description: "Background build",
    is_backgrounded: true,
    task_type: "local_bash",
    uuid: `started-${taskId}`,
    session_id: sessionId,
  });

const backgroundTaskNotification = (taskId: string) =>
  frame({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    status: "completed",
    output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
    summary: `Background build ${taskId} completed`,
    uuid: `notification-${taskId}`,
    session_id: sessionId,
  });

const wakeAssistant = (uuid: string) =>
  frame({
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content: [{ type: "text", text: `Background build finished (${uuid}).` }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

it.effect("offers a continuation for a later wake after a queued continuation is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-cancelled-continuation");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
      const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
        const done = yield* Deferred.make<void>();
        processed.set(message, done);
        yield* Queue.offer(sdkMessages, message);
        yield* Deferred.await(done);
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const continuations: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
      const services =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof ClaudeAdapterV2.makeClaudeAdapterV2>>
        >();
      const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            attachmentsDir: cwd,
            fileSystem,
            path,
            random,
            idAllocator,
            continuationRequests: {
              offer: (request) =>
                Effect.sync(() => continuations.push(request)).pipe(
                  Effect.andThen(requests.offer(request)),
                ),
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(sessionId),
              open: () =>
                Effect.succeed({
                  // Resolve each frame's Deferred once the adapter pulls the next one.
                  messages: Stream.fromQueue(sdkMessages).pipe(
                    Stream.flatMap((message) =>
                      Stream.make(message).pipe(
                        Stream.concat(
                          Stream.fromEffect(
                            Effect.suspend(() => {
                              const done = processed.get(message);
                              return done === undefined
                                ? Effect.void
                                : Deferred.succeed(done, undefined);
                            }),
                          ).pipe(Stream.drain),
                        ),
                      ),
                    ),
                  ),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              subagentModel: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          }).pipe(Effect.provideContext(services));
          return [adapter];
        }),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:cancelled-continuation");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const runUpdated = (messageId: string, status: string) =>
          watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.userMessageId === messageId &&
              event.payload.status === status,
          );
        // A user turn that leaves a background task running when it ends.
        const userTurnWithBackgroundTask = Effect.fnUntraced(function* (
          id: string,
          taskId: string,
        ) {
          const running = yield* runUpdated(id, "running");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text: "Run the build in the background.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const waiting = yield* runUpdated(id, "waiting");
          yield* Queue.offer(sdkMessages, backgroundTaskStarted(taskId));
          yield* Queue.offer(sdkMessages, result(`result-${id}`, false));
          yield* Fiber.join(waiting);
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:cancelled-continuation"),
          title: "Cancelled continuation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });

        // The first run is still finalizing when its background task wakes Claude.
        yield* userTurnWithBackgroundTask("first", "build-1");
        const queued = yield* watch(
          (event) => event.type === "run.created" && event.payload.status === "queued",
        );
        yield* offerAndWait(backgroundTaskNotification("build-1"));
        yield* offerAndWait(wakeAssistant("wake-1"));
        yield* Fiber.join(queued);
        assert.lengthOf(continuations, 1);
        const continuationRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        );
        assert.ok(continuationRun !== undefined);
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel"),
          threadId,
          runId: continuationRun.id,
        });
        yield* offerAndWait(result("wake-1-result", false));
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        const idle = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(idle.runs.find((run) => run.id === continuationRun.id)?.status, "cancelled");
        assert.isFalse(idle.runs.some((run) => run.status === "queued"));

        yield* userTurnWithBackgroundTask("second", "build-2");
        yield* worker.drain();
        // The second user run has completed, so this continuation starts without queueing.
        const isContinuationRun = (
          event: OrchestrationV2DomainEvent,
          type: string,
          status: string,
        ) =>
          (event.type === "run.created" || event.type === "run.updated") &&
          event.type === type &&
          event.payload.status === status &&
          event.payload.userMessageId !== MessageId.make("first") &&
          event.payload.userMessageId !== MessageId.make("second");
        const secondCreated = yield* watch((event) =>
          isContinuationRun(event, "run.created", "starting"),
        );
        const secondRunning = yield* watch((event) =>
          isContinuationRun(event, "run.updated", "running"),
        );
        yield* offerAndWait(backgroundTaskNotification("build-2"));
        yield* offerAndWait(wakeAssistant("wake-2"));
        assert.lengthOf(
          continuations,
          2,
          "the wake after a cancelled queued continuation must offer a new continuation",
        );
        yield* Fiber.join(secondCreated);
        yield* worker.drain();
        yield* Fiber.join(secondRunning);
        const secondContinuation = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "running",
        );
        assert.ok(secondContinuation !== undefined);
        const secondWaiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === secondContinuation.id &&
            event.payload.status === "waiting",
        );
        yield* offerAndWait(result("wake-2-result", false));
        yield* Fiber.join(secondWaiting);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          settled.runs.find((run) => run.id === secondContinuation.id)?.status,
          "completed",
        );
        assert.deepEqual(
          settled.turnItems.flatMap((item) =>
            item.runId === secondContinuation.id && item.type === "assistant_message"
              ? [item.text]
              : [],
          ),
          ["Background build finished (wake-2)."],
          "the continuation must carry only its own wake's output",
        );
        assert.lengthOf(continuations, 2, "two wakes must offer exactly two continuations");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-cancelled-continuation" },
            registry,
            { runEffectWorker: false, runContinuationWorker: true },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  ),
);

it.effect.each([
  "before commit",
  "after commit",
  "during slow ingest",
  "stale pending after completion",
  "across outbox recovery",
] as const)("steer fault: a result overtakes the steer %s and delivery remains once", (delay) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("steer-fault-delayed-command");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const offers: SDKUserMessage[] = [];
    const resultPulled = yield* Deferred.make<void>();
    const storageEntered = yield* Deferred.make<void>();
    const releaseStorage = yield* Deferred.make<void>();
    const holdStorage = Deferred.succeed(storageEntered, undefined).pipe(
      Effect.andThen(Deferred.await(releaseStorage)),
    );
    let settleEffectId: string | undefined;
    const commandEntered = yield* Deferred.make<void>();
    const releaseCommit = yield* Deferred.make<void>();
    const followUpWritten = yield* Deferred.make<SDKUserMessage>();
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: modelSelection.instanceId,
      settings,
      environment: {},
      attachmentsDir: cwd,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(sessionId),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages).pipe(
              Stream.tap((frame) =>
                frame.type === "result" && frame.uuid === "blocked-result"
                  ? Deferred.succeed(resultPulled, undefined)
                  : Effect.void,
              ),
            ),
            offer: (message) =>
              Effect.gen(function* () {
                offers.push(message);
                if (offers.length > 1) yield* Deferred.succeed(followUpWritten, message);
              }),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            renameSession: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });

    const steerId = CommandId.make("delayed-steer");
    const threadId = ThreadId.make("thread:steer-fault-delayed-command");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const see = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:steer-fault-delayed-command"),
        title: "Steer fault",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* see(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      const firstMessageId = MessageId.make("first");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first"),
        threadId,
        messageId: firstMessageId,
        text: "Start the build.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const steerMessageId = MessageId.make("delayed-steer");
      const steer = {
        type: "message.dispatch",
        commandId: steerId,
        threadId,
        messageId: steerMessageId,
        text: "Check the logs next.",
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: firstRun.id },
        createdBy: "user",
        creationSource: "web",
      } as const;
      const firstResultPersisted = yield* see(
        (event) => event.type === "run.updated" && event.payload.status === "waiting",
      );
      if (
        delay === "during slow ingest" ||
        delay === "stale pending after completion" ||
        delay === "across outbox recovery"
      ) {
        const pendingPersisted = yield* see(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerMessageId &&
            event.payload.status === "pending",
        );
        yield* orchestrator.dispatch(steer);
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        settleEffectId = (yield* outbox.listByCommandId(steerId)).find(
          (effect) => effect.request.type === "provider-turn.steer",
        )?.id;
        assert.isDefined(settleEffectId);

        const delivering = yield* worker.drain().pipe(Effect.forkScoped);

        const offer = yield* Deferred.await(followUpWritten);
        if (delay === "across outbox recovery") {
          yield* Deferred.await(storageEntered);
          yield* Fiber.interrupt(delivering);
          const lost = yield* outbox.reconcileAfterProcessLoss;
          assert.equal(lost.cancelled, 1);
          yield* worker.drain();
          assert.isTrue((yield* orchestrator.dispatch(steer)).replayed);
        } else {
          yield* Fiber.join(delivering);
        }
        yield* Fiber.join(pendingPersisted);
        if (delay === "during slow ingest") {
          const blocked = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            blocked.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === steerMessageId,
            )?.status,
            "pending",
          );
        }
        const completedStatus = yield* see(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerMessageId &&
            event.payload.status === "completed",
        );
        yield* Queue.offer(
          sdkMessages,
          frame({
            type: "command_lifecycle",
            command_uuid: offer.uuid,
            state: "started",
            session_id: sessionId,
          }),
        );
        if (delay === "stale pending after completion") {
          yield* Fiber.join(completedStatus);
          const current = yield* orchestrator.getThreadProjection(threadId);
          const providerSessionId = current.providerThreads[0]?.providerSessionId;
          if (providerSessionId == null) return yield* Effect.die("Missing provider session");
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
          yield* ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId,
            runId: firstRun.id,
            event: {
              type: "steer.updated",
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              threadId,
              runId: firstRun.id,
              messageId: steerMessageId,
              status: "pending",
            },
          });
        }
        if (delay === "during slow ingest") {
          yield* Deferred.await(storageEntered);
          yield* Queue.offer(
            sdkMessages,
            frame({ ...result("blocked-result"), user_message_uuid: offer.uuid }),
          );
          yield* Deferred.await(resultPulled);
          yield* Deferred.succeed(releaseStorage, undefined);
        } else {
          yield* Queue.offer(
            sdkMessages,
            frame({ ...result("unblocked-result"), user_message_uuid: offer.uuid }),
          );
        }
        yield* Fiber.join(completedStatus);
        yield* Fiber.join(firstResultPersisted);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        const sink = yield* EventSink.EventSinkV2;
        const last = yield* sink.latestSequence({ threadId });
        const terminalEvents = yield* sink.stream({ threadId }).pipe(
          Stream.takeUntil((stored) => stored.sequence === last),
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "completed",
          ),
          Stream.runCollect,
        );
        assert.lengthOf(terminalEvents, 1);
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(offers, 2);
        assert.lengthOf(
          settled.providerTurns.filter((turn) => turn.status === "completed"),
          1,
        );
        assert.lengthOf(
          settled.messages.filter((message) => message.id === steerMessageId),
          1,
        );
        assert.equal(
          settled.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === steerMessageId,
          )?.status,
          "completed",
        );
        return;
      }
      const submitting = yield* orchestrator.dispatch(steer).pipe(Effect.forkScoped);
      yield* Deferred.await(commandEntered);
      if (delay === "after commit") yield* Fiber.join(submitting);
      yield* Queue.offer(
        sdkMessages,
        frame({ ...result("first-result"), user_message_uuid: offers[0]!.uuid }),
      );
      yield* Fiber.join(firstResultPersisted);
      yield* Deferred.succeed(releaseCommit, undefined);
      const receipt = yield* Fiber.await(submitting);
      assert.equal(
        receipt._tag,
        "Success",
        "a steer admitted while the run was active must be preserved",
      );
      assert.lengthOf(offers, 1);
      const replay = yield* orchestrator.dispatch(steer);
      assert.isTrue(replay.replayed);
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      const deliveryState = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        offers.slice(1).map((offer) => JSON.stringify(offer.message.content).includes(steer.text)),
        [true],
        `the accepted steer must cross the SDK boundary once (runs ${deliveryState.runs.map((run) => run.status).join(", ")})`,
      );
      const followUp = yield* Deferred.await(followUpWritten);
      const followUpDone = yield* see(
        (event) => event.type === "run.updated" && event.payload.status === "waiting",
      );
      yield* Queue.offer(
        sdkMessages,
        frame({ ...result("follow-up-result"), user_message_uuid: followUp.uuid }),
      );
      yield* Fiber.join(followUpDone);
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        projection.messages.filter((message) => message.id === steerMessageId),
        1,
      );
      assert.lengthOf(
        projection.providerTurns.filter((turn) => turn.status === "completed"),
        2,
      );
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "steer-fault-delayed-command" },
          ProviderAdapterRegistry.layerSingle(adapter),
          {
            runEffectWorker: false,
            wrapOutbox: (outbox) => ({
              ...outbox,
              succeed: (input) =>
                delay === "across outbox recovery" && input.effectId === settleEffectId
                  ? holdStorage.pipe(Effect.andThen(outbox.succeed(input)))
                  : outbox.succeed(input),
            }),
            wrapEventSink: (sink) => ({
              ...sink,
              write: (input) =>
                delay === "during slow ingest" &&
                input.events.some(
                  (event) =>
                    event.type === "turn-item.updated" &&
                    event.payload.type === "user_message" &&
                    event.payload.messageId === MessageId.make("delayed-steer") &&
                    event.payload.status === "completed",
                )
                  ? holdStorage.pipe(Effect.andThen(sink.write(input)))
                  : sink.write(input),
              commitCommand: (input) =>
                input.commandId !== steerId
                  ? sink.commitCommand(input)
                  : delay === "before commit"
                    ? Deferred.succeed(commandEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseCommit)),
                        Effect.andThen(sink.commitCommand(input)),
                      )
                    : sink
                        .commitCommand(input)
                        .pipe(Effect.tap(() => Deferred.succeed(commandEntered, undefined))),
            }),
          },
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);

const hasHook = false;
const isFork = false;

const orderingCases = [
  ["1 human then agent", ["human", "agent"]],
  ["1 agent then human", ["agent", "human"]],
  ["2 concurrent human wins lock", ["human", "agent"]],
  ["2 concurrent agent wins lock", ["agent", "human"]],
  ["3 earlier human delayed before commit", ["human", "agent"]],
  ["3 slow human attachment", ["human", "agent"]],
  ["4 opposite sides of a boundary", ["human", "agent"]],
  ["5 explicit human queue", ["human", "agent"]],
  ["5 explicit agent queue", ["agent", "human"]],
  ["6 missed boundary human then agent", ["human", "agent"]],
  ["6 missed boundary agent then human", ["agent", "human"]],
  ["6 missed boundary behind older Queue", ["older", "human", "agent"]],
  ["7 human then delegated completion", ["human", "child"]],
  ["7 delegated completion then human", ["child", "human"]],
  ["8 stop between senders", ["human", "agent"]],
] as const;

it.effect.each(orderingCases.map(([scenario, order]) => ({ scenario, order })))(
  "Claude cross-sender order $scenario",
  ({ scenario, order }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-cross-sender");
      let sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offers: SDKUserMessage[] = [];
      const offered = yield* Queue.unbounded<SDKUserMessage>();
      const commitEntered = yield* Deferred.make<void>();
      const commitRelease = yield* Deferred.make<void>();
      const invite = yield* Deferred.make<void>();
      const earlierPreparing = yield* Deferred.make<void>();
      const preparationRelease = yield* Deferred.make<void>();
      const attachmentRead = yield* Deferred.make<void>();
      const attachmentRelease = yield* Deferred.make<void>();
      const session = sessionId;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const system =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof ClaudeAdapterV2.makeClaudeAdapterV2>>
        >();
      const attachment = ChatFileAttachment.make({
        id: ChatAttachmentId.make("order-probe-abcdefab-1234-1234-1234-123456789abc"),
        type: "file",
        mimeType: "application/pdf",
        name: "order.pdf",
        sizeBytes: 100,
      });
      const filePath = path.join(cwd, attachmentRelativePath(attachment)!);
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(
        filePath,
        "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
          "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n" +
          "3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
      );
      let opened: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          const continuationRequests =
            yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const fileSystem = {
            ...fs,
            stream: (name: string, options?: Parameters<typeof fs.stream>[1]) =>
              name === filePath && scenario === "3 slow human attachment"
                ? Stream.fromEffect(
                    Deferred.succeed(attachmentRead, undefined).pipe(
                      Effect.andThen(Deferred.await(attachmentRelease)),
                    ),
                  ).pipe(Stream.drain, Stream.concat(fs.stream(name, options)))
                : fs.stream(name, options),
          };
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            attachmentsDir: cwd,
            fileSystem,
            path,
            random,
            idAllocator,
            continuationRequests,
            queryRunner: {
              allocateSessionId: Effect.succeed(session),
              open: ({ options }) =>
                Effect.gen(function* () {
                  if (opened !== undefined && scenario.startsWith("8"))
                    sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  opened = options;
                  const messages = sdkMessages;
                  return {
                    messages: Stream.fromQueue(messages),
                    offer: (message, onQueued) =>
                      Effect.gen(function* () {
                        offers.push(message);
                        onQueued?.();

                        yield* Queue.offer(offered, message);
                      }),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    renameSession: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    mcpServerStatus: Effect.succeed([]),
                    readMcpResource: () => Effect.die("unexpected MCP resource read"),
                    callMcpTool: () => Effect.die("unexpected MCP tool call"),
                    listPermissionRules: Effect.die("unexpected permission rules read"),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: scenario.startsWith("8") ? Queue.shutdown(messages) : Effect.void,
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              subagentModel: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          }).pipe(Effect.provideContext(system));
          return [adapter];
        }),
      );

      const threadId = ThreadId.make("thread:claude-cross-sender");
      type Sender = (typeof orderingCases)[number][1][number];
      const messageId = (sender: Sender) => MessageId.make(`cross-sender:${sender}`);
      const commandId = (sender: Sender) => CommandId.make(`send:${sender}`);
      const marker = (sender: Sender) => `ORDER_${sender.toUpperCase()}`;
      const tested = new Set(order as readonly Sender[]);
      const promptOrders: Array<{ at: string; prompts: Sender[] }> = [];
      const labelOf = (message: SDKUserMessage): Sender | undefined =>
        [...tested].find((sender) =>
          JSON.stringify(message.message.content).includes(marker(sender)),
        );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const watch = Effect.fnUntraced(function* (
          predicate: (event: OrchestrationV2DomainEvent) => boolean,
        ) {
          const afterSequence = yield* sink.latestSequence({ threadId });
          return yield* sink.stream({ threadId, afterSequence }).pipe(
            Stream.filter(({ event }) => predicate(event)),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("order-project"),
          title: "Cross-sender order",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("initial"),
          threadId,
          messageId: MessageId.make("initial"),
          text: "Run both tools.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const initialPrompt = yield* Queue.take(offered);
        const started = yield* orchestrator.getThreadProjection(threadId);
        const root = started.runs[0]!;
        yield* Queue.offer(
          sdkMessages,
          frame({
            type: "system",
            subtype: "init",
            session_id: session,
            capabilities: ["interrupt_cancel_queued_v1"],
          }),
        );

        const tool = Effect.fnUntraced(function* (id: string) {
          const seen = yield* watch(
            (e) =>
              e.type === "turn-item.updated" &&
              e.payload.nativeItemRef?.nativeId === id &&
              e.payload.status === "running",
          );
          const fixture = batch as Extract<SDKMessage, { type: "assistant" }>;
          yield* Queue.offer(
            sdkMessages,
            frame({
              ...fixture,
              uuid: `batch:${id}`,
              message: {
                ...fixture.message,
                id: `message:${id}`,
                content: [{ type: "tool_use", id, name: "Bash", input: { command: "true" } }],
              },
              user_message_uuids: [initialPrompt.uuid],
            }),
          );
          yield* Fiber.join(seen);
        });
        const read = Effect.fnUntraced(function* (at: string, native: SDKUserMessage[]) {
          const prompts = native.flatMap((message) => {
            const sender = labelOf(message);
            return sender === undefined ? [] : [sender];
          });
          promptOrders.push({ at, prompts });
          for (const message of native) {
            yield* Queue.offer(
              sdkMessages,
              frame({
                type: "command_lifecycle",
                state: "started",
                session_id: session,
                command_uuid: message.uuid,
              }),
            );
          }
        });
        const drainOffers = Effect.fnUntraced(function* (at: string) {
          const native = yield* Queue.clear(offered);
          yield* read(at, native);
          return native;
        });
        const doHook = () => {
          const hook = (
            opened?.hooks as
              | Partial<Record<"PostToolBatch", Array<{ hooks: HookCallback[] }>>>
              | undefined
          )?.PostToolBatch?.[0]?.hooks[0];
          return hook === undefined
            ? Effect.void
            : Effect.promise(() =>
                hook(
                  {
                    hook_event_name: "PostToolBatch",
                    session_id: session,
                    transcript_path: "",
                    cwd,
                    tool_calls: [],
                  },
                  undefined,
                  { signal: new AbortController().signal },
                ),
              );
        };
        const boundary = Effect.fnUntraced(function* (id: string) {
          const seen = yield* watch(
            (e) =>
              e.type === "turn-item.updated" &&
              e.payload.nativeItemRef?.nativeId === id &&
              e.payload.status === "completed",
          );
          yield* Queue.offer(sdkMessages, toolResult(id, false));
          yield* Fiber.join(seen);
          yield* doHook();
          return yield* drainOffers(id);
        });

        const send = Effect.fnUntraced(function* (sender: Sender) {
          const queued =
            sender === "older" ||
            (sender === "child" && !isFork) ||
            (scenario === "5 explicit human queue" && sender === "human") ||
            (scenario === "5 explicit agent queue" && sender === "agent");
          if (sender === "child") {
            if (root.rootNodeId === null) return yield* Effect.die("No root node");
            const taskId = NodeId.make("completed-child");
            const now = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cohort"),
                  type: "run.updated",
                  threadId,
                  runId: root.id,
                  occurredAt: now,
                  payload: {
                    ...root,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId: messageId("child"), taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("child"),
                  type: "subagent.updated",
                  threadId,
                  runId: root.id,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: root.id,
                    parentNodeId: root.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Background work",
                    title: "Child",
                    model: null,
                    completionWake: "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: marker("child"),
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
          }
          return yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: commandId(sender),
            threadId,
            messageId: messageId(sender),
            text: marker(sender),
            attachments:
              scenario === "3 slow human attachment" && sender === "human" ? [attachment] : [],
            ...(queued || sender === "child"
              ? {}
              : { deliveryIntent: sender === "human" ? "steer" : "auto" }),
            dispatchMode: queued
              ? { type: "queue_after_active" }
              : { type: "steer_active", targetRunId: root.id },
            createdBy: sender === "human" || sender === "older" ? "user" : "agent",
            creationSource: sender === "child" ? "server" : sender === "agent" ? "mcp" : "web",
            ...(sender === "child"
              ? {
                  delegatedCompletion: {
                    parentRunId: root.id,
                    generation: 1,
                    taskIds: [NodeId.make("completed-child")],
                  },
                }
              : {}),
          });
        });

        yield* tool("boundary-1");
        const watchBaseFinished = () =>
          watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === root.id &&
              ["waiting", "completed", "interrupted", "cancelled"].includes(e.payload.status),
          );
        const stopped = scenario.startsWith("8") ? yield* watchBaseFinished() : undefined;
        if (scenario.startsWith("6")) yield* boundary("boundary-1");
        if (scenario.startsWith("2")) {
          const first = yield* send(order[0]).pipe(Effect.forkScoped);
          yield* Deferred.await(commitEntered);
          const second = yield* Deferred.succeed(invite, undefined).pipe(
            Effect.andThen(send(order[1])),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(invite);
          yield* Deferred.succeed(commitRelease, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        } else if (scenario === "3 earlier human delayed before commit") {
          const earlier = yield* Deferred.succeed(earlierPreparing, undefined).pipe(
            Effect.andThen(Deferred.await(preparationRelease)),
            Effect.andThen(send("human")),
            Effect.forkScoped,
          );
          yield* Deferred.await(earlierPreparing);
          yield* send("agent");
          yield* Deferred.succeed(preparationRelease, undefined);
          yield* Fiber.join(earlier);
        } else if (scenario === "3 slow human attachment") {
          yield* send("human");
          const writing = yield* (hasHook && isFork ? doHook() : worker.drain()).pipe(
            Effect.forkScoped,
          );
          yield* Deferred.await(attachmentRead);
          const later = yield* send("agent").pipe(Effect.forkScoped);
          yield* Fiber.join(later);
          yield* Deferred.succeed(attachmentRelease, undefined);
          yield* Fiber.join(writing);
        } else if (scenario === "4 opposite sides of a boundary") {
          yield* send("human");
          yield* worker.drain();
          yield* boundary("boundary-1");
          yield* tool("boundary-2");
          yield* send("agent");
          yield* worker.drain();
          yield* boundary("boundary-2");
        } else if (scenario === "8 stop between senders") {
          yield* send("human");
          yield* worker.drain();
          yield* Queue.clear(offered);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: root.id,
            holdQueue: true,
          });
          yield* worker.drain();
          if (stopped !== undefined) yield* Fiber.join(stopped);
          // MCP Auto sends a plain start once the old turn is no longer steerable.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: commandId("agent"),
            threadId,
            messageId: messageId("agent"),
            text: marker("agent"),
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          });
        } else {
          for (const sender of order) yield* send(sender);
        }
        yield* worker.drain();
        if (!scenario.startsWith("6") && !scenario.startsWith("8") && !scenario.startsWith("4")) {
          yield* boundary("boundary-1");
          if (isFork && scenario === "3 slow human attachment") {
            yield* tool("boundary-2");
            yield* boundary("boundary-2");
          }
        }

        // Distinguish a post-result SDK write from a later T3 turn.
        const afterFirst = yield* Queue.size(offered);
        const baseFinished = stopped ?? (yield* watchBaseFinished());
        if (stopped === undefined)
          yield* Queue.offer(
            sdkMessages,
            frame({
              ...result("first-result"),
              user_message_uuid: initialPrompt.uuid,
            }),
          );

        if (scenario.startsWith("6") && !isFork) {
          const firstQueued =
            afterFirst > 0
              ? undefined
              : yield* Effect.raceFirst(
                  Queue.take(offered),
                  Fiber.join(baseFinished).pipe(Effect.as(undefined)),
                );
          yield* worker.drain();
          const extra = [
            ...(firstQueued === undefined ? [] : [firstQueued]),
            ...(yield* Queue.clear(offered)),
          ];
          if (extra.length > 0) {
            yield* read("post-result in current T3 run", extra);
            yield* Queue.offer(
              sdkMessages,
              frame({
                ...result("post-result"),
                user_message_uuid: extra.at(-1)?.uuid,
              }),
            );
          }
        }
        yield* Fiber.join(baseFinished);
        yield* worker.drain();
        if (scenario.startsWith("8")) {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("resume"),
            threadId,
          });
        }
        for (let index = 0; index < order.length; index++) {
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const next = yield* drainOffers("next T3 turn");
          if (next.length === 0) break;
          const finished = yield* watch(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id !== root.id &&
              ["waiting", "completed", "interrupted", "cancelled"].includes(e.payload.status),
          );
          yield* Queue.offer(
            sdkMessages,
            frame({
              ...result(`next:${index}`),
              user_message_uuid: next.at(-1)?.uuid,
            }),
          );
          yield* Fiber.join(finished);
          yield* worker.drain();
        }

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const last = yield* sink.latestSequence({ threadId });
        const persisted = yield* sink.stream({ threadId }).pipe(
          Stream.takeUntil((record) => record.sequence === last),
          Stream.runCollect,
        );
        const committed = [
          ...new Set(
            persisted.flatMap(({ event }) =>
              event.type === "message.updated"
                ? [...tested].filter((s) => event.payload.id === messageId(s))
                : [],
            ),
          ),
        ];
        const timeline = projection.turnItems.flatMap((item) => {
          const id =
            item.type === "user_message"
              ? item.messageId
              : item.type === "notification" && item.source.kind === "delegated_task"
                ? messageId("child")
                : undefined;
          return id !== undefined
            ? [...tested].filter((sender) => id === messageId(sender))
            : item.nativeItemRef?.nativeId === "boundary-1" ||
                item.nativeItemRef?.nativeId === "boundary-2"
              ? [item.nativeItemRef.nativeId]
              : [];
        });
        const authors = projection.messages.flatMap((message) =>
          [...tested].flatMap((s) =>
            message.id === messageId(s) ? [[s, message.createdBy, message.creationSource]] : [],
          ),
        );
        const readOrder = promptOrders.flatMap((step) => step.prompts);
        const timelineOrder = timeline.filter((value) => !value.startsWith("boundary-"));
        const ledger = {
          committed,
          promptOrders,
          timeline,
          authors,
          runs: projection.runs.map((run) => [
            run.ordinal,
            run.status,
            run.userMessageId,
            DateTime.toEpochMillis(run.requestedAt),
            run.queueHeld ?? false,
          ]),
        };
        yield* Effect.sync(() =>
          console.log("ordering evidence", scenario, JSON.stringify(ledger)),
        );
        const expected = scenario.startsWith("5")
          ? [...order].reverse()
          : scenario === "6 missed boundary behind older Queue"
            ? ["human", "agent", "older"]
            : committed;
        assert.sameMembers(committed, [...order], "committed messages");
        assert.deepEqual(
          committed,
          scenario === "3 earlier human delayed before commit" ? ["agent", "human"] : [...order],
          "commit sequence",
        );
        if (scenario.startsWith("8")) {
          const firstAfterStop = projection.runs.find(
            (run) => run.id !== root.id && run.status !== "queued" && run.status !== "cancelled",
          );
          assert.equal(
            firstAfterStop?.userMessageId,
            messageId("human"),
            "the first new T3 run must start with the older unread message",
          );
        }
        assert.deepEqual(readOrder, expected, "native read sequence and count");
        assert.deepEqual(timelineOrder, readOrder, "timeline sequence and count");
        assert.lengthOf(authors, order.length, "one durable message per sender");
        assert.isTrue(
          authors.every(
            ([sender, author]) =>
              author === (sender === "human" || sender === "older" ? "user" : "agent"),
          ),
          "sender label",
        );
        if (scenario.startsWith("4"))
          assert.deepEqual(timeline, ["boundary-1", "human", "boundary-2", "agent"]);
        if (isFork && scenario.startsWith("6"))
          assert.isTrue(
            promptOrders
              .filter((entry) => entry.prompts.length > 0)
              .every((entry) => entry.at === "next T3 turn"),
            "missed-boundary updates must use separate T3 turns",
          );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry({ name: "claude-cross-sender" }, registry, {
            runEffectWorker: false,
            runContinuationWorker: true,
            wrapEventSink: (sink) => ({
              ...sink,
              commitCommand: (input) =>
                scenario.startsWith("2") && input.commandId === commandId(order[0])
                  ? Deferred.succeed(commitEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(commitRelease)),
                      Effect.andThen(sink.commitCommand(input)),
                    )
                  : sink.commitCommand(input),
            }),
          }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
);
