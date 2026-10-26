import type { PromptSuggestion, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface PromptSuggestionChange {
  readonly threadId: ThreadId;
  readonly suggestion: PromptSuggestion | null;
}

// Provider sessions can outlive a provider switch, so late predictions need run ownership.
// Adapters and WebSocket routes must share the live layer reference to share its map.
export class PromptSuggestions extends Context.Reference<{
  readonly claim: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly publish: (threadId: ThreadId, suggestion: PromptSuggestion) => Effect.Effect<void>;
  readonly clear: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly stream: (threadId: ThreadId) => Stream.Stream<PromptSuggestion | null>;
}>("t3/provider/PromptSuggestions", {
  defaultValue: () => ({
    claim: () => Effect.void,
    publish: () => Effect.void,
    clear: () => Effect.void,
    stream: () => Stream.make(null),
  }),
}) {}

export const make = Effect.gen(function* () {
  const threads = new Map<
    ThreadId,
    { readonly runId: RunId; readonly suggestion: PromptSuggestion | null }
  >();
  const changes = yield* PubSub.unbounded<PromptSuggestionChange>();

  const set = Effect.fn("PromptSuggestions.set")(function* (
    threadId: ThreadId,
    runId: RunId | null,
    suggestion: PromptSuggestion | null,
  ) {
    const existing = threads.get(threadId)?.suggestion ?? null;
    if (runId === null) {
      threads.delete(threadId);
    } else {
      threads.set(threadId, { runId, suggestion });
    }
    if (existing?.id === suggestion?.id) return;
    yield* PubSub.publish(changes, { threadId, suggestion });
  });

  const claim: (typeof PromptSuggestions.Service)["claim"] = (threadId, runId) =>
    set(threadId, runId, null);

  const publish: (typeof PromptSuggestions.Service)["publish"] = (threadId, suggestion) =>
    Effect.suspend(() =>
      threads.get(threadId)?.runId === suggestion.runId
        ? set(threadId, suggestion.runId, suggestion)
        : Effect.void,
    );

  const clear: (typeof PromptSuggestions.Service)["clear"] = (threadId, runId) =>
    Effect.suspend(() =>
      threads.get(threadId)?.runId === runId ? set(threadId, null, null) : Effect.void,
    );

  /**
   * One-slot sliding mailbox per subscriber: each value replaces the last, so
   * a slow socket only ever holds the current suggestion.
   */
  const stream: (typeof PromptSuggestions.Service)["stream"] = (threadId) =>
    Stream.callback<PromptSuggestion | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = threads.get(threadId)?.suggestion ?? null;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId === threadId) Queue.offerUnsafe(mailbox, change.suggestion);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return { claim, publish, clear, stream } satisfies typeof PromptSuggestions.Service;
});

export const layer = Layer.effect(PromptSuggestions, make);
