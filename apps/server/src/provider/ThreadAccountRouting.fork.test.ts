import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2TurnItem,
  UsageLimitSourceError,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { RouterListing } from "../usage/cliproxyApi.ts";
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
          routerAlias: () => Effect.succeed((alias) => alias),
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

// HMAC-SHA256("management-secret", '["claude","7"]'): the slot's alias before quota router 0.28.0.
const LEGACY = "account-de21b724378312e0";
const CURRENT = "account-aaaaaaaaaaaaaaaa";
const SPARE = "account-bbbbbbbbbbbbbbbb";
const HUB = UsageLimitSourceId.make("hub");

// A hub with two Claude slots whose router lists `router.listing` (omitted when undefined).
function aliasHub(router: { listing: RouterListing; pins?: ReadonlyArray<unknown> }) {
  const pins: Array<unknown> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      if (path.endsWith("/control/pin")) pins.push(body.account);
      const answer = path.endsWith("/auth-files")
        ? {
            files: [
              { id: "a.json", auth_index: "7", provider: "claude", email: "a@x.test" },
              { id: "b.json", auth_index: "8", provider: "claude", email: "b@x.test" },
            ],
          }
        : path.endsWith("/control")
          ? {
              pins: router.pins ?? [],
              ...(router.listing === undefined ? {} : { accounts: router.listing }),
            }
          : path.endsWith("/api-call")
            ? { status_code: 500, body: "" }
            : { pins: [] };
      return HttpClientResponse.fromWeb(request, Response.json(answer));
    }),
  );
  const layer = Layer.mergeAll(
    ServerSettings.ServerSettingsService.layerTest({
      usageLimitSources: {
        [HUB]: {
          kind: "cliproxy",
          url: "http://hub.test",
          managementKey: "management-secret",
          enabled: true,
        },
      },
    }),
    Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) => Effect.succeed(references.map(() => undefined)),
      invalidate: () => Effect.void,
    }),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    Layer.succeed(HttpClient.HttpClient, http),
    NodeCrypto.layer,
  );
  return { pins, layer };
}

const aliasesOf = (sources: UsageLimitSources.UsageLimitSources["Service"]) =>
  sources.current.pipe(
    Effect.map((snapshots) => snapshots[0]?.accounts.map((account) => account.routerAlias)),
  );

describe("router account aliases", () => {
  it.effect(
    "re-pins a legacy choice by its new alias, and by its legacy one after a rollback",
    () => {
      const router: { listing: RouterListing; pins?: ReadonlyArray<unknown> } = {
        listing: [
          { account: CURRENT, provider: "claude", auth_index: "7", legacy_account: LEGACY },
          { account: SPARE, provider: "claude", auth_index: "8" },
        ],
      };
      const hub = aliasHub(router);
      return Effect.gen(function* () {
        const sources = yield* UsageLimitSources.make;
        const routing = yield* ThreadAccountRouting.make.pipe(
          Effect.provideService(UsageLimitSources.UsageLimitSources, sources),
        );
        const turn = (account: string) =>
          routing.prepareTurn({
            appThread: { id: "thread-1", accountChoice: { ...CHOICE, account } } as never,
            providerThread: {
              driver: "claudeAgent",
              providerInstanceId: "claude",
              nativeThreadRef: { nativeId: "native" },
            } as never,
            loadCompactions: Effect.succeed([]),
          });
        yield* sources.refresh;
        expect(yield* aliasesOf(sources)).toEqual([CURRENT, SPARE]);
        yield* turn(LEGACY);
        // A router rolled back to 0.27.0 resolves only legacy aliases.
        router.listing = undefined;
        yield* sources.refresh;
        expect(yield* aliasesOf(sources)).toEqual([LEGACY, "account-69e27c40424fa28a"]);
        // Also when it already lists the pin under the new alias it loaded.
        router.pins = [{ session: "claude:native", account: CURRENT }];
        yield* turn(CURRENT);
        expect(hub.pins).toEqual([CURRENT, LEGACY]);
      }).pipe(Effect.provide(hub.layer), Effect.scoped);
    },
  );

  it.effect("names a newly listed account once a control read sees it", () => {
    const router: { listing: RouterListing } = { listing: null };
    const hub = aliasHub(router);
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      expect(yield* aliasesOf(sources)).toEqual([undefined, undefined]);
      router.listing = [{ account: CURRENT, provider: "claude", auth_index: "7" }];
      yield* sources.control(HUB, { url: "http://hub.test", managementKey: "management-secret" });
      const renamed = yield* sources.streamChanges.pipe(
        Stream.map((snapshots) => snapshots[0]?.accounts.map((account) => account.routerAlias)),
        Stream.filter((aliases) => aliases?.[0] === CURRENT),
        Stream.runHead,
      );
      expect(renamed._tag).toBe("Some");
    }).pipe(Effect.provide(hub.layer), Effect.scoped);
  });
});
