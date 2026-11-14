import type {
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ClaudeSettings,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type ResolvedProviderInstanceEnvironment,
  RunAttemptId,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ClaudeKeepWarm from "../../provider/ClaudeKeepWarm.ts";
import * as ProviderInstallationGate from "../../provider/ProviderInstallationGate.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

type HarnessServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | Scope.Scope
  | SecureRandom.SecureRandom;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Terminal = Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>;

interface WakeHarness {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly threadId: ThreadId;
  readonly sdkMessages: Queue.Queue<SDKMessage>;
  readonly processQueues: ReadonlyArray<Queue.Queue<SDKMessage>>;
  readonly offerAndWait: (message: SDKMessage) => Effect.Effect<void>;
  readonly offeredMessages: ReadonlyArray<SDKUserMessage>;
  readonly promptUuid: (index: number) => NonNullable<SDKUserMessage["uuid"]>;
  readonly continuationRequests: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>;
  readonly events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
  readonly terminalReceipts: Queue.Queue<Terminal>;
  readonly systemNoticeReceipts: Queue.Queue<
    Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
  >;
  readonly getOpenedOptions: () => ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
  readonly terminalEvents: () => ReadonlyArray<Terminal>;
  readonly hasPendingBackgroundWork: Effect.Effect<boolean>;
  readonly until: (predicate: () => boolean) => Effect.Effect<void>;
  readonly awaitTerminal: (count: number) => Effect.Effect<void>;
  readonly awaitContinuation: (count: number) => Effect.Effect<void>;
}

export interface ClaudeAdapterForkSuiteInput<HarnessError, CaptureError> {
  readonly makeWakeHarnessWithOptions: (options?: {
    readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
    readonly interrupt?: Effect.Effect<void>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly settings?: ClaudeSettings;
    readonly freshQueueOnReopen?: boolean;
    readonly claimAgentMessages?: ProviderContinuationRequests.ClaimAgentMessages;
    readonly queryFailure?: Effect.Effect<never, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly reopenFailure?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly offerFailure?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly withdrawAgentMessages?: ProviderContinuationRequests.AcknowledgeAgentMessages;
    readonly acknowledgeAgentMessages?: ProviderContinuationRequests.AcknowledgeAgentMessages;
    readonly onHandoff?: (
      handoff: NonNullable<Parameters<ClaudeAdapterV2.ClaudeAgentSdkQuerySession["offer"]>[2]>,
    ) => void;
  }) => Effect.Effect<WakeHarness, HarnessError, HarnessServices>;
  readonly makeClaudeTestTurnInput: (input: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly now: DateTime.Utc;
    readonly attemptId: RunAttemptId;
    readonly text: string;
    readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
    readonly providerTurnOrdinal?: number;
    readonly nativeThreadHasTurns?: boolean;
    readonly promptCacheExpiresAt?: DateTime.Utc;
    readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
    readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
    readonly modelSelection?: ModelSelection;
  }) => ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly captureSdkExecutablePaths: (
    binaryPath: string,
    environment?: ResolvedProviderInstanceEnvironment,
  ) => Effect.Effect<
    { readonly apiTimeoutEnvironment: ReadonlyArray<string | undefined> },
    CaptureError,
    HarnessServices | ProviderInstallationGate.ProviderInstallationGate
  >;
  readonly claudeSdkFrame: (frame: unknown) => SDKMessage;
  readonly makeAssistantTextFrame: (input: {
    readonly uuid: string;
    readonly text: string;
  }) => SDKMessage;
  readonly makeAssistantErrorFrame: (input: {
    readonly uuid: string;
    readonly error:
      | "authentication_failed"
      | "invalid_request"
      | "rate_limit"
      | "server_error"
      | undefined;
    readonly text?: string;
    readonly parentToolUseId?: string | null;
    readonly apiErrorParams?: unknown;
  }) => SDKMessage;
  readonly makeResultFrame: (input: {
    readonly uuid: string;
    readonly result: string;
    readonly numTurns?: number;
    readonly origin?: { readonly kind: "task-notification" };
    readonly subtype?: string;
    readonly isError?: boolean;
    readonly errors?: ReadonlyArray<string>;
    readonly apiErrorStatus?: number;
    readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
  }) => SDKMessage;
  readonly CLAUDE_TEST_MODEL_SELECTION: ModelSelection;
  readonly DEFAULT_CLAUDE_SETTINGS: ClaudeSettings;
  readonly UNCACHED_COLD_COMPACTION_SETTINGS: ClaudeSettings;
  readonly WAKE_NATIVE_SESSION: string;
  readonly wakeTaskStarted: SDKMessage;
  readonly wakeNotification: SDKMessage;
  readonly wakeTurnInit: SDKMessage;
  readonly turnOneResult: SDKMessage;
}

/**
 * Fork-only Claude adapter cases, registered inside the upstream wake suite so
 * they share its harness and frames without adding lines to the upstream file.
 */
export function runClaudeAdapterForkSuite<HarnessError, CaptureError>(
  input: ClaudeAdapterForkSuiteInput<HarnessError, CaptureError>,
) {
  const {
    makeWakeHarnessWithOptions,
    makeClaudeTestTurnInput,
    captureSdkExecutablePaths,
    claudeSdkFrame,
    makeAssistantTextFrame,
    makeAssistantErrorFrame,
    makeResultFrame,
    CLAUDE_TEST_MODEL_SELECTION,
    DEFAULT_CLAUDE_SETTINGS,
    UNCACHED_COLD_COMPACTION_SETTINGS,
    WAKE_NATIVE_SESSION,
    wakeTaskStarted,
    wakeNotification,
    wakeTurnInit,
    turnOneResult,
  } = input;
  const makeWakeHarness = makeWakeHarnessWithOptions();

  it.effect.each([
    "generic retry",
    "failed compaction",
    "successful compaction",
    "expired compaction",
    "partly expired compaction",
    "embedded completes retained reset",
    "embedded replaces retained reset",
    "current event wins over embedded reset",
    "sparse rejection",
    "unrelated allowed window",
    "allowed window",
    "overage",
    "incomplete windows",
    "expired reset",
    "successful recovery",
    "non-limit failure",
    "interrupted turn",
    "query exit",
    "different model",
    "model switch back",
    "different native thread",
  ] as const)("retains usage reset metadata correctly across %s", (scenario) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: Queue.shutdown,
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const resetsAt = Math.floor(DateTime.toEpochMillis(now) / 1000) + 7_200;
      const resetAt = DateTime.formatIso(DateTime.makeUnsafe(resetsAt * 1000));
      const laterResetAt = DateTime.formatIso(DateTime.makeUnsafe((resetsAt + 7200) * 1000));
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      let ordinal = 0;
      let frameOrdinal = 0;
      const uuid = () => `00000000-0000-4000-8000-${String(++frameOrdinal).padStart(12, "0")}`;
      const messages = () => harness.processQueues.at(-1)!;
      const start = (
        modelSelection = CLAUDE_TEST_MODEL_SELECTION,
        providerThread = harness.providerThread,
      ) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-reset-retention-${++ordinal}`),
            providerTurnOrdinal: ordinal,
            modelSelection,
            text: "Continue.",
            attachments: [],
          }),
        );
      const limit = (rate_limit_info: SDKRateLimitInfo) =>
        Queue.offer(
          messages(),
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info,
            uuid: uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      const fail = Effect.fnUntraced(function* (
        expectedReset: string | null,
        assistantInfo?: SDKRateLimitInfo,
      ) {
        yield* Queue.offerAll(messages(), [
          makeAssistantErrorFrame({
            uuid: uuid(),
            error: "rate_limit",
            ...(assistantInfo === undefined
              ? {}
              : { apiErrorParams: { rate_limit_info: assistantInfo } }),
          }),
          makeResultFrame({
            uuid: uuid(),
            result: "API Error",
            terminalReason: "api_error",
            isError: true,
            apiErrorStatus: 429,
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, "usage_limit");
        assert.equal(terminal.failure.resetAt, expectedReset);
      });
      yield* start();
      yield* limit({
        status: "rejected",
        rateLimitType: "five_hour",
        ...(scenario === "embedded completes retained reset" ? {} : { resetsAt }),
      });
      if (scenario === "incomplete windows") {
        yield* limit({ status: "rejected", rateLimitType: "seven_day" });
      }
      if (scenario === "partly expired compaction") {
        yield* limit({ status: "rejected", rateLimitType: "seven_day", resetsAt: resetsAt + 7200 });
      }
      yield* fail(
        scenario === "incomplete windows" || scenario === "embedded completes retained reset"
          ? null
          : scenario === "partly expired compaction"
            ? laterResetAt
            : resetAt,
      );

      if (scenario === "expired reset") yield* TestClock.adjust("3 hours");
      yield* start(
        scenario === "different model" || scenario === "model switch back"
          ? { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-opus-4-6" }
          : CLAUDE_TEST_MODEL_SELECTION,
        scenario === "different native thread"
          ? {
              ...harness.providerThread,
              nativeThreadRef: {
                driver: harness.providerThread.driver,
                nativeId: "other-session",
                strength: "strong",
              },
            }
          : harness.providerThread,
      );
      if (
        scenario === "failed compaction" ||
        scenario === "successful compaction" ||
        scenario === "expired compaction" ||
        scenario === "partly expired compaction"
      ) {
        const blocked =
          scenario === "failed compaction" || scenario === "partly expired compaction";
        const expectedReset = scenario === "partly expired compaction" ? laterResetAt : resetAt;
        if (scenario === "expired compaction" || scenario === "partly expired compaction")
          yield* TestClock.adjust("3 hours");
        yield* Queue.offerAll(messages(), [
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            compact_result: scenario === "successful compaction" ? "success" : "failed",
            ...(scenario !== "successful compaction"
              ? { compact_error: "Compaction stopped by the provider." }
              : {}),
            uuid: uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            ...makeResultFrame({ uuid: uuid(), result: "", numTurns: 0, terminalReason: null }),
            local_command: "compact",
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, blocked ? "failed" : "completed");
        if (terminal.status === "failed") {
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(terminal.failure.resetAt, expectedReset);
        }
        yield* start();
        yield* fail(blocked ? expectedReset : null);
        return;
      }
      if (scenario === "successful recovery" || scenario === "non-limit failure") {
        yield* Queue.offerAll(messages(), [
          makeAssistantErrorFrame({
            uuid: uuid(),
            error: scenario === "non-limit failure" ? "invalid_request" : undefined,
          }),
          makeResultFrame({
            uuid: uuid(),
            result: scenario === "successful recovery" ? "Done." : "API Error",
            terminalReason: scenario === "successful recovery" ? "completed" : "api_error",
            isError: scenario === "non-limit failure",
            ...(scenario === "non-limit failure" ? { apiErrorStatus: 400 } : {}),
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, scenario === "successful recovery" ? "completed" : "failed");
        yield* start();
      } else if (scenario === "interrupted turn" || scenario === "query exit") {
        if (scenario === "interrupted turn") {
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: harness.providerThread.driver,
              nativeTurnId: `turn:attempt-reset-retention-${ordinal}`,
            }),
          });
        } else {
          yield* Queue.shutdown(messages());
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, scenario === "interrupted turn" ? "interrupted" : "failed");
        yield* start();
      }
      if (scenario === "sparse rejection")
        yield* limit({ status: "rejected", rateLimitType: "five_hour" });
      if (scenario === "unrelated allowed window")
        yield* limit({ status: "allowed", rateLimitType: "seven_day" });
      if (scenario === "allowed window")
        yield* limit({ status: "allowed", rateLimitType: "five_hour" });
      if (scenario === "overage")
        yield* limit({ status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed" });
      if (
        scenario === "embedded completes retained reset" ||
        scenario === "embedded replaces retained reset" ||
        scenario === "current event wins over embedded reset"
      ) {
        const embeddedReset = resetsAt + 3600;
        const eventReset = resetsAt + 1800;
        if (scenario === "current event wins over embedded reset") {
          yield* limit({ status: "rejected", rateLimitType: "five_hour", resetsAt: eventReset });
        }
        yield* fail(
          DateTime.formatIso(
            DateTime.makeUnsafe(
              (scenario === "current event wins over embedded reset" ? eventReset : embeddedReset) *
                1000,
            ),
          ),
          { status: "rejected", rateLimitType: "five_hour", resetsAt: embeddedReset },
        );
        return;
      }
      const retainsReset =
        scenario === "generic retry" ||
        scenario === "sparse rejection" ||
        scenario === "unrelated allowed window";
      yield* fail(retainsReset ? resetAt : null);
      if (scenario === "model switch back") {
        yield* start();
        yield* fail(null);
      }
      if (scenario === "incomplete windows") {
        yield* start();
        yield* limit({ status: "allowed", rateLimitType: "seven_day" });
        yield* fail(resetAt);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  describe("executable path", () => {
    it.effect("does not mutate the shared host environment when defaulting the API timeout", () => {
      const sharedEnvironment = { PATH: "/test/bin" };
      return Effect.scoped(
        Effect.gen(function* () {
          const { apiTimeoutEnvironment } = yield* captureSdkExecutablePaths("claude");
          assert.deepEqual(apiTimeoutEnvironment, ["3600000"]);
          assert.deepEqual(sharedEnvironment, { PATH: "/test/bin" });
        }),
      ).pipe(
        Effect.provideService(HostProcess.Environment, sharedEnvironment),
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            ProviderInstallationGate.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );
    });

    it.effect.each([
      { source: "the default", environment: [], hostEnvironment: {}, expected: "3600000" },
      {
        source: "an instance override",
        environment: [{ name: "API_TIMEOUT_MS", value: "1200000", sensitive: false }],
        hostEnvironment: { API_TIMEOUT_MS: "1800000" },
        expected: "1200000",
      },
      {
        source: "a host override",
        environment: [],
        hostEnvironment: { API_TIMEOUT_MS: "1800000" },
        expected: "1800000",
      },
    ])("allows proxy-held requests while respecting $source for the API timeout", (testCase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { apiTimeoutEnvironment } = yield* captureSdkExecutablePaths(
            "claude",
            testCase.environment,
          );
          assert.deepEqual(apiTimeoutEnvironment, [testCase.expected]);
        }),
      ).pipe(
        Effect.provideService(HostProcess.Environment, testCase.hostEnvironment),
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            ProviderInstallationGate.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );
  });

  it.effect("withdraws a never-pulled input discarded after its hook aborts", () =>
    Effect.gen(function* () {
      const offers: ProviderContinuationRequests.AgentMessageOffer[] = [0, 1].map((index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        queuedRunId: RunId.make(`abort-queued-${index}`),
        messageId: MessageId.make(`abort-message-${index}`),
        text: `UPDATE_${index}`,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      }));
      const handoffs: Array<
        NonNullable<Parameters<ClaudeAdapterV2.ClaudeAgentSdkQuerySession["offer"]>[2]>
      > = [];
      const withdrawals =
        yield* Queue.unbounded<
          Parameters<ProviderContinuationRequests.AcknowledgeAgentMessages>[0]
        >();
      const harness = yield* makeWakeHarnessWithOptions({
        claimAgentMessages: () => Effect.succeed(offers),
        withdrawAgentMessages: (withdrawal) =>
          Queue.offer(withdrawals, withdrawal).pipe(Effect.asVoid),
        onHandoff: (handoff) => {
          handoffs.push(handoff);
        },
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("abort-boundary-attempt"),
          text: "Work.",
          attachments: [],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "init",
          capabilities: ["interrupt_cancel_queued_v1"],
          user_message_uuid: harness.promptUuid(0),
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const hook = harness.getOpenedOptions()?.hooks?.PostToolBatch?.[0]?.hooks[0];
      assert.isDefined(hook);
      if (hook === undefined) return;
      const finished = Promise.withResolvers<void>();
      const pending = yield* Effect.promise((signal) =>
        hook(
          {
            hook_event_name: "PostToolBatch",
            session_id: WAKE_NATIVE_SESSION,
            transcript_path: "/repo/session.jsonl",
            cwd: "/repo",
            tool_calls: [],
          },
          undefined,
          { signal },
        ).finally(() => {
          finished.resolve();
        }),
      ).pipe(Effect.forkChild);
      yield* harness.until(() => handoffs.length === 2);
      handoffs[0]!.onPulled();
      handoffs[0]!.onConsumed();
      yield* Fiber.interrupt(pending);
      yield* Effect.promise(() => finished.promise);
      assert.isFalse(handoffs[1]!.isCurrent());
      handoffs[1]!.onDiscarded();
      const withdrawal = yield* Queue.take(withdrawals);
      assert.deepEqual(
        withdrawal.offers.map((offer) => offer.id),
        [offers[1]!.id],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect.each(["interrupted turn", "query exit", "session close"] as const)(
    "settles unreported handed-off input on %s",
    (ending) =>
      Effect.gen(function* () {
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const offers: ProviderContinuationRequests.AgentMessageOffer[] = [0, 1].map((index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          queuedRunId: RunId.make(`ending-queued-${index}`),
          messageId: MessageId.make(`ending-message-${index}`),
          text: `UPDATE_${index}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        }));
        const handoffs: Array<
          NonNullable<Parameters<ClaudeAdapterV2.ClaudeAgentSdkQuerySession["offer"]>[2]>
        > = [];
        const withdrawals: Parameters<ProviderContinuationRequests.AcknowledgeAgentMessages>[0][] =
          [];
        const directReceipts: string[] = [];
        const sessionScope = yield* Scope.make();
        const harness = yield* makeWakeHarnessWithOptions({
          claimAgentMessages: () => Effect.succeed(offers),
          withdrawAgentMessages: (withdrawal) =>
            Effect.sync(() => {
              withdrawals.push(withdrawal);
            }),
          acknowledgeAgentMessages: (receipt) =>
            Effect.sync(() => {
              directReceipts.push(...receipt.offers.map((offer) => offer.id));
            }),
          onHandoff: (handoff) => {
            handoffs.push(handoff);
          },
          // The query runner turns the interrupt receipt's cancelled list into discards.
          interrupt: Effect.sync(() => handoffs[0]!.onDiscarded()),
          close: (messages) => Queue.shutdown(messages),
        }).pipe(Scope.provide(sessionScope));
        const attemptId = RunAttemptId.make("ending-boundary-attempt");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Work.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "init",
            capabilities: ["interrupt_cancel_queued_v1"],
            user_message_uuid: harness.promptUuid(0),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const hook = harness.getOpenedOptions()?.hooks?.PostToolBatch?.[0]?.hooks[0];
        assert.isDefined(hook);
        if (hook === undefined) return;
        const signal = yield* Effect.abortSignal;
        const pending = yield* Effect.promise(() =>
          hook(
            {
              hook_event_name: "PostToolBatch",
              session_id: WAKE_NATIVE_SESSION,
              transcript_path: "/repo/session.jsonl",
              cwd: "/repo",
              tool_calls: [],
            },
            undefined,
            { signal },
          ),
        ).pipe(Effect.forkChild);
        yield* harness.until(() => handoffs.length === 2);
        for (const handoff of handoffs) {
          handoff.onPulled();
          handoff.onConsumed();
        }
        yield* Fiber.join(pending);
        if (ending === "interrupted turn") {
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: harness.providerThread.driver,
              nativeTurnId: `turn:${attemptId}`,
            }),
          });
        } else if (ending === "query exit") {
          yield* Queue.shutdown(harness.processQueues.at(-1)!);
        } else {
          // Idle release: the turn ended with the input unreported, then the session closes.
          yield* harness.offerAndWait(makeResultFrame({ uuid: "idle-result", result: "Done." }));
        }
        yield* Queue.take(harness.terminalReceipts);
        if (ending === "session close") yield* Scope.close(sessionScope, Exit.void);
        const steps = harness.events.flatMap((event) =>
          event.type === "boundary_messages.updated" ? [event.step] : [],
        );
        const withdrawn = new Set(
          withdrawals.flatMap((withdrawal) => withdrawal.offers.map((offer) => offer.id)),
        );
        const received = harness.events.flatMap((event) =>
          event.type === "boundary_messages.updated" && event.step === "receipt"
            ? event.offers.map((offer) => offer.id)
            : [],
        );
        // Stop's receipt proves which input was removed unread. Input a lost process never
        // reported is unknowable and counts as delivered, so it is never sent twice.
        assert.deepEqual([...withdrawn], ending === "interrupted turn" ? [offers[0]!.id] : []);
        const delivered = (ending === "interrupted turn" ? offers.slice(1) : offers).map(
          (offer) => offer.id,
        );
        if (ending === "session close") {
          assert.deepEqual(steps, []);
          assert.deepEqual(directReceipts, delivered);
        } else {
          assert.deepEqual(steps, ["reserve", "receipt"]);
          assert.deepEqual(received, delivered);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            ProviderInstallationGate.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect.each([
    { createdBy: "agent", text: "See the attached screenshot." },
    { createdBy: "user", text: "See the attached screenshot." },
    { createdBy: "user", text: "/review the diff" },
    { createdBy: "user", text: "\n/review the diff" },
  ] as const)(
    "tells Claude what a native $createdBy steer's tool cancellations mean ($text)",
    ({ createdBy, text }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attemptId = RunAttemptId.make("attempt-agent-steer-note");
          const input = makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Audit the settings pages.",
            attachments: [],
          });
          yield* harness.runtime.startTurn(input);
          yield* harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
            message: {
              createdBy,
              creationSource: createdBy === "agent" ? "mcp" : "web",
              messageId: MessageId.make("message-agent-steer-note"),
              text,
              attachments: [],
            },
          });
          const steer = encodeJson(harness.offeredMessages[1]?.message.content);
          assert.include(steer, text.trim());
          assert.equal(steer.includes("came from another agent"), createdBy === "agent");
          // Claude Code reports cancelled calls as the user refusing them; every steer
          // that can cause that says so, except a slash command the note would break.
          assert.equal(
            steer.includes(ClaudeAdapterV2.CLAUDE_STEER_CANCELLATION_NOTE),
            !text.trim().startsWith("/"),
          );
          if (text.trim().startsWith("/")) {
            assert.equal(harness.offeredMessages[1]?.message.content, text.trim());
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );

  it.effect("shows a keep-warm stall and pauses it as a usage limit with the hold's reset", () => {
    const sessions: Array<ClaudeKeepWarm.ClaudeKeepWarmSession> = [];
    return Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({ close: Queue.shutdown });
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-keep-warm"),
          providerTurnOrdinal: 1,
          text: "Continue.",
          attachments: [],
        }),
      );
      const session = sessions[0]!;
      const turn = (yield* session.turn)!;
      assert.equal(turn.session, WAKE_NATIVE_SESSION);
      const hold = {
        resetAt: DateTime.formatIso(DateTime.add(now, { hours: 2 })),
        releaseAt: DateTime.formatIso(DateTime.add(now, { minutes: 59 })),
      };
      yield* session.show(turn, hold);
      const running = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.deepInclude(running, { status: "running", keepWarm: hold });

      // Releasing ends the notice with a mark that `restore` clears without moving its end.
      yield* session.show(turn, { ...hold, released: true });
      const released = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.deepInclude(released, {
        id: running.id,
        status: "completed",
        keepWarm: { ...hold, released: true },
      });
      // A poll that still lists the released hold does not reopen it.
      yield* session.show(turn, hold);
      assert.deepEqual((yield* session.turn)?.hold, { ...hold, released: true });
      yield* session.show(turn, null);
      yield* TestClock.adjust("5 minutes");
      yield* session.restore(turn);
      const restored = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      const unmarked = { ...released, keepWarm: hold };
      assert.deepEqual({ ...restored, updatedAt: released.updatedAt }, unmarked);
      assert.isNull((yield* session.turn)?.hold);
      // A release that outlives its reset loses the mark on the next poll.
      yield* session.show(turn, hold);
      yield* Queue.take(harness.systemNoticeReceipts);
      yield* session.show(turn, { ...hold, released: true });
      yield* Queue.take(harness.systemNoticeReceipts);
      yield* TestClock.adjust("3 hours");
      yield* session.show(turn, null);
      assert.deepInclude((yield* Queue.take(harness.systemNoticeReceipts)).turnItem, {
        status: "completed",
        keepWarm: hold,
      });
      yield* session.show(turn, hold);
      assert.deepInclude((yield* Queue.take(harness.systemNoticeReceipts)).turnItem, {
        status: "running",
        keepWarm: hold,
      });

      yield* session.pause({ ...turn, hold }, hold);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      assert.deepInclude(terminal.failure, { class: "usage_limit", resetAt: hold.resetAt });
      const completed = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.deepInclude(completed, { id: running.id, status: "completed", keepWarm: hold });
      // A poll that read the hold before the turn ended cannot reopen its notice.
      yield* session.show(turn, hold);
      assert.isNull(yield* session.turn);
      assert.lengthOf(
        harness.events.filter(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        ),
        8,
      );
    }).pipe(
      Effect.provideService(ClaudeKeepWarm.ClaudeKeepWarm, {
        register: (session) => Effect.sync(() => void sessions.push(session)),
        find: () => Effect.succeed(null),
        release: () => Effect.void,
      }),
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    );
  });

  it.effect.each([true, false])(
    "uses a gateway's assigned-account reset (known: %s) instead of a retained account reset",
    (known) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const ownerReset = DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 3_600_000),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-assigned-account-limit"),
            text: "Continue.",
            attachments: [],
          }),
        );
        const explanation = known
          ? `Usage limit reached (5h); resets at ${ownerReset}. Retry after this reset.`
          : "Usage limit reached; the pinned account reset is unavailable.";
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: DateTime.toEpochMillis(now) / 1_000 + 7_200,
            },
            uuid: "00000000-0000-4000-8000-000000000672",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000673",
            error: "server_error",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000674",
            result: `API Error: 503 ${encodeJson({ error: { type: "server_error", message: `quota_admission_limited: ${explanation}` } })}`,
            terminalReason: "api_error",
            isError: true,
            apiErrorStatus: 503,
          }),
        ]);
        yield* harness.until(
          () =>
            harness.terminalEvents().length > 0 ||
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "error" &&
                event.turnItem.retry !== undefined,
            ),
        );
        assert.isAbove(harness.terminalEvents().length, 0);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, "usage_limit");
        assert.equal(terminal.failure.resetAt, known ? ownerReset : null);
        assert.equal(terminal.failure.message, explanation);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-compaction-after-gateway-limit"),
            providerTurnOrdinal: 2,
            text: "/compact",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            compact_result: "failed",
            compact_error: "Compaction stopped without quota metadata.",
            uuid: "00000000-0000-4000-8000-000000000675",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            ...makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000676",
              result: "",
              numTurns: 0,
              terminalReason: null,
            }),
            local_command: "compact",
          }),
        ]);
        const compaction = yield* Queue.take(harness.terminalReceipts);
        assert.equal(compaction.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            ProviderInstallationGate.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  describe("cold compaction prompt caching", () => {
    const compactInput = (
      harness: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      },
      now: DateTime.Utc,
      promptCacheExpiresAt: DateTime.Utc | undefined,
    ) =>
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId: RunAttemptId.make("attempt-cold-compact"),
        text: "/compact",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
        ...(promptCacheExpiresAt === undefined ? {} : { promptCacheExpiresAt }),
      });

    it.effect.each([
      { compactResult: "completed", isError: false },
      { compactResult: "failed", isError: true },
    ])(
      "compacts a thread with an expired cache uncached, then caches the next turn ($compactResult compaction)",
      ({ isError }) =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarnessWithOptions({
            settings: UNCACHED_COLD_COMPACTION_SETTINGS,
            environment: {
              CLAUDE_CONFIG_DIR: "/claude-home",
              ANTHROPIC_CUSTOM_HEADERS: "X-Team: blue",
            },
            freshQueueOnReopen: true,
          });
          const now = yield* DateTime.now;
          yield* harness.runtime.compactThread!(compactInput(harness, now, now));
          const compactOptions = harness.getOpenedOptions();
          assert.equal(compactOptions?.env?.DISABLE_PROMPT_CACHING, "1");
          assert.equal(compactOptions?.env?.CLAUDE_CONFIG_DIR, "/claude-home");
          // Asks CLIProxyAPI not to add its own markers, keeping the user's headers.
          assert.equal(
            compactOptions?.env?.ANTHROPIC_CUSTOM_HEADERS,
            "X-Team: blue\nX-CPA-Prompt-Cache-Mode: explicit",
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000901",
              result: isError ? "Compaction failed." : "Compacted conversation.",
              isError,
            }),
          );
          yield* Queue.take(harness.terminalReceipts);

          // The queued message opens a new process with normal caching.
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-after-cold-compact"),
              text: "Continue",
              attachments: [],
              providerTurnOrdinal: 3,
              nativeThreadHasTurns: true,
              promptCacheExpiresAt: DateTime.subtractDuration(now, Duration.hours(1)),
            }),
          );
          const nextOptions = harness.getOpenedOptions();
          assert.notStrictEqual(nextOptions, compactOptions);
          assert.isUndefined(nextOptions?.env?.DISABLE_PROMPT_CACHING);
          assert.equal(nextOptions?.env?.ANTHROPIC_CUSTOM_HEADERS, "X-Team: blue");
          assert.equal(nextOptions?.env?.CLAUDE_CONFIG_DIR, "/claude-home");
          assert.lengthOf(harness.processQueues, 2);
          assert.lengthOf(harness.offeredMessages, 2);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              IdAllocator.layer,
              McpProviderSessions.layer,
            ),
          ),
        ),
    );

    it.effect("keeps a live process and its caching for a compaction", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          settings: UNCACHED_COLD_COMPACTION_SETTINGS,
        });
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-before-warm-compact"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        const liveOptions = harness.getOpenedOptions();
        yield* harness.offerAndWait(wakeTaskStarted);
        yield* harness.offerAndWait(turnOneResult);
        yield* Queue.take(harness.terminalReceipts);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        // Even when the cache has expired, the process that runs the
        // background task stays, and so does its caching.
        yield* harness.runtime.compactThread!(compactInput(harness, now, now));
        assert.strictEqual(harness.getOpenedOptions(), liveOptions);
        assert.isUndefined(liveOptions?.env?.DISABLE_PROMPT_CACHING);
        assert.deepEqual(harness.offeredMessages[1]?.message.content, "/compact");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            IdAllocator.layer,
            McpProviderSessions.layer,
          ),
        ),
      ),
    );

    it.effect.each([
      { name: "setting off", settings: DEFAULT_CLAUDE_SETTINGS, expiresInMs: 0 },
      {
        name: "an unexpired cache",
        settings: UNCACHED_COLD_COMPACTION_SETTINGS,
        expiresInMs: 1,
      },
      {
        name: "an unknown cache expiry",
        settings: UNCACHED_COLD_COMPACTION_SETTINGS,
        expiresInMs: undefined,
      },
    ])("keeps caching for a fresh-process compaction with $name", ({ settings, expiresInMs }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ settings });
        const now = yield* DateTime.now;
        yield* harness.runtime.compactThread!(
          compactInput(
            harness,
            now,
            expiresInMs === undefined
              ? undefined
              : DateTime.add(now, { milliseconds: expiresInMs }),
          ),
        );
        assert.isUndefined(harness.getOpenedOptions()?.env?.DISABLE_PROMPT_CACHING);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            IdAllocator.layer,
            McpProviderSessions.layer,
          ),
        ),
      ),
    );
  });

  describe("exhausted API retries", () => {
    const retryItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "error" &&
        event.turnItem.retry !== undefined
          ? [event.turnItem]
          : [],
      );
    const recoveryLayers = Layer.mergeAll(
      IdAllocator.layer,
      McpProviderSessions.layer,
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 }),
    );
    const start = Effect.fnUntraced(function* (harness: Effect.Success<typeof makeWakeHarness>) {
      const turnInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-claude-recovery"),
        text: "Finish the task.",
        attachments: [],
      });
      yield* harness.runtime.startTurn(turnInput);
      return turnInput;
    });

    const overload = (harness: Effect.Success<typeof makeWakeHarness>) =>
      harness.offerAndWait(
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000930",
          result: "API Error: Repeated 529 Overloaded errors",
          isError: true,
          apiErrorStatus: 529,
          terminalReason: "api_error",
        }),
      );

    it.effect("a second steer preserves an earlier steer after its SDK offer fails", () =>
      Effect.gen(function* () {
        let fail = true;
        const harness = yield* makeWakeHarnessWithOptions({
          freshQueueOnReopen: true,
          offerFailure: Effect.suspend(() => {
            if (!fail) return Effect.void;
            fail = false;
            return Effect.fail(
              new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                method: "offer",
                cause: { code: "ECONNRESET" },
              }),
            );
          }),
        });
        const input = yield* start(harness);
        const steer = (text: string) =>
          harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: IdAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${input.attemptId}`,
            }),
            message: { ...input.message, text },
          });
        yield* overload(harness);
        yield* Queue.shutdown(harness.sdkMessages);
        yield* TestClock.adjust(1_000);
        yield* steer("FIRST: do not deploy.");
        yield* TestClock.adjust(6_500);
        yield* harness.until(() => retryItems(harness.events).at(-1)?.retry?.attempt === 2);
        yield* steer("SECOND: also run the tests.");
        yield* TestClock.adjust(15_000);
        yield* harness.until(
          () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
        );
        const delivered = encodeJson(harness.offeredMessages.slice(1));
        assert.include(delivered, "FIRST: do not deploy.");
        assert.include(delivered, "SECOND: also run the tests.");
        assert.isBelow(delivered.indexOf("FIRST:"), delivered.indexOf("SECOND:"));
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000951",
            result: "Followed both instructions.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each([
      { initialized: false, stderr: "SyntaxError", recovers: false },
      { initialized: true, stderr: "SyntaxError", recovers: true },
      // Network evidence keeps a pre-init crash transient.
      { initialized: false, stderr: "Error: connect ECONNREFUSED 127.0.0.1:443", recovers: true },
    ])(
      "a nonzero process exit with $stderr retries when transient (received init: $initialized)",
      ({ initialized, stderr, recovers }) =>
        Effect.gen(function* () {
          const errors = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>();
          const harness = yield* makeWakeHarnessWithOptions({
            freshQueueOnReopen: true,
            queryFailure: Queue.take(errors).pipe(Effect.flatMap(Effect.fail)),
          });
          yield* start(harness);
          yield* overload(harness);
          yield* Queue.shutdown(harness.sdkMessages);
          yield* TestClock.adjust(7_500);
          yield* harness.until(() => harness.offeredMessages.length === 2);
          if (initialized) yield* harness.offerAndWait(wakeTurnInit);
          yield* Queue.offer(
            errors,
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "fromAsyncIterable",
              cause: Object.assign(
                new Error(`Claude Code process exited with code 1. stderr: ${stderr}`),
                {
                  errorClass: "process_exited_nonzero",
                  exitCode: 1,
                },
              ),
            }),
          );
          yield* harness.until(
            () =>
              harness.terminalEvents().length > 0 ||
              retryItems(harness.events).at(-1)?.retry?.attempt === 2,
          );
          if (recovers) {
            assert.lengthOf(harness.terminalEvents(), 0);
            yield* TestClock.adjust(15_000);
            yield* harness.until(() => harness.offeredMessages.length === 3);
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000952",
                result: "Recovered after the process exit.",
              }),
            );
          } else assert.equal(harness.terminalEvents()[0]?.status, "failed");
          yield* harness.awaitTerminal(1);
          assert.equal(harness.terminalEvents()[0]?.status, recovers ? "completed" : "failed");
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each(["EAGAIN", "ENOMEM"])(
      "a transient startup %s keeps retrying before init",
      (code) =>
        Effect.gen(function* () {
          const errors = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>();
          const harness = yield* makeWakeHarnessWithOptions({
            freshQueueOnReopen: true,
            queryFailure: Queue.take(errors).pipe(Effect.flatMap(Effect.fail)),
          });
          yield* start(harness);
          yield* Queue.offer(
            errors,
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "fromAsyncIterable",
              cause: { code, errorClass: "spawn_failed" },
            }),
          );
          yield* harness.until(
            () => retryItems(harness.events).length > 0 || harness.terminalEvents().length > 0,
          );
          assert.lengthOf(harness.terminalEvents(), 0);
          yield* TestClock.adjust(7_500);
          yield* harness.until(() => harness.offeredMessages.length === 2);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000953",
              result: "Recovered after the spawn failure.",
            }),
          );
          yield* harness.awaitTerminal(1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("reopening an accepted turn resumes beyond its original rollback cutoff", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              nativeConversationHeadRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "00000000-0000-4000-8000-000000000444",
                strength: "weak",
              },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-retry-rollback"),
            text: "New task after rollback.",
            attachments: [],
          }),
        );
        assert.equal(
          harness.getOpenedOptions()?.resumeSessionAt,
          "00000000-0000-4000-8000-000000000444",
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000931",
            text: "Made progress on the new task.",
          }),
        );
        yield* overload(harness);
        yield* Queue.shutdown(harness.sdkMessages);
        yield* TestClock.adjust(7_500);
        yield* harness.until(
          () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.equal(harness.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
        assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000935",
            result: "Finished the new task.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect(
      "delivers steering accepted during a closed-process backoff instead of a synthetic prompt",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const input = yield* start(harness);
          yield* overload(harness);
          yield* Queue.shutdown(harness.sdkMessages);
          yield* TestClock.adjust(1_000);
          for (const text of ["Do this instead.", "Keep these additional requirements."]) {
            yield* harness.runtime.steerTurn({
              threadId: harness.threadId,
              runId: input.runId,
              providerThread: harness.providerThread,
              providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeTurnId: `turn:${input.attemptId}`,
              }),
              message: { ...input.message, text },
            });
          }
          assert.lengthOf(harness.offeredMessages, 1);
          yield* TestClock.adjust(6_500);
          yield* harness.until(
            () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
          );
          assert.lengthOf(harness.terminalEvents(), 0);
          assert.isUndefined(harness.offeredMessages[1]?.isSynthetic);
          assert.include(String(harness.offeredMessages[1]?.message.content), "Do this instead.");
          assert.include(
            String(harness.offeredMessages[1]?.message.content),
            "Keep these additional requirements.",
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000936",
              result: "Followed the new instructions.",
            }),
          );
          yield* harness.awaitTerminal(1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each(["stream", "reopen"] as const)(
      "fails permanent SDK startup errors during %s",
      (phase) =>
        Effect.gen(function* () {
          const errors = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>();
          const error = new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
            method: phase === "stream" ? "fromAsyncIterable" : "query",
            cause:
              phase === "stream"
                ? Object.assign(new Error("Failed to spawn Claude Code process"), {
                    code: "EACCES",
                    errorClass: "executable_launch_failed",
                  })
                : { errorClass: "configuration_error", startupFatal: true },
          });
          const harness = yield* makeWakeHarnessWithOptions({
            freshQueueOnReopen: true,
            queryFailure: Queue.take(errors).pipe(Effect.flatMap(Effect.fail)),
            ...(phase === "reopen" ? { reopenFailure: Effect.fail(error) } : {}),
          });
          yield* start(harness);
          if (phase === "stream") yield* Queue.offer(errors, error);
          else {
            yield* overload(harness);
            yield* Queue.shutdown(harness.sdkMessages);
            yield* TestClock.adjust(7_500);
          }
          yield* harness.until(
            () =>
              harness.terminalEvents().length > 0 ||
              (phase === "stream"
                ? retryItems(harness.events).length > 0
                : retryItems(harness.events).at(-1)?.retry?.attempt === 2),
          );
          assert.equal(harness.terminalEvents()[0]?.status, "failed");
          yield* TestClock.adjust("5 minutes");
          assert.lengthOf(harness.offeredMessages, 1);
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each(["authentication_failed", "invalid_request"] as const)(
      "does not inherit overload retryability after %s",
      (error) =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* start(harness);
          yield* overload(harness);
          yield* TestClock.adjust(7_500);
          yield* harness.until(() => harness.offeredMessages.length === 2);
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000932",
              error,
              text: "This request cannot continue.",
            }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000933",
              result: "This request cannot continue.",
              isError: true,
              terminalReason: "api_error",
            }),
          );
          yield* harness.until(
            () =>
              harness.terminalEvents().length > 0 ||
              retryItems(harness.events).at(-1)?.retry?.attempt === 2,
          );
          assert.equal(harness.terminalEvents()[0]?.status, "failed");
          yield* TestClock.adjust("5 minutes");
          assert.lengthOf(harness.offeredMessages, 2);
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each(["reopen", "offer"] as const)("recovers from a temporary %s failure", (phase) =>
      Effect.gen(function* () {
        let fail = true;
        const temporaryFailure = Effect.suspend(() => {
          if (!fail) return Effect.void;
          fail = false;
          return Effect.fail(
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: phase === "reopen" ? "setMcpServers" : "offer",
              cause:
                phase === "reopen"
                  ? "Claude Code did not answer the MCP server registration."
                  : { code: "ECONNRESET" },
            }),
          );
        });
        const harness = yield* makeWakeHarnessWithOptions({
          freshQueueOnReopen: true,
          ...(phase === "reopen"
            ? { reopenFailure: temporaryFailure }
            : { offerFailure: temporaryFailure }),
        });
        const input = yield* start(harness);
        yield* overload(harness);
        yield* Queue.shutdown(harness.sdkMessages);
        yield* TestClock.adjust(1_000);
        if (phase === "offer") {
          yield* harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${input.attemptId}`,
            }),
            message: { ...input.message, text: "Preserve this steering across the failed offer." },
          });
        }
        yield* TestClock.adjust(6_500);
        yield* harness.until(
          () =>
            harness.terminalEvents().length > 0 ||
            retryItems(harness.events).at(-1)?.retry?.attempt === 2,
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust(15_000);
        yield* harness.until(
          () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        if (phase === "offer") {
          assert.include(
            String(harness.offeredMessages[1]?.message.content),
            "Preserve this steering across the failed offer.",
          );
          assert.isUndefined(harness.offeredMessages[1]?.isSynthetic);
        }
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000934", result: "Recovered." }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each([529, 500, 503, 408, undefined])(
      "continues the same run after an exhausted API failure (%s)",
      (status) =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* start(harness);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000901",
              result:
                status === undefined
                  ? "API Error: Connection error."
                  : "API Error: Repeated failures.",
              isError: status !== 529,
              terminalReason: status === 529 ? null : "api_error",
              ...(status === undefined ? {} : { apiErrorStatus: status }),
            }),
          );
          yield* harness.until(
            () => retryItems(harness.events).length > 0 || harness.terminalEvents().length > 0,
          );
          const running = retryItems(harness.events)[0];
          assert.equal(running?.status, "running");
          assert.deepEqual(running?.retry, { attempt: 1, maxAttempts: null, retryDelayMs: 7_500 });
          assert.lengthOf(harness.terminalEvents(), 0);
          yield* TestClock.adjust(7_499);
          assert.lengthOf(harness.offeredMessages, 1);
          yield* TestClock.adjust(1);
          yield* harness.until(() => harness.offeredMessages.length === 2);
          const continuation = harness.offeredMessages[1]!;
          assert.isTrue(continuation.isSynthetic);
          assert.notEqual(continuation.uuid, harness.promptUuid(0));
          assert.equal(continuation.session_id, WAKE_NATIVE_SESSION);
          yield* harness.offerAndWait(
            makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              text: "Resuming the task.",
            }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000903",
              result: "Done.",
            }),
          );
          yield* harness.awaitTerminal(1);
          const recovered = retryItems(harness.events).at(-1);
          assert.equal(recovered?.id, running?.id);
          assert.equal(recovered?.status, "completed");
          assert.equal(recovered?.title, "Provider recovered");
          assert.deepEqual(
            harness.terminalEvents().map((event) => event.status),
            ["completed"],
          );
          assert.isFalse(
            harness.events.some(
              (event) => event.type === "message.updated" && event.message.role === "user",
            ),
          );
          assert.lengthOf(harness.continuationRequests, 0);
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("resumes the same native session if the exhausted process closes", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
        yield* start(harness);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000911",
            result: "API Error: Repeated 529 Overloaded errors",
            isError: true,
            apiErrorStatus: 529,
            terminalReason: "api_error",
          }),
        );
        yield* Queue.shutdown(harness.sdkMessages);
        yield* TestClock.adjust(7_500);
        yield* harness.until(
          () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.lengthOf(harness.processQueues, 2);
        assert.equal(harness.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000912",
            result: "Recovered.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each([undefined, 503, 400, 429])(
      "handles an SDK stream failure with HTTP status %s",
      (status) =>
        Effect.gen(function* () {
          const errors = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>();
          const harness = yield* makeWakeHarnessWithOptions({
            freshQueueOnReopen: true,
            queryFailure: Queue.take(errors).pipe(Effect.flatMap(Effect.fail)),
          });
          yield* start(harness);
          yield* Queue.offer(
            errors,
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "fromAsyncIterable",
              cause: { message: "Connection failed.", ...(status === undefined ? {} : { status }) },
            }),
          );
          const recoverable = status === undefined || status === 503;
          yield* harness.until(
            () => retryItems(harness.events).length > 0 || harness.terminalEvents().length > 0,
          );
          if (recoverable) {
            assert.lengthOf(harness.terminalEvents(), 0);
            yield* TestClock.adjust(7_500);
            yield* harness.until(() => harness.offeredMessages.length === 2);
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000915",
                result: "Recovered.",
              }),
            );
          }
          yield* harness.awaitTerminal(1);
          assert.equal(harness.terminalEvents()[0]?.status, recoverable ? "completed" : "failed");
          yield* TestClock.adjust("5 minutes");
          assert.lengthOf(harness.offeredMessages, recoverable ? 2 : 1);
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("steering replaces the pending internal continuation", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const input = yield* start(harness);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000913",
            result: "API Error: Repeated 529 Overloaded errors",
            isError: true,
            apiErrorStatus: 529,
            terminalReason: "api_error",
          }),
        );
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: { ...input.message, text: "Follow the updated instructions." },
        });
        yield* TestClock.adjust("5 minutes");
        yield* harness.until(
          () => harness.offeredMessages.length === 2 || harness.terminalEvents().length > 0,
        );
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isUndefined(harness.offeredMessages[1]?.isSynthetic);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000914",
            result: "Done.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("backs off without an attempt cap and resets only after root progress", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* start(harness);
        const failure = (includeStatus = true) =>
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000906",
            result: "API Error: Request failed.",
            ...(includeStatus ? { apiErrorStatus: 529 } : {}),
            terminalReason: "api_error",
            isError: true,
          });
        const delays = [7_500, 15_000, 30_000, 60_000, 120_000, 135_000, 135_000];
        for (const [index, delay] of delays.entries()) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "api_retry",
              attempt: 10,
              max_retries: 10,
              retry_delay_ms: 1_000,
              error_status: null,
              error: "connection_error",
              uuid: "00000000-0000-4000-8000-000000000916",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000907",
              error: "server_error",
              text: "API Error: Repeated 529 Overloaded errors",
            }),
          );
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000908",
              error: undefined,
              parentToolUseId: "nested-agent-tool",
            }),
          );
          yield* harness.offerAndWait(failure(index !== 0));
          yield* harness.until(
            () => retryItems(harness.events).at(-1)?.retry?.retryDelayMs === delay,
          );
          assert.deepEqual(retryItems(harness.events).at(-1)?.retry, {
            attempt: index + 1,
            maxAttempts: null,
            retryDelayMs: delay,
          });
          yield* TestClock.adjust(delay);
          yield* harness.until(() => harness.offeredMessages.length === index + 2);
        }
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text.includes("API Error"),
          ),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000909",
            text: "Made progress.",
          }),
        );
        yield* harness.offerAndWait(failure());
        yield* harness.until(
          () =>
            retryItems(harness.events).at(-1)?.status === "running" &&
            retryItems(harness.events).at(-1)?.retry?.attempt === 1,
        );
        assert.equal(retryItems(harness.events).at(-1)?.retry?.retryDelayMs, 7_500);
        yield* TestClock.adjust(7_500);
        yield* harness.until(() => harness.offeredMessages.length === 9);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000910",
            result: "Done.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(retryItems(harness.events).at(-1)?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("fails the run once retries pass a day without progress", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* start(harness);
        const failure = makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000911",
          result: "API Error: Request failed.",
          apiErrorStatus: 529,
          terminalReason: "api_error",
          isError: true,
        });
        yield* harness.offerAndWait(failure);
        yield* harness.until(() => retryItems(harness.events).length > 0);
        yield* TestClock.adjust(7_500);
        yield* harness.until(() => harness.offeredMessages.length === 2);
        // The continuation stays silent for a day, then fails again.
        yield* TestClock.adjust("24 hours");
        yield* harness.offerAndWait(failure);
        yield* harness.awaitTerminal(1);
        const [terminal] = harness.terminalEvents();
        assert.equal(terminal?.status, "failed");
        assert.equal(terminal?.status === "failed" ? terminal.retry?.attempt : null, 1);
        assert.lengthOf(harness.offeredMessages, 2);
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect("recovers a background-task wake without opening another T3 run", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const input = yield* start(harness);
        yield* harness.offerAndWait(wakeTaskStarted);
        yield* harness.offerAndWait(turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* harness.offerAndWait(wakeNotification);
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.awaitContinuation(1);
        yield* harness.runtime.startTurn({
          ...input,
          attemptId: RunAttemptId.make("attempt-claude-recovery-wake"),
          providerTurnOrdinal: 2,
          message: {
            ...input.message,
            createdBy: "agent",
            creationSource: "provider",
            text: "Background task completed.",
          },
        });
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000917",
            result: "API Error: Repeated 529 Overloaded errors",
            isError: true,
            apiErrorStatus: 529,
            terminalReason: "api_error",
            origin: { kind: "task-notification" },
          }),
        );
        yield* TestClock.adjust(7_500);
        yield* harness.until(() => harness.offeredMessages.length === 2);
        assert.lengthOf(harness.terminalEvents(), 1);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000918",
            result: "Finished the background work.",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed", "completed"],
        );
        assert.lengthOf(harness.continuationRequests, 1);
        assert.equal(retryItems(harness.events).at(-1)?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each(["backoff", "continuation", "closed process", "queued steering"] as const)(
      "Stop cancels an exhausted API retry during %s",
      (phase) =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarnessWithOptions({ close: Queue.shutdown });
          const input = yield* start(harness);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000904",
              result: "API Error: Repeated 529 Overloaded errors",
              isError: true,
              apiErrorStatus: 529,
              terminalReason: "api_error",
            }),
          );
          yield* harness.until(
            () => retryItems(harness.events).length > 0 || harness.terminalEvents().length > 0,
          );
          assert.lengthOf(harness.terminalEvents(), 0);
          if (phase === "closed process" || phase === "queued steering") {
            yield* Queue.shutdown(harness.sdkMessages);
            yield* TestClock.adjust(7_499);
          }
          if (phase === "queued steering") {
            yield* harness.runtime.steerTurn({
              threadId: harness.threadId,
              runId: input.runId,
              providerThread: harness.providerThread,
              providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeTurnId: `turn:${input.attemptId}`,
              }),
              message: { ...input.message, text: "This steering must be cancelled by Stop." },
            });
          }
          if (phase === "continuation") {
            yield* TestClock.adjust(7_500);
            yield* harness.until(() => harness.offeredMessages.length === 2);
          }
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${input.attemptId}`,
            }),
          });
          yield* harness.awaitTerminal(1);
          yield* TestClock.adjust("5 minutes");
          assert.lengthOf(harness.offeredMessages, phase === "continuation" ? 2 : 1);
          assert.deepEqual(
            harness.terminalEvents().map((event) => event.status),
            ["interrupted"],
          );
          assert.equal(retryItems(harness.events).at(-1)?.status, "interrupted");
        }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );

    it.effect.each([400, 401, 403, 429])("still fails a nonrecoverable API status %s", (status) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* start(harness);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000905",
            result: `API Error: ${status} rejected.`,
            isError: true,
            apiErrorStatus: status,
            terminalReason: "api_error",
          }),
        );
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, status === 429 ? "usage_limit" : "provider_error");
        yield* TestClock.adjust("5 minutes");
        assert.lengthOf(harness.offeredMessages, 1);
        assert.lengthOf(retryItems(harness.events), 0);
      }).pipe(Effect.scoped, Effect.provide(recoveryLayers)),
    );
  });
}
