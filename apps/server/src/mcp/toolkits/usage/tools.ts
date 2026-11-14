import {
  IsoDateTime,
  OrchestratorMcpFailure,
  RouterAccountAlias,
  RouterProvider,
  ThreadAccountError,
  ThreadAccountMarginInput,
  ThreadAccountUsage,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: account usage and CLI Proxy quota-router controls, for agents. */
const UsageTool = Tool.make("t3_usage", {
  description:
    "Account usage and CLI Proxy routing. `read` (default): each account's quota windows (used %, reset), plan, subscription end and credits; each hub's steers, pins, holds, margins and ends; and, for `threadId` (default: this thread), the account its next request uses (`next`) and its `owner`. Read it before saying which account has quota. Pin a thread with t3_thread_configure. `steer`: new threads go to `account`; null with `provider` clears. `margin`: let a Claude thread use the router's spare headroom (`headroomScale` 0-1, null clears) until `until` (default 1h). `end`: declare `account`'s subscription end `endsAt` (null removes).",
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["read", "steer", "margin", "end"])),
    threadId: Schema.optional(ThreadId),
    account: Schema.optional(Schema.NullOr(RouterAccountAlias)),
    provider: Schema.optional(RouterProvider),
    headroomScale: Schema.optional(ThreadAccountMarginInput.fields.headroomScale),
    until: Schema.optional(IsoDateTime),
    endsAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  }),
  success: Schema.Union([ThreadAccountUsage, Schema.Struct({ done: Schema.Literal(true) })]),
  failure: Schema.Union([OrchestratorMcpFailure, ThreadAccountError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadAccountService.ThreadAccounts,
  ],
})
  .annotate(Tool.Title, "Account usage and routing")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const UsageToolkit = Toolkit.make(UsageTool);
