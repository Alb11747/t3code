import * as Effect from "effect/Effect";

import * as ClaudeKeepWarmActions from "../../../orchestration-v2/ClaudeKeepWarmActions.ts";
import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { StallToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const keepWarmActions = yield* ClaudeKeepWarmActions.make;
  const threadAccounts = yield* ThreadAccountService.ThreadAccounts;
  return {
    t3_thread_stall_action: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      // Same grant as the client RPC's operate scope: a credential that can control threads.
      (input) =>
        Effect.gen(function* () {
          yield* readCaller();
          if (input.action === "switch" && input.account !== undefined) {
            // Stops the held turn and continues it on that account.
            yield* threadAccounts.set({
              threadId: input.threadId,
              account: input.account,
              ...(input.dropThinking === undefined ? {} : { dropThinking: input.dropThinking }),
            });
          } else {
            yield* keepWarmActions.run({ threadId: input.threadId, action: input.action });
          }
          return { threadId: input.threadId, action: input.action };
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof StallToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(StallToolkit, make);
