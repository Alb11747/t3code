import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { claudeThinkingRecoveryTarget } from "@t3tools/shared/orchestrationV2ClaudeThinkingRecovery";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";

export const claudeThinkingRecoveryForkTest = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thinking-recovery");
  const projectId = ProjectId.make("thinking-recovery-project");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const timestamp = DateTime.formatIso(now);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make("thinking-recovery:project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Recovery",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thinking-recovery:create"),
    threadId,
    projectId,
    title: "Recovery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("thinking-recovery:send"),
    threadId,
    messageId: MessageId.make("thinking-recovery:message"),
    text: "Do the work once.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const run = initial.runs[0]!;
  const attempt = initial.attempts[0]!;
  const providerThread = initial.providerThreads[0]!;
  const node = initial.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
  yield* events.write({
    events: [
      {
        id: EventId.make("thinking-recovery:failed-run"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run, status: "failed", startedAt: now, completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:failed-attempt"),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: { ...attempt, status: "failed", startedAt: now, completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:failed-node"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...node, status: "failed", startedAt: now, completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:native-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeThreadRef: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: "native-thinking-recovery",
            strength: "strong",
          },
          status: "idle",
        },
      },
      {
        id: EventId.make("thinking-recovery:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("thinking-recovery:error"),
          type: "error",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Provider failed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "provider_error",
            code: "invalid_request",
            retryable: false,
            message:
              "Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
          },
        },
      },
    ],
  });
  const failed = yield* orchestrator.getThreadProjection(threadId);
  assert.deepEqual(claudeThinkingRecoveryTarget(failed), { runId: run.id, attemptId: attempt.id });
  assert.equal(
    claudeThinkingRecoveryTarget({
      ...failed,
      thread: { ...failed.thread, modelSelection: { ...modelSelection, model: "another-model" } },
    }),
    null,
  );
  assert.equal(
    claudeThinkingRecoveryTarget({
      ...failed,
      thread: { ...failed.thread, providerInstanceId: ProviderInstanceId.make("another-account") },
    }),
    null,
  );
  assert.equal(
    claudeThinkingRecoveryTarget({ ...failed, thread: { ...failed.thread, archivedAt: now } }),
    null,
  );
  assert.equal(
    claudeThinkingRecoveryTarget({
      ...failed,
      providerThreads: failed.providerThreads.map((thread) => ({
        ...thread,
        nativeThreadRef: null,
      })),
    }),
    null,
  );
  assert.equal(
    claudeThinkingRecoveryTarget({
      ...failed,
      attempts: failed.attempts.map((attempt) => ({ ...attempt, status: "running" })),
    }),
    null,
  );
  const retry = {
    type: "run.retry" as const,
    commandId: CommandId.make("thinking-recovery:retry"),
    threadId,
    runId: run.id,
    attemptId: attempt.id,
    recovery: "drop_thinking" as const,
  };
  const first = yield* orchestrator.dispatch(retry);
  assert.equal((yield* orchestrator.dispatch(retry)).sequence, first.sequence);
  const recovered = yield* orchestrator.getThreadProjection(threadId);
  assert.deepEqual(
    (yield* outbox.listByCommandId(retry.commandId)).map((effect) => effect.request),
    [
      {
        type: "provider-turn.start",
        runId: run.id,
        attemptId: recovered.runs[0]!.activeAttemptId!,
      },
    ],
  );
  assert.lengthOf(recovered.runs, 1);
  assert.lengthOf(recovered.attempts, 2);
  assert.equal(recovered.runs[0]?.status, "starting");
  assert.equal(recovered.runs[0]?.userMessageId, run.userMessageId);
  assert.equal(recovered.attempts[1]?.reason, "retry");
  assert.equal(recovered.attempts[1]?.recovery, "drop_thinking");
  assert.deepEqual(recovered.messages, failed.messages);
  assert.deepEqual(recovered.turnItems, failed.turnItems);
  assert.deepEqual(recovered.providerThreads, failed.providerThreads);
  assert.equal(claudeThinkingRecoveryTarget(recovered), null);
  assert.equal(
    (yield* orchestrator
      .dispatch({ ...retry, commandId: CommandId.make("thinking-recovery:stale-retry") })
      .pipe(Effect.exit))._tag,
    "Failure",
  );
  const retryAttempt = recovered.attempts[1]!;
  const retryNode = recovered.nodes.find((candidate) => candidate.id === retryAttempt.rootNodeId)!;
  const priorFailure = failed.turnItems.find((item) => item.type === "error")!;
  yield* events.write({
    events: [
      {
        id: EventId.make("thinking-recovery:retry-failed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...recovered.runs[0]!, status: "failed", completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:retry-attempt-failed"),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: { ...retryAttempt, status: "failed", completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:retry-node-failed"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...retryNode, status: "failed", completedAt: now },
      },
      {
        id: EventId.make("thinking-recovery:retry-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...priorFailure,
          id: TurnItemId.make("thinking-recovery:retry-error"),
          nodeId: retryNode.id,
          ordinal: 3,
        },
      },
    ],
  });
  assert.deepEqual(
    claudeThinkingRecoveryTarget(yield* orchestrator.getThreadProjection(threadId)),
    { runId: run.id, attemptId: retryAttempt.id },
  );
  assert.equal(
    (yield* orchestrator
      .dispatch({ ...retry, commandId: CommandId.make("thinking-recovery:old-attempt") })
      .pipe(Effect.exit))._tag,
    "Failure",
  );
  yield* orchestrator.dispatch({
    ...retry,
    commandId: CommandId.make("thinking-recovery:retry-current-attempt"),
    attemptId: retryAttempt.id,
  });
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make("thinking-recovery:stop"),
    threadId,
    runId: run.id,
    holdQueue: true,
  });
  assert.equal((yield* outbox.listByCommandId(retry.commandId))[0]?.status, "cancelled");
  assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status, "interrupted");
  assert.equal(
    (yield* orchestrator
      .dispatch({ ...retry, commandId: CommandId.make("thinking-recovery:after-stop") })
      .pipe(Effect.exit))._tag,
    "Failure",
  );
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("thinking-recovery:normal-send"),
    threadId,
    messageId: MessageId.make("thinking-recovery:normal-message"),
    text: "A separate turn.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const normal = yield* orchestrator.getThreadProjection(threadId);
  assert.equal(
    normal.attempts.find((candidate) => candidate.id === normal.runs.at(-1)?.activeAttemptId)
      ?.recovery,
    undefined,
  );
});
