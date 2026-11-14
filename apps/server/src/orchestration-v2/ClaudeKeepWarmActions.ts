import {
  ClaudeKeepWarmActionError,
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  type ClaudeKeepWarmActionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ClaudeKeepWarm from "../provider/ClaudeKeepWarm.ts";
import * as ThreadAccountService from "../usage/ThreadAccountService.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * Fork: the composer actions for a turn the quota router holds, to keep Claude's cache warm or
 * because the thread's pin waits for its account.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
  const threadAccounts = yield* ThreadAccountService.ThreadAccounts;

  const run = Effect.fn("ClaudeKeepWarmActions.run")(function* (input: ClaudeKeepWarmActionInput) {
    const { threadId } = input;
    const failWith = (cause: { readonly message: string }) =>
      new ClaudeKeepWarmActionError({ threadId, detail: cause.message });
    const stalled = yield* keepWarm.find(threadId);
    if (stalled?.turn.hold.kind === "pin") return yield* runPinHold(input, stalled, failWith);
    if (input.action === "stop_waiting") {
      return yield* new ClaudeKeepWarmActionError({
        threadId,
        detail: "This thread is not waiting for its chosen account.",
      });
    }
    // A released hold only takes `restore`; a live one takes everything else.
    if (
      stalled === null ||
      (stalled.turn.hold.released === true) !== (input.action === "restore")
    ) {
      return yield* new ClaudeKeepWarmActionError({
        threadId,
        detail:
          input.action === "restore"
            ? "This thread's turn was not released from keep-warm holds."
            : "This thread is no longer held to keep Claude's prompt cache warm.",
      });
    }
    const { session, turn } = stalled;
    switch (input.action) {
      case "release":
        // Marked first: the released request's response can end the notice before the router
        // answers, and an ended notice can no longer take the mark.
        yield* session.show(turn, { ...turn.hold, released: true });
        yield* keepWarm.release(turn.session, turn.hold.resetAt).pipe(
          Effect.tapError(() =>
            session.restore(turn).pipe(Effect.andThen(session.show(turn, turn.hold))),
          ),
          Effect.mapError(failWith),
        );
        return;
      case "switch":
        yield* keepWarm
          .release(turn.session, turn.hold.resetAt, true)
          .pipe(Effect.mapError(failWith));
        yield* session.show(turn, null);
        return;
      case "restore":
        yield* keepWarm.release(turn.session, null).pipe(Effect.mapError(failWith));
        yield* session.restore(turn);
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

  // The router re-places a held request as soon as its pin changes, so nothing here stops the turn.
  const runPinHold = Effect.fn("ClaudeKeepWarmActions.runPinHold")(function* (
    input: ClaudeKeepWarmActionInput,
    stalled: NonNullable<Effect.Success<ReturnType<typeof keepWarm.find>>>,
    failWith: (cause: { readonly message: string }) => ClaudeKeepWarmActionError,
  ) {
    const { threadId } = input;
    const { session, turn } = stalled;
    const refuse = (detail: string) =>
      Effect.fail(new ClaudeKeepWarmActionError({ threadId, detail }));
    switch (input.action) {
      case "release":
      case "stop_waiting": {
        // Keeps the held account, so the thread still prefers it; for a pin T3 did not set, T3
        // now stores that account as its own thread's choice.
        const stored =
          turn.hold.account === undefined
            ? yield* orchestrator.getThreadRecords(threadId, []).pipe(
                Effect.map((records) => records.thread.accountChoice ?? null),
                Effect.mapError(failWith),
              )
            : null;
        const account =
          turn.hold.account ??
          (stored ? (yield* threadAccounts.describeChoice(stored)).account : undefined);
        if (account === undefined) {
          return yield* refuse("The router did not say which account this thread waits for.");
        }
        yield* threadAccounts.set({ threadId, account, stall: false }).pipe(
          // The agent's dropThinking confirmation has no place here; the picker asks for it.
          Effect.mapError((error) =>
            error.requiresDropThinking === true
              ? new ClaudeKeepWarmActionError({
                  threadId,
                  detail:
                    "Another account owns this conversation, so falling back would drop its earlier thinking. Use Switch account to move it; it asks first.",
                })
              : failWith(error),
          ),
        );
        return;
      }
      case "pause":
        if (turn.hold.resetUnknown === true) {
          return yield* refuse(
            "The router does not know when this account resets. Switch accounts or stop waiting instead.",
          );
        }
        yield* session.pause(turn, turn.hold).pipe(Effect.mapError(failWith));
        return;
      case "switch":
        return yield* refuse(
          "Choose the account to switch to: pick one in the account picker, or pass `account`.",
        );
      case "restore":
        return yield* refuse("This thread waits for its chosen account; it was not released.");
      case "compact":
        return yield* refuse(
          "This thread waits for its chosen account, which is out, so a compaction would wait too. Switch accounts or stop waiting instead.",
        );
    }
  });

  return { run };
});
