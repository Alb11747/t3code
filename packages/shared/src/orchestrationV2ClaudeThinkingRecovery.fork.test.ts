import {
  NodeId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isClaudeThinkingPrefixMismatch,
  retriedWithDroppedThinking,
} from "./orchestrationV2ClaudeThinkingRecovery.ts";

const bindingError =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\\"drop_block\\\"."}}';
const failure = (message: string): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  code: "invalid_request",
  message,
  retryable: false,
});

describe("explicit Claude thinking recovery", () => {
  it("recognizes a preserved-thinking prefix error even when it is non-transient", () => {
    expect(isClaudeThinkingPrefixMismatch(failure(bindingError))).toBe(true);
    expect(
      isClaudeThinkingPrefixMismatch(
        failure(bindingError.replaceAll("thinking`", "redacted_thinking`")),
      ),
    ).toBe(true);
  });

  it.each([
    "messages.1.content.0: Invalid `signature` in `thinking` block.",
    "Invalid signature in thinking block: unable to decrypt signature.",
    "Thinking block signature belongs to another account.",
    "Thinking block is incompatible with this model.",
    "thinking.block_binding: Extra inputs are not permitted",
    'API Error: 400: set thinking.block_binding.prefix_mismatch_behavior to "drop_block"',
    "API Error: 429: usage limit exceeded",
    "Authentication failed",
  ])("does not offer recovery for %s", (message) => {
    expect(isClaudeThinkingPrefixMismatch(failure(message))).toBe(false);
  });

  it.each(["usage_limit", "permission_error"] as const)(
    "excludes %s even with quoted prefix text",
    (errorClass) => {
      expect(isClaudeThinkingPrefixMismatch({ ...failure(bindingError), class: errorClass })).toBe(
        false,
      );
    },
  );

  it("marks only a failure whose next attempt dropped thinking", () => {
    const runId = RunId.make("run-1");
    const attempt = (ordinal: number, recovery?: "drop_thinking") =>
      ({
        runId,
        attemptOrdinal: ordinal,
        rootNodeId: NodeId.make(`node-${ordinal}`),
        ...(recovery === undefined ? {} : { recovery }),
      }) as OrchestrationV2RunAttempt;
    const attempts = [attempt(1), attempt(2), attempt(3, "drop_thinking")];
    expect(retriedWithDroppedThinking(attempts, runId, NodeId.make("node-2"))).toBe(true);
    expect(retriedWithDroppedThinking(attempts, runId, NodeId.make("node-1"))).toBe(false);
    expect(retriedWithDroppedThinking(attempts, runId, NodeId.make("node-3"))).toBe(false);
  });
});
