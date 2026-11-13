import * as Effect from "effect/Effect";

import * as ClaudeKeepWarmActions from "../../../orchestration-v2/ClaudeKeepWarmActions.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { StallToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const keepWarmActions = yield* ClaudeKeepWarmActions.make;
  return {
    t3_thread_stall_action: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      // Same grant as the client RPC's operate scope: a credential that can control threads.
      (input) => readCaller().pipe(Effect.andThen(keepWarmActions.run(input)), Effect.as(input)),
    ),
  } satisfies McpToolAccess.Handlers<typeof StallToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(StallToolkit, make);
