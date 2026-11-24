import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MessageSearch from "../../../orchestration-v2/MessageSearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { MessageSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MessageSearchToolkit, {
  t3_message_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const result = yield* (yield* MessageSearch.MessageSearch)
        .search({
          threadId: input.threadId,
          projectId: input.projectId,
          authors: input.authors,
          senderThreadId: input.senderThreadId,
          query: input.query,
          cursor: input.cursor,
          limit: input.limit ?? 20,
          maxChars: input.maxChars ?? 2000,
        })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "invalid_cursor"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
              : unavailable(),
          ),
        );
      return {
        ...result,
        matches: result.matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId, match.threadTitle),
        })),
      };
    }),
  ),
});
