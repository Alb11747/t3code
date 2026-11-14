import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";

import { withServedModels } from "../provider/HubModelAliases.ts";
import { hubModelAliasesOf } from "./HubModelAliasSync.ts";

const model = (slug: string, extra: object = {}) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...extra,
});
const claude = {
  instanceId: "claude",
  driver: "claudeAgent",
  auth: { status: "authenticated", type: "customEndpoint" },
  models: [
    model("claude-opus-5-5"),
    model("claude-opus-4-7", { isLegacy: true }),
    model("claude-opus-4-7", { isCustom: true }),
  ],
} as unknown as ServerProvider;
const direct = {
  ...claude,
  instanceId: "claude-direct",
  auth: { status: "authenticated", type: "subscription" },
} as unknown as ServerProvider;
const hub = (id: string, driver: string) =>
  ({
    id,
    kind: "cliproxy",
    label: id,
    checkedAt: "2026-11-14T12:00:00.000Z",
    accounts: [{ id: "a.json", driver, routerAlias: "account-1111111111111111" }],
    modelAliases: {
      claude: { "claude-opus-4-7": "claude-opus-5-5" },
      codex: { "gpt-6-sol": "gpt-6.1-sol" },
    },
  }) as unknown as UsageLimitSourceSnapshot;

describe("hub model aliases", () => {
  it("joins a provider to its hub's channel and marks only that hub's retired IDs", () => {
    const aliases = hubModelAliasesOf([claude, direct], [hub("hub", "claudeAgent")]);
    expect([...aliases]).toEqual([["claude", { "claude-opus-4-7": "claude-opus-5-5" }]]);

    const marked = withServedModels(claude, aliases.get(claude.instanceId));
    expect(marked.models.map((entry) => [entry.slug, entry.isCustom, entry.servedBy])).toEqual([
      ["claude-opus-5-5", false, undefined],
      ["claude-opus-4-7", false, "claude-opus-5-5"],
      ["claude-opus-4-7", true, undefined],
    ]);
    // A hub that stops aliasing the ID clears the mark.
    expect(withServedModels(marked, undefined).models.some((entry) => entry.servedBy)).toBe(false);
  });

  it("uses no hub when two hold the provider's accounts", () => {
    expect(
      hubModelAliasesOf([claude], [hub("one", "claudeAgent"), hub("two", "claudeAgent")]).size,
    ).toBe(0);
  });
});
