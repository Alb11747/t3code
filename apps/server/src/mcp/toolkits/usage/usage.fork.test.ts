import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as UsageHandlers from "./handlers.ts";
import { UsageToolkit } from "./tools.ts";

const threadId = ThreadId.make("usage-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("usage-environment"),
  requestNamespace: "usage-session",
  thread: {
    threadId,
    providerSessionId: "usage-session",
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
  clientInfo: { name: "usage", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "usage", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (args: object, capabilities = scope.capabilities) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_usage", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, capabilities }),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const failureCode = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text).code : undefined;
};

const layer = (runtimeMode: RuntimeMode, steers: Array<unknown>) =>
  McpHttpServer.toolkitRegistration(UsageToolkit, UsageHandlers.layer).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode })),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadAccountService.ThreadAccounts, {
        ...ThreadAccountService.ThreadAccounts.defaultValue(),
        steer: (input) => Effect.sync(() => void steers.push(input)),
      }),
    ),
  );

it.effect("steers only for a full-access caller and reads only with orchestration", () => {
  const steers: Array<unknown> = [];
  const account = "account-2222222222222222";
  return Effect.gen(function* () {
    expect(failureCode(yield* call({}, new Set<never>()))).toBe("capability_denied");
    const result = yield* call({ action: "steer", account });
    expect(result.isError).not.toBe(true);
    expect(steers).toEqual([{ account }]);
  }).pipe(
    Effect.provide(layer("full-access", steers)),
    Effect.andThen(
      Effect.gen(function* () {
        expect(failureCode(yield* call({ action: "steer", account }))).toBe("capability_denied");
        expect(steers).toHaveLength(1);
      }).pipe(Effect.provide(layer("approval-required", steers))),
    ),
  );
});
