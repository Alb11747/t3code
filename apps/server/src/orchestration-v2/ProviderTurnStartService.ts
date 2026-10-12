import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

/** Claude refuses to replace a process running background work before it reads the prompt. */
const refusedBeforePrompt = (error: unknown): boolean =>
  Predicate.isTagged(error, "ClaudeBackgroundWorkBlocksQueryReplacementError") ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. When `willRetry` is true, a session open
   * failure is returned so the caller can retry. Otherwise the run is settled
   * as failed.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      // Guards and background routing need live execution state, not a fresh
      // allocation of every completed message and tool output in the thread.
      // `false` means the run moved on or is gone. A failed read is an error,
      // so the caller fails the start or the run instead of skipping it.
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          // Only startup needs the handoff history. The event worker keeps this
          // session alive afterward, including when background work remains.
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        // The effect is idempotent once the run has advanced or terminalized.
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const compactionMessageIds = new Set(
        projection.messages
          .filter(
            (candidate) =>
              candidate.attachments.length === 0 &&
              candidate.text.trim().toLowerCase() === "/compact",
          )
          .map((candidate) => candidate.id),
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      compactionMessageIds.has(source.userMessageId)) ||
                    // Retry deferred history once space recovers. Child results remain
                    // available through task_status after their delivery turn ends.
                    ((source.status === "completed" || source.status === "cancelled") &&
                      handoff.delivery?.status === "pending" &&
                      handoff.delivery.deferred === true &&
                      !projection.contextTransfers.some(
                        (transfer) =>
                          transfer.id === handoff.transferId && transfer.type === "subagent_result",
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      // Settles a run that never reached the provider: one signal turn item plus
      // terminal run, attempt and root node, written only while the run is still
      // the current starting attempt.
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          /** Omitted when the run never started, so `startedAt` stays as projected. */
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          /** Emitted after the run events when the provider thread should go idle. */
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("provider turn start failed to recreate worktree", {
                      threadId: projection.thread.id,
                      worktreePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: run.modelSelection,
      });
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      // The last start attempt fails the run with the provider's own reason
      // instead of leaving it `starting` after the effect gives up. A run that
      // already left `starting` is not overwritten, and a failed write returns
      // its error to the effect worker.
      const settleStartFailure = (failed: {
        readonly signal: string;
        readonly title: string;
        readonly error: Error;
      }) =>
        Effect.gen(function* () {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message:
                  nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message,
                class: "provider_error",
              }),
            },
          });
        });
      if (sessionResult._tag === "Failure") {
        if (input.willRetry === true) return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      // Only the provider's own thread load fails the run on the last attempt;
      // store, id and handoff failures around it keep their typed errors.
      const loadFromProvider = (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) =>
        Effect.gen(function* () {
          const loaded = yield* Effect.result(load);
          if (loaded._tag === "Success") return loaded.success;
          if (input.willRetry === true) return yield* loaded.failure;
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: loaded.failure,
          });
          return undefined;
        });
      let effectiveHandoffs = handoffs;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* loadFromProvider(
            session.forkThread({
              sourceProviderThread,
              sourceProviderTurns: sourceProjection.providerTurns,
              targetThreadId: projection.thread.id,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(sourceProviderTurn === undefined
                ? {}
                : { providerTurnId: sourceProviderTurn.id }),
            }),
          );
        }
        if (providerThread.nativeThreadRef === null) {
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending" &&
            handoff.delivery.deferred !== true,
        );
        const cancelledRunIds = new Set(
          projection.runs
            .filter((source) => source.status === "cancelled")
            .map((source) => source.id),
        );
        const cancelledAttempts = new Map(
          projection.attempts
            .filter((source) => cancelledRunIds.has(source.runId))
            .map((source) => [source.id, source]),
        );
        const cancelledRootTurns = new Map(
          projection.providerTurns
            .filter(
              (turn) =>
                turn.runAttemptId !== null &&
                cancelledAttempts.get(turn.runAttemptId)?.providerThreadId ===
                  turn.providerThreadId &&
                cancelledAttempts.get(turn.runAttemptId)?.rootNodeId === turn.nodeId,
            )
            .map((turn) => [turn.id, turn]),
        );
        const acceptedCancelledAttempts = new Set(
          [...cancelledRootTurns.values()].flatMap((turn) =>
            turn.status === "completed" ? [turn.runAttemptId!] : [],
          ),
        );
        const acceptedCancelledRunIds = new Set(
          [...acceptedCancelledAttempts].map(
            (attemptId) => cancelledAttempts.get(attemptId)!.runId,
          ),
        );
        const attemptsByRun = Map.groupBy(projection.attempts, (source) => source.runId);
        const checkedCancelledRunIds = new Set<RunId>();
        const cancelledMessages: OrchestrationV2ConversationMessage[] = [];
        const readCancelledAdmission = Effect.fn("readCancelledAdmission")(function* (
          sourceRunId: RunId,
        ) {
          checkedCancelledRunIds.add(sourceRunId);
          // A provider message can commit before its node and turn item. Keep
          // both event prefixes, reading only the requested cancelled run.
          const { turnItems, messages } = yield* projectionStore.getThreadRecords(
            input.threadId,
            ["turnItems", "messages"],
            {
              turnItemRunId: sourceRunId,
              messageRunIds: [sourceRunId],
              messageRoles: ["assistant"],
              turnItemTypes: [
                "assistant_message",
                "reasoning",
                "proposed_plan",
                "todo_list",
                "approval_request",
                "user_input_request",
                "subagent",
                "compaction",
                "command_execution",
                "dynamic_tool",
                "file_change",
                "file_search",
                "web_search",
              ],
            },
          );
          for (const item of turnItems) {
            const turn =
              item.providerTurnId === null
                ? undefined
                : cancelledRootTurns.get(item.providerTurnId);
            const attempt =
              turn?.runAttemptId == null ? undefined : cancelledAttempts.get(turn.runAttemptId);
            if (
              attempt === undefined ||
              item.runId !== attempt.runId ||
              item.providerThreadId !== turn?.providerThreadId ||
              ((item.type === "assistant_message" || item.type === "reasoning") &&
                item.text.length === 0 &&
                (item.type !== "assistant_message" || !item.attachments?.length)) ||
              (item.type === "proposed_plan" && item.markdown.length === 0) ||
              (item.type === "todo_list" && item.steps.length === 0) ||
              (item.type === "subagent" && item.origin !== "provider_native") ||
              (item.type === "compaction" && item.status !== "completed")
            )
              continue;
            acceptedCancelledAttempts.add(attempt.id);
            acceptedCancelledRunIds.add(attempt.runId);
          }
          for (const sourceMessage of messages) {
            if (
              sourceMessage.creationSource !== "provider" ||
              (sourceMessage.text.length === 0 && sourceMessage.attachments.length === 0)
            )
              continue;
            cancelledMessages.push(sourceMessage);
            acceptedCancelledRunIds.add(sourceRunId);
            const sourceAttempts = attemptsByRun.get(sourceRunId)!;
            // Messages carry no native/attempt identity, and their child node
            // may not have committed yet. An earlier retry's output cannot
            // establish admission for a later attempt on another native session.
            if (sourceAttempts.length === 1) {
              acceptedCancelledAttempts.add(sourceAttempts[0]!.id);
            }
          }
        });
        const currentCancelledRunIds = new Set(
          [...cancelledAttempts.values()]
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                source.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
                !acceptedCancelledAttempts.has(source.id),
            )
            .map((source) => source.runId),
        );
        for (const sourceRunId of currentCancelledRunIds) {
          yield* readCancelledAdmission(sourceRunId);
        }
        // Adapters publish running turns on either side of prompt submission.
        // Without completion or provider output, prompt admission is uncertain.
        // Replace that native session to resolve uncertain occupancy.
        const uncertainCancelledPrompt = [...cancelledAttempts.values()].some(
          (source) =>
            source.providerThreadId === providerThread.id &&
            source.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            !acceptedCancelledAttempts.has(source.id),
        );
        const resumed = yield* Effect.result(
          uncertainDelivery || uncertainCancelledPrompt
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: uncertainDelivery
                    ? "Uncertain native history injection"
                    : "Uncertain native prompt acceptance after cancellation",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : uncertainCancelledPrompt
              ? "uncertain_cancelled_prompt"
              : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session
            .ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              // The native ref is dropped so the adapter binds a fresh native
              // session instead of retrying the resume that just failed, while
              // still adopting this row's identity.
              existingProviderThread: { ...providerThread, nativeThreadRef: null },
            })
            .pipe(
              Effect.flatMap((replacement) =>
                replacement.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId
                  ? Effect.fail(
                      new ProviderAdapter.ProviderAdapterEnsureThreadError({
                        driver: session.driver,
                        threadId: projection.thread.id,
                        cause:
                          "Provider returned the previous native session instead of a fresh replacement",
                      }),
                    )
                  : Effect.succeed(replacement),
              ),
            ),
        );
        if (replacement === undefined) return undefined;
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        // Historical cancellation evidence is only needed when reconstructing
        // a replacement, not on every subsequent ordinary turn.
        for (const sourceRunId of cancelledRunIds) {
          if (!checkedCancelledRunIds.has(sourceRunId)) {
            yield* readCancelledAdmission(sourceRunId);
          }
        }
        const fallbackItems = [...(yield* projectionStore.getTurnStartHistory(input.threadId))];
        const representedMessages = new Map(
          fallbackItems.flatMap((item) =>
            item.type === "assistant_message" ? [[item.messageId, item] as const] : [],
          ),
        );
        const runOrdinals = new Map(projection.runs.map((source) => [source.id, source.ordinal]));
        for (const sourceMessage of cancelledMessages) {
          const representedItem = representedMessages.get(sourceMessage.id);
          if (representedItem !== undefined) {
            // Each streaming update commits its message first as well. Overlay
            // newer durable content without duplicating or moving the item.
            // Streaming updates can share a millisecond; the conversation
            // message is the authoritative content at an equal timestamp.
            if (
              DateTime.isGreaterThanOrEqualTo(sourceMessage.updatedAt, representedItem.updatedAt)
            ) {
              fallbackItems[fallbackItems.indexOf(representedItem)] = {
                ...representedItem,
                text: sourceMessage.text,
                attachments: sourceMessage.attachments,
                streaming: sourceMessage.streaming,
                status: sourceMessage.streaming ? "running" : "completed",
                completedAt: sourceMessage.streaming ? null : sourceMessage.updatedAt,
                updatedAt: sourceMessage.updatedAt,
              };
            }
            continue;
          }
          // Only the message committed before the crash. Include its durable
          // output in replacement history without persisting a synthetic item.
          const historicalItem: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`message-only:${sourceMessage.id}`),
            threadId: input.threadId,
            runId: sourceMessage.runId,
            nodeId: sourceMessage.nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: sourceMessage.streaming ? "running" : "completed",
            title: null,
            startedAt: sourceMessage.createdAt,
            completedAt: sourceMessage.streaming ? null : sourceMessage.updatedAt,
            updatedAt: sourceMessage.updatedAt,
            type: "assistant_message",
            messageId: sourceMessage.id,
            text: sourceMessage.text,
            attachments: sourceMessage.attachments,
            streaming: sourceMessage.streaming,
          };
          const sourceOrdinal = runOrdinals.get(sourceMessage.runId!)!;
          const insertAt = fallbackItems.findIndex((item) => {
            const itemOrdinal = item.runId === null ? 0 : runOrdinals.get(item.runId)!;
            return (
              itemOrdinal > sourceOrdinal ||
              (itemOrdinal === sourceOrdinal &&
                DateTime.isGreaterThan(item.startedAt ?? item.updatedAt, sourceMessage.createdAt))
            );
          });
          fallbackItems.splice(
            insertAt === -1 ? fallbackItems.length : insertAt,
            0,
            historicalItem,
          );
        }
        // Keep accepted requests with their output and cancellation status.
        // Uncertain cancelled requests must not be replayed by later replacements.
        const cancelledRequestIds = new Set(
          projection.runs
            .filter(
              (source) => source.status === "cancelled" && !acceptedCancelledRunIds.has(source.id),
            )
            .map((source) => source.userMessageId),
        );
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: fallbackItems.filter(
            (item) =>
              (item.type !== "user_message" || !cancelledRequestIds.has(item.messageId)) &&
              (item.runId === null ||
                projection.runs.some(
                  (source) => source.id === item.runId && source.ordinal < run.ordinal,
                )),
          ),
          createdAt,
        });
        effectiveHandoffs = [handoff, ...effectiveHandoffs];
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      // The last attempt already failed the run.
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const sameNativeThread =
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const deliveredAttemptIds = new Set(
        projection.providerTurns.map((turn) => turn.runAttemptId),
      );
      const acceptedAttempts = projection.attempts.filter(
        (source) =>
          source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
      );
      const acceptedAttemptsById = new Map(acceptedAttempts.map((source) => [source.id, source]));
      const nativeId = loadedProviderThread.nativeThreadRef?.nativeId;
      const explicitCompaction =
        sameNativeThread && nativeId !== undefined
          ? projection.runs.findLast((source) => {
              const acceptedAttempt =
                source.activeAttemptId === null
                  ? undefined
                  : acceptedAttemptsById.get(source.activeAttemptId);
              return (
                source.ordinal < run.ordinal &&
                source.status === "completed" &&
                source.completedAt !== null &&
                compactionMessageIds.has(source.userMessageId) &&
                acceptedAttempt?.status === "completed" &&
                acceptedAttempt.nativeThreadId === nativeId
              );
            })
          : undefined;
      let compaction =
        explicitCompaction?.completedAt == null
          ? undefined
          : {
              runId: explicitCompaction.id,
              ordinal: explicitCompaction.ordinal,
              completedAt: explicitCompaction.completedAt,
              explicit: true,
              summary: "",
            };
      // Native completion can precede explicit run finalization. Bound telemetry
      // by the marker while retaining the run boundary for fallback history.
      let compactionUsageResetAt: DateTime.Utc | undefined;
      let compactionMarker: Extract<OrchestrationV2TurnItem, { type: "compaction" }> | undefined;
      let explicitCompactionSummaryAt: DateTime.Utc | undefined;
      if (sameNativeThread && nativeId !== undefined) {
        const providerTurnsById = new Map(projection.providerTurns.map((turn) => [turn.id, turn]));
        const runsById = new Map(projection.runs.map((source) => [source.id, source]));
        for (const item of projection.turnItems) {
          if (
            item.type !== "compaction" ||
            item.status !== "completed" ||
            item.providerThreadId !== providerThread.id ||
            item.providerTurnId === null ||
            item.runId === null
          )
            continue;
          const providerTurn = providerTurnsById.get(item.providerTurnId);
          const acceptedAttempt =
            providerTurn?.runAttemptId == null
              ? undefined
              : acceptedAttemptsById.get(providerTurn.runAttemptId);
          const source = runsById.get(item.runId);
          if (
            source === undefined ||
            source.status === "rolled_back" ||
            source.ordinal >= run.ordinal ||
            acceptedAttempt?.nativeThreadId !== nativeId ||
            acceptedAttempt.runId !== item.runId ||
            providerTurn?.nodeId !== acceptedAttempt.rootNodeId
          )
            continue;
          const completedAt = item.completedAt ?? item.updatedAt;
          if (item.runId === explicitCompaction?.id) {
            // A later synthetic completion receipt can omit the native summary.
            if (
              compaction?.runId === item.runId &&
              item.summary &&
              (explicitCompactionSummaryAt === undefined ||
                DateTime.isGreaterThanOrEqualTo(completedAt, explicitCompactionSummaryAt))
            ) {
              compaction.summary = item.summary;
              explicitCompactionSummaryAt = completedAt;
            }
            if (
              compaction?.runId === item.runId &&
              (compactionUsageResetAt === undefined ||
                DateTime.isGreaterThan(completedAt, compactionUsageResetAt))
            ) {
              compactionUsageResetAt = completedAt;
              compactionMarker = item;
            }
            continue;
          }
          if (
            compaction !== undefined &&
            !DateTime.isGreaterThan(completedAt, compaction.completedAt)
          )
            continue;
          // Automatic compaction can finish before the ordinary turn fails.
          // Its tool node is scoped through the accepted root provider turn.
          compaction = {
            runId: source.id,
            ordinal: source.ordinal,
            completedAt,
            explicit: false,
            summary: item.summary ?? "",
          };
          compactionUsageResetAt = completedAt;
          compactionMarker = item;
        }
      }
      // Only started runs reached the provider-thread update below. Queued runs and
      // failures during session setup cannot establish a new telemetry selection.
      const measuredContext = latestNativeContextUsage(projection, providerThread);
      const previousSelection =
        measuredContext?.modelSelection ??
        projection.runs.findLast(
          (source) =>
            source.ordinal < run.ordinal &&
            source.startedAt !== null &&
            source.providerThreadId === providerThread.id,
        )?.modelSelection;
      const sameSelection =
        previousSelection === undefined ||
        modelSelectionsEqual(previousSelection, run.modelSelection);
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      // Claude reports its post-compaction watermark at the marker's timestamp.
      // The matching count establishes provenance that an ordinary same-ms report lacks.
      const measuredCompactionWatermark =
        measuredContext !== undefined &&
        compactionUsageResetAt !== undefined &&
        compactionMarker?.afterTokenCount !== undefined &&
        measuredContext.runOrdinal === compaction?.ordinal &&
        measuredContext.usage.usedTokens === compactionMarker.afterTokenCount &&
        DateTime.Equivalence(
          DateTime.makeUnsafe(measuredContext.reportedAt),
          compactionUsageResetAt,
        );
      const staleAfterCompaction =
        compaction !== undefined &&
        measuredContext !== undefined &&
        (measuredContext.runOrdinal < compaction.ordinal ||
          (compactionUsageResetAt !== undefined &&
            !measuredCompactionWatermark &&
            // Equal timestamps without a matching watermark have unknown provenance.
            DateTime.isLessThanOrEqualTo(
              DateTime.makeUnsafe(measuredContext.reportedAt),
              compactionUsageResetAt,
            )));
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const knownModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      // Persist before delivery. Keep this native transcript's measured
      // occupancy. A different model drops compaction telemetry and uses the
      // new window when that window is known. Successful compaction invalidates
      // older occupancy, while retaining model capacity and fresh compaction reports.
      // Thread-only usage is invalidated by its adapter; absent turn telemetry
      // cannot establish that a provider's current snapshot is stale.
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage: staleAfterCompaction ? null : previousUsage,
        knownModelWindow,
      });
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      // Recovery cancels running turns. Record known-unsent history in the same
      // transaction so a crash before budgeting cannot strand its ready handoff.
      // Existing same-native delivery markers retain their ambiguity or completion.
      const unsentHandoffs: Array<OrchestrationV2ContextHandoff> = [];
      if (nativeId !== undefined && nativeId !== null) {
        effectiveHandoffs = effectiveHandoffs.map((handoff) => {
          if (handoff.delivery?.nativeThreadId === nativeId) return handoff;
          const deferred: OrchestrationV2ContextHandoff = {
            ...handoff,
            delivery: { nativeThreadId: nativeId, status: "pending", deferred: true, itemIds: [] },
            updatedAt: now,
          };
          unsentHandoffs.push(deferred);
          return deferred;
        });
      }
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      for (const handoff of unsentHandoffs) {
        events.push({
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "context-handoff.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: handoff,
        });
      }
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
        RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const userText = projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      });
      // Delivered once: this run's provider turn marks the work as told. A
      // restart continuation is prompted by its own text or resumes natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds,
        run,
        attempts: projection.attempts,
      });
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork);
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const settledHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.delivery?.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId &&
          handoff.delivery?.status !== "pending",
      );
      const deliveredItemIds = new Set(
        settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
      );
      const coveredItemIds = new Set([
        ...deliveredItemIds,
        ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
      ]);
      // Deferred history is still unsent, but already has a handoff selected
      // for retry. Reuse it instead of rebuilding missed-run records each turn.
      const deferredHistoryItemIds = new Set(
        effectiveHandoffs.flatMap((handoff) =>
          handoff.delivery?.status !== "pending" || handoff.delivery.deferred !== true
            ? []
            : [
                ...(handoff.history?.messages.map((message) => message.itemId) ?? []),
                ...(handoff.history?.omittedItemIds ?? []),
              ],
        ),
      );
      const nativeInputRunIds = new Set(
        acceptedAttempts
          .filter(
            (source) =>
              source.nativeThreadId !== undefined &&
              source.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId,
          )
          .map((source) => source.runId),
      );
      const legacyInputRunIds = new Set(
        acceptedAttempts
          .filter((source) => source.nativeThreadId === undefined)
          .map((source) => source.runId),
      );
      const legacyRecoveredRunIds = new Set(
        projection.runs
          .filter(
            (source) =>
              source.providerThreadId === providerThread.id &&
              settledHandoffs.some(
                (handoff) =>
                  handoff.strategy === "full_thread_summary" &&
                  handoff.fromProviderThreadIds.includes(providerThread.id) &&
                  source.ordinal >= handoff.coveredRunOrdinals.from &&
                  source.ordinal <= handoff.coveredRunOrdinals.to,
              ),
          )
          .map((source) => source.id),
      );
      // Use saved text and actual native attachments when telemetry is absent.
      // Legacy attempts lack native identity; exclude their explicitly recovered
      // history, whose attachments were not replayed into the replacement thread.
      const nativeContextEstimate = Effect.gen(function* () {
        if (!sameNativeThread) return 0;
        const countedCompaction =
          compactionMarker?.afterTokenCount === undefined ? undefined : compactionMarker;
        const compactedAt =
          countedCompaction === undefined ? compaction?.completedAt : compactionUsageResetAt;
        const postCompactionRunIds = new Set(
          countedCompaction === undefined
            ? []
            : projection.runs
                .filter((source) => compaction !== undefined && source.ordinal > compaction.ordinal)
                .map((source) => source.id),
        );
        const importedAfterCompaction = new Set(
          settledHandoffs.flatMap((handoff) =>
            compactedAt != null && DateTime.isGreaterThanOrEqualTo(handoff.updatedAt, compactedAt)
              ? (handoff.delivery?.itemIds ?? [])
              : [],
          ),
        );
        // A provider's post-compaction count already covers its summary and earlier
        // inputs. Add later native output and imports; absent a count, keep the summary.
        return (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce(
          (sum, item) => {
            // Timeline ordinals distinguish later output from the marker even
            // when both events share a millisecond timestamp.
            const afterCountedCompaction =
              countedCompaction !== undefined &&
              ((item.providerTurnId === countedCompaction.providerTurnId &&
                item.ordinal > countedCompaction.ordinal) ||
                (item.runId !== null && postCompactionRunIds.has(item.runId)));
            const beforeCompaction =
              compactedAt != null &&
              !afterCountedCompaction &&
              (countedCompaction !== undefined ||
                !compaction?.explicit ||
                item.runId !== compaction.runId) &&
              (countedCompaction === undefined
                ? DateTime.isLessThan(item.updatedAt, compactedAt)
                : DateTime.isLessThanOrEqualTo(item.updatedAt, compactedAt));
            if (
              item.runId === run.id ||
              (beforeCompaction && !importedAfterCompaction.has(item.id)) ||
              (item.runId !== null &&
                missedRunIds.has(item.runId) &&
                !deliveredItemIds.has(item.id)) ||
              (item.providerThreadId !== providerThread.id && !deliveredItemIds.has(item.id))
            )
              return sum;
            const historical = historicalMessage(item);
            const nativeAttachments =
              !beforeCompaction &&
              item.type === "user_message" &&
              item.providerThreadId === providerThread.id &&
              item.runId !== null &&
              (nativeInputRunIds.has(item.runId) ||
                (legacyInputRunIds.has(item.runId) &&
                  !coveredItemIds.has(item.id) &&
                  !legacyRecoveredRunIds.has(item.runId)))
                ? attachmentTokenAllowance(item.attachments)
                : 0;
            return (
              sum +
              (historical === null ? 0 : Buffer.byteLength(historical.text)) +
              nativeAttachments
            );
          },
          countedCompaction?.afterTokenCount ?? Buffer.byteLength(compaction?.summary ?? ""),
        );
      });
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      // Replacing a native thread clears its usage, not the selected model's capacity.
      const budgetProviderThread = {
        ...runningProviderThread,
        contextUsage: handoffUsage,
      };
      const missedRuns = projection.runs.filter(
        (source) =>
          source.ordinal < run.ordinal &&
          source.providerThreadId === providerThread.id &&
          (source.status === "failed" || source.status === "interrupted") &&
          !deliveredAttemptIds.has(source.activeAttemptId),
      );
      const missedRunIds = new Set(missedRuns.map((source) => source.id));
      const missedItems =
        missedRunIds.size === 0
          ? []
          : (yield* projectionStore.getTurnStartHistory(input.threadId, [...missedRunIds])).filter(
              (item) =>
                item.runId !== null &&
                missedRunIds.has(item.runId) &&
                !coveredItemIds.has(item.id) &&
                !deferredHistoryItemIds.has(item.id) &&
                historicalMessage(item) !== null,
            );
      const startWithHandoffs = (
        turnInput: Parameters<typeof session.startTurn>[0],
        compact = false,
      ) =>
        Effect.gen(function* () {
          // A failed turn/start can leave the requested turn absent from
          // native history even when its preceding handoff was injected.
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact,
            providerThread: runningProviderThread,
            budget: Effect.gen(function* () {
              return handoffBudget({
                tokenCap,
                modelContextWindow,
                // The note is sent with the user text, so it spends the same allowance.
                userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                attachments: message.attachments,
                providerThread: budgetProviderThread,
                nativeContextEstimate:
                  budgetProviderThread.contextUsage?.usedTokens === undefined
                    ? yield* nativeContextEstimate
                    : 0,
              });
            }),
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: (handoff) =>
              Effect.gen(function* () {
                const updatedAt = yield* DateTime.now;
                yield* eventSink.write({
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({
                        threadId: projection.thread.id,
                      }),
                      type: "context-handoff.updated",
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: updatedAt,
                      payload: { ...handoff, updatedAt },
                    },
                  ],
                });
              }),
          });
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          // A note continuation has no turn to resume; its text is the prompt.
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: context === "" ? userText : `${context}\n\nUser message:\n${userText}`,
            },
          }).pipe(
            // A pending marker would make the next turn abandon this native
            // session, though the refused prompt never reached it.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // The provider already accepted the turn. A stale pending marker
          // can force a fresh thread later, but must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterTurnStartError"
              ? cause
              : new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId: run.id,
                  cause,
                }),
          ),
        );
      const deliverySession =
        effectiveHandoffs.length === 0 &&
        missedItems.length === 0 &&
        restartNote === "" &&
        !noteContinuation
          ? session
          : makeDeliverySession(session, startWithHandoffs);
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        // Legacy accepted attempts have no native id. They count only before
        // a replacement, while no accepted attempt records a native identity.
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        start(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);
