import * as DateTime from "effect/DateTime";

export type ClaudePromptCaching = "default" | "disabled";

// Cold compaction replaces history, so caching it again buys nothing. Require a
// reported expiry and an already released process: unknown TTLs may still be cached,
// and live processes may run background work. Mixed TTLs use the latest reported expiry.
export function claudeCompactionPromptCaching(input: {
  readonly uncachedColdCompaction: boolean;
  readonly hasLiveProcess: boolean;
  readonly promptCacheExpiresAt: DateTime.Utc | undefined;
  readonly now: DateTime.Utc;
}): ClaudePromptCaching {
  return input.uncachedColdCompaction &&
    !input.hasLiveProcess &&
    input.promptCacheExpiresAt !== undefined &&
    DateTime.isGreaterThanOrEqualTo(input.now, input.promptCacheExpiresAt)
    ? "disabled"
    : "default";
}

// Claude omits cache markers; CLIProxyAPI also needs this header to avoid adding
// markers for Agent SDK requests. Other endpoints ignore the header.
export function uncachedClaudeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const header = "X-CPA-Prompt-Cache-Mode: explicit";
  const customHeaders = environment.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    ...environment,
    DISABLE_PROMPT_CACHING: "1",
    ANTHROPIC_CUSTOM_HEADERS: customHeaders ? `${customHeaders}\n${header}` : header,
  };
}
