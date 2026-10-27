import { useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import type { ChatComposerHandle } from "./ChatComposer";
import type { ChatMessage } from "../../types";
import { useComposerSend } from "./useComposerSend";

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    activeProviderThreadId: "claude-conversation",
    destinationProviderThreadId: "claude-conversation",
    contextUpdatedAt: "2026-10-26T17:00:00.000Z",
    contextTokens: 250_000,
    usageUpdatedAt: null as string | null,
    startTurn: vi.fn(),
    awaitUploads: vi.fn(),
    config: Atom.make(new Map()).pipe(Atom.keepAlive),
    presentations: Atom.make(new Map()).pipe(Atom.keepAlive),
  };
});

vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.startTurn,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: () => true,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock("./useMultipleModelSend", () => ({ useMultipleModelSend: () => vi.fn() }));
vi.mock("./useProposedPlanSend", () => ({ usePlanFollowUpSend: () => vi.fn() }));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  environmentServerConfigsAtom: mocks.config,
}));
vi.mock("../../state/presentation", async (original) => ({
  ...(await original<typeof import("../../state/presentation")>()),
  environmentPresentations: { presentationsAtom: mocks.presentations },
}));
vi.mock("../../state/threads", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const DateTime = await import("effect/DateTime");
  return {
    ...(await original<typeof import("../../state/threads")>()),
    threadEnvironment: { startTurn: {}, uploadFeedback: {} },
    environmentThreadDetails: {
      quietThreadAtom: () =>
        Atom.make({
          projection: {
            thread: { activeProviderThreadId: mocks.activeProviderThreadId },
            providerTurns:
              mocks.usageUpdatedAt === null
                ? []
                : [
                    {
                      providerThreadId: mocks.destinationProviderThreadId,
                      tokenUsage: { usedTokens: 250_000, updatedAt: mocks.usageUpdatedAt },
                    },
                  ],
            providerThreads: [
              {
                id: mocks.destinationProviderThreadId,
                driver: "claudeAgent",
                providerInstanceId: "claudeAgent",
                appThreadId: "thread-test",
                ownerNodeId: null,
                updatedAt: DateTime.makeUnsafe(mocks.contextUpdatedAt),
                contextUsage: { usedTokens: mocks.contextTokens },
              },
            ],
          },
        }),
    },
  };
});
vi.mock("../../lib/attachmentUploadQueue", () => ({
  awaitAttachmentUploads: () => mocks.awaitUploads(),
  readAttachmentUpload: () => undefined,
  startAttachmentUpload: () => {},
  retryAttachmentUpload: () => {},
  releaseDraftAttachments: () => {},
  getUploadedAttachments: () => [
    {
      type: "image",
      id: "uploaded-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    },
  ],
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";

type SendInput = Parameters<typeof useComposerSend>[0];
type Sender = ReturnType<typeof useComposerSend>;

function Harness({ input, sender }: { input: SendInput; sender: { current: Sender | null } }) {
  const result = useComposerSend(input);
  useImperativeHandle(sender, () => result);
  return null;
}

function setup(
  provider = ProviderDriverKind.make("claudeAgent"),
  prompt = "Keep the attachment",
  currentProvider = "claudeAgent",
) {
  mocks.activeProviderThreadId =
    currentProvider === "codex" ? "codex-conversation" : "claude-conversation";
  mocks.destinationProviderThreadId = "claude-conversation";
  mocks.contextUpdatedAt = "2026-10-26T17:00:00.000Z";
  mocks.contextTokens = 250_000;
  mocks.usageUpdatedAt = null;
  mocks.startTurn.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.awaitUploads.mockReset().mockResolvedValue(undefined);
  const environmentId = EnvironmentId.make("compaction-send-test");
  const instanceId = ProviderInstanceId.make(provider);
  const sourceInstanceId = ProviderInstanceId.make("claudeAgent");
  const thread = makeThreadFixture({
    environmentId,
    activeProviderThreadId: ProviderThreadId.make(
      currentProvider === "codex" ? "codex-conversation" : "claude-conversation",
    ),
    modelSelection: {
      instanceId: ProviderInstanceId.make(currentProvider),
      model: currentProvider === "codex" ? "gpt-6.1-sol" : "claude-opus-4-6",
    },
  });
  const target = scopeThreadRef(environmentId, thread.id);
  const key = scopedThreadKey(target);
  const image = {
    type: "image" as const,
    id: "local-image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 4,
    file: new File(["test"], "image.png", { type: "image/png" }),
    previewUrl: "data:image/png;base64,dGVzdA==",
  };
  const config = { environment: { capabilities: { attachmentUploads: true } } };
  appAtomRegistry.set(mocks.config, new Map([[environmentId, config]]));
  appAtomRegistry.set(mocks.presentations, new Map([[environmentId, { serverConfig: config }]]));
  const handle: Partial<ChatComposerHandle> = {
    getSendContext: () => ({
      answeringPendingUserInput: false,
      prompt,
      images: [image],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      selectedPromptEffort: null,
      selectedModelOptionsForDispatch: undefined,
      selectedModelSelection: {
        instanceId,
        model: provider === "codex" ? "gpt-6.1-sol" : "claude-opus-4-6",
      },
      multipleModelSelections: null,
      providerAvailable: true,
      selectedProvider: provider,
      selectedModel: provider === "codex" ? "gpt-6.1-sol" : "claude-opus-4-6",
      selectedProviderModels: [],
      interactionMode: "default",
      interactionModeEnabled: true,
      shownPendingApprovalIds: [],
    }),
    validateProviderInput: () => true,
    resetCursorState: () => {},
  };
  let optimisticMessages: ChatMessage[] = [];
  const input: SendInput = {
    environmentId,
    routeThreadKey: key,
    currentRouteThreadKeyRef: { current: key },
    optimisticBlobPreviews: { track: vi.fn(), release: vi.fn() },
    draftId: null,
    draftThread: null,
    activeThread: thread,
    activeThreadKey: key,
    activeThreadBranch: "main",
    activeProject: {
      id: thread.projectId,
      environmentId,
      title: "test",
      workspaceRoot: "/workspace/test",
      defaultModelSelection: null,
      scripts: [],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    activeProjectDefaultModelSelection: null,
    activeProposedPlan: null,
    activeMessageCount: 2,
    isServerThread: true,
    isLocalDraftThread: false,
    isGitRepo: false,
    phase: "ready",
    runtimeMode: "full-access",
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [],
    providerInstanceEntries: [],
    composerRef: { current: handle as ChatComposerHandle },
    composerDraftTarget: target,
    promptRef: { current: prompt },
    composerImagesRef: { current: [image] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    queuedRunEdit: {
      isEditing: false,
      editingRunId: null,
      isSaving: false,
      draftTarget: target,
      editingAttachments: null,
      beginEdit: vi.fn(),
      cancelEdit: vi.fn(),
      removeEditingAttachment: vi.fn(),
      saveEdit: vi.fn(),
    },
    isConnecting: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: false,
    resumeCompaction: {
      usedTokens: 250_000,
      providerInstanceId: sourceInstanceId,
      providerThreadId: ProviderThreadId.make("claude-conversation"),
      sourceUpdatedAt: Date.parse("2026-10-26T17:00:00.000Z"),
    },
    showPlanFollowUpPrompt: false,
    usageLimitsKey: null,
    usageLimitsOffered: false,
    openUsageLimits: vi.fn(),
    clearUsageLimitsFor: vi.fn(),
    needsLoadBalancing: false,
    loadBalancing: { refresh: vi.fn(), pending: false, environmentId: null, failed: false },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: null,
    onAdvanceActivePendingUserInput: vi.fn(),
    onRespondToApproval: vi.fn(),
    beginLocalDispatch: vi.fn(),
    resetLocalDispatch: vi.fn(),
    beginWorktreeSetup: vi.fn(),
    captureDraftHeroComposerRect: vi.fn(),
    setDockedDraftHeroThreadKey: vi.fn(),
    setSetupQueueSendThreadKey: vi.fn(),
    setOptimisticUserMessages: (update) => {
      optimisticMessages = typeof update === "function" ? update(optimisticMessages) : update;
    },
    setFeedbackSubmissionsByThreadKey: vi.fn(),
    setThreadError: vi.fn(),
    setKeepFullHistory: vi.fn(),
    anchorNewTurn: vi.fn(),
    acknowledgeActiveThreadWoke: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    handleNewThreadInActiveProject: vi.fn(),
    persistThreadSettingsForNextTurn: vi
      .fn()
      .mockResolvedValue({ _tag: "Success", value: undefined }),
  };
  return {
    input,
    sender: { current: null } as { current: Sender | null },
    getOptimisticMessages: () => optimisticMessages,
  };
}

describe("resume compaction dispatch", () => {
  it("sends once to live Codex despite stale parent Claude eligibility", async () => {
    const { input, sender } = setup(ProviderDriverKind.make("codex"));
    await using _screen = await render(<Harness input={input} sender={sender} />);
    await act(() => sender.current!.onSend());
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(mocks.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
          dispatchMode: "auto",
          message: expect.objectContaining({
            text: "Keep the attachment",
            attachments: [expect.objectContaining({ id: "uploaded-image" })],
          }),
        }),
      }),
    );
  });

  it.each([
    { change: "replaced", dispatchMode: "auto" },
    { change: "refreshed", dispatchMode: "auto" },
    { change: "usage-refreshed", dispatchMode: "auto" },
    { change: "compacted", dispatchMode: "auto" },
    { change: "refreshed", dispatchMode: "queue" },
    { change: "refreshed", dispatchMode: "steer" },
  ] as const)(
    "preserves $dispatchMode dispatch when the source is $change during upload",
    async ({ change, dispatchMode }) => {
      const { input: initialInput, sender, getOptimisticMessages } = setup();
      const input: SendInput = {
        ...initialInput,
        phase: dispatchMode === "auto" ? "ready" : "running",
      };
      let finishUpload!: () => void;
      const upload = new Promise<void>((resolve) => {
        finishUpload = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      mocks.awaitUploads.mockImplementation(() => {
        markStarted();
        return upload;
      });
      await using _screen = await render(<Harness input={input} sender={sender} />);
      const send = sender.current!.onSend(undefined, dispatchMode);
      await started;
      if (change === "replaced") mocks.destinationProviderThreadId = "replacement-conversation";
      else if (change === "refreshed") mocks.contextUpdatedAt = "2026-10-26T19:00:00.000Z";
      else if (change === "usage-refreshed") mocks.usageUpdatedAt = "2026-10-26T19:00:00.000Z";
      else mocks.contextTokens = 1_000;
      await act(async () => {
        finishUpload();
        await send;
      });
      expect(getOptimisticMessages()).toHaveLength(1);
      expect(getOptimisticMessages()[0]?.inputIntent).toBe(
        dispatchMode === "queue" ? "queued_turn" : dispatchMode === "steer" ? "steer" : undefined,
      );
      if (dispatchMode === "queue") expect(input.anchorNewTurn).not.toHaveBeenCalled();
      else
        expect(input.anchorNewTurn).toHaveBeenCalledExactlyOnceWith(
          input.activeThreadKey,
          getOptimisticMessages()[0]!.id,
        );
      expect(mocks.startTurn).toHaveBeenCalledTimes(1);
      expect(mocks.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            dispatchMode,
            message: expect.objectContaining({
              text: "Keep the attachment",
              attachments: [expect.objectContaining({ id: "uploaded-image" })],
            }),
          }),
        }),
      );
    },
  );

  it.each(["claudeAgent", "codex"])(
    "compacts the saved Claude destination when returning from %s",
    async (currentProvider) => {
      const { input, sender, getOptimisticMessages } = setup(
        ProviderDriverKind.make("claudeAgent"),
        "Keep the attachment",
        currentProvider,
      );
      await using _screen = await render(<Harness input={input} sender={sender} />);
      await act(() => sender.current!.onSend());
      expect(getOptimisticMessages()[0]?.inputIntent).toBe("queued_turn");
      expect(input.anchorNewTurn).not.toHaveBeenCalled();
      expect(mocks.startTurn).toHaveBeenCalledTimes(2);
      expect(mocks.startTurn.mock.calls[0]![0].input.modelSelection.instanceId).toBe("claudeAgent");
      expect(
        mocks.startTurn.mock.calls.map(([call]) => [
          call.input.message.text,
          call.input.dispatchMode,
        ]),
      ).toEqual([
        ["/compact", undefined],
        ["Keep the attachment", "queue"],
      ]);
    },
  );
});
