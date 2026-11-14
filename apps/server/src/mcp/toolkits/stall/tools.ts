import {
  ClaudeKeepWarmAction,
  ClaudeKeepWarmActionError,
  OrchestratorMcpFailure,
  ThreadAccountError,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";

/** Fork: the keep-warm stall banner's actions, for agents. */
const ThreadStallActionTool = Tool.make("t3_thread_stall_action", {
  description:
    "Act on a thread whose `stalled.kind` is `keep_warm` (t3_thread_list/read): its Claude turn runs about one step per hour until `resetAt` to keep its prompt cache warm. Waiting is free. `release`: run at full speed on the nearly exhausted account until `resetAt`, which may hit the limit; `restore` undoes it. `switch`: move to another account, which rewrites the full context cache once (about one uncached prompt); `account` picks it (email or alias), and an account-bound conversation also needs `dropThinking: true`. `compact`: stop, compact on the warm account, continue; best for a long conversation that must go on now. `pause`: end the turn as a usage limit that resumes at `resetAt`. To snooze instead, use t3_thread_organize. With `accountHold` instead, the thread waits for its account: `switch` with `account` moves the held request now (automatic: t3_thread_configure `account: null`), `stop_waiting` keeps the account but falls back now, `pause` as above.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    action: ClaudeKeepWarmAction,
    account: Schema.optional(TrimmedNonEmptyString),
    dropThinking: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ threadId: ThreadId, action: ClaudeKeepWarmAction }),
  failure: Schema.Union([OrchestratorMcpFailure, ClaudeKeepWarmActionError, ThreadAccountError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Orchestrator.OrchestratorV2,
    ThreadAccountService.ThreadAccounts,
  ],
})
  .annotate(Tool.Title, "Act on a stalled thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const StallToolkit = Toolkit.make(ThreadStallActionTool);
