import {
  type ChatAttachment,
  isCompactionCommandMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { compactionBlocksSteering } from "./composerDispatch.ts";
import type { V2ItemSupport } from "./itemSupport.ts";
import type { ThreadStructure } from "./models.ts";

type Projection = ThreadStructure;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly delivery: "pending" | "queued" | "delivering";
  readonly deliveryLabel: string;
  readonly editBlockedReason: string | null;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
  /** Carries the attribution a sent message shows: automation, agent sender, or guest. */
  readonly message?: Message;
}

export function orderThreadQueueForDisplay<T extends Pick<QueuedThreadRun, "delivery">>(
  entries: ReadonlyArray<T>,
): T[] {
  return [
    ...entries.filter((entry) => entry.delivery !== "queued"),
    ...entries.filter((entry) => entry.delivery === "queued"),
  ];
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canPromoteToSteer: boolean;
  /** The active run has no running provider turn; the server steers a follow-up into the next one. */
  readonly awaitsProviderTurn: boolean;
  /** The active run is a compaction, so promoting a queued message stops it instead of steering. */
  readonly promoteSkipsCompaction: boolean;
  readonly canSendNow: boolean;
  /** Send now into this turn reaches Claude at once and can cancel the tools it is running. */
  readonly sendNowInterruptsTools: boolean;
}

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSteersDuringCompaction(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  return (
    resolveThreadProviderSession(projection)?.capabilities.turns.activeSteeringDuringCompaction ===
    true
  );
}

function supportsSteering(turns: OrchestrationV2ProviderCapabilities["turns"]): boolean {
  return (
    turns.supportsActiveSteering ||
    (turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart)
  );
}

export function threadCanSteer(
  projection: Projection | null,
  input: {
    readonly compactCommandIsActive: boolean;
    readonly compactionRunning: boolean;
    readonly activeRunId: Run["id"] | null | undefined;
  },
): boolean {
  const turns = projection && resolveThreadProviderSession(projection)?.capabilities.turns;
  // A steer submitted before the session attaches can wait for its provider turn.
  if (turns && !supportsSteering(turns)) return false;
  return !compactionBlocksSteering({
    compactCommandIsActive: input.compactCommandIsActive,
    compactionRunning: input.compactionRunning,
    steersDuringCompaction: turns?.activeSteeringDuringCompaction === true,
    run: projection?.runs.find((run) => run.id === input.activeRunId),
    messages: projection?.messages,
  });
}

export function threadSupportsProviderHandoff(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;

  // Detaching a stopped session removes it from the projection. The server still
  // hands off from saved app history, which needs the source provider thread but
  // not its native ref.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
}

export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  if (!projection.runs.some((run) => run.status === "queued")) return [];

  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

export function deriveThreadQueueWorkflowState(
  projection: Projection,
  resolve: MFunctionType = mFallback,
): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const canSteer = capabilities !== undefined && supportsSteering(capabilities);
  const activeMessage = projection.messages.find(
    (message) => message.id === activeRun?.userMessageId,
  );
  const promoteSkipsCompaction =
    activeMessage !== undefined && isCompactionCommandMessage(activeMessage);
  const activeProviderTurnRunning =
    activeRun !== null &&
    activeRun.status !== "preparing" &&
    activeRun.status !== "starting" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const hasSteerableProviderTurn = activeRun?.status === "running" && activeProviderTurnRunning;
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    // The server settles every offer once Claude reports it started or never read it.
    const delivery =
      run.boundaryOffer !== undefined
        ? "delivering"
        : run.deliveryIntent !== undefined || message?.atToolBoundary === true
          ? "pending"
          : "queued";
    return {
      run,
      delivery,
      deliveryLabel:
        delivery === "delivering"
          ? resolve(msg("Delivering"))
          : delivery === "pending"
            ? resolve(msg("Pending"))
            : resolve(msg("Queued")),
      editBlockedReason:
        delivery === "delivering"
          ? resolve(msg("This message is being delivered to the agent"))
          : null,
      // A queued guest message shows the guest's words; the agent still gets the attributed text.
      text: message?.context?.guest?.text ?? message?.text ?? resolve(msg("Queued message")),
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
      ...(message ? { message } : {}),
    } satisfies QueuedThreadRun;
  });

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canSendNow:
      activeRun === null &&
      projection.thread.archivedAt == null &&
      projection.thread.deletedAt == null,
    canPromoteToSteer:
      promoteSkipsCompaction ||
      ((activeRun?.status === "preparing" || activeRun?.status === "starting") &&
        (capabilities === undefined || canSteer)) ||
      (hasSteerableProviderTurn && canSteer),
    awaitsProviderTurn: activeRun !== null && !activeProviderTurnRunning,
    promoteSkipsCompaction,
    // A starting turn takes it at a boundary, and a compaction is skipped instead.
    sendNowInterruptsTools:
      hasSteerableProviderTurn && !promoteSkipsCompaction && session?.driver === "claudeAgent",
  };
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  return providerSupportsFork(input.capabilities);
}

/** Compaction forks at the end of its containing run, including automatic compaction. */
export function canForkProjectedCompactionItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly support: Pick<V2ItemSupport, "run" | "providerTurn" | "providerSession">;
}): boolean {
  const { item } = input.projectedItem;
  const { run, providerTurn, providerSession } = input.support;
  const retained = input.projectedItem.compactionForkSupport;
  const runStatus = run?.status ?? retained?.runStatus;
  if (item.type !== "compaction" || item.status !== "completed" || runStatus === undefined) {
    return false;
  }
  // Mirrors the server's forkable source statuses: a run that stopped after
  // compaction still forks with whatever it finished.
  switch (runStatus) {
    case "completed":
    case "waiting":
    case "failed":
    case "interrupted":
    case "cancelled":
      break;
    default:
      return false;
  }

  const capabilities = providerSession?.capabilities ?? retained?.capabilities;
  const nativeTurnRef =
    providerTurn === null ? retained?.nativeTurnRef : providerTurn.nativeTurnRef;
  // Native compaction forks need an exact retained turn boundary. In
  // particular, Claude /compact turns become forkable when the adapter records
  // the command echo; older markers with weak cursors stay hidden. Portable
  // forks use the bounded run transcript instead.
  if (
    (capabilities === undefined || providerSupportsNativeFork(capabilities)) &&
    (nativeTurnRef?.strength !== "strong" || nativeTurnRef.nativeId === null)
  ) {
    return false;
  }

  return providerSupportsFork(capabilities);
}

function providerSupportsFork(capabilities?: OrchestrationV2ProviderCapabilities): boolean {
  if (capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  return providerSupportsNativeFork(capabilities) || capabilities.context.supportsFullThreadHandoff;
}

function providerSupportsNativeFork(capabilities: OrchestrationV2ProviderCapabilities): boolean {
  return (
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong"
  );
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
