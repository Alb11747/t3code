import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  RunAttemptId,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import type { ClaudeAgentSdkQueryOptions } from "./ClaudeAdapterV2.ts";

type Terminal = Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface RecoveryHarness {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly threadId: ThreadId;
  readonly offeredMessages: ReadonlyArray<SDKUserMessage>;
  readonly processQueues: ReadonlyArray<Queue.Queue<SDKMessage>>;
  readonly terminalReceipts: Queue.Queue<Terminal>;
  readonly events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
  readonly getOpenedOptions: () => ClaudeAgentSdkQueryOptions | undefined;
  readonly offerAndWait: (message: SDKMessage) => Effect.Effect<void>;
  readonly until: (predicate: () => boolean) => Effect.Effect<void>;
}

export function runClaudeThinkingRecoverySuite<E>(input: {
  readonly makeHarness: (
    environment: NodeJS.ProcessEnv,
    interrupt?: Effect.Effect<void>,
    launchArgs?: string,
  ) => Effect.Effect<RecoveryHarness, E, Scope.Scope>;
  readonly makeTurn: (input: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly now: DateTime.Utc;
    readonly attemptId: RunAttemptId;
    readonly text: string;
    readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
    readonly providerTurnOrdinal: number;
    readonly nativeThreadHasTurns: boolean;
  }) => ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly makeResult: (input: {
    readonly uuid: string;
    readonly result: string;
    readonly isError?: boolean;
    readonly apiErrorStatus?: number;
    readonly terminalReason?: SDKResultMessage["terminal_reason"];
  }) => SDKMessage;
}) {
  describe("Claude explicit thinking recovery", () => {
    it.effect.each(["project", ""])("honors settings sources '%s' during recovery", (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thinking-sources-" });
        const excludedEnv = {
          CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}',
          ANTHROPIC_BETAS: "excluded-beta",
        };
        yield* fs.writeFileString(
          path.join(home, "settings.json"),
          encodeJson({ env: excludedEnv }),
        );
        using _settings = vi
          .spyOn(ClaudeSdk, "resolveSettings")
          .mockImplementation(async (options) => ({
            effective: { env: options?.settingSources?.includes("local") ? excludedEnv : {} },
            provenance: {},
            sources: [],
          }));
        const harness = yield* input.makeHarness(
          {
            CLAUDE_CONFIG_DIR: home,
            CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"kept"}}',
          },
          undefined,
          `--setting-sources "${source}" --settings '{"env":{"ANTHROPIC_BETAS":"launch-beta"}}'`,
        );
        yield* harness.runtime.startTurn({
          ...input.makeTurn({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("thinking-recovery-sources"),
            text: "Original request.",
            attachments: [],
            providerTurnOrdinal: 2,
            nativeThreadHasTurns: true,
          }),
          recovery: "drop_thinking",
        });
        const options = harness.getOpenedOptions();
        assert.deepEqual(decodeJson(options?.env?.CLAUDE_CODE_EXTRA_BODY ?? "{}"), {
          metadata: { user_id: "kept" },
          thinking: {
            type: "adaptive",
            display: "summarized",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
          },
        });
        assert.equal(options?.extraArgs?.["setting-sources"], source);
        assert.equal(
          options?.env?.ANTHROPIC_BETAS,
          "launch-beta,thinking-binding-controls-2026-08-01",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect.each(["completed", "failed", "stopped"] as const)(
      "limits dropped thinking to the explicit retry after it is %s",
      (outcome) =>
        Effect.scoped(
          Effect.gen(function* () {
            const environment = {
              ANTHROPIC_BETAS: "existing-beta",
              CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"fixture"}}',
              ANTHROPIC_CUSTOM_HEADERS: "X-Team: blue",
            };
            const originalEnvironment = { ...environment };
            let acknowledge = Effect.void;
            const harness = yield* input.makeHarness(
              environment,
              Effect.suspend(() => acknowledge),
            );
            const originalThread = encodeJson(harness.providerThread);
            const now = yield* DateTime.now;
            const turn = (ordinal: number) =>
              input.makeTurn({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make(`thinking-recovery-${ordinal}`),
                text: "Original request that has already run tools.",
                attachments: [],
                providerTurnOrdinal: ordinal,
                nativeThreadHasTurns: true,
              });
            yield* harness.runtime.startTurn(turn(1));
            const ordinaryOptions = harness.getOpenedOptions();
            assert.equal(
              ordinaryOptions?.env?.CLAUDE_CODE_EXTRA_BODY,
              environment.CLAUDE_CODE_EXTRA_BODY,
            );
            yield* harness.offerAndWait(
              input.makeResult({
                uuid: "ordinary-failure",
                result: "API Error: 400: preserved thinking prefix mismatch",
                isError: true,
                apiErrorStatus: 400,
                terminalReason: "api_error",
              }),
            );
            assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "failed");

            yield* harness.runtime.startTurn({
              ...turn(2),
              providerThread: {
                ...harness.providerThread,
                nativeConversationHeadRef: {
                  driver: harness.providerThread.driver,
                  nativeId: "completed-tool-boundary",
                  strength: "weak",
                },
              },
              recovery: "drop_thinking",
            });
            const recoveryOptions = harness.getOpenedOptions();
            assert.notStrictEqual(recoveryOptions, ordinaryOptions);
            assert.equal(recoveryOptions?.resume, ordinaryOptions?.resume);
            assert.isUndefined(recoveryOptions?.resumeSessionAt);
            assert.deepInclude(decodeJson(recoveryOptions?.env?.CLAUDE_CODE_EXTRA_BODY ?? "{}"), {
              metadata: { user_id: "fixture" },
              thinking: {
                type: "adaptive",
                display: "summarized",
                block_binding: { prefix_mismatch_behavior: "drop_block" },
              },
            });
            assert.include(
              recoveryOptions?.env?.ANTHROPIC_BETAS?.split(",") ?? [],
              "thinking-binding-controls-2026-08-01",
            );
            assert.include(
              recoveryOptions?.env?.ANTHROPIC_BETAS?.split(",") ?? [],
              "existing-beta",
            );
            assert.equal(recoveryOptions?.env?.ANTHROPIC_CUSTOM_HEADERS, "X-Team: blue");
            assert.deepEqual(
              harness.offeredMessages[1]?.message.content,
              "Continue from where you stopped.",
            );
            assert.isTrue(harness.offeredMessages[1]?.isSynthetic);

            if (outcome === "stopped") {
              yield* harness.until(() =>
                harness.events.some(
                  (event) =>
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.runAttemptId === "thinking-recovery-2" &&
                    event.providerTurn.status === "running",
                ),
              );
              const running = harness.events.findLast(
                (event) =>
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.runAttemptId === "thinking-recovery-2" &&
                  event.providerTurn.status === "running",
              );
              assert.equal(running?.type, "provider_turn.updated");
              if (running?.type !== "provider_turn.updated") return;
              acknowledge = harness.offerAndWait(
                input.makeResult({
                  uuid: "recovery-stopped",
                  result: "",
                  terminalReason: "aborted_streaming",
                }),
              );
              yield* harness.runtime.interruptTurn({
                providerThread: harness.providerThread,
                providerTurnId: running.providerTurn.id,
              });
            } else {
              yield* harness.offerAndWait(
                input.makeResult({
                  uuid: "recovery-result",
                  result: outcome === "failed" ? "API Error: 400: request rejected" : "Recovered.",
                  ...(outcome === "failed"
                    ? {
                        isError: true,
                        apiErrorStatus: 400,
                        terminalReason: "api_error" as const,
                      }
                    : {}),
                }),
              );
            }
            assert.equal(
              (yield* Queue.take(harness.terminalReceipts)).status,
              outcome === "stopped" ? "interrupted" : outcome,
            );

            if (outcome === "failed") {
              yield* harness.runtime.startTurn({ ...turn(3), recovery: "drop_thinking" });
              assert.notStrictEqual(harness.getOpenedOptions(), recoveryOptions);
              yield* harness.offerAndWait(
                input.makeResult({
                  uuid: "repeated-recovery-result",
                  result: "Recovered on the second explicit attempt.",
                }),
              );
              assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
            }
            yield* harness.runtime.startTurn(turn(outcome === "failed" ? 4 : 3));
            const laterOptions = harness.getOpenedOptions();
            assert.notStrictEqual(laterOptions, recoveryOptions);
            assert.deepEqual(laterOptions?.env, ordinaryOptions?.env);
            assert.lengthOf(harness.processQueues, outcome === "failed" ? 4 : 3);
            assert.equal(encodeJson(harness.providerThread), originalThread);
            assert.deepEqual(environment, originalEnvironment);
            assert.equal(
              harness.offeredMessages.filter((message) => message.isSynthetic).length,
              outcome === "failed" ? 2 : 1,
            );
          }),
        ),
    );
  });
}
