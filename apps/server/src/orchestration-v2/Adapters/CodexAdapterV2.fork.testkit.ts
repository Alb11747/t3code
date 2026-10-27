import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  type CodexSettings,
  type OrchestrationV2ProviderThread,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexReplay from "effect-codex-app-server/replay";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import * as PromptSuggestions from "../../provider/PromptSuggestions.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import type { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

type ReplayEntry = CodexReplay.CodexAppServerReplayEntry;

export interface CodexAdapterForkSuiteInput {
  readonly DEFAULT_CODEX_SETTINGS: CodexSettings;
  readonly makeCodexReplayHarness: (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    onEvent?: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown>,
    onRequest?: (method: string, params: unknown) => Effect.Effect<void>,
    readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
    adapterOptions?: Partial<
      Pick<CodexAdapterV2.CodexAdapterV2Options, "settings" | "promptSuggestions">
    >,
    decorateClient?: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => CodexClient.CodexAppServerClient["Service"],
  ) => Effect.Effect<
    {
      readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly threadId: ThreadId;
      readonly events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
      readonly terminalEvents: () => ReadonlyArray<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >;
      readonly hasPendingBackgroundWork: Effect.Effect<boolean>;
      readonly firstTerminal: Effect.Effect<void>;
      readonly until: (predicate: () => boolean) => Effect.Effect<void>;
    },
    ProviderAdapter.ProviderAdapterV2Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | IdAllocator.IdAllocatorV2
    | McpProviderSessions.McpProviderSessions
    | Path.Path
    | Scope.Scope
  >;
  readonly makeCodexReplayTranscript: (input: {
    readonly scenario: string;
    readonly entries: ReadonlyArray<ReplayEntry>;
  }) => CodexReplay.CodexAppServerReplayTranscript;
  readonly codexReplayPreamble: (input: {
    readonly nativeThreadId: string;
    readonly nativeTurnId: string;
    readonly prompt: string;
    readonly sentPrompt?: string;
  }) => Array<ReplayEntry>;
  readonly makeCodexReplayTurn: (input: {
    readonly id: string;
    readonly status: "inProgress" | "completed" | "interrupted" | "failed";
  }) => Record<string, unknown>;
  readonly makeCodexTestTurnInput: (input: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly now: DateTime.Utc;
    readonly attemptId: RunAttemptId;
    readonly text: string;
  }) => ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly withReplayRequestId: (entry: ReplayEntry, id: number) => ReplayEntry;
}

/**
 * Fork-only Codex adapter cases (composer predictions, abandoned turn starts, overload
 * retries), registered inside the upstream suite so they share its replay harness.
 */
export function runCodexAdapterForkSuite(input: CodexAdapterForkSuiteInput) {
  const {
    DEFAULT_CODEX_SETTINGS,
    makeCodexReplayHarness,
    makeCodexReplayTranscript,
    codexReplayPreamble,
    makeCodexReplayTurn,
    makeCodexTestTurnInput,
    withReplayRequestId,
  } = input;

  it.effect.each([
    {
      name: "web prompt in an agent-created thread",
      message: { createdBy: "user", creationSource: "web" },
      predict: true,
    },
    {
      name: "mobile prompt in an agent-created thread",
      message: { createdBy: "user", creationSource: "mobile" },
      predict: true,
    },
    {
      name: "agent launch or follow-up",
      message: { createdBy: "agent", creationSource: "mcp" },
      predict: false,
    },
    {
      name: "automatic provider wake",
      message: { createdBy: "agent", creationSource: "provider" },
      predict: false,
    },
    {
      name: "system prompt",
      message: { createdBy: "system", creationSource: "server" },
      predict: false,
    },
    {
      name: "user-created scheduled task",
      message: {
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: ScheduledTaskId.make("scheduled-prediction"),
      },
      predict: false,
    },
  ] as const)("only requests composer predictions for a direct user prompt: $name", (testCase) =>
    Effect.gen(function* () {
      const nativeThreadId = "prediction-origin-thread";
      const nativeTurnId = "prediction-origin-turn";
      const prompt = "Implement";
      const completed = yield* Deferred.make<void>();
      const authRequests: unknown[] = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: `prediction-origin-${testCase.name}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        }),
        undefined,
        undefined,
        undefined,
        { settings: { ...DEFAULT_CODEX_SETTINGS, promptSuggestions: true } },
        (client) => ({
          ...client,
          request: ((method: string, params: unknown) => {
            if (method === "getAuthStatus") {
              authRequests.push(params);
              return Effect.succeed({ authMethod: null, authToken: null });
            }
            return client.raw.request(method, params);
          }) as CodexClient.CodexAppServerClient["Service"]["request"],
          handleServerNotification: (method, handler) =>
            client.handleServerNotification(method, (payload) =>
              handler(payload).pipe(
                Effect.tap(() =>
                  method === "turn/completed"
                    ? Deferred.succeed(completed, undefined)
                    : Effect.void,
                ),
              ),
            ),
        }),
      );
      const turnInput = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("prediction-origin-attempt"),
        text: prompt,
      });
      yield* harness.runtime.startTurn({
        ...turnInput,
        appThread: { ...turnInput.appThread, createdBy: "agent", creationSource: "mcp" },
        message: { ...turnInput.message, ...testCase.message },
      });
      yield* Deferred.await(completed);
      yield* TestClock.adjust("0 millis");
      assert.lengthOf(authRequests, testCase.predict ? 1 : 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { action: "next turn", late: false },
    { action: "rollback", late: false },
    { action: "close", late: false },
    { action: "next turn", late: true },
    { action: "rollback", late: true },
    { action: "close", late: true },
    { action: "provider switch", late: true },
  ] as const)("revokes composer predictions on $action (late=$late)", ({ action, late }) =>
    Effect.gen(function* () {
      const nativeThreadId = "prediction-thread";
      const nativeTurnId = "prediction-native-turn";
      const prompt = "Implement";
      const nextTurn: Array<CodexReplay.CodexAppServerReplayEntry> = [
        {
          type: "expect_outbound",
          frame: {
            id: 4,
            method: "turn/start",
            params: {
              threadId: nativeThreadId,
              input: [{ type: "text", text: "Next" }],
              cwd: "/workspace",
              model: "gpt-5.4",
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "dangerFullAccess" },
              summary: "detailed",
              collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
            },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 4,
            result: { turn: makeCodexReplayTurn({ id: "next-turn", status: "inProgress" }) },
          },
        },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: `prediction-${action}-${late}`,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            label: "completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
          ...(action === "next turn" ? nextTurn : []),
        ],
      });
      const store = yield* PromptSuggestions.make;
      const suggested = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const responseReturned = yield* Deferred.make<void>();
      let resolveResponse!: (response: Response) => void;
      let signal: AbortSignal | null | undefined;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        if (init?.method === "GET") return Response.json({ is_enabled: true, prompt: "Predict" });
        signal = init?.signal;
        if (!late) {
          Deferred.doneUnsafe(requested, Effect.void);
          return new Response(
            'data: {"type":"response.output_text.delta","delta":"{\\"suggestion\\":\\"Add tests\\"}"}\n\ndata: {"type":"response.completed"}\n\n',
          );
        }
        const response = await new Promise<Response>((resolve) => {
          resolveResponse = resolve;
          Deferred.doneUnsafe(requested, Effect.void);
        });
        Deferred.doneUnsafe(responseReturned, Effect.void);
        return response;
      };
      const sessionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
      const harness = yield* makeCodexReplayHarness(
        transcript,
        undefined,
        undefined,
        undefined,
        {
          settings: { ...DEFAULT_CODEX_SETTINGS, promptSuggestions: true },
          promptSuggestions: {
            ...store,
            publish: (threadId, suggestion) =>
              store
                .publish(threadId, suggestion)
                .pipe(Effect.andThen(Deferred.succeed(suggested, undefined))),
          },
        },
        (client) => ({
          ...client,
          request: ((method: string, params: unknown) => {
            if (method === "getAuthStatus")
              return Effect.succeed({ authMethod: "chatgpt", authToken: "token" });
            if (method === "config/read") return Effect.succeed({ config: {} });
            if (method === "thread/read") return Effect.succeed({ thread: { turns: [] } });
            return client.raw.request(method, params);
          }) as CodexClient.CodexAppServerClient["Service"]["request"],
          raw: {
            ...client.raw,
            request: (method, params) =>
              method === "account/read"
                ? Effect.succeed({
                    workspaceRouting: {
                      backendOrigin: "https://chatgpt.example",
                      chatgptAccountId: "account",
                    },
                  })
                : client.raw.request(method, params),
          },
        }),
      ).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      const turnInput = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("prediction-attempt"),
        text: prompt,
      });
      yield* harness.runtime
        .startTurn(turnInput)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const current = store.stream(harness.threadId).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map(([suggestion]) => suggestion),
      );
      const lateResponse = () =>
        resolveResponse(
          new Response(
            'data: {"type":"response.output_text.delta","delta":"{\\"suggestion\\":\\"Too late\\"}"}\n\ndata: {"type":"response.completed"}\n\n',
          ),
        );
      yield* harness.firstTerminal;
      yield* Deferred.await(requested);
      if (!late) {
        yield* Deferred.await(suggested);
        const suggestion = yield* current;
        assert.equal(suggestion?.text, "Add tests");
        assert.equal(suggestion?.runId, turnInput.runId);
        assert.match(suggestion!.id, /^[0-9a-f-]{36}$/);
      }
      if (action === "provider switch") {
        // Another provider's run takes the thread while this session stays open.
        const newer = { id: "newer", runId: RunId.make("other-provider-run"), text: "Keep going" };
        yield* store.claim(harness.threadId, newer.runId);
        yield* store.publish(harness.threadId, newer);
        lateResponse();
        yield* Deferred.await(suggested);
        assert.deepEqual(yield* current, newer, "A stale run must not publish");
        yield* Scope.close(sessionScope, Exit.void);
        assert.deepEqual(yield* current, newer, "A stale run must not clear");
        return;
      }
      if (action === "next turn") {
        yield* harness.runtime.startTurn({
          ...turnInput,
          message: { ...turnInput.message, text: "Next" },
          runId: RunId.make("next-run"),
          attemptId: RunAttemptId.make("next-attempt"),
        });
      } else if (action === "rollback") {
        yield* harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("prediction-checkpoint"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [],
        });
      } else {
        yield* Scope.close(sessionScope, Exit.void);
      }
      assert.isNull(yield* current);
      if (late) {
        assert.isTrue(signal?.aborted);
        lateResponse();
        yield* Deferred.await(responseReturned);
        yield* Effect.yieldNow;
        assert.isNull(yield* current, "Late results must not publish");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("skips two cancelled queued starts and waits for an abandoned turn to complete", () =>
    Effect.gen(function* () {
      const nativeThreadId = "queued-cancel-thread";
      const abandonedTurnId = "abandoned-turn";
      const retriedTurnId = "successful-retry-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: retriedTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "queued-cancelled-starts",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: abandonedTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: {
                threadId: nativeThreadId,
                turnId: abandonedTurnId,
              },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            afterMs: 1000,
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: abandonedTurnId, status: "interrupted" }),
              },
            },
          },
          withReplayRequestId(preamble.at(-3)!, 5),
          withReplayRequestId(preamble.at(-2)!, 5),
          preamble.at(-1)!,
        ],
      });
      const requests: Array<string> = [];
      const registeredTurns = new Set<string>();
      const interrupted = yield* Deferred.make<void>();
      const retryRegistered = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated") {
              const id = event.providerTurn.nativeTurnRef?.nativeId;
              if (id != null) registeredTurns.add(id);
              if (id === retriedTurnId) yield* Deferred.succeed(retryRegistered, undefined);
            }
          }),
        (method) =>
          Effect.sync(() => requests.push(method)).pipe(
            Effect.andThen(
              method === "turn/interrupt"
                ? Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      );
      const turnInput = (attempt: string) =>
        Effect.map(DateTime.now, (now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text: prompt,
          }),
        );
      const first = yield* harness.runtime
        .startTurn(yield* turnInput("first"))
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("0 millis");
      for (const attempt of ["queued-one", "queued-two"]) {
        const queued = yield* harness.runtime
          .startTurn(yield* turnInput(attempt))
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("0 millis");
        yield* Fiber.interrupt(queued);
      }
      yield* Fiber.interrupt(first);
      const retry = yield* harness.runtime
        .startTurn(yield* turnInput("retry"))
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(interrupted);
      assert.lengthOf(
        requests.filter((method) => method === "turn/start"),
        1,
      );
      assert.deepEqual([...registeredTurns], []);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(retry);
      yield* Deferred.await(retryRegistered);
      assert.lengthOf(
        requests.filter((method) => method === "turn/start"),
        2,
      );
      assert.deepEqual([...registeredTurns], [retriedTurnId]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps a newer start from adopting an abandoned compact turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "abandoned-compact-thread";
      const compactTurnId = "abandoned-compact-turn";
      const retriedTurnId = "after-compact-retry-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: retriedTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "abandoned-compact-start-then-retry",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            frame: { id: 3, method: "thread/compact/start", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: compactTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: compactTurnId },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: compactTurnId, status: "interrupted" }),
              },
            },
          },
          withReplayRequestId(preamble.at(-3)!, 5),
          withReplayRequestId(preamble.at(-2)!, 5),
          preamble.at(-1)!,
        ],
      });
      const registeredTurns = new Set<string>();
      const retryRegistered = yield* Deferred.make<void>();
      const interruptedTurns: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) => {
          if (event.type !== "provider_turn.updated") return Effect.void;
          const nativeId = event.providerTurn.nativeTurnRef?.nativeId;
          if (nativeId != null) registeredTurns.add(nativeId);
          return nativeId === retriedTurnId
            ? Deferred.succeed(retryRegistered, undefined)
            : Effect.void;
        },
        (method, params) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") {
              interruptedTurns.push((params as { turnId: string }).turnId);
            }
          }),
      );
      const turnInput = (attempt: string) =>
        Effect.map(DateTime.now, (now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text: prompt,
          }),
        );
      const compacting = yield* harness.runtime.compactThread!(
        yield* turnInput("abandoned-compact-attempt"),
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust("0 millis");
      yield* Fiber.interrupt(compacting);
      const retry = yield* harness.runtime
        .startTurn(yield* turnInput("after-compact-retry-attempt"))
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(retry);
      yield* Deferred.await(retryRegistered);
      assert.deepEqual(interruptedTurns, [compactTurnId]);
      assert.deepEqual([...registeredTurns], [retriedTurnId]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("does not publish an abandoned turn after a suspended suggestion claim", () =>
    Effect.gen(function* () {
      const nativeThreadId = "cancelled-registration-thread";
      const abandonedTurnId = "cancelled-registration-turn";
      const retriedTurnId = "registration-retry-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: abandonedTurnId,
        prompt,
      });
      const retryPreamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: retriedTurnId,
        prompt,
      });
      const completed = (id: string): CodexReplay.CodexAppServerReplayEntry => ({
        type: "emit_inbound",
        frame: {
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id, status: "completed" }),
          },
        },
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "cancelled-during-prediction-cleanup",
        entries: [
          ...preamble.slice(0, -1),
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: abandonedTurnId },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          completed(abandonedTurnId),
          withReplayRequestId(retryPreamble.at(-3)!, 5),
          withReplayRequestId(retryPreamble.at(-2)!, 5),
          retryPreamble.at(-1)!,
          completed(retriedTurnId),
        ],
      });
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const retryRegistered = yield* Deferred.make<void>();
      const registeredTurns = new Set<string>();
      let claimCount = 0;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          Effect.gen(function* () {
            if (event.type !== "provider_turn.updated") return;
            const id = event.providerTurn.nativeTurnRef?.nativeId;
            if (id != null) registeredTurns.add(id);
            if (id === retriedTurnId) yield* Deferred.succeed(retryRegistered, undefined);
          }),
        undefined,
        undefined,
        {
          promptSuggestions: {
            publish: () => Effect.void,
            clear: () => Effect.void,
            // Hold the first claim, made once the native response starts
            // registration, until the retry has started.
            claim: () =>
              Effect.gen(function* () {
                claimCount++;
                if (claimCount === 1) {
                  yield* Deferred.succeed(cleanupStarted, undefined);
                  yield* Deferred.await(releaseCleanup);
                }
              }),
          },
        },
      );
      const turnInput = (attempt: string) =>
        Effect.map(DateTime.now, (now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text: prompt,
          }),
        );
      const first = yield* harness.runtime
        .startTurn(yield* turnInput("cancelled"))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(cleanupStarted);
      yield* Fiber.interrupt(first);
      assert.deepEqual([...registeredTurns], []);
      const retry = yield* harness.runtime
        .startTurn(yield* turnInput("retry"))
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseCleanup, undefined);
      yield* Fiber.join(retry);
      yield* Deferred.await(retryRegistered);
      yield* harness.firstTerminal;
      assert.deepEqual([...registeredTurns], [retriedTurnId]);
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("allows a healthy compact after an abandoned start is rejected late", () =>
    Effect.gen(function* () {
      const nativeThreadId = "late-rejected-start-thread";
      const nativeTurnId = "healthy-compact-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "late-rejected-start-then-compact",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            afterMs: 1000,
            frame: { id: 3, error: { code: -32603, message: "Start rejected." } },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "thread/compact/start",
              params: { threadId: nativeThreadId },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          preamble.at(-1)!,
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const requests: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) => Effect.sync(() => requests.push(method)),
      );
      const turnInput = (attempt: string) =>
        Effect.map(DateTime.now, (now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text: prompt,
          }),
        );
      const first = yield* harness.runtime
        .startTurn(yield* turnInput("rejected"))
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("0 millis");
      yield* Fiber.interrupt(first);
      const compact = yield* harness.runtime.compactThread!(yield* turnInput("compact")).pipe(
        Effect.forkScoped,
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(compact);
      yield* harness.firstTerminal;
      assert.notInclude(requests, "turn/interrupt");
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("does not abandon an already completed turn when its start response is withheld", () =>
    Effect.gen(function* () {
      const nativeThreadId = "completed-before-start-response-thread";
      const completedTurnId = "already-completed-turn";
      const retriedTurnId = "after-completion-retry-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: completedTurnId,
        prompt,
      });
      const retryPreamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: retriedTurnId,
        prompt,
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "completed-before-abandoned-start-response",
        entries: [
          ...preamble.slice(0, -2),
          preamble.at(-1)!,
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: completedTurnId, status: "completed" }),
              },
            },
          },
          preamble.at(-2)!,
          withReplayRequestId(retryPreamble.at(-3)!, 4),
          // Report the retry's native start before answering its request: any
          // phantom abandoned marker would interrupt this legitimate turn.
          retryPreamble.at(-1)!,
          withReplayRequestId(retryPreamble.at(-2)!, 4),
        ],
      });
      const registeredTurns = new Set<string>();
      const retryRegistered = yield* Deferred.make<void>();
      const requests: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) => {
          if (event.type !== "provider_turn.updated") return Effect.void;
          const nativeId = event.providerTurn.nativeTurnRef?.nativeId;
          if (nativeId != null) registeredTurns.add(nativeId);
          return nativeId === retriedTurnId
            ? Deferred.succeed(retryRegistered, undefined)
            : Effect.void;
        },
        (method) => Effect.sync(() => requests.push(method)),
      );
      const turnInput = (attempt: string) =>
        Effect.map(DateTime.now, (now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text: prompt,
          }),
        );
      const starting = yield* harness.runtime
        .startTurn(yield* turnInput("already-completed-attempt"))
        .pipe(Effect.forkScoped);
      yield* harness.firstTerminal;
      yield* Fiber.join(starting);
      yield* harness.runtime.startTurn(yield* turnInput("after-completion-retry-attempt"));
      yield* Deferred.await(retryRegistered);
      assert.notInclude(requests, "turn/interrupt");
      assert.deepEqual([...registeredTurns], [completedTurnId, retriedTurnId]);
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  describe("overload retries", () => {
    // A zero draw gives each backoff step its full length, so delays are exact.
    const fullRetryDelays = Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 0,
      nextIntUnsafe: () => 0,
    });
    const nativeThreadId = "overload-thread";
    const prompt = "Fix the build";
    const turnCompleted = (id: string, status: "completed" | "failed", includeErrorInfo = true) =>
      ({
        type: "emit_inbound",
        label: `turn/completed ${id}`,
        frame: {
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: {
              ...makeCodexReplayTurn({ id, status }),
              ...(status === "failed"
                ? {
                    error: {
                      message: "Selected model is at capacity. Please try a different model.",
                      ...(includeErrorInfo ? { codexErrorInfo: "serverOverloaded" as const } : {}),
                    },
                  }
                : {}),
            },
          },
        },
      }) satisfies CodexReplay.CodexAppServerReplayEntry;
    const retryRows = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "error" &&
        event.turnItem.retry !== undefined
          ? [
              [
                event.turnItem.status,
                event.turnItem.retry.attempt,
                event.turnItem.retry.retryDelayMs,
              ],
            ]
          : [],
      );
    const runInput = (harness: {
      readonly threadId: ThreadId;
      readonly providerThread: OrchestrationV2ProviderThread;
    }) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("overload-attempt"),
            text: prompt,
          }),
        ),
      );
    const providerTurnId = (nativeTurnId: string) =>
      IdAllocator.IdAllocatorV2.pipe(
        Effect.map((ids) =>
          ids.derive.providerTurn({ driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeTurnId }),
        ),
      );

    it.effect.each([
      { source: "completion", draw: 0, delayMs: 10_000 },
      { source: "notification", draw: 0, delayMs: 10_000 },
      // Threads failing together draw different waits from the upper half of the step.
      { source: "completion", draw: 0.5, delayMs: 7_500 },
    ] as const)(
      "continues an overloaded run reported by $source with an empty-input turn after a $delayMs ms backoff",
      ({ source, draw, delayMs }) =>
        Effect.gen(function* () {
          const transcript = makeCodexReplayTranscript({
            scenario: "overload-retry",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
              ...(source === "notification"
                ? [
                    {
                      type: "emit_inbound" as const,
                      label: "overload error notification",
                      frame: {
                        method: "error",
                        params: {
                          threadId: nativeThreadId,
                          turnId: "turn-1",
                          willRetry: false,
                          error: {
                            message: "Selected model is at capacity. Please try a different model.",
                            codexErrorInfo: "serverOverloaded",
                          },
                        },
                      },
                    },
                  ]
                : []),
              turnCompleted("turn-1", "failed", source === "completion"),
              {
                type: "expect_outbound",
                label: "retry turn/start",
                frame: {
                  id: 4,
                  method: "turn/start",
                  params: {
                    threadId: nativeThreadId,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "detailed",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "retry turn/start",
                frame: {
                  id: 4,
                  result: { turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }) },
                },
              },
              {
                type: "emit_inbound",
                label: "retry turn/started",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
                  },
                },
              },
              turnCompleted("turn-2", "completed"),
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(yield* runInput(harness));
          yield* harness.until(() => retryRows(harness.events).length > 0);
          // The run stays open through the backoff.
          assert.lengthOf(harness.terminalEvents(), 0);
          yield* TestClock.adjust(delayMs);
          yield* harness.firstTerminal;

          assert.deepEqual(
            harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
            [[yield* providerTurnId("turn-2"), "completed"]],
          );
          assert.deepEqual(retryRows(harness.events), [
            ["running", 1, delayMs],
            ["running", 1, null],
            ["completed", 1, null],
          ]);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              Layer.succeed(Random.Random, {
                nextDoubleUnsafe: () => draw,
                nextIntUnsafe: () => 0,
              }),
            ),
          ),
        ),
    );

    it.effect("stops an abandoned in-flight overload retry before submitting a newer turn", () =>
      Effect.gen(function* () {
        const retryId = "abandoned-capacity-retry";
        const nextId = "healthy-after-capacity-stop";
        const nextPrompt = "New user request";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt });
        const nextPreamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: nextId,
          prompt: nextPrompt,
        });
        const startEntry = preamble.at(-3)!;
        if (startEntry.type !== "expect_outbound") return yield* Effect.die("expected turn/start");
        const transcript = makeCodexReplayTranscript({
          scenario: "stop-withheld-overload-retry",
          entries: [
            ...preamble,
            turnCompleted("turn-1", "failed"),
            {
              type: "expect_outbound",
              frame: {
                ...(startEntry.frame as { params: object }),
                id: 4,
                params: { ...(startEntry.frame as { params: object }).params, input: [] },
              },
            },
            {
              type: "emit_inbound",
              afterMs: 1000,
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: retryId, status: "inProgress" }),
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "turn/interrupt",
                params: {
                  threadId: nativeThreadId,
                  turnId: retryId,
                },
              },
            },
            { type: "emit_inbound", frame: { id: 5, result: {} } },
            { ...turnCompleted(retryId, "completed"), afterMs: 1000 },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: { turn: makeCodexReplayTurn({ id: retryId, status: "inProgress" }) },
              },
            },
            withReplayRequestId(nextPreamble.at(-3)!, 6),
            withReplayRequestId(nextPreamble.at(-2)!, 6),
            nextPreamble.at(-1)!,
            turnCompleted(nextId, "completed"),
          ],
        });
        const scheduled = yield* Deferred.make<void>();
        const submitted = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const nextCompleted = yield* Deferred.make<void>();
        const nextProviderTurnId = yield* providerTurnId(nextId);
        const registered = new Set<string>();
        let starts = 0;
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) =>
            Effect.gen(function* () {
              if (event.type === "provider_turn.updated") {
                const id = event.providerTurn.nativeTurnRef?.nativeId;
                if (id != null) registered.add(id);
              }
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "error" &&
                event.turnItem.retry?.retryDelayMs === 10_000
              )
                yield* Deferred.succeed(scheduled, undefined);
              if (event.type === "turn.terminal" && event.providerTurnId === nextProviderTurnId)
                yield* Deferred.succeed(nextCompleted, undefined);
            }),
          (method) =>
            Effect.gen(function* () {
              if (method === "turn/start" && ++starts === 2)
                yield* Deferred.succeed(submitted, undefined);
              if (method === "turn/interrupt") yield* Deferred.succeed(interrupted, undefined);
            }),
        );
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* Deferred.await(scheduled);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(submitted);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.isTrue(
          yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: yield* providerTurnId("turn-1"),
          requestRuntimeRestart: true,
        });
        const nextInput = yield* runInput(harness);
        const next = yield* harness.runtime
          .startTurn({
            ...nextInput,
            attemptId: RunAttemptId.make("after-capacity-stop"),
            message: { ...nextInput.message, text: nextPrompt },
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(interrupted);
        assert.equal(starts, 2, "interrupt acknowledgement must not release the retry's lane");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.isTrue(
          yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(next);
        yield* Deferred.await(nextCompleted);
        assert.deepEqual([...registered], ["turn-1", nextId]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted", "completed"],
        );
        yield* TestClock.adjust("0 millis");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.isFalse(
          yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect("fails the run when the retry start goes unanswered and stops its late turn", () =>
      Effect.gen(function* () {
        const lateId = "late-capacity-retry";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt });
        const startEntry = preamble.at(-3)!;
        if (startEntry.type !== "expect_outbound") return yield* Effect.die("expected turn/start");
        const transcript = makeCodexReplayTranscript({
          scenario: "silent-overload-retry",
          entries: [
            ...preamble,
            turnCompleted("turn-1", "failed"),
            {
              type: "expect_outbound",
              frame: {
                ...(startEntry.frame as { params: object }),
                id: 4,
                params: { ...(startEntry.frame as { params: object }).params, input: [] },
              },
            },
            {
              type: "emit_inbound",
              afterMs: 121_000,
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: lateId, status: "inProgress" }),
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: lateId },
              },
            },
            { type: "emit_inbound", frame: { id: 5, result: {} } },
          ],
        });
        const scheduled = yield* Deferred.make<void>();
        const submitted = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const registered = new Set<string>();
        let starts = 0;
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) =>
            Effect.gen(function* () {
              if (event.type === "provider_turn.updated") {
                const id = event.providerTurn.nativeTurnRef?.nativeId;
                if (id != null) registered.add(id);
              }
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.type === "error" &&
                event.turnItem.retry?.retryDelayMs === 10_000
              )
                yield* Deferred.succeed(scheduled, undefined);
            }),
          (method) =>
            Effect.gen(function* () {
              if (method === "turn/start" && ++starts === 2)
                yield* Deferred.succeed(submitted, undefined);
              if (method === "turn/interrupt") yield* Deferred.succeed(interrupted, undefined);
            }),
        );
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* Deferred.await(scheduled);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(submitted);
        yield* TestClock.adjust("119 seconds");
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust("1 second");
        yield* harness.firstTerminal;
        const [terminal] = harness.terminalEvents();
        assert.equal(terminal?.providerTurnId, yield* providerTurnId("turn-1"));
        assert.equal(
          terminal?.status === "failed" ? terminal.failure.code : null,
          "serverOverloaded",
        );
        assert.deepEqual(retryRows(harness.events).at(-1)?.slice(0, 2), ["failed", 1]);

        yield* TestClock.adjust("1 second");
        yield* Deferred.await(interrupted);
        assert.deepEqual([...registered], ["turn-1"]);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect("keeps retrying past an hour and restarts the backoff after progress", () =>
      Effect.gen(function* () {
        // Thirty failed retries outlast the former one-hour, 24-attempt cap. The
        // next retry makes progress before failing, so its wait starts over.
        const failedRetries = 30;
        const retryTurn = (
          retry: number,
          outcome: "failed" | "progress" | "completed",
        ): Array<CodexReplay.CodexAppServerReplayEntry> => {
          const id = `turn-${retry + 1}`;
          return [
            {
              type: "expect_outbound",
              label: `retry ${retry} turn/start`,
              frame: {
                id: retry + 3,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                },
              },
            },
            {
              type: "emit_inbound",
              label: `retry ${retry} turn/start`,
              frame: {
                id: retry + 3,
                result: { turn: makeCodexReplayTurn({ id, status: "inProgress" }) },
              },
            },
            {
              type: "emit_inbound",
              label: `retry ${retry} turn/started`,
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id, status: "inProgress" }),
                },
              },
            },
            ...(outcome === "progress"
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: `retry ${retry} agent message`,
                    frame: {
                      method: "item/agentMessage/delta",
                      params: {
                        threadId: nativeThreadId,
                        turnId: id,
                        itemId: `message-${id}`,
                        delta: "Working",
                      },
                    },
                  },
                ]
              : []),
            turnCompleted(id, outcome === "completed" ? "completed" : "failed"),
          ];
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "overload-retry-persistent",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
            turnCompleted("turn-1", "failed"),
            ...Array.from({ length: failedRetries }, (_, index) =>
              retryTurn(index + 1, "failed"),
            ).flat(),
            ...retryTurn(failedRetries + 1, "progress"),
            ...retryTurn(failedRetries + 2, "completed"),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* runInput(harness));
        const scheduled = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "running" &&
            event.turnItem.retry?.retryDelayMs != null
              ? [event.turnItem.retry]
              : [],
          );
        for (let count = 1; count <= failedRetries + 2; count++) {
          yield* harness.until(() => scheduled().length >= count);
          assert.lengthOf(harness.terminalEvents(), 0);
          yield* TestClock.adjust(scheduled()[count - 1]?.retryDelayMs ?? 0);
        }
        yield* harness.firstTerminal;

        const retries = scheduled();
        assert.deepEqual(
          retries.map((retry) => retry.attempt),
          [...Array.from({ length: failedRetries + 1 }, (_, index) => index + 1), 1],
        );
        assert.deepEqual(
          retries.slice(0, 7).map((retry) => retry.retryDelayMs),
          [10_000, 20_000, 40_000, 80_000, 160_000, 180_000, 180_000],
        );
        assert.equal(retries.at(-1)?.retryDelayMs, 10_000);
        assert.isTrue(retries.every((retry) => retry.maxAttempts === null));
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[yield* providerTurnId(`turn-${failedRetries + 3}`), "completed"]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect.each([
      { name: "rate limit", errorInfo: "rateLimitExceeded" },
      {
        name: "429 exhaustion",
        errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      },
      { name: "503 connection", errorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } },
    ] as const)(
      "retries a $name failure without waiting for a usage reset until Stop",
      ({ name, errorInfo }) =>
        Effect.gen(function* () {
          const transcript = makeCodexReplayTranscript({
            scenario: `throttle-retry-${name}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
              // A stale full-allowance snapshot must not turn throttling into a reset wait.
              {
                type: "emit_inbound",
                label: "account/rateLimits/updated",
                frame: {
                  method: "account/rateLimits/updated",
                  params: {
                    rateLimits: {
                      limitId: "codex",
                      primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed turn-1",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: {
                      ...makeCodexReplayTurn({ id: "turn-1", status: "failed" }),
                      error: { message: "Too many requests.", codexErrorInfo: errorInfo },
                    },
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(yield* runInput(harness));
          yield* harness.until(() => retryRows(harness.events).length > 0);
          const row = harness.events.find(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
          );
          if (row?.type !== "turn_item.updated" || row.turnItem.type !== "error") {
            return assert.fail("Expected a retry row");
          }
          assert.equal(row.turnItem.failure.class, "provider_error");
          assert.equal(row.turnItem.failure.resetAt ?? null, null);
          assert.equal(row.turnItem.retry?.retryDelayMs, 10_000);

          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: yield* providerTurnId("turn-1"),
          });
          yield* harness.firstTerminal;
          assert.deepEqual(
            harness.terminalEvents().map((event) => event.status),
            ["interrupted"],
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              fullRetryDelays,
            ),
          ),
        ),
    );

    it.effect(
      "rechecks a usage limit with no known reset, then waits for the reset it learns",
      () =>
        Effect.gen(function* () {
          const usageLimited = (id: string) =>
            ({
              type: "emit_inbound",
              label: `turn/completed ${id}`,
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id, status: "failed" }),
                    error: {
                      message: "You've hit your usage limit.",
                      codexErrorInfo: "usageLimitExceeded",
                    },
                  },
                },
              },
            }) satisfies CodexReplay.CodexAppServerReplayEntry;
          const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt });
          const startEntry = preamble.at(-3)!;
          if (startEntry.type !== "expect_outbound")
            return yield* Effect.die("expected turn/start");
          const transcript = makeCodexReplayTranscript({
            scenario: "usage-limit-recheck",
            entries: [
              ...preamble,
              usageLimited("turn-1"),
              {
                type: "emit_inbound",
                label: "account/rateLimits/updated",
                frame: {
                  method: "account/rateLimits/updated",
                  params: {
                    rateLimits: {
                      limitId: "codex",
                      primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  ...(startEntry.frame as { params: object }),
                  id: 4,
                  params: { ...(startEntry.frame as { params: object }).params, input: [] },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 4,
                  result: { turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }) },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
                  },
                },
              },
              usageLimited("turn-2"),
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(yield* runInput(harness));
          yield* harness.until(() => retryRows(harness.events).length > 0);
          assert.lengthOf(harness.terminalEvents(), 0);
          yield* TestClock.adjust("10 seconds");
          yield* harness.firstTerminal;

          const [terminal] = harness.terminalEvents();
          assert.equal(terminal?.providerTurnId, yield* providerTurnId("turn-2"));
          if (terminal?.status !== "failed") return assert.fail("Expected a usage-limit failure");
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(terminal.failure.resetAt, "2033-05-19T07:20:00.000Z");
          assert.deepEqual(retryRows(harness.events).at(-1)?.slice(0, 2), ["failed", 1]);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              fullRetryDelays,
            ),
          ),
        ),
    );

    it.effect.each([
      { name: "overloaded", code: -32001 },
      { name: "internal error", code: -32603 },
    ] as const)("handles a retry start Codex rejects as $name", ({ name, code }) =>
      Effect.gen(function* () {
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt });
        const startEntry = preamble.at(-3)!;
        if (startEntry.type !== "expect_outbound") return yield* Effect.die("expected turn/start");
        const retryStart = (id: number) =>
          ({
            type: "expect_outbound",
            frame: {
              ...(startEntry.frame as { params: object }),
              id,
              params: { ...(startEntry.frame as { params: object }).params, input: [] },
            },
          }) satisfies CodexReplay.CodexAppServerReplayEntry;
        const transcript = makeCodexReplayTranscript({
          scenario: `overload-retry-start-rejected-${name}`,
          entries: [
            ...preamble,
            turnCompleted("turn-1", "failed"),
            retryStart(4),
            { type: "emit_inbound", frame: { id: 4, error: { code, message: "Rejected." } } },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* harness.until(() => retryRows(harness.events).length > 0);
        yield* TestClock.adjust("10 seconds");
        if (code === -32603) {
          yield* harness.firstTerminal;
          const [terminal] = harness.terminalEvents();
          assert.equal(
            terminal?.status === "failed" ? terminal.failure.code : null,
            "serverOverloaded",
          );
          assert.deepEqual(retryRows(harness.events).at(-1)?.slice(0, 2), ["failed", 1]);
          return;
        }
        // Nothing started, so the run waits out the next backoff until Stop.
        yield* harness.until(() =>
          retryRows(harness.events).some((row) => row[0] === "running" && row[1] === 2),
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: yield* providerTurnId("turn-1"),
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        assert.deepEqual(retryRows(harness.events).slice(-2), [
          ["running", 2, 20_000],
          ["interrupted", 2, 20_000],
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect("keeps a notified client-error status when the completion omits it", () =>
      Effect.gen(function* () {
        const message = "Request failed after retries.";
        const transcript = makeCodexReplayTranscript({
          scenario: "notified-client-error-status",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
            {
              type: "emit_inbound",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: "turn-1",
                  willRetry: false,
                  error: {
                    message,
                    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 403 } },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: "turn-1", status: "failed" }),
                    error: {
                      message,
                      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } },
                    },
                  },
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["failed"],
        );
        assert.lengthOf(retryRows(harness.events), 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect("settles an overloaded run when Stop arrives during the backoff", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "overload-retry-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
            turnCompleted("turn-1", "failed"),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* harness.until(() => retryRows(harness.events).length > 0);
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: yield* providerTurnId("turn-1"),
        });
        yield* harness.firstTerminal;
        // The backoff ending starts nothing once Stop settled the run.
        yield* TestClock.adjust("10 seconds");

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        assert.deepEqual(retryRows(harness.events), [
          ["running", 1, 10_000],
          ["interrupted", 1, 10_000],
        ]);
        assert.deepEqual(
          requests.filter((method) => method === "turn/start" || method === "turn/interrupt"),
          ["turn/start"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    const childThreadId = "overload-child-thread";
    const childTurnId = "overload-child-turn";
    const runningSubagent = [
      {
        type: "emit_inbound",
        label: "subagent started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "overload-subagent-call",
              kind: "started",
              agentThreadId: childThreadId,
              agentPath: "/root/review",
            },
            threadId: nativeThreadId,
            turnId: "turn-1",
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "child turn/started",
        frame: {
          method: "turn/started",
          params: {
            threadId: childThreadId,
            turn: makeCodexReplayTurn({ id: childTurnId, status: "inProgress" }),
          },
        },
      },
    ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
    const childTurnCompleted = (status: "completed" | "interrupted") =>
      ({
        type: "emit_inbound",
        label: `child turn/completed ${status}`,
        frame: {
          method: "turn/completed",
          params: {
            threadId: childThreadId,
            turn: makeCodexReplayTurn({ id: childTurnId, status }),
          },
        },
      }) satisfies CodexReplay.CodexAppServerReplayEntry;

    it.effect("retries an overloaded run once its running subagents finish", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "overload-retry-after-subagent",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
            ...runningSubagent,
            turnCompleted("turn-1", "failed"),
            childTurnCompleted("completed"),
            {
              type: "expect_outbound",
              label: "retry turn/start",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "retry turn/start",
              frame: {
                id: 4,
                result: { turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }) },
              },
            },
            {
              type: "emit_inbound",
              label: "retry turn/started",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
                },
              },
            },
            turnCompleted("turn-2", "completed"),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* runInput(harness));
        yield* harness.until(() => retryRows(harness.events).length > 0);
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust("10 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[yield* providerTurnId("turn-2"), "completed"]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );

    it.effect("Stop while an overloaded run waits for subagents ends them without a retry", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "overload-retry-subagent-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt }),
            ...runningSubagent,
            turnCompleted("turn-1", "failed"),
            {
              type: "emit_inbound",
              label: "child message",
              frame: {
                method: "item/completed",
                params: {
                  threadId: childThreadId,
                  turnId: childTurnId,
                  item: { type: "agentMessage", id: "child-message", text: "Reviewing" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "child turn/interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: childThreadId, turnId: childTurnId },
              },
            },
            { type: "emit_inbound", label: "child turn/interrupt", frame: { id: 4, result: {} } },
            childTurnCompleted("interrupted"),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(yield* runInput(harness));
        // The waiting run shows nothing new, so the child message that follows
        // the failure marks it as handled.
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
          ),
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: yield* providerTurnId("turn-1"),
        });
        yield* harness.firstTerminal;
        yield* TestClock.adjust("10 seconds");

        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[yield* providerTurnId("turn-1"), "failed"]],
        );
        assert.lengthOf(retryRows(harness.events), 0);
        assert.deepEqual(
          requests.filter((method) => method === "turn/start" || method === "turn/interrupt"),
          ["turn/start", "turn/interrupt"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            fullRetryDelays,
          ),
        ),
      ),
    );
  });
}
