import {
  ClaudeKeepWarmAction,
  ClaudeKeepWarmActionError,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: the keep-warm stall banner's actions, for agents. */
const ThreadStallActionTool = Tool.make("t3_thread_stall_action", {
  description:
    "Act on a thread whose `stalled.kind` is `keep_warm` (t3_thread_list/read): its Claude turn runs about one step per hour until `resetAt` to keep its prompt cache warm. Waiting is free. `release`: run at full speed on the nearly exhausted account until `resetAt`, which may hit the limit; `restore` undoes it. `switch`: move to another account, which rewrites the full context cache once (about one uncached prompt). `compact`: stop, compact on the warm account, continue; best for a long conversation that must go on now. `pause`: end the turn as a usage limit that resumes at `resetAt`. To snooze instead, use t3_thread_organize.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    action: ClaudeKeepWarmAction,
  }),
  success: Schema.Struct({ threadId: ThreadId, action: ClaudeKeepWarmAction }),
  failure: Schema.Union([OrchestratorMcpFailure, ClaudeKeepWarmActionError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Orchestrator.OrchestratorV2,
  ],
})
  .annotate(Tool.Title, "Act on a stalled thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const StallToolkit = Toolkit.make(ThreadStallActionTool);
