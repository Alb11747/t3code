import {
  IsoDateTime,
  MessageId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as MessageSearch from "../../../orchestration-v2/MessageSearch.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: messages by author across threads, with a cursor callers save to read only newer ones. */
const MessageSearchTool = Tool.make("t3_message_search", {
  description:
    "Messages in the order T3 stored them, oldest first, in one thread (`threadId`), one project, or all, including subagent and archived threads. `authors`: user (a person typed it), agent (another agent or T3's tools; `senderThreadId` narrows to one sender), scheduled_task, assistant (the thread's own agent). `query`: text it contains. Save `nextCursor` and pass it as `cursor` later to get only messages stored since. `more`: call again now.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    authors: Schema.optional(Schema.Array(MessageSearch.MessageAuthor)),
    senderThreadId: Schema.optional(ThreadId),
    query: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(clampedPositiveInt(100)),
    maxChars: Schema.optional(clampedPositiveInt(16000)),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({
        messageId: MessageId,
        threadId: ThreadId,
        projectId: ProjectId,
        threadTitle: Schema.String,
        link: Schema.String,
        author: MessageSearch.MessageAuthor,
        senderThreadId: Schema.optional(ThreadId),
        scheduledTaskId: Schema.optional(ScheduledTaskId),
        createdAt: IsoDateTime,
        text: Schema.String,
        truncated: Schema.Boolean,
      }),
    ),
    nextCursor: Schema.String,
    more: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MessageSearch.MessageSearch,
  ],
})
  .annotate(Tool.Title, "Search messages by author")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MessageSearchToolkit = Toolkit.make(MessageSearchTool);
