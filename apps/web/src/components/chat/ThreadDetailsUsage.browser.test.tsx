import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadDetailsContext } from "./ThreadDetailsUsage";

const usage: ContextWindowSnapshot = {
  usedTokens: 101_000,
  totalProcessedTokens: null,
  maxTokens: 475_000,
  remainingTokens: 374_000,
  usedPercentage: 21.3,
  remainingPercentage: 78.7,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  autoCompactThreshold: null,
  cost: null,
  updatedAt: "2026-11-26T00:00:00.000Z",
};

it("shows a thread's custom auto-compact limit beside its context", async () => {
  await using _screen = await render(
    <ThreadDetailsContext usage={usage} autoCompactLimit={200_000} />,
  );
  await expect.element(page.getByText("Auto-compact")).toBeVisible();
  await expect.element(page.getByText("at 200k")).toBeVisible();
});

it("shows no limit row for a thread that follows its model", async () => {
  await using _screen = await render(<ThreadDetailsContext usage={usage} />);
  await expect.element(page.getByText("Context")).toBeVisible();
  await expect.element(page.getByText("Auto-compact")).not.toBeInTheDocument();
});
