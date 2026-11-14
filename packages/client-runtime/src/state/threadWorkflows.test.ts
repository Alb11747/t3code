import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import {
  canForkProjectedAssistantItem,
  canForkProjectedCompactionItem,
  deriveThreadQueueWorkflowState,
  resolveLatestMergeBackRun,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

const compactionForkInput = () =>
  ({
    projectedItem: {
      sourceThreadId: "source-thread",
      item: { type: "compaction", runId: "compact-run", status: "completed" },
    },
    support: {
      run: { id: "compact-run", status: "completed" },
      providerTurn: { nativeTurnRef: { nativeId: "native-compact-turn", strength: "strong" } },
      providerSession: { capabilities: capabilities({ nativeFork: true }) },
    },
  }) as unknown as Parameters<typeof canForkProjectedCompactionItem>[0];

describe("thread workflows", () => {
  it("forks paged compactions without source control records while respecting live run status", () => {
    const input = compactionForkInput();
    const projectedItem = {
      ...input.projectedItem,
      compactionForkSupport: {
        runStatus: input.support.run!.status,
        nativeTurnRef: input.support.providerTurn!.nativeTurnRef,
        capabilities: input.support.providerSession!.capabilities,
      },
    };
    const support = { run: null, providerTurn: null, providerSession: null };
    expect(canForkProjectedCompactionItem({ projectedItem, support })).toBe(true);
    expect(
      canForkProjectedCompactionItem({
        projectedItem,
        support: { ...support, run: { ...input.support.run!, status: "running" } },
      }),
    ).toBe(false);
    expect(
      canForkProjectedCompactionItem({
        projectedItem: {
          ...projectedItem,
          compactionForkSupport: {
            ...projectedItem.compactionForkSupport,
            nativeTurnRef: {
              ...projectedItem.compactionForkSupport.nativeTurnRef!,
              strength: "weak",
            },
          },
        },
        support,
      }),
    ).toBe(false);
  });

  it("allows a completed thread to switch providers after its session detaches", () => {
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        modelSelection: { instanceId: "cursor", model: "grok-4.7" },
      },
      runs: [{ id: "run", status: "completed" }],
      providerSessions: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerInstanceId: "cursor",
          providerSessionId: "detached-session",
          nativeThreadRef: { driver: "cursor", nativeId: "agent-123", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "running" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(false);
  });

  it("sorts queued messages and gates promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "offered",
          status: "queued",
          userMessageId: "message-offered",
          ordinal: 4,
          boundaryOffer: {
            id: "offer",
            targetRunId: "active",
            providerTurnId: "provider-turn-active",
          },
        },
        // Automatic notifications stay hidden, offered or not.
        { id: "notice", status: "queued", userMessageId: "message-notice", ordinal: 5 },
        {
          id: "offered-notice",
          status: "queued",
          userMessageId: "message-offered-notice",
          ordinal: 6,
          boundaryOffer: {
            id: "offer-notice",
            targetRunId: "active",
            providerTurnId: "provider-turn-active",
          },
        },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        {
          id: "message-first",
          text: "First",
          attachments: [
            {
              type: "image",
              id: "attachment-first",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
        { id: "message-later", text: "Later", atToolBoundary: true },
        { id: "message-offered", text: "Offered", atToolBoundary: true },
        { id: "message-notice", text: "Notice", notification: {} },
        { id: "message-offered-notice", text: "Offered notice", notification: {} },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(
      state.queuedRuns.map(({ run, text, delivery, editBlockedReason }) => [
        run.id,
        text,
        delivery,
        editBlockedReason !== null,
      ]),
    ).toEqual([
      ["first", "First", "queued", false],
      ["later", "Later", "pending", false],
      ["offered", "Offered", "delivering", true],
    ]);
    expect(state.queuedRuns.map(({ attachments }) => attachments.map(({ id }) => id))).toEqual([
      ["attachment-first"],
      [],
      [],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canPromoteToSteer).toBe(true);
    expect(state.awaitsProviderTurn).toBe(false);
    expect(state.canSendNow).toBe(false);
  });

  it.each(["completed", "interrupted", "cancelled", "failed"])(
    "allows sending a held message after a %s turn without a live session",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [
          { id: "previous", status, ordinal: 1 },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2, queueHeld: true },
        ],
        messages: [{ id: "message", text: "Send this" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);

      expect(state.canSendNow).toBe(true);
      expect(state.canPromoteToSteer).toBe(false);
      expect(state.isHeld).toBe(true);
    },
  );

  it.each(["preparing", "starting", "running", "waiting"])(
    "does not offer send now while a turn is %s, and steers follow-ups once a turn runs",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "active", status, ordinal: 1 }],
        messages: [],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);

      expect(state.canSendNow).toBe(false);
      expect(state.awaitsProviderTurn).toBe(true);
    },
  );

  it("offers to skip a running compaction even when the provider cannot steer", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        { id: "compact", status: "running", userMessageId: "message-compact", ordinal: 1 },
        { id: "queued", status: "queued", userMessageId: "message-queued", ordinal: 2 },
      ],
      messages: [
        { id: "message-compact", role: "user", text: "/compact", attachments: [] },
        { id: "message-queued", role: "user", text: "Next", attachments: [] },
      ],
      providerThreads: [],
      providerTurns: [],
      providerSessions: [],
    } as never);

    expect(state.canPromoteToSteer).toBe(true);
    expect(state.promoteSkipsCompaction).toBe(true);
  });

  it("keeps held messages visible and clears the hold when they leave the queue", () => {
    for (const status of ["queued", "cancelled", "starting"] as const) {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "held", status, userMessageId: "message", ordinal: 1, queueHeld: true }],
        messages: [{ id: "message", text: "Saved message" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);
      expect(state.isHeld).toBe(status === "queued");
      expect(state.queuedRuns.map(({ text }) => text)).toEqual(
        status === "queued" ? ["Saved message"] : [],
      );
    }
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "defers steering during setup and blocks it while waiting (%s)",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(status !== "waiting");
    },
  );

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("forks a compaction-only turn without requiring an assistant response", () => {
    const input = compactionForkInput();
    expect(canForkProjectedCompactionItem(input)).toBe(true);
    for (const status of ["waiting", "interrupted", "failed", "cancelled"] as const) {
      expect(
        canForkProjectedCompactionItem({
          ...input,
          support: { ...input.support, run: { ...input.support.run!, status } },
        }),
      ).toBe(true);
    }
  });

  it("waits for the containing run to finish even when automatic compaction has completed", () => {
    const input = compactionForkInput();
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: { ...input.support, run: { ...input.support.run!, status: "running" } },
      }),
    ).toBe(false);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        projectedItem: {
          ...input.projectedItem,
          item: { ...input.projectedItem.item, status: "running" },
        },
      }),
    ).toBe(false);
  });

  it("does not offer compaction forks without a source run or after rollback", () => {
    const input = compactionForkInput();
    expect(
      canForkProjectedCompactionItem({ ...input, support: { ...input.support, run: null } }),
    ).toBe(false);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: { ...input.support, run: { ...input.support.run!, status: "rolled_back" } },
      }),
    ).toBe(false);
  });

  it("requires an exact native compaction boundary instead of relying on a changing source head", () => {
    const input = compactionForkInput();
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: { ...input.support, providerSession: null },
      }),
    ).toBe(true);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: {
          ...input.support,
          providerTurn: {
            ...input.support.providerTurn!,
            nativeTurnRef: { ...input.support.providerTurn!.nativeTurnRef!, nativeId: null },
          },
        },
      }),
    ).toBe(false);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: {
          ...input.support,
          providerTurn: {
            ...input.support.providerTurn!,
            nativeTurnRef: {
              ...input.support.providerTurn!.nativeTurnRef!,
              strength: "weak",
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: { ...input.support, providerTurn: null, providerSession: null },
      }),
    ).toBe(false);
  });

  it("allows portable compaction forks but hides actions for an incapable provider", () => {
    const input = compactionForkInput();
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: {
          ...input.support,
          providerTurn: null,
          providerSession: {
            ...input.support.providerSession!,
            capabilities: capabilities({ portableFork: true }),
          },
        },
      }),
    ).toBe(true);
    expect(
      canForkProjectedCompactionItem({
        ...input,
        support: {
          ...input.support,
          providerSession: { ...input.support.providerSession!, capabilities: capabilities() },
        },
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );
});
