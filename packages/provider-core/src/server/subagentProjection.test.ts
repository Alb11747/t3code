import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import { makeSubagentChildThread, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

describe("makeSubagentChildThread", () => {
  // Exclusivity belongs only to threads that asked: a child prefers its parent's account but
  // never waits for it, and a new conversation has no moved thinking to drop.
  it.each([
    { name: "on the parent's instance", instanceId: "codex", suggested: true },
    { name: "on another instance", instanceId: "claude", suggested: false },
  ])("takes the parent's account as a suggestion only $name", ({ instanceId, suggested }) => {
    const choice = { sourceId: "hub", account: "account-1111111111111111", stall: true };
    const child = makeSubagentChildThread({
      parentThread: {
        id: "parent",
        lineage: { rootThreadId: "parent" },
        accountChoice: { ...choice, instanceId: "codex" },
        accountMovedAt: "2026-11-14T00:00:00.000Z",
      } as never,
      childThreadId: "child" as never,
      parentNodeId: "node" as never,
      activeProviderThreadId: null,
      providerInstanceId: instanceId as never,
      modelSelection: { instanceId, model: "model" } as never,
      title: "Child",
      now: DateTime.makeUnsafe(0),
      createdBy: "agent",
      creationSource: "mcp",
    });
    expect(child.accountChoice).toEqual(
      suggested ? { ...choice, stall: false, instanceId: "codex" } : null,
    );
    expect(child.accountMovedAt).toBeNull();
  });
});
