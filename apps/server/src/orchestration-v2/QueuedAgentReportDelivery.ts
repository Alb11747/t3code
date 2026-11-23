import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  withMessageSenderNote,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { queuedAgentReportBatch } from "./QueuedRunOrder.ts";

export function queuedRunCancellationEvents(
  projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">,
  run: OrchestrationV2Run,
  now: DateTime.Utc,
): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> {
  const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId);
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [
    {
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
    },
  ];
  if (attempt !== undefined && rootNode !== undefined) {
    events.push({
      type: "run-attempt.updated",
      threadId: run.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...attempt, status: "cancelled", completedAt: now },
    });
  }
  if (rootNode !== undefined) {
    events.push({
      type: "node.updated",
      threadId: run.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...rootNode, status: "cancelled", completedAt: now },
    });
  }
  return events;
}

export const prepareQueuedAgentReportDelivery = Effect.fn("QueuedAgentReportDelivery.prepare")(
  function* (input: {
    readonly store: ProjectionStoreV2Shape;
    readonly sink: EventSinkV2Shape;
    readonly ids: IdAllocatorV2["Service"];
    readonly run: OrchestrationV2Run;
    readonly message: OrchestrationV2ConversationMessage;
  }) {
    const { store, sink, ids, run, message } = input;
    const { threadId, rootNodeId, providerInstanceId, activeAttemptId } = run;
    if (activeAttemptId === null || rootNodeId === null) return undefined;
    const { runs } = yield* store.getThreadRecords(threadId, ["runs"], {
      runStatuses: ["queued"],
    });
    if (runs.length === 0) return undefined;
    const { messages } = yield* store.getThreadRecords(threadId, ["messages"], {
      messageIds: runs.map(({ userMessageId }) => userMessageId),
    });
    const batch = queuedAgentReportBatch({ runs, messages }, run, message);
    if (batch.length === 0) return undefined;

    const rootItem = yield* store.getTurnItem({
      threadId,
      itemId: ids.derive.userTurnItem({ messageId: message.id }),
    });
    if (rootItem?.type !== "user_message") return undefined;
    const { nodes, attempts } = yield* store.getThreadRecords(threadId, ["nodes", "attempts"], {
      nodeIds: batch.flatMap(({ run }) => (run.rootNodeId === null ? [] : [run.rootNodeId])),
      attemptIds: batch.flatMap(({ run }) =>
        run.activeAttemptId === null ? [] : [run.activeAttemptId],
      ),
    });
    const now = yield* DateTime.now;
    const receivingRun: OrchestrationV2Run = {
      ...run,
      batchQueuedReports: undefined,
      queuedReportMessageIds: batch.map(({ message }) => message.id),
    };
    const events = yield* Effect.forEach(batch, ({ run: queued, message: report }, index) =>
      Effect.gen(function* () {
        const received = {
          threadId,
          runId: run.id,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
        };
        return [
          ...(yield* Effect.forEach(
            queuedRunCancellationEvents({ nodes, attempts }, queued, now),
            (event) =>
              ids.allocate
                .event({ threadId })
                .pipe(Effect.map((id) => ({ ...event, id }) as OrchestrationV2DomainEvent)),
          )),
          {
            ...received,
            id: yield* ids.allocate.event({ threadId }),
            type: "message.updated",
            payload: { ...report, runId: run.id, nodeId: rootNodeId, updatedAt: now },
          },
          {
            ...received,
            id: yield* ids.allocate.event({ threadId }),
            type: "turn-item.updated",
            payload: {
              ...rootItem,
              id: ids.derive.userTurnItem({ messageId: report.id }),
              ordinal: rootItem.ordinal + index + 1,
              messageId: report.id,
              text: report.text,
              attachments: report.attachments,
              createdBy: report.createdBy,
              creationSource: report.creationSource,
              senderThreadId: report.senderThreadId,
              linkedSender: report.linkedSender,
              modelSwitch: undefined,
            },
          },
        ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
      }),
    );
    const result = yield* sink.writeIfRunCurrent({
      threadId,
      runId: run.id,
      activeAttemptId,
      expectedStatus: "running",
      events: [
        ...events.flat(),
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "run.updated",
          threadId,
          runId: run.id,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: receivingRun,
        },
      ],
    });
    if (!result.committed) return null;
    const text = projectComposerContextForProvider({
      text: [message, ...batch.map(({ message }) => message)]
        .map((item) => withMessageSenderNote(item, item.text))
        .join("\n\n"),
      records: [],
    });
    return { run: receivingRun, text };
  },
);
