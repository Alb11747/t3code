import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type ClaudeKeepWarmHold,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ClaudeKeepWarm from "../../../provider/ClaudeKeepWarm.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as StallHandlers from "./handlers.ts";
import { StallToolkit } from "./tools.ts";

const threadId = ThreadId.make("stall-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("stall-environment"),
  requestNamespace: "stall-session",
  thread: {
    threadId,
    providerSessionId: "stall-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "stall", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stall", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const hold: ClaudeKeepWarmHold = {
  resetAt: "2026-11-13T12:00:00.000Z",
  releaseAt: "2026-11-13T11:00:00.000Z",
};

const call = (args: object, capabilities = scope.capabilities) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: "t3_thread_stall_action", arguments: args }),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, capabilities }),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const layer = (held: boolean, released: Array<[string, string | null]>) =>
  McpHttpServer.toolkitRegistration(StallToolkit, StallHandlers.layer).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
    Layer.provide(
      Layer.succeed(ClaudeKeepWarm.ClaudeKeepWarm, {
        register: () => Effect.void,
        find: () =>
          Effect.succeed(
            held
              ? {
                  session: {
                    turn: Effect.succeed(null),
                    show: () => Effect.void,
                    restore: () => Effect.void,
                    pause: () => Effect.void,
                  },
                  turn: {
                    threadId,
                    runId: RunId.make("stall-run"),
                    providerTurnId: ProviderTurnId.make("stall-turn"),
                    session: "native-session",
                    hold,
                  },
                }
              : null,
          ),
        release: (session, until) => Effect.sync(() => void released.push([session, until])),
      }),
    ),
  );

it.effect("releases a held thread through the keep-warm actions", () => {
  const released: Array<[string, string | null]> = [];
  return Effect.gen(function* () {
    const result = yield* call({ threadId, action: "release" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ threadId, action: "release" });
    expect(released).toEqual([["native-session", hold.resetAt]]);
  }).pipe(Effect.provide(layer(true, released)));
});

it.effect("reports a thread that is not held and refuses clients without orchestration", () =>
  Effect.gen(function* () {
    expect(declaredFailure(yield* call({ threadId, action: "compact" }))).toMatchObject({
      _tag: "ClaudeKeepWarmActionError",
      detail: "This thread is no longer held to keep Claude's prompt cache warm.",
    });
    expect(
      declaredFailure(yield* call({ threadId, action: "pause" }, new Set<never>())),
    ).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layer(false, []))),
);
