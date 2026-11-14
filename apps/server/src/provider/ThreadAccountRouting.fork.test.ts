import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2TurnItem, UsageLimitSourceError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ThreadAccountRouting from "./ThreadAccountRouting.ts";

const compaction = (completedAt: string, status = "completed") =>
  ({
    type: "compaction",
    status,
    completedAt: DateTime.makeUnsafe(completedAt),
  }) as unknown as OrchestrationV2TurnItem;

describe("accountMoveDropsThinking", () => {
  it.each([
    { movedAt: null, items: [], drops: false },
    { movedAt: "2026-11-14T12:00:00.000Z", items: [], drops: true },
    {
      movedAt: "2026-11-14T12:00:00.000Z",
      items: [compaction("2026-11-14T11:00:00.000Z")],
      drops: true,
    },
    {
      movedAt: "2026-11-14T12:00:00.000Z",
      items: [compaction("2026-11-14T13:00:00.000Z", "failed")],
      drops: true,
    },
    {
      movedAt: "2026-11-14T12:00:00.000Z",
      items: [compaction("2026-11-14T13:00:00.000Z")],
      drops: false,
    },
  ])("moved $movedAt with $items.length compactions drops: $drops", ({ movedAt, items, drops }) => {
    expect(ThreadAccountRouting.accountMoveDropsThinking(movedAt, items)).toBe(drops);
  });
});

type Pin = Parameters<UsageLimitSources.UsageLimitSources["Service"]["pin"]>[1];
const CHOICE = { sourceId: "hub", account: "account-0123456789abcdef", stall: true };

function prepareTurn(input: {
  readonly accountChoice?: object;
  readonly accountMovedAt?: string;
  readonly instanceId?: string;
  readonly pin?: Effect.Effect<undefined, UsageLimitSourceError>;
}) {
  const pins: Pin[] = [];
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-14T12:00:00.000Z"));
    const routing = yield* ThreadAccountRouting.make;
    const fiber = yield* routing
      .prepareTurn({
        appThread: {
          id: "thread-1",
          accountChoice: input.accountChoice,
          accountMovedAt: input.accountMovedAt,
        } as never,
        providerThread: {
          driver: "claudeAgent",
          providerInstanceId: input.instanceId ?? "claude",
          nativeThreadRef: { nativeId: "native" },
        } as never,
        loadCompactions: Effect.succeed([]),
      })
      .pipe(Effect.forkChild);
    // The turn-start pin gives up after three seconds.
    yield* TestClock.adjust("3 seconds");
    return { drops: yield* Fiber.join(fiber), pins };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.ServerSettingsService.layerTest({}),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          hub: () => Effect.succeed({ url: "http://hub.test", managementKey: "key" }),
          pin: (_hub, pin) =>
            Effect.sync(() => void pins.push(pin)).pipe(
              Effect.andThen(input.pin ?? Effect.undefined),
            ),
        }),
      ),
    ),
  );
}

describe("ThreadAccountRouting.prepareTurn", () => {
  it.effect.each([
    {
      name: "re-pins the thread's chosen account for a week at each turn",
      input: { accountChoice: CHOICE },
      pins: [
        {
          sessions: ["native"],
          account: CHOICE.account,
          stall: true,
          expiresAt: "2026-11-21T11:00:00.000Z",
          move: false,
        },
      ],
      drops: false,
    },
    {
      name: "keeps the move on the re-pin while moved thinking is still dropped",
      input: { accountChoice: CHOICE, accountMovedAt: "2026-11-14T11:00:00.000Z" },
      pins: [expect.objectContaining({ account: CHOICE.account, move: true })],
      drops: true,
    },
    { name: "makes no router call without a choice", input: {}, pins: [], drops: false },
    {
      name: "skips a choice made for another provider instance",
      input: { accountChoice: { ...CHOICE, instanceId: "claude-work" } },
      pins: [],
      drops: false,
    },
    {
      name: "starts the turn when the pin fails",
      input: {
        accountChoice: CHOICE,
        pin: Effect.fail(new UsageLimitSourceError({ detail: "503" })),
      },
      pins: [expect.objectContaining({ account: CHOICE.account })],
      drops: false,
    },
    {
      name: "starts the turn when the hub does not answer",
      input: {
        accountChoice: CHOICE,
        accountMovedAt: "2026-11-14T11:00:00.000Z",
        pin: Effect.never,
      },
      pins: [expect.objectContaining({ account: CHOICE.account })],
      drops: true,
    },
  ])("$name", ({ input, pins, drops }) =>
    Effect.gen(function* () {
      const result = yield* prepareTurn(input);
      expect(result.pins).toEqual(pins);
      expect(result.drops).toBe(drops);
    }),
  );
});
