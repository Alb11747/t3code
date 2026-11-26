import { ProviderInstanceId } from "@t3tools/contracts";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { describe, expect, it } from "@effect/vitest";

import { makeServedUsageModel } from "./servedUsageModel.ts";

const record = (
  model: string,
  timestampMs: number,
  provider: UsageRecord["provider"] = "codex",
): UsageRecord => ({
  provider,
  timestampMs,
  model,
  sessionId: "s",
  totals: EMPTY_TOTALS,
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: null,
});

const codex = ProviderInstanceId.make("codex");
const files = (records: readonly UsageRecord[]) =>
  [...new Set(records.map((r) => r.provider))].map((provider) => ({
    provider,
    records: records.filter((r) => r.provider === provider),
    tailRecords: [],
  }));

const providerOf = (id: ProviderInstanceId) =>
  id === "codex" ? "codex" : id === "claudeAgent" ? "claude" : undefined;

describe("makeServedUsageModel", () => {
  const aliases = new Map([
    [codex, { "gpt-sol": "gpt-6.2-sol", "gpt-6.1-sol": "gpt-6.2-sol" }],
    [ProviderInstanceId.make("claudeAgent"), { "claude-fable-5": "claude-fable-5-2" }],
  ]);
  const history = [
    record("gpt-6.1-sol", 100),
    record("gpt-6.2-sol", 200),
    record("claude-fable-5-2", 50, "claude"),
  ];
  const served = makeServedUsageModel(aliases, providerOf, files(history))!;

  it("attributes a family name or retired ID to the model the hub answers it with", () => {
    expect(served(record("gpt-sol", 300)).model).toBe("gpt-6.2-sol");
    expect(served(record("gpt-6.1-sol", 250)).model).toBe("gpt-6.2-sol");
    expect(served(record("claude-fable-5", 60, "claude")).model).toBe("claude-fable-5-2");
  });

  it("keeps records from before the target was in use", () => {
    expect(served(record("gpt-6.1-sol", 150)).model).toBe("gpt-6.1-sol");
    expect(served(record("gpt-6.1-sol", 200)).model).toBe("gpt-6.2-sol");
  });

  it("keeps IDs another provider's hub maps, or that no record of the target dates", () => {
    expect(served(record("claude-fable-5", 60)).model).toBe("claude-fable-5");
    const unseen = makeServedUsageModel(aliases, providerOf, files([record("gpt-sol", 1)]))!;
    expect(unseen(record("gpt-sol", 2)).model).toBe("gpt-sol");
  });

  it("drops the requested ID's rate model and leaves ambiguous IDs alone", () => {
    const withRate = { ...record("gpt-sol", 300), rateModel: "gpt-sol" };
    expect(served(withRate)).not.toHaveProperty("rateModel");
    const conflicting = makeServedUsageModel(
      new Map([
        [codex, { "gpt-sol": "gpt-6.2-sol" }],
        [ProviderInstanceId.make("codex-backup"), { "gpt-sol": "gpt-6.1-sol" }],
      ]),
      (id) => (id.startsWith("codex") ? "codex" : undefined),
      files(history),
    );
    expect(conflicting).toBeUndefined();
  });

  it("is absent without any hub aliases that move a record", () => {
    expect(makeServedUsageModel(new Map(), providerOf, files(history))).toBeUndefined();
    const selfOnly = new Map([[codex, { "gpt-6.2-sol": "gpt-6.2-sol" }]]);
    expect(makeServedUsageModel(selfOnly, providerOf, files(history))).toBeUndefined();
  });
});
