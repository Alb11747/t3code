const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

function recoveryObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object for dropped-thinking recovery.`);
  }
  return value as Record<string, unknown>;
}

export function claudeThinkingRecoveryEnvironment(
  environment: NodeJS.ProcessEnv,
  summarizeThinking: boolean,
): NodeJS.ProcessEnv & { ANTHROPIC_BETAS: string; CLAUDE_CODE_EXTRA_BODY: string } {
  const body = recoveryObject(
    JSON.parse(environment.CLAUDE_CODE_EXTRA_BODY || "{}"),
    "CLAUDE_CODE_EXTRA_BODY",
  );
  const thinking =
    body.thinking === undefined ? {} : recoveryObject(body.thinking, "Extra-body thinking");
  if (thinking.type !== undefined && thinking.type !== "adaptive" && thinking.type !== "enabled") {
    throw new TypeError("Dropped-thinking recovery requires adaptive or enabled thinking.");
  }
  const binding =
    thinking.block_binding === undefined
      ? {}
      : recoveryObject(thinking.block_binding, "Extra-body thinking.block_binding");
  const betas = new Set(
    (environment.ANTHROPIC_BETAS ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
  );
  betas.add(THINKING_BINDING_BETA);
  return {
    ...environment,
    ANTHROPIC_BETAS: [...betas].join(","),
    // Claude Code merges extra body at the top level, replacing its entire thinking object.
    CLAUDE_CODE_EXTRA_BODY: JSON.stringify({
      ...body,
      thinking: {
        type: "adaptive",
        ...(summarizeThinking ? { display: "summarized" } : {}),
        ...thinking,
        block_binding: { ...binding, prefix_mismatch_behavior: "drop_block" },
      },
    }),
  };
}
