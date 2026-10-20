import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

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
  it.effect.each(["attach", "replace", "clear"] as const)(
    "preserves another provider's pending result when a provider is changed: %s",
    (change) =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(session("previous"));
        yield* sessions.set(session("active"));
        yield* sessions.recordHtmlRender(threadId, page, reference);
        if (change === "attach") yield* sessions.set(session("third"));
        if (change === "replace") yield* sessions.set(session("previous", "replacement"));
        if (change === "clear") yield* sessions.clear(threadId, "previous");
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
