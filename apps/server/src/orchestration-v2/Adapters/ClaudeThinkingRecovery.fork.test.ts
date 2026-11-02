import { assert, describe, it } from "@effect/vitest";

import { claudeThinkingRecoveryEnvironment } from "./ClaudeThinkingRecovery.ts";

describe("Claude dropped-thinking request controls", () => {
  it("creates a complete thinking configuration without mutating the normal environment", () => {
    const environment = { PATH: "fixture-path" };
    for (const summarizeThinking of [false, true]) {
      const recovery = claudeThinkingRecoveryEnvironment(environment, summarizeThinking);
      assert.deepEqual(JSON.parse(recovery.CLAUDE_CODE_EXTRA_BODY), {
        thinking: {
          type: "adaptive",
          ...(summarizeThinking ? { display: "summarized" } : {}),
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
      });
      assert.equal(recovery.ANTHROPIC_BETAS, "thinking-binding-controls-2026-08-01");
      assert.equal(recovery.PATH, "fixture-path");
    }
    assert.deepEqual(environment, { PATH: "fixture-path" });
  });

  it("preserves caller controls while overriding only the binding policy and adding the beta once", () => {
    const body = {
      output_config: { effort: "high" },
      thinking: {
        type: "enabled",
        budget_tokens: 4096,
        display: "omitted",
        block_binding: { prefix_mismatch_behavior: "error", fixture_option: true },
      },
    };
    const environment = {
      CLAUDE_CODE_EXTRA_BODY: JSON.stringify(body),
      ANTHROPIC_BETAS:
        "fixture-beta, thinking-binding-controls-2026-08-01,thinking-binding-controls-2026-08-01",
    };
    const recovery = claudeThinkingRecoveryEnvironment(environment, true);
    assert.deepEqual(JSON.parse(recovery.CLAUDE_CODE_EXTRA_BODY), {
      ...body,
      thinking: {
        ...body.thinking,
        block_binding: { fixture_option: true, prefix_mismatch_behavior: "drop_block" },
      },
    });
    assert.equal(recovery.ANTHROPIC_BETAS, "fixture-beta,thinking-binding-controls-2026-08-01");
    assert.equal(
      JSON.parse(environment.CLAUDE_CODE_EXTRA_BODY).thinking.block_binding
        .prefix_mismatch_behavior,
      "error",
    );
  });

  it("rejects malformed or incompatible external controls instead of discarding them", () => {
    assert.throws(
      () => claudeThinkingRecoveryEnvironment({ CLAUDE_CODE_EXTRA_BODY: "{" }, true),
      SyntaxError,
    );
    for (const body of [
      null,
      [],
      1,
      { thinking: null },
      { thinking: [] },
      { thinking: { type: "disabled" } },
      { thinking: { block_binding: "error" } },
    ]) {
      assert.throws(
        () =>
          claudeThinkingRecoveryEnvironment({ CLAUDE_CODE_EXTRA_BODY: JSON.stringify(body) }, true),
        TypeError,
      );
    }
  });
});
