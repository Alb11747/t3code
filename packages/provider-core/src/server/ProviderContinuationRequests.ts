import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/**
 * Moves the thread's queued agent updates into `runId`, the provider's running turn, and returns
 * their text for the provider to deliver at a tool boundary. Updates it does not return stay queued.
 */
export type ClaimAgentMessages = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) => Effect.Effect<ReadonlyArray<string>>;

/**
 * The default reference drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
  readonly claimAgentMessages?: ClaimAgentMessages;
  /** Installs the worker's claim; until then nothing is claimed and updates start the next turn. */
  readonly serveAgentMessages?: (claim: ClaimAgentMessages) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    const claim = yield* Ref.make<ClaimAgentMessages>(() => Effect.succeed([]));
    return {
      offer: (request: ProviderContinuationRequest) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
      claimAgentMessages: (input) => Ref.get(claim).pipe(Effect.flatMap((serve) => serve(input))),
      serveAgentMessages: (serve) => Ref.set(claim, serve),
    };
  }),
);
