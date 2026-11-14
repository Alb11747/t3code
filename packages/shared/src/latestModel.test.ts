import { describe, expect, it } from "vite-plus/test";

import { modelFamilyName, resolveLatestFamilyModel } from "./latestModel.ts";

const slugs = (...values: string[]): Array<{ slug: string; servedBy?: string }> =>
  values.map((slug) => ({ slug }));
// A retired ID a proxy answers with another model, listed beside the real ones.
const alias = (slug: string, servedBy: string) => ({ slug, servedBy });

describe("resolveLatestFamilyModel", () => {
  it.each([
    ["gpt-6-sol", slugs("gpt-6-sol", "gpt-6.2-sol", "gpt-6.1-sol"), "gpt-6.2-sol"],
    ["gpt-6.1-sol", slugs("gpt-6.1-sol", "gpt-7-terra", "gpt-6-sol"), "gpt-6.1-sol"],
    ["openai.gpt-6.1-luna", slugs("gpt-6.2-luna", "openai.gpt-6.2-luna"), "openai.gpt-6.2-luna"],
    ["claude-haiku-4-5-20251001", slugs("claude-haiku-5-5", "claude-sonnet-6"), "claude-haiku-5-5"],
    ["claude-opus-5-5[1m]", slugs("claude-opus-6", "claude-opus-6[1m]"), "claude-opus-5-5[1m]"],
    ["gpt-6.2-sol", slugs("gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"), "gpt-6.1-sol"],
    ["claude-opus-5", slugs("claude-opus-5-1"), "claude-opus-5-1"],
    ["gpt-6-chat-thinking", slugs("gpt-7-chat-thinking"), "gpt-6-chat-thinking"],
    ["codex-auto-review", slugs("codex-auto-review-2"), "codex-auto-review"],
    ["gpt-image-2", slugs("gpt-image-3"), "gpt-image-2"],
    ["gpt-6.1-sol", [], "gpt-6.1-sol"],
    ["gpt-6.1-sol", [...slugs("gpt-6.1-sol"), alias("gpt-6.2-sol", "gpt-6.1-sol")], "gpt-6.1-sol"],
    ["gpt-6-sol", [alias("gpt-6-sol", "gpt-6.1-sol"), ...slugs("gpt-6.1-sol")], "gpt-6.1-sol"],
  ])("%s resolves to the newest of its family", (slug, models, expected) => {
    expect(resolveLatestFamilyModel(slug, models)).toBe(expected);
  });

  it("names only families that can be followed", () => {
    expect(modelFamilyName("openai.gpt-6.1-sol")).toBe("Sol");
    expect(modelFamilyName("claude-opus-5-5")).toBe("Opus");
    expect(modelFamilyName("claude-opus-5-5[1m]")).toBeNull();
    expect(modelFamilyName("gpt-6-chat-thinking")).toBeNull();
  });
});
