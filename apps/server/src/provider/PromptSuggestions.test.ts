import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as PromptSuggestions from "./PromptSuggestions.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const runId = RunId.make("run-1");
const newerRunId = RunId.make("run-2");
const suggestion = { id: "suggestion-1", runId, text: "Add a regression test" };
const newerSuggestion = { id: "suggestion-3", runId: newerRunId, text: "Ship it" };

const current = (suggestions: Effect.Success<typeof PromptSuggestions.make>) =>
  suggestions.stream(threadId).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([v]) => v),
  );

describe("PromptSuggestions", () => {
  it.effect("sends a late subscriber the current suggestion", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.claim(threadId, runId);
      yield* suggestions.publish(threadId, suggestion);

      expect(yield* current(suggestions)).toEqual(suggestion);
    }),
  );

  it.effect("streams a thread's own changes until its suggestion is cleared", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.claim(threadId, runId);
      yield* suggestions.claim(otherThreadId, runId);
      yield* suggestions.publish(threadId, suggestion);
      const collected = yield* suggestions.stream(threadId).pipe(
        Stream.takeUntil((value) => value === null),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* suggestions.publish(otherThreadId, { id: "suggestion-2", runId, text: "Elsewhere" });
      yield* suggestions.clear(threadId, runId);

      const values = yield* Fiber.join(collected);
      expect(values.at(-1)).toBeNull();
      expect(values.some((value) => value?.id === "suggestion-2")).toBe(false);
    }),
  );

  it.effect("ignores a superseded run's late suggestion and cleanup", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.claim(threadId, runId);
      yield* suggestions.claim(threadId, newerRunId);
      yield* suggestions.publish(threadId, newerSuggestion);

      yield* suggestions.publish(threadId, suggestion);
      yield* suggestions.clear(threadId, runId);
      expect(yield* current(suggestions)).toEqual(newerSuggestion);

      yield* suggestions.clear(threadId, newerRunId);
      expect(yield* current(suggestions)).toBeNull();
      // Clearing ends the claim, so a prediction still in flight is dropped.
      yield* suggestions.publish(threadId, newerSuggestion);
      expect(yield* current(suggestions)).toBeNull();
    }),
  );

  it.effect("clears the previous suggestion when a newer run claims the thread", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.claim(threadId, runId);
      yield* suggestions.publish(threadId, suggestion);
      yield* suggestions.claim(threadId, newerRunId);

      expect(yield* current(suggestions)).toBeNull();
    }),
  );
});
