import {
  ClaudeKeepWarmActionError,
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  type ClaudeKeepWarmActionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Fork: the composer actions for a turn the quota router holds to keep Claude's cache warm. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;

  const run = Effect.fn("ClaudeKeepWarmActions.run")(function* (input: ClaudeKeepWarmActionInput) {
    const { threadId } = input;
    const failWith = (cause: { readonly message: string }) =>
      new ClaudeKeepWarmActionError({ threadId, detail: cause.message });
    const stalled = yield* keepWarm.find(threadId);
    if (stalled === null) {
      return yield* new ClaudeKeepWarmActionError({
        threadId,
        detail: "This thread is no longer held to keep Claude's prompt cache warm.",
      });
    }
    const { session, turn } = stalled;
    switch (input.action) {
      case "release":
        yield* keepWarm.release(turn.session, turn.hold.resetAt).pipe(Effect.mapError(failWith));
        yield* session.show(turn, null);
        return;
      case "pause":
        yield* session.pause(turn, turn.hold).pipe(Effect.mapError(failWith));
        return;
      case "compact": {
        // No release: the proxy sends the compaction itself unheld to the warm account, which
        // reads the cache, and ends the stopped turn's hold. The held request never reached
        // Anthropic, so stopping loses no work. The small compacted context can move accounts.
        const compactId = `keep-warm-compact:${turn.runId}`;
        // Queue maintenance before releasing the turn, so a child wake cannot win the gap.
        yield* Effect.forEach(
          [
            {
              type: "message.dispatch",
              commandId: CommandId.make(compactId),
              messageId: MessageId.make(compactId),
              threadId,
              text: IDLE_COMPACTION_TEXT,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "server",
            },
            {
              type: "message.dispatch",
              commandId: CommandId.make(`keep-warm-continue:${turn.runId}`),
              messageId: MessageId.make(`keep-warm-continue:${turn.runId}`),
              threadId,
              afterCompactionMessageId: MessageId.make(compactId),
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "server",
            },
            {
              type: "run.interrupt",
              commandId: CommandId.make(`${compactId}:stop`),
              threadId,
              runId: turn.runId,
              preserveDelegatedTasks: true,
              reason: "Stopped to compact and continue on an account with quota.",
            },
          ] as const,
          (command) => orchestrator.dispatch(command).pipe(Effect.mapError(failWith)),
          { discard: true },
        );
      }
    }
  });

  return { run };
});
