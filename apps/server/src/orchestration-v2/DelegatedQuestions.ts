import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

interface PendingQuestion {
  readonly requestId: RuntimeRequestId;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

/**
 * Questions a thread is blocked on that an answer can still resume. A question
 * is readable only once both its runtime request and its turn item exist, and
 * adapters record those in either order.
 */
export const pendingQuestions = (
  records: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<PendingQuestion> =>
  records.runtimeRequests.flatMap((request) => {
    if (
      request.kind !== "user_input" ||
      request.status !== "pending" ||
      request.responseCapability.type === "not_resumable"
    ) {
      return [];
    }
    const item = records.turnItems.findLast(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === request.id,
    );
    return item?.type === "user_input_request"
      ? [{ requestId: request.id, questions: item.questions }]
      : [];
  });

const questionThreadId = (event: OrchestrationV2DomainEvent): ThreadId | undefined =>
  (event.type === "runtime-request.updated" &&
    event.payload.kind === "user_input" &&
    event.payload.status === "pending") ||
  (event.type === "turn-item.updated" && event.payload.type === "user_input_request")
    ? event.threadId
    : undefined;

const taskLabel = (task: OrchestrationV2Subagent) =>
  task.title?.trim() || task.prompt.trim().slice(0, 80);

/** The notification that hands one child question to the parent agent. */
export const questionNotification = (
  parentThreadId: ThreadId,
  task: OrchestrationV2Subagent,
  childThreadId: ThreadId,
  question: PendingQuestion,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> => {
  const lines = question.questions.flatMap((entry) => [
    `- ${entry.id}: ${entry.question}`,
    ...entry.options.map(
      (option) =>
        `  - ${option.value ?? option.label}${option.value === undefined ? "" : ` (${option.label})`}: ${option.description}`,
    ),
  ]);
  return {
    type: "message.dispatch",
    // Stable per request, so relaying the same question again is a no-op.
    commandId: CommandId.make(`server:delegated-question:${question.requestId}`),
    threadId: parentThreadId,
    messageId: MessageId.make(`message:delegated-question:${question.requestId}`),
    text: [
      `Delegated task "${taskLabel(task)}" (taskId ${task.id}) is waiting on a question:`,
      ...lines,
      `Answer with t3_pending_request_respond({threadId: "${childThreadId}", requestId: "${question.requestId}", answers}), keying answers by question id with an option value or your own text. Ask the user instead when the decision is theirs. If the request is no longer pending, it was already answered.`,
    ].join("\n"),
    notification: {
      source: { kind: "delegated_task", taskIds: [task.id], childThreadId },
      outcome: "updated",
      summary: `Delegated task "${taskLabel(task)}" asked a question`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
};

/**
 * Relays questions from T3-owned delegated children to their parent agent as a
 * notification, steered into a running turn where the provider can take it
 * without interrupting tools. A parent blocked in delegate_task(mode="wait")
 * gets the question as that call's result instead, so its task is skipped
 * until the wait gives up delivery. The user still sees and can answer every
 * question; whoever answers first wins.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const relay = Effect.fn("DelegatedQuestions.relay")(function* (childThreadId: ThreadId) {
    const child = yield* orchestrator.getThreadRecords(
      childThreadId,
      ["runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request"] },
    );
    const { parentThreadId, relationshipToParent } = child.thread.lineage;
    if (relationshipToParent !== "subagent" || parentThreadId === null) return;
    const questions = pendingQuestions(child);
    if (questions.length === 0) return;
    const parent = yield* orchestrator.getThreadRecords(parentThreadId, ["subagents"]);
    const task = parent.subagents.find(
      (candidate) => candidate.origin === "app_owned" && candidate.childThreadId === childThreadId,
    );
    if (task === undefined || task.completionWake === "settled_only") return;
    if (parent.thread.archivedAt !== null) return;
    yield* Effect.forEach(
      questions,
      (question) =>
        orchestrator.dispatch(questionNotification(parentThreadId, task, childThreadId, question)),
      { discard: true },
    );
  });

  const start = () =>
    forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const threadId = questionThreadId(event);
        return threadId === undefined
          ? Effect.void
          : relay(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("delegated question relay failed", { threadId, cause }),
              ),
            );
      }),
    );

  return { relay, start };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((relay) => relay.start())));
