import {
  HttpQuotaRefreshResult,
  IsoDateTime,
  OrchestratorMcpFailure,
  ProviderConsumeResetCreditResult,
  ProviderInstanceId,
  RouterProvider,
  ThreadAccountError,
  ThreadAccountMarginInput,
  ThreadAccountUsage,
  ThreadId,
  TrimmedNonEmptyString,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: account usage and CLI Proxy quota-router controls, for agents. */
const UsageTool = Tool.make("t3_usage", {
  description:
    "Account usage and CLI Proxy routing. `read` (default): each account's quota windows (used %, reset), plan, subscription end and credits; each hub's steers, pins, holds, margins and ends; whether you may redeem resets (`agentsCanRedeemResetCredits`); and, for `threadId` (default: this thread), the account its next request uses (`next`; after a compaction, `afterCompaction`) and its `owner`. Read it before saying which account has quota. Pin a thread, or pace a low-importance one (it waits while usage is ahead of pace), with t3_thread_configure. `steer`: new threads go to `account` (email or alias); null with `provider` clears. `margin`: let a Claude thread use the router's spare headroom (`headroomScale` 0-1, null clears) until `until` (default 1h). `end`: declare `account`'s subscription end `endsAt` (null removes). `redeem`: spend a banked rate-limit reset on `instanceId` (native account) or `account` (hub account), with `creditId` when the reading lists `resetCreditOptions`. It cannot be undone: redeem only when the user asked or your standing instructions allow it. A hub's `quotaAccounts` are readings an HTTP quota source (Antigravity) takes only every few hours; check `ageMinutes` before trusting one. `refresh`: ask that source to read `accountId` of hub `sourceId` again now (only when `refreshable`; it runs the provider's CLI, so refresh only an old reading a decision depends on); `rate-limited` names `retryAt`.",
  parameters: Schema.Struct({
    action: Schema.optional(
      Schema.Literals(["read", "steer", "margin", "end", "redeem", "refresh"]),
    ),
    threadId: Schema.optional(ThreadId),
    account: Schema.optional(
      Schema.Union([
        TrimmedNonEmptyString,
        Schema.Null.annotate({ description: "Clear the steer for the named provider." }),
      ]),
    ),
    provider: Schema.optional(RouterProvider),
    headroomScale: Schema.optional(ThreadAccountMarginInput.fields.headroomScale),
    until: Schema.optional(IsoDateTime),
    endsAt: Schema.optional(
      Schema.Union([
        IsoDateTime,
        Schema.Null.annotate({ description: "Remove the account's declared subscription end." }),
      ]),
    ),
    instanceId: Schema.optional(ProviderInstanceId),
    creditId: Schema.optional(TrimmedNonEmptyString),
    sourceId: Schema.optional(UsageLimitSourceId),
    accountId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    ThreadAccountUsage,
    ProviderConsumeResetCreditResult,
    HttpQuotaRefreshResult,
    Schema.Struct({ done: Schema.Literal(true) }),
  ]),
  failure: Schema.Union([OrchestratorMcpFailure, ThreadAccountError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadAccountService.ThreadAccounts,
    UsageLimitSources.UsageLimitSources,
  ],
})
  .annotate(Tool.Title, "Account usage and routing")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const UsageToolkit = Toolkit.make(UsageTool);
