import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseIssueUrl } from "../../../issueWatch/issueWatchReport.ts";
import { inactive, IssueWatchService } from "../../../issueWatch/IssueWatchService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
} from "../pullRequests/tools.ts";
import {
  type IssueTargetInput,
  IssueUrlInvalidError,
  IssueWatchFailedError,
  IssueWatchFromSubagentError,
  IssuesToolkit,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const issueWatches = yield* IssueWatchService;

  const resolve = Effect.fn("IssuesToolkit.resolve")(function* (input: IssueTargetInput) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId: ThreadId | undefined = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new PullRequestThreadRequiredError();
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((cause) => new IssueWatchFailedError({ detail: cause.message, cause })),
      );
    if (thread === null || thread.deletedAt !== null) {
      return yield* new PullRequestThreadNotFoundError({ threadId });
    }
    const parsed = parseIssueUrl(input.url);
    if (parsed.kind === "pull-request") {
      return yield* new IssueUrlInvalidError({
        detail: "This is a pull request URL. Call watch_pull_request instead.",
      });
    }
    if (parsed.kind === "invalid") {
      return yield* new IssueUrlInvalidError({
        detail: "Pass a GitHub issue URL such as https://github.com/owner/repo/issues/123.",
      });
    }
    return { thread, issue: { ...parsed.issue, url: parsed.url } };
  });

  const failed = Effect.mapError(
    (error: { readonly message: string }) =>
      new IssueWatchFailedError({ detail: error.message, cause: error }),
  );

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    watch_issue: writesThread((input) =>
      Effect.gen(function* () {
        const { thread, issue } = yield* resolve(input);
        if (thread.lineage.relationshipToParent === "subagent") {
          return yield* new IssueWatchFromSubagentError();
        }
        if (inactive(thread)) {
          return yield* new IssueWatchFailedError({
            detail: `Thread ${thread.id} is settled or archived, so it cannot watch issues.`,
          });
        }
        return yield* issueWatches.watch(thread.id, issue).pipe(failed);
      }),
    ),
    unwatch_issue: writesThread((input) =>
      Effect.gen(function* () {
        const { thread, issue } = yield* resolve(input);
        return yield* issueWatches.unwatch(thread.id, issue).pipe(failed);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssuesToolkit, make);
