import "~/index.css";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  canOperate: true,
  retry: vi.fn(),
}));

vi.mock(import("../../state/entities"), () => ({
  useThreadProjection: (() => state.projection && { projection: state.projection }) as never,
}));
vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: () => state.canOperate,
}));
vi.mock(import("../../state/threads"), () => ({
  threadEnvironment: { retryRun: {} } as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => state.retry) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { DroppedThinkingRetryAction } from "./DroppedThinkingRetryAction";

const environmentId = EnvironmentId.make("environment:remote");
const runId = RunId.make("run:failed");
const attemptId = RunAttemptId.make("attempt:failed");
const nodeId = NodeId.make("node:failed");

function setup() {
  const projection = makeThreadProjectionFixture();
  const now = projection.updatedAt;
  const providerInstanceId = ProviderInstanceId.make("claude-proxy");
  const providerThreadId = ProviderThreadId.make("provider-thread:claude");
  const modelSelection = { instanceId: providerInstanceId, model: "claude-opus" };
  state.projection = {
    ...projection,
    thread: {
      ...projection.thread,
      providerInstanceId,
      modelSelection,
      activeProviderThreadId: providerThreadId,
    },
    runs: [
      {
        id: runId,
        threadId: projection.thread.id,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:original"),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "failed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "failed",
        startedAt: now,
        completedAt: now,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId,
        providerSessionId: ProviderSessionId.make("session:claude"),
        appThreadId: projection.thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "native-claude",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "error",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("error:binding"),
        threadId: projection.thread.id,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "failed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error",
        failure: {
          class: "provider_error",
          code: "invalid_request",
          retryable: false,
          message:
            "Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
        },
      },
    ],
  };
  state.canOperate = true;
  state.retry.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return { threadId: projection.thread.id };
}

it("retries the failed attempt in its environment once while the command is pending", async () => {
  const { threadId } = setup();
  let finish!: () => void;
  state.retry.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await using screen = await render(
    <DroppedThinkingRetryAction
      environmentId={environmentId}
      threadId={threadId}
      runId={runId}
      nodeId={nodeId}
    />,
  );
  const action = screen.getByRole("button", { name: "Retry with dropped thinking" });
  await action.click();
  expect(state.retry).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, runId, attemptId, recovery: "drop_thinking" },
  });
  await expect.element(action).toBeDisabled();
  finish();
  await expect.element(action).toBeEnabled();
});

it("keeps recovery unavailable to read-only connections and superseded error rows", async () => {
  const { threadId } = setup();
  state.canOperate = false;
  await using screen = await render(
    <DroppedThinkingRetryAction
      environmentId={environmentId}
      threadId={threadId}
      runId={runId}
      nodeId={nodeId}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Retry with dropped thinking" }))
    .toBeDisabled();
  expect(state.retry).not.toHaveBeenCalled();
  state.canOperate = true;
  await screen.rerender(
    <DroppedThinkingRetryAction
      environmentId={environmentId}
      threadId={threadId}
      runId={runId}
      nodeId={NodeId.make("node:older-attempt")}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Retry with dropped thinking" }))
    .not.toBeInTheDocument();
});
