import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { ServerProvider, UsageLimitSourceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageResetSnoozeService from "./UsageResetSnoozeService.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (hours: number) => iso(NOW + hours * 3_600_000);
const window = (id: string, usedPercent: number, resetsAt: string) => ({
  id,
  kind: "session" as const,
  label: id,
  usedPercent,
  resetsAt,
});

const claude = (auth: Record<string, unknown>, windows: ReturnType<typeof window>[]) =>
  ({
    instanceId: "claude",
    driver: "claudeAgent",
    auth: { status: "authenticated", ...auth },
    usageLimits: { checkedAt: at(0), windows },
  }) as unknown as ServerProvider;

// Another hub account recovers sooner than the one the router reports.
const hub = [
  {
    id: "hub",
    kind: "cliproxy",
    label: "Hub",
    checkedAt: at(0),
    accounts: [
      {
        id: "claude-soon.json",
        driver: "claudeAgent",
        usageLimits: { checkedAt: at(0), windows: [window("five_hour", 100, at(1))] },
      },
    ],
  },
] as unknown as ReadonlyArray<UsageLimitSourceSnapshot>;

function resolve(input: {
  readonly provider: ServerProvider;
  readonly pick: { readonly resetsAt: string | null } | null;
  readonly hubs?: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly freshContext?: boolean;
}) {
  const asked: Array<
    Parameters<UsageLimitSources.UsageLimitSources["Service"]["nextPickReset"]>[0]
  > = [];
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const service = yield* UsageResetSnoozeService.make;
    const result = yield* service
      .resolve({
        threadId: "thread-1" as never,
        modelSelection: { instanceId: "claude" as never, model: "claude-opus-5-5" },
        ...(input.freshContext ? { freshContext: true } : {}),
      })
      .pipe(Effect.result);
    return { result, asked };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([input.provider]),
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          current: Effect.succeed(input.hubs ?? hub),
          nextPickReset: (request) => {
            asked.push(request);
            return Effect.succeed(input.pick);
          },
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          resolveMessageProviderThread: () =>
            Effect.succeed({ nativeThreadRef: { nativeId: "native-session" } } as never),
        }),
      ),
    ),
  );
}

describe("UsageResetSnoozeService", () => {
  it.effect("uses a native account's own blocking reset", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* resolve({
        provider: claude({}, [window("five_hour", 100, at(3))]),
        pick: { resetsAt: at(9) },
      });
      expect(result).toMatchObject({
        _tag: "Success",
        success: { resetsAt: at(3), basis: "account" },
      });
      expect(asked).toEqual([]);
    }),
  );

  it.effect("uses the router's account behind a gateway, not the soonest hub account", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* resolve({
        // Streamed windows from the last account served must not win over the router.
        provider: claude({ type: "customEndpoint" }, [window("five_hour", 10, at(2))]),
        pick: { resetsAt: at(4) },
      });
      expect(result).toMatchObject({
        _tag: "Success",
        success: { resetsAt: at(4), basis: "router" },
      });
      expect(asked).toEqual([
        {
          sourceId: "hub",
          provider: "claude",
          model: "claude-opus-5-5",
          session: "native-session",
        },
      ]);
    }),
  );

  it.effect("falls back to the soonest hub reset when the hub cannot preview picks", () =>
    Effect.gen(function* () {
      const { result } = yield* resolve({
        provider: claude({ type: "customEndpoint" }, []),
        pick: null,
      });
      expect(result).toMatchObject({
        _tag: "Success",
        success: { resetsAt: at(1), basis: "soonest", accountLabel: "claude-soon" },
      });
    }),
  );

  it.effect("fails instead of substituting another account when the picked reset is unknown", () =>
    Effect.gen(function* () {
      const { result } = yield* resolve({
        provider: claude({ type: "customEndpoint" }, []),
        pick: { resetsAt: null },
      });
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("previews a new session when the composer armed a fresh one", () =>
    Effect.gen(function* () {
      const { asked } = yield* resolve({
        provider: claude({ type: "customEndpoint" }, []),
        pick: { resetsAt: at(4) },
        freshContext: true,
      });
      expect(asked).toEqual([{ sourceId: "hub", provider: "claude", model: "claude-opus-5-5" }]);
    }),
  );

  it.effect("does not treat a direct API key as behind a hub", () =>
    Effect.gen(function* () {
      const provider = {
        ...claude({ type: "apiKey" }, []),
        usageLimits: { checkedAt: at(0), windows: [], unavailable: { reason: "unsupported" } },
      } as unknown as ServerProvider;
      const { result, asked } = yield* resolve({ provider, pick: { resetsAt: at(4) } });
      expect(result._tag).toBe("Failure");
      expect(asked).toEqual([]);
    }),
  );

  it.effect("cannot tell which of several hubs a provider uses, so takes the soonest", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* resolve({
        provider: claude({ type: "customEndpoint" }, []),
        pick: { resetsAt: at(4) },
        hubs: [...hub, { ...hub[0]!, id: "other-hub" as never }],
      });
      expect(result).toMatchObject({ _tag: "Success", success: { basis: "soonest" } });
      expect(asked).toEqual([]);
    }),
  );
});
