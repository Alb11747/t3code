import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import { IssueWatchService } from "../../../issueWatch/IssueWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
} from "../pullRequests/tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  IssueWatchService,
];

export const IssueTargetInput = Schema.Struct({
  threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
  url: TrimmedNonEmptyString.annotate({ description: "GitHub issue URL." }),
});
export type IssueTargetInput = typeof IssueTargetInput.Type;

export class IssueUrlInvalidError extends Schema.TaggedError<IssueUrlInvalidError>()(
  "IssueUrlInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class IssueWatchFromSubagentError extends Schema.TaggedError<IssueWatchFromSubagentError>()(
  "IssueWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch issues. Finish your task and report back instead.";
  }
}

export class IssueWatchFailedError extends Schema.TaggedError<IssueWatchFailedError>()(
  "IssueWatchFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export const IssueToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  PullRequestThreadRequiredError,
  PullRequestThreadNotFoundError,
  IssueUrlInvalidError,
  IssueWatchFromSubagentError,
  IssueWatchFailedError,
]);

export const WatchIssueResult = Schema.Struct({
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  watching: Schema.Boolean,
  wasWatching: Schema.Boolean,
});

const WatchIssueTool = Tool.make("watch_issue", {
  description:
    "Watch an open GitHub issue for this thread. T3 wakes you on new comments from others and when it closes. Handle existing comments first. After this call, end your turn. The watch stays on after each wake.",
  parameters: IssueTargetInput,
  success: WatchIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const UnwatchIssueTool = Tool.make("unwatch_issue", {
  description: "Stop watching a GitHub issue for this thread.",
  parameters: IssueTargetInput,
  success: WatchIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

export const IssuesToolkit = Toolkit.make(WatchIssueTool, UnwatchIssueTool);
