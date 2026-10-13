import type * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/http";

const PredictionConfig = Schema.Struct({
  is_enabled: Schema.Boolean,
  prompt: Schema.optional(Schema.String),
  prediction_reasoning_effort: Schema.optional(Schema.String),
  unsupported_models: Schema.optional(Schema.Array(Schema.String)),
});
const ProviderConfig = Schema.Struct({
  base_url: Schema.optional(Schema.NullOr(Schema.String)),
  experimental_bearer_token: Schema.optional(Schema.NullOr(Schema.String)),
  env_key: Schema.optional(Schema.NullOr(Schema.String)),
  http_headers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  requires_openai_auth: Schema.optional(Schema.Boolean),
});
const Routing = Schema.Struct({
  workspaceRouting: Schema.Struct({
    backendOrigin: Schema.String,
    chatgptAccountId: Schema.String,
  }),
});
const Event = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
const Suggestion = Schema.fromJsonString(
  Schema.Struct({ suggestion: Schema.NullOr(Schema.String) }),
);
const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeConfig = Schema.decodeUnknownEffect(PredictionConfig);
const decodeProviders = Schema.decodeUnknownEffect(Schema.Record(Schema.String, ProviderConfig));
const decodeRouting = Schema.decodeUnknownEffect(Routing);
const decodeEvent = Schema.decodeEffect(Event);
const decodeSuggestion = Schema.decodeEffect(Suggestion, { onExcessProperty: "error" });

class PredictionError extends Schema.TaggedError<PredictionError>()("CodexPredictionError", {
  reason: Schema.String,
}) {}
const isPredictionError = Schema.is(PredictionError);

/** Fork-only client for ChatGPT's composer predictions, shared by an adapter's sessions. */
export const makeCodexComposerPredictions = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  let cachedConfig:
    | { key: string; expiresAt: number; config: typeof PredictionConfig.Type }
    | undefined;

  const predict = Effect.fn("codexComposerPrediction")(
    function* (input: {
      readonly client: {
        readonly request: CodexClient.CodexAppServerClient["Service"]["request"];
        readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
      };
      readonly environment: NodeJS.ProcessEnv;
      readonly nativeThreadId: string;
      readonly model: string;
      readonly turnId: string;
    }) {
      const auth = yield* input.client.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      });
      if (auth.authMethod !== "chatgpt" || !auth.authToken) {
        yield* Effect.logDebug("Skipped Codex composer prediction: ChatGPT sign-in required.");
        return null;
      }
      // The generated account/read decoder drops workspaceRouting on this CLI version.
      const { workspaceRouting: routing } = yield* input.client.raw
        .request("account/read", {})
        .pipe(Effect.flatMap(decodeRouting));
      const backendOrigin = routing.backendOrigin.replace(/\/+$/, "");
      const chatGptHeaders = {
        authorization: `Bearer ${auth.authToken}`,
        "ChatGPT-Account-ID": routing.chatgptAccountId,
      };
      const { config } = yield* input.client.request("config/read", { includeLayers: false });
      const providerName = config.model_provider ?? "openai";
      const providers = yield* decodeProviders(config.model_providers ?? {});
      const provider = providers[providerName];
      let endpoint: string;
      let headers: Record<string, string>;
      if (provider?.base_url) {
        endpoint = `${provider.base_url.replace(/\/+$/, "")}/responses`;
        const token =
          provider.experimental_bearer_token ||
          (provider.env_key ? input.environment[provider.env_key] : undefined) ||
          (provider.requires_openai_auth ? auth.authToken : undefined);
        headers = {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...provider.http_headers,
        };
      } else if (providerName === "openai") {
        endpoint = `${backendOrigin}/backend-api/codex/responses`;
        headers = chatGptHeaders;
      } else {
        yield* Effect.logDebug("Skipped Codex composer prediction: unsupported provider.");
        return null;
      }
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const key = `${backendOrigin}/${routing.chatgptAccountId}`;
      if (cachedConfig?.key !== key || cachedConfig.expiresAt <= now) {
        const response = yield* http.execute(
          HttpClientRequest.get(`${backendOrigin}/backend-api/wham/predictions/config`).pipe(
            HttpClientRequest.setHeaders({ ...chatGptHeaders, accept: "application/json" }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new PredictionError({ reason: `config HTTP ${response.status}` });
        }
        const predictionConfig = yield* response.json.pipe(Effect.flatMap(decodeConfig));
        cachedConfig = { key, expiresAt: now + 5 * 60_000, config: predictionConfig };
      }
      const predictionConfig = cachedConfig.config;
      if (
        !predictionConfig.is_enabled ||
        !predictionConfig.prompt?.trim() ||
        predictionConfig.unsupported_models?.includes(input.model)
      ) {
        yield* Effect.logDebug("Skipped Codex composer prediction: disabled or unsupported model.");
        return null;
      }

      const { thread } = yield* input.client.request("thread/read", {
        threadId: input.nativeThreadId,
        includeTurns: true,
      });
      const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
      for (const turn of thread.turns) {
        for (const item of turn.items) {
          if (item.type === "userMessage") {
            const text = item.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            if (text) messages.push({ role: "user", text });
          } else if (item.type === "agentMessage" && item.text) {
            messages.push({ role: "assistant", text: item.text });
          }
        }
      }
      const recent = messages.slice(-20);
      let characters = recent.reduce((total, message) => total + message.text.length, 0);
      while (characters > 24_000 && recent.length > 1) {
        characters -= recent.shift()!.text.length;
      }
      if (recent[0] && characters > 24_000) recent[0].text = recent[0].text.slice(-24_000);
      const effort = predictionConfig.prediction_reasoning_effort || "medium";
      const metadata = {
        thread_id: input.nativeThreadId,
        session_id: input.nativeThreadId,
        turn_id: input.turnId,
        request_kind: "turn",
        thread_source: "composer_predictions",
        turn_trigger: "composer_predictions",
        model: input.model,
        reasoning_effort: effort,
      };
      const response = yield* http.execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({ ...headers, accept: "text/event-stream" }),
          HttpClientRequest.bodyJsonUnsafe({
            model: input.model,
            stream: true,
            store: false,
            input: [
              ...recent.map((message) => ({
                type: "message",
                role: message.role,
                content: [
                  {
                    type: message.role === "user" ? "input_text" : "output_text",
                    text: message.text,
                  },
                ],
              })),
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `${predictionConfig.prompt}\n\nReturn only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.`,
                  },
                ],
              },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
            reasoning: { effort },
            text: { verbosity: "low" },
            prompt_cache_key: input.nativeThreadId,
            client_metadata: {
              ws_request_header_x_openai_internal_codex_responses_lite: "true",
              thread_id: input.nativeThreadId,
              session_id: input.nativeThreadId,
              turn_id: input.turnId,
              "x-codex-turn-metadata": encodeMetadata(metadata),
            },
          }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new PredictionError({ reason: `generation HTTP ${response.status}` });
      }
      const result = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((frame) =>
          Effect.gen(function* () {
            if (frame.event === "error")
              return yield* new PredictionError({ reason: "stream error" });
            const event = yield* decodeEvent(frame.data);
            if (event.type === "response.failed" || event.type === "error") {
              return yield* new PredictionError({ reason: "generation failed" });
            }
            return event;
          }),
        ),
        Stream.takeUntil((event) => event.type === "response.completed"),
        Stream.runFold(
          () => ({ text: "", completed: false }),
          (state, event) => ({
            text:
              state.text + (event.type === "response.output_text.delta" ? (event.delta ?? "") : ""),
            completed: event.type === "response.completed",
          }),
        ),
      );
      if (!result.completed) return yield* new PredictionError({ reason: "incomplete stream" });
      const decoded = yield* decodeSuggestion(result.text);
      return decoded.suggestion?.trim() || null;
    },
    Effect.timeout("30 seconds"),
    Effect.catch((cause) =>
      Effect.logDebug("Codex composer prediction unavailable.", {
        reason: isPredictionError(cause) ? cause.reason : cause._tag,
      }).pipe(Effect.as(null)),
    ),
    Effect.scoped,
  );

  return { predict };
});
