import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
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

/** A queued update handed to the provider; its text carries `id` so the saved copy is unique. */
export interface AgentMessageOffer {
  readonly id: string;
  readonly queuedRunId: RunId;
  readonly text: string;
}

/**
 * Offers the thread's queued agent updates to `runId`, the provider's running turn, for delivery at
 * a tool boundary. Offered updates stay queued, and nothing starts them, until a receipt joins them.
 */
export type ClaimAgentMessages = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  /** The hook's own provider turn; an offer to any other turn of the run is refused. */
  readonly providerTurnId: ProviderTurnId;
}) => Effect.Effect<ReadonlyArray<AgentMessageOffer>>;

/** Joins offers to their turn once the provider has saved them in its own session history. */
export type AcknowledgeAgentMessages = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly offers: ReadonlyArray<AgentMessageOffer>;
}) => Effect.Effect<void>;

interface AgentMessageDelivery {
  readonly claim: ClaimAgentMessages;
  readonly acknowledge: AcknowledgeAgentMessages;
}

/**
 * The default reference drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
  readonly claimAgentMessages?: ClaimAgentMessages;
  readonly acknowledgeAgentMessages?: AcknowledgeAgentMessages;
  /** Installs the worker's delivery; until then nothing is claimed and updates start the next turn. */
  readonly serveAgentMessages?: (delivery: AgentMessageDelivery) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    const delivery = yield* Ref.make<AgentMessageDelivery>({
      claim: () => Effect.succeed([]),
      acknowledge: () => Effect.void,
    });
    return {
      offer: Effect.fn("ProviderContinuationRequests.offer")(function (
        request: ProviderContinuationRequest,
      ) {
        return Queue.offer(queue, request).pipe(Effect.asVoid);
      }),
      take: Queue.take(queue),
      claimAgentMessages: Effect.fn("ProviderContinuationRequests.claimAgentMessages")((input) =>
        Ref.get(delivery).pipe(Effect.flatMap((served) => served.claim(input))),
      ),
      acknowledgeAgentMessages: Effect.fn("ProviderContinuationRequests.acknowledgeAgentMessages")(
        (input) => Ref.get(delivery).pipe(Effect.flatMap((served) => served.acknowledge(input))),
      ),
      serveAgentMessages: Effect.fn("ProviderContinuationRequests.serveAgentMessages")((served) =>
        Ref.set(delivery, served),
      ),
    };
  }),
);
