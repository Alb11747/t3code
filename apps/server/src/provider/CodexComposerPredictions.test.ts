import { assert, describe, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeCodexComposerPredictions } from "./CodexComposerPredictions.ts";

const sse = (text: string, terminal = "response.completed") =>
  [
    { type: "response.output_text.delta", delta: text.slice(0, 8) },
    { type: "response.output_text.delta", delta: text.slice(8) },
    { type: terminal },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");

function clientFor(config: Schema.Json, chatGpt = true, messages: ReadonlyArray<Schema.Json> = []) {
  // Test boundary: the app-server's generated request API is generic by method.
  const request = ((method: string) =>
    Effect.succeed(
      method === "getAuthStatus"
        ? { authMethod: chatGpt ? "chatgpt" : "apikey", authToken: "chatgpt-token" }
        : method === "config/read"
          ? { config }
          : { thread: { turns: [{ items: messages }] } },
    )) as CodexClient.CodexAppServerClient["Service"]["request"];
  return {
    request,
    raw: {
      request: () =>
        Effect.succeed({
          workspaceRouting: {
            backendOrigin: "https://chatgpt.example",
            chatgptAccountId: "account",
          },
        }),
    },
  };
}

const requestInput = {
  environment: { PROXY_TOKEN: "environment-token" },
  nativeThreadId: "native-thread",
  model: "test-model",
  turnId: "prediction-turn",
};

describe("Codex composer predictions", () => {
  it.effect.each([
    {
      provider: {
        base_url: "https://proxy.example/v1/",
        experimental_bearer_token: "proxy-token",
        http_headers: { "x-proxy": "custom" },
      },
      token: "proxy-token",
    },
    {
      provider: { base_url: "https://proxy.example/v1", env_key: "PROXY_TOKEN" },
      token: "environment-token",
    },
    {
      provider: { base_url: "https://proxy.example/v1", requires_openai_auth: true },
      token: "chatgpt-token",
    },
    { provider: null, token: "chatgpt-token" },
  ])("routes generation and authentication for $token", ({ provider, token }) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          if (request.method === "GET") {
            assert.equal(request.headers.authorization, "Bearer chatgpt-token");
            assert.equal(request.headers["chatgpt-account-id"], "account");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                is_enabled: true,
                prompt: "Predict",
                prediction_reasoning_effort: "high",
              }),
            );
          }
          assert.equal(
            request.url,
            provider
              ? "https://proxy.example/v1/responses"
              : "https://chatgpt.example/backend-api/codex/responses",
          );
          assert.equal(request.headers.authorization, `Bearer ${token}`);
          assert.equal(request.headers["chatgpt-account-id"], provider ? undefined : "account");
          if (provider && "http_headers" in provider)
            assert.equal(request.headers["x-proxy"], "custom");
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const body = JSON.parse(new TextDecoder().decode(request.body.body));
            assert.equal(body.model, "test-model");
            assert.equal(body.reasoning.effort, "high");
            assert.equal(
              body.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite,
              "true",
            );
            assert.equal(
              JSON.parse(body.client_metadata["x-codex-turn-metadata"]).thread_source,
              "composer_predictions",
            );
            assert.deepEqual(
              body.input.slice(0, -1).map((item: { role: string }) => item.role),
              ["user", "assistant"],
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(sse('{"suggestion":"  Add tests  "}')),
          );
        }),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const input = {
        ...requestInput,
        client: clientFor(
          provider ? { model_provider: "proxy", model_providers: { proxy: provider } } : {},
          true,
          [
            {
              type: "userMessage",
              content: [
                { type: "text", text: "Implement" },
                { type: "image", url: "ignored" },
              ],
            },
            { type: "reasoning", text: "hidden" },
            { type: "agentMessage", text: "Done" },
          ],
        ),
      };
      assert.equal(yield* predictions.predict(input), "Add tests");
      assert.equal(yield* predictions.predict(input), "Add tests");
      assert.lengthOf(
        requests.filter((url) => url.endsWith("/config")),
        1,
      );
      yield* TestClock.adjust("5 minutes");
      assert.equal(yield* predictions.predict(input), "Add tests");
      assert.lengthOf(
        requests.filter((url) => url.endsWith("/config")),
        2,
      );
    }),
  );

  it.effect.each([
    {
      config: { model_provider: "unsupported" },
      prediction: { is_enabled: true, prompt: "Predict" },
      chatGpt: true,
    },
    {
      config: {},
      prediction: { is_enabled: true, prompt: "Predict", unsupported_models: ["test-model"] },
      chatGpt: true,
    },
    { config: {}, prediction: { is_enabled: false, prompt: "Predict" }, chatGpt: true },
    { config: {}, prediction: { is_enabled: true }, chatGpt: true },
    { config: {}, prediction: { is_enabled: true, prompt: "Predict" }, chatGpt: false },
  ])("skips unavailable predictions %#", ({ config, prediction, chatGpt }) =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.method, "GET", "No generation when unavailable");
          return HttpClientResponse.fromWeb(request, Response.json(prediction));
        }),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.isNull(
        yield* predictions.predict({ ...requestInput, client: clientFor(config, chatGpt) }),
      );
    }),
  );

  it.effect.each([
    { stream: sse('{"suggestion":" Next "}'), expected: "Next" },
    { stream: sse('{"suggestion":null}'), expected: null },
    { stream: sse('{"suggestion":"  "}'), expected: null },
    { stream: sse("not JSON"), expected: null },
    { stream: sse('{"suggestion":42}'), expected: null },
    { stream: sse('{"suggestion":"Next","extra":true}'), expected: null },
    { stream: sse('{"suggestion":"Next"}', "response.failed"), expected: null },
    { stream: "event: error\ndata: {}\n\n", expected: null },
    { stream: "data: not JSON\n\n", expected: null },
    { stream: 'data: {"type":"response.output_text.delta","delta":"{}"}\n\n', expected: null },
  ])("handles streaming output %#", ({ stream, expected }) =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.method === "GET"
              ? Response.json({ is_enabled: true, prompt: "Predict" })
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      const bytes = new TextEncoder().encode(stream);
                      for (let i = 0; i < bytes.length; i += 7)
                        controller.enqueue(bytes.slice(i, i + 7));
                      controller.close();
                    },
                  }),
                ),
          ),
        ),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.equal(
        yield* predictions.predict({ ...requestInput, client: clientFor({}) }),
        expected,
      );
    }),
  );

  it.effect("bounds visible conversation context without including tool or reasoning text", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "GET")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ is_enabled: true, prompt: "Predict" }),
            );
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const body = JSON.parse(new TextDecoder().decode(request.body.body));
            const history = body.input.slice(0, -1);
            assert.lengthOf(history, 12);
            assert.equal(history[0].content[0].text.slice(0, 2), "18");
            assert.isAtMost(
              history.reduce(
                (total: number, item: { content: Array<{ text: string }> }) =>
                  total + item.content[0]!.text.length,
                0,
              ),
              24_000,
            );
          }
          return HttpClientResponse.fromWeb(request, new Response(sse('{"suggestion":null}')));
        }),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const messages = Array.from({ length: 30 }, (_, i) => ({
        type: "agentMessage",
        text: String(i).padStart(2, "0") + "x".repeat(1998),
      }));
      yield* predictions.predict({ ...requestInput, client: clientFor({}, true, messages) });
    }),
  );

  it.effect.each(["config", "generation"])("returns no prediction on %s HTTP failure", (stage) =>
    Effect.gen(function* () {
      let generated = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "POST") generated++;
          return HttpClientResponse.fromWeb(
            request,
            request.method === "GET" && stage === "generation"
              ? Response.json({ is_enabled: true, prompt: "Predict" })
              : new Response(null, { status: 503 }),
          );
        }),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.isNull(yield* predictions.predict({ ...requestInput, client: clientFor({}) }));
      assert.equal(generated, stage === "generation" ? 1 : 0);
    }),
  );

  it.effect("stops an unfinished response after thirty seconds", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      let cancelled = false;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "GET")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ is_enabled: true, prompt: "Predict" }),
            );
          Deferred.doneUnsafe(requested, Effect.void);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            ),
          );
        }),
      );
      const predictions = yield* makeCodexComposerPredictions.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const fiber = yield* predictions
        .predict({ ...requestInput, client: clientFor({}) })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("30 seconds");
      assert.isNull(yield* Fiber.join(fiber));
      assert.isTrue(cancelled);
    }),
  );
});
