import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as AcpSchema from "effect-acp/compat";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeAntigravityAcpAdapterFlavor } from "./AntigravityAdapterV2.ts";

const layerTest = Layer.mergeAll(
  NodeCrypto.layer,
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const detachedCommandId = "call_daemon";

const openMetricsSession = Effect.fn("openMetricsSession")(function* () {
  const instanceId = ProviderInstanceId.make("antigravity-metrics-test");
  const threadId = ThreadId.make("thread-antigravity-metrics");
  const selfInvocation = yield* resolveSelfInvocation();
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const sent = yield* Queue.unbounded<Deferred.Deferred<AcpSchema.PromptResponse>>();
  const wireSettled = yield* Queue.unbounded<void>();
  const records: Array<unknown> = [];
  type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let handleUpdate: Parameters<Runtime["handleSessionUpdate"]>[0] = () =>
    Effect.die("session update handler not installed");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    selfInvocation,
    flavor: {
      ...makeAntigravityAcpAdapterFlavor({
        instanceId,
        selfInvocation,
        random,
        path,
        fileSystem: yield* FileSystem.FileSystem,
        host: yield* ProviderHost.ProviderHost,
        defaultModel: Effect.undefined,
        withProcess: (_stop, task) => task,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: {
                T3_ACP_ANTIGRAVITY: "1",
                T3_ACP_AGENT_VERSION: "1.5.16",
                T3_ACP_AVAILABLE_COMMANDS: "compact",
              },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.map((runtime): Runtime => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  handleUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: (_payload, options) =>
                Effect.gen(function* () {
                  const reply = yield* Deferred.make<AcpSchema.PromptResponse>();
                  if (options?.dispatched) yield* Deferred.succeed(options.dispatched, undefined);
                  yield* Queue.offer(sent, reply);
                  return yield* Deferred.await(reply);
                }),
            })),
          ),
      }),
      extractBackgroundTaskId: (tool) =>
        tool.toolCallId === detachedCommandId ? "daemon-task" : undefined,
      isBackgroundCommandTool: (tool) => tool.toolCallId === detachedCommandId,
    },
    testHooks: { afterPromptWireSettled: () => Queue.offer(wireSettled, undefined) },
  }).pipe(
    Effect.provideService(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
      writeAcpTurn: (record) => Effect.sync(() => void records.push(record)),
    }),
  );
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" };
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-metrics"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = Effect.fnUntraced(function* (
    matches: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(events);
      if (matches(event)) return event;
    }
  });
  const start = Effect.fnUntraced(function* (ordinal: number, messageText?: string) {
    const input = makeTurnInput({
      threadId,
      providerThread,
      instanceId,
      modelSelection,
      runtimePolicy,
      now: yield* DateTime.now,
      ordinal,
      ...(messageText === undefined ? {} : { messageText }),
    });
    yield* session.startTurn(input);
    const turn = yield* until(
      (event) => event.type === "provider_turn.updated" && event.providerTurn.status === "running",
    );
    if (turn.type !== "provider_turn.updated") return yield* Effect.die("provider turn must start");
    return { input, providerTurnId: turn.providerTurn.id, reply: yield* Queue.take(sent) };
  });
  const respond = Effect.fnUntraced(function* (
    reply: Deferred.Deferred<AcpSchema.PromptResponse>,
    response: AcpSchema.PromptResponse,
  ) {
    yield* Deferred.succeed(reply, response);
    yield* Queue.take(wireSettled);
  });
  const send = (update: AcpSchema.SessionUpdate) =>
    Effect.suspend(() =>
      handleUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update })),
    );
  return {
    records,
    session,
    until,
    start,
    respond,
    send,
    nextPrompt: Queue.take(sent),
    terminal: until((event) => event.type === "turn.terminal"),
    updateUsage: (used: number) => send({ sessionUpdate: "usage_update", used, size: 1048576 }),
    output: send({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "private output" },
    }),
  };
});

const coldUsage = {
  inputTokens: 9561,
  outputTokens: 24,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  thoughtTokens: 22,
  totalTokens: 9585,
};
const warmUsage = {
  inputTokens: 2155,
  outputTokens: 25,
  cachedReadTokens: 7504,
  cachedWriteTokens: 0,
  thoughtTokens: 23,
  totalTokens: 9684,
};

it.effect("records Antigravity trace timings and marks a missing usage reply as partial", () =>
  Effect.gen(function* () {
    const { records, start, respond, updateUsage, output, terminal } = yield* openMetricsSession();
    // Timestamps and counters from a two-prompt agy 1.5.16 trace.
    yield* TestClock.setTime(Date.parse("2026-11-26T15:43:50.355Z"));
    const cold = yield* start(1);
    yield* updateUsage(0);
    yield* TestClock.adjust(17_402);
    yield* output;
    yield* TestClock.adjust(52);
    yield* updateUsage(9585);
    yield* TestClock.adjust(7);
    yield* respond(cold.reply, { stopReason: "end_turn", usage: coldUsage });
    yield* terminal;

    const warm = yield* start(2);
    yield* TestClock.adjust(6_844);
    yield* output;
    yield* TestClock.adjust(62);
    yield* updateUsage(9684);
    yield* TestClock.adjust(3);
    yield* respond(warm.reply, {
      stopReason: "end_turn",
      usage: { ...warmUsage, _meta: { text: "private metadata" } },
    });
    yield* terminal;

    const failed = yield* start(3, "/compact");
    yield* TestClock.adjust(10);
    yield* respond(failed.reply, { stopReason: "error" });
    yield* terminal;

    assert.lengthOf(records, 3);
    assert.include(records[0], {
      startedAt: "2026-11-26T15:43:50.355Z",
      firstOutputAt: "2026-11-26T15:44:07.757Z",
      promptResponseAt: "2026-11-26T15:44:07.816Z",
      completedAt: "2026-11-26T15:44:07.816Z",
      ttfoMs: 17_402,
      durationMs: 17_461,
      cacheReadRate: 0,
    });
    assert.deepInclude(records[1], {
      threadId: warm.input.threadId,
      providerInstanceId: warm.input.modelSelection.instanceId,
      driver: "antigravity",
      kind: "prompt",
      status: "completed",
      stopReason: "end_turn",
      ttfoMs: 6_844,
      durationMs: 6_909,
      usage: warmUsage,
      usageCoverage: "complete",
      promptsDispatched: 1,
      usageRepliesReceived: 1,
      cacheReadRate: 7504 / (2155 + 7504),
      lastUsageUpdate: { used: 9684, size: 1048576 },
    });
    assert.deepInclude(records[2], {
      kind: "compact",
      status: "failed",
      stopReason: "error",
      durationMs: 10,
      firstOutputAt: null,
      ttfoMs: null,
      usage: null,
      usageCoverage: "partial",
      promptsDispatched: 1,
      usageRepliesReceived: 0,
      lastUsageUpdate: null,
    });
    assert.notProperty(records[2], "cacheReadRate");
    assert.notInclude(JSON.stringify(records), "private");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "settles the steered turn with partial usage when the latest response arrives first",
  () =>
    Effect.gen(function* () {
      const opened = yield* openMetricsSession();
      const { input, providerTurnId, reply } = yield* opened.start(1);
      yield* opened.session.steerTurn({
        threadId: input.threadId,
        runId: input.runId,
        providerThread: input.providerThread,
        providerTurnId,
        message: { ...input.message, messageId: MessageId.make("metrics-steer"), text: "steer" },
      });
      const steered = yield* opened.nextPrompt;
      yield* opened.respond(steered, { stopReason: "end_turn", usage: warmUsage });
      yield* opened.terminal;
      assert.isFalse(yield* Deferred.isDone(reply), "the earlier wire response is outstanding");
      assert.deepInclude(opened.records[0], {
        status: "completed",
        promptsDispatched: 2,
        usageRepliesReceived: 1,
        usageCoverage: "partial",
        usage: warmUsage,
      });
      assert.notProperty(opened.records[0], "cacheReadRate");
      yield* opened.respond(reply, { stopReason: "end_turn", usage: coldUsage });
      assert.lengthOf(opened.records, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("excludes a detached command's update from the next prompt's first output", () =>
  Effect.gen(function* () {
    const opened = yield* openMetricsSession();
    const earlier = yield* opened.start(1);
    const toolCallId = detachedCommandId;
    yield* opened.send({
      sessionUpdate: "tool_call",
      toolCallId,
      kind: "execute",
      title: "Run a daemon",
      status: "in_progress",
      rawInput: { CommandLine: "node helper.mjs", IsDaemon: true, WaitMsBeforeAsync: 500 },
    });
    yield* opened.updateUsage(9585);
    yield* opened.respond(earlier.reply, { stopReason: "end_turn", usage: coldUsage });
    yield* opened.terminal;

    const next = yield* opened.start(2);
    yield* TestClock.adjust(50);
    yield* opened.send({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
      rawOutput: { output: "The daemon wrote an update." },
    });
    const update = yield* opened.until(
      (event) =>
        event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === toolCallId,
    );
    assert.equal(update.type === "turn_item.updated" && update.turnItem.runId, earlier.input.runId);
    yield* opened.respond(next.reply, { stopReason: "end_turn", usage: warmUsage });
    yield* opened.terminal;
    assert.deepInclude(opened.records[1], { firstOutputAt: null, ttfoMs: null });
  }).pipe(Effect.provide(layerTest)),
);
