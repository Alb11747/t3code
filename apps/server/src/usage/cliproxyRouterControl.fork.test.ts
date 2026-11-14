import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const hub = { url: "http://hub.test:8317", managementKey: "management-secret" };
const session = "6f1c2a9e-0000-4000-8000-000000000001";

function routerHub(answer: (request: { method: string; path: string; body: unknown }) => unknown) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      const seen = { method: request.method, path: new URL(request.url).pathname, body };
      requests.push(seen);
      const answered = answer(seen);
      return HttpClientResponse.fromWeb(
        request,
        answered instanceof Response ? answered : Response.json(answered),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(PlatformCrypto.layer),
    ),
  };
}

const pinInput = {
  sessions: [session],
  account: "account-0123456789abcdef",
  stall: false,
  expiresAt: "2026-11-20T00:00:00.000Z",
};

describe("quota-router account controls", () => {
  it.effect("moves an owned conversation when the router confirms the move pin", () =>
    Effect.gen(function* () {
      const test = routerHub(({ body }) => ({
        pins: [{ ...(body as object), session, move: true }],
      }));
      yield* (yield* test.api).pin(hub, { ...pinInput, move: true });
      expect(test.requests).toEqual([
        {
          method: "POST",
          path: "/v0/management/control/pin",
          body: {
            sessions: [session],
            account: "account-0123456789abcdef",
            stall: false,
            expires_at: "2026-11-20T00:00:00.000Z",
            move: true,
          },
        },
      ]);
    }),
  );

  it.effect("withdraws a move pin that an older router stored as a plain pin", () =>
    Effect.gen(function* () {
      const test = routerHub(({ method }) =>
        method === "POST"
          ? { pins: [{ session, account: "account-0123456789abcdef", stall: false }] }
          : { pins: [] },
      );
      const result = yield* (yield* test.api)
        .pin(hub, { ...pinInput, move: true })
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.detail).toMatch(/Update it to 0\.24\.0/);
      expect(test.requests.map(({ method, body }) => [method, body])).toEqual([
        ["POST", expect.objectContaining({ move: true })],
        ["DELETE", { sessions: [session] }],
      ]);
    }),
  );

  it.effect("withdraws a move pin the router saved before failing to save the move", () =>
    Effect.gen(function* () {
      const test = routerHub(({ method }) =>
        method === "POST" ? new Response("", { status: 503 }) : { pins: [] },
      );
      const result = yield* (yield* test.api)
        .pin(hub, { ...pinInput, move: true })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(test.requests.map(({ method, body }) => [method, body])).toEqual([
        ["POST", expect.objectContaining({ move: true })],
        ["DELETE", { sessions: [session] }],
      ]);
    }),
  );

  it.effect("reads a conversation's established owner from the pick preview", () =>
    Effect.gen(function* () {
      const test = routerHub(() => ({
        account: "account-0123456789abcdef",
        owner: "account-fedcba9876543210",
        reset_at: null,
      }));
      expect(yield* (yield* test.api).nextPick(hub, { provider: "claude", session })).toEqual({
        account: "account-0123456789abcdef",
        owner: "account-fedcba9876543210",
        resetsAt: null,
      });
    }),
  );

  it.effect("sends margin overrides and subscription ends in the router's shapes", () =>
    Effect.gen(function* () {
      const test = routerHub(() => ({ pins: [] }));
      const api = yield* test.api;
      const margin = {
        sessions: [session],
        expiresAt: "2026-11-14T13:00:00.000Z",
        actor: "T3 Code",
      };
      yield* api.margin(hub, { ...margin, headroomScale: 0 });
      yield* api.margin(hub, { ...margin, headroomScale: null });
      yield* api.subscriptionEnd(hub, "account-0123456789abcdef", "2026-12-01T00:00:00.000Z");
      yield* api.subscriptionEnd(hub, "account-0123456789abcdef", null);
      expect(test.requests.map(({ method, path, body }) => [method, path, body])).toEqual([
        [
          "POST",
          "/v0/management/control/margin",
          {
            sessions: [session],
            headroom_scale: 0,
            expires_at: "2026-11-14T13:00:00.000Z",
            actor: "T3 Code",
          },
        ],
        ["DELETE", "/v0/management/control/margin", { sessions: [session], actor: "T3 Code" }],
        [
          "PUT",
          "/v0/management/control/end",
          { account: "account-0123456789abcdef", ends_at: "2026-12-01T00:00:00.000Z" },
        ],
        ["DELETE", "/v0/management/control/end", { account: "account-0123456789abcdef" }],
      ]);
    }),
  );

  it.effect("names each hub account by the router's alias", () =>
    Effect.gen(function* () {
      const test = routerHub(({ path }) =>
        path.endsWith("/auth-files")
          ? { files: [{ id: "a.json", auth_index: "7", provider: "claude", email: "a@x.test" }] }
          : { status_code: 500, body: "" },
      );
      const [account] = yield* (yield* test.api).readAccounts(hub);
      // HMAC-SHA256("management-secret", '["claude","7"]'), as AgentBridge derives it.
      expect(account?.routerAlias).toBe("account-de21b724378312e0");
    }),
  );
});
