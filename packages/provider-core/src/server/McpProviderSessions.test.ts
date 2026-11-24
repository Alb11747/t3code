import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(
          threadId,
          "send_to_user",
          { message: "Old" },
          undefined,
          "session-2",
        ),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId, "session-2");
      yield* sessions.clearToolResults(threadId, "session-2");
      yield* sessions.toolResultEpoch(threadId, "session-2");
      assert.strictEqual(
        yield* sessions.takeToolResult(
          threadId,
          "send_to_user",
          { message: "Current" },
          undefined,
          "session-2",
        ),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(
          threadId,
          "send_to_user",
          { message: "Late from turn 1" },
          undefined,
          "session-2",
        ),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});

const threadId = ThreadId.make("thread-provider-html");
const session = (instance: string, providerSessionId = instance) => ({
  environmentId: EnvironmentId.make("environment-provider-html"),
  threadId,
  providerInstanceId: ProviderInstanceId.make(instance),
  providerSessionId,
  endpoint: "http://127.0.0.1:9999/mcp",
  authorizationHeader: "Bearer fixture",
  browserToolsAvailable: true,
});
const page = { html: "<p>Report</p>", title: "Report", height: 240 };
const reference = { attachmentId: "report-html", title: page.title, height: page.height };

describe("provider HTML references", () => {
  it.effect.each(["attach", "replace", "clear", "finish turn"] as const)(
    "preserves another provider's pending results when a provider is changed: %s",
    (change) =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(session("previous"));
        yield* sessions.set(session("active"));
        yield* sessions.recordHtmlRender(threadId, page, reference);
        const input = { task: "Audit" };
        const previousResult = { taskId: "previous-task" };
        const activeResult = { taskId: "active-task" };
        const previousEpoch = yield* sessions.toolResultEpoch(threadId, "previous");
        const activeEpoch = yield* sessions.toolResultEpoch(threadId, "active");
        yield* sessions.recordToolResult(threadId, "delegate_task", input, previousResult, {
          providerSessionId: "previous",
          epoch: previousEpoch,
        });
        if (change === "attach") yield* sessions.set(session("third"));
        if (change === "replace") yield* sessions.set(session("previous", "replacement"));
        if (change === "clear") yield* sessions.clear(threadId, "previous");
        if (change === "finish turn") yield* sessions.clearToolResults(threadId, "previous");
        yield* sessions.recordToolResult(threadId, "delegate_task", input, activeResult, {
          providerSessionId: "active",
          epoch: activeEpoch,
        });
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", input, undefined, "active"),
          activeResult,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", input, undefined, "previous"),
          change === "attach" ? previousResult : undefined,
        );
        assert.deepEqual(yield* sessions.takeHtmlRender(threadId, page), reference);
        assert.equal(
          (yield* sessions.read(threadId, ProviderInstanceId.make("active")))?.providerSessionId,
          "active",
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect.each(["last session", "thread", "replace sole session"] as const)(
    "removes stale pending results when clearing %s",
    (cleanup) =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(session("active"));
        yield* sessions.recordHtmlRender(threadId, page, reference);
        if (cleanup === "last session") yield* sessions.clear(threadId, "active");
        if (cleanup === "thread") yield* sessions.clear(threadId);
        if (cleanup === "replace sole session")
          yield* sessions.set(session("active", "replacement"));
        assert.isUndefined(yield* sessions.takeHtmlRender(threadId, page));
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
