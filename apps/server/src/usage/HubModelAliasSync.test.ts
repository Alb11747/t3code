import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";

import { withServedModels } from "../provider/HubModelAliases.ts";
import { hubModelAliasesOf, withLastAccounts } from "./HubModelAliasSync.ts";

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
  auth: { status: "authenticated", type: "customEndpoint", endpoint: "https://hub.test:8317" },
  models: [
    model("claude-opus-5-5"),
    model("claude-opus-4-7", { isLegacy: true }),
    model("claude-opus-4-7", { isCustom: true }),
    // Renamed by a `fork: false` alias: its target is not listed, so it is the working ID.
    model("claude-sonnet-renamed"),
  ],
} as unknown as ServerProvider;
const hub = (id: string, driver: string) =>
  ({
    id,
    kind: "cliproxy",
    label: id,
    origin: "https://hub.test:8317",
    checkedAt: "2026-11-14T12:00:00.000Z",
    accounts: [{ id: "a.json", driver, routerAlias: "account-1111111111111111" }],
    modelAliases: {
      claude: {
        "claude-opus-4-7": "claude-opus-5-5",
        "claude-sonnet-renamed": "claude-sonnet-5-5",
      },
      codex: { "gpt-6-sol": "gpt-6.1-sol" },
    },
  }) as unknown as UsageLimitSourceSnapshot;

describe("hub model aliases", () => {
  it("marks only the hub's retired IDs whose served model the provider lists", () => {
    const aliases = hubModelAliasesOf([claude], [hub("hub", "claudeAgent")]);
    const marked = withServedModels(claude, aliases.get(claude.instanceId));
    expect(marked.models.map((entry) => [entry.slug, entry.isCustom, entry.servedBy])).toEqual([
      ["claude-opus-5-5", false, undefined],
      ["claude-opus-4-7", false, "claude-opus-5-5"],
      ["claude-opus-4-7", true, undefined],
      ["claude-sonnet-renamed", false, undefined],
    ]);
    // A hub that stops aliasing the ID clears the mark.
    expect(withServedModels(marked, undefined).models.some((entry) => entry.servedBy)).toBe(false);
  });

  it.each([
    ["two hubs hold its accounts", claude, [hub("one", "claudeAgent"), hub("two", "claudeAgent")]],
    [
      "it sends requests to another endpoint",
      { ...claude, auth: { ...claude.auth, endpoint: "https://proxy.other" } },
      [hub("one", "claudeAgent")],
    ],
    [
      "its endpoint is unknown",
      { ...claude, auth: { status: "authenticated", type: "customEndpoint" } },
      [hub("one", "claudeAgent")],
    ],
    [
      "it has no custom endpoint",
      { ...claude, auth: { status: "authenticated", type: "subscription" } },
      [hub("one", "claudeAgent")],
    ],
  ])("joins no hub when %s", (_case, provider, sources) => {
    expect(hubModelAliasesOf([provider as ServerProvider], sources).size).toBe(0);
  });

  it("keeps a provider joined through a failed account read", () => {
    const cache = new Map();
    const good = hub("one", "claudeAgent");
    withLastAccounts([good], cache);
    const failed = { ...good, accounts: [], error: "The hub management request failed." };
    const joined = withLastAccounts([failed], cache);
    expect(hubModelAliasesOf([claude], joined).get(claude.instanceId)).toEqual(
      good.modelAliases?.claude,
    );
    expect(joined[0]?.error).toBe(failed.error);
  });
});
