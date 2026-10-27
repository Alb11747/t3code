import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  NodeId,
  type OrchestrationV2ProviderThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  resolveContextWindowModelDisplayName,
  resolveResumeCompactionProviderThread,
  resumeCompactionTokensForSelection,
  shouldOfferResumeCompaction,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

describe("resume compaction", () => {
  const instanceId = ProviderInstanceId.make("claude-primary");
  const providerThreadId = ProviderThreadId.make("claude-conversation");
  const recommendation = {
    usedTokens: 120_000,
    providerInstanceId: instanceId,
    providerThreadId,
    sourceUpdatedAt: 0,
  };
  const selection = {
    resumeCompaction: recommendation,
    selectedProvider: ProviderDriverKind.make("claudeAgent"),
    selectedInstanceId: instanceId,
  };

  it("uses the latest root conversation belonging to the destination instance", () => {
    const threadId = ThreadId.make("thread");
    const at = DateTime.makeUnsafe("2026-10-26T17:00:00.000Z");
    const source: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: { usedTokens: 250_000 },
      nativeMetadata: null,
      goal: null,
      createdAt: at,
      updatedAt: at,
    };
    const newest = DateTime.makeUnsafe("2026-10-26T19:00:00.000Z");
    const replacement = {
      ...source,
      id: ProviderThreadId.make("replacement"),
      updatedAt: DateTime.makeUnsafe("2026-10-26T18:00:00.000Z"),
    };
    const providerThreads = [
      source,
      replacement,
      {
        ...source,
        id: ProviderThreadId.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        updatedAt: newest,
      },
      {
        ...source,
        id: ProviderThreadId.make("child"),
        ownerNodeId: NodeId.make("child-node"),
        updatedAt: newest,
      },
      {
        ...source,
        id: ProviderThreadId.make("other-app-thread"),
        appThreadId: ThreadId.make("other-thread"),
        updatedAt: newest,
      },
    ];
    expect(
      resolveResumeCompactionProviderThread({ providerThreads, threadId, instanceId }),
    ).toEqual(replacement);
    expect(
      resolveResumeCompactionProviderThread({
        providerThreads,
        threadId,
        instanceId: ProviderInstanceId.make("claude-new"),
      }),
    ).toBeNull();
  });

  it("shows the suggestion only for the matching Claude destination", () => {
    expect(resumeCompactionTokensForSelection(selection)).toBe(120_000);
    for (const override of [
      { selectedProvider: ProviderDriverKind.make("codex") },
      { selectedInstanceId: ProviderInstanceId.make("claude-work") },
      { resumeCompaction: null },
    ]) {
      expect(resumeCompactionTokensForSelection({ ...selection, ...override })).toBeNull();
    }
  });

  it("offers compaction after the cache TTL, preserving warm and small contexts", () => {
    const usage = {
      provider: "claudeAgent",
      usedTokens: 250_000,
      updatedAt: "2026-10-26T17:00:00.000Z",
      promptCacheTtlMs: 5 * 60_000,
      now: "2026-10-26T17:05:00.000Z",
    };
    expect(shouldOfferResumeCompaction(usage)).toBe(true);
    expect(shouldOfferResumeCompaction({ ...usage, now: "2026-10-26T17:04:59.000Z" })).toBe(false);
    expect(shouldOfferResumeCompaction({ ...usage, usedTokens: 1_000 })).toBe(false);
    expect(shouldOfferResumeCompaction({ ...usage, provider: "codex" })).toBe(false);
  });
});

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "" }],
    skills: [],
  };
}

describe("hasAvailableCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("GPT-5.6 Sol");
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});
