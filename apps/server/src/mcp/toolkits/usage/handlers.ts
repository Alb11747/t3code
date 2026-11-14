import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadAccountService from "../../../usage/ThreadAccountService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, readThread } from "../../threadAccess.ts";
import { UsageToolkit } from "./tools.ts";

const missing = (name: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `This action needs \`${name}\`.`,
  });

const make = Effect.gen(function* () {
  const accounts = yield* ThreadAccountService.ThreadAccounts;
  const done = { done: true } as const;
  return {
    t3_usage: McpToolAccess.either(
      (input) => (input.action ?? "read") === "read",
      McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          yield* readCaller();
          const scope = yield* McpInvocationContext.McpInvocationContext;
          if (input.threadId === undefined && scope.thread === undefined) {
            return yield* accounts.usage({});
          }
          const { projection } = yield* readThread(input.threadId);
          return yield* accounts.usage({ threadId: projection.thread.id });
        }),
      ),
      McpToolAccess.either(
        (input) => input.action === "margin",
        // A margin override changes one thread's routing, like pinning it.
        McpToolAccess.writesThreads(
          (input) => [input.threadId],
          (input) =>
            Effect.gen(function* () {
              if (input.headroomScale === undefined) return yield* missing("headroomScale");
              const { projection } = yield* readThread(input.threadId);
              yield* accounts.margin({
                threadId: projection.thread.id,
                headroomScale: input.headroomScale,
                ...(input.until === undefined ? {} : { until: input.until }),
              });
              return done;
            }),
        ),
        // Steers, ends and redemptions act on accounts every thread shares, not on one thread.
        McpToolAccess.writes(
          (input) =>
            Effect.gen(function* () {
              if (input.action === "redeem") {
                // Plan mode makes no lasting changes, and a redeemed reset cannot be undone.
                if ((yield* readCaller()).limits.interactionMode === "plan") {
                  return yield* new OrchestratorMcpFailure({
                    code: "interaction_mode_escalation_denied",
                    message: "A plan-mode thread cannot redeem reset credits.",
                  });
                }
                const credit = input.creditId === undefined ? {} : { creditId: input.creditId };
                if (input.instanceId !== undefined) {
                  return yield* accounts.redeem({ instanceId: input.instanceId, ...credit });
                }
                if (!input.account) {
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "This action needs `instanceId` or `account`.",
                  });
                }
                return yield* accounts.redeem({ account: input.account, ...credit });
              }
              if (input.action === "end") {
                if (!input.account) return yield* missing("account");
                if (input.endsAt === undefined) return yield* missing("endsAt");
                yield* accounts.end({ account: input.account, endsAt: input.endsAt });
                return done;
              }
              if (input.account === undefined) return yield* missing("account");
              yield* accounts.steer({
                account: input.account,
                ...(input.provider === undefined ? {} : { provider: input.provider }),
              });
              return done;
            }),
          { linkedCallers: { refused: "change this environment's accounts" } },
        ),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof UsageToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(UsageToolkit, make);
