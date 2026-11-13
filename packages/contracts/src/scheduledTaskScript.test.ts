import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationOperateScope, AuthTerminalOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("scheduled task script permissions", () => {
  it.each([
    [{ title: "Rename" }, [AuthOrchestrationOperateScope]],
    [{ script: undefined }, [AuthOrchestrationOperateScope]],
    [{ script: "return true;" }, [AuthOrchestrationOperateScope, AuthTerminalOperateScope]],
    [{ script: null }, [AuthOrchestrationOperateScope, AuthTerminalOperateScope]],
    [{ resetScriptState: true }, [AuthOrchestrationOperateScope, AuthTerminalOperateScope]],
  ])("an upsert of %j needs %j", (input, scopes) => {
    expect(clientRpcRequiredScopes(WS_METHODS.scheduledTasksUpsert, input)).toEqual(scopes);
  });

  it("a dry run needs terminal access", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.scheduledTasksTestScript, {})).toEqual([
      AuthTerminalOperateScope,
    ]);
  });
});
