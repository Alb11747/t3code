import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";

import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

const encodeProbeAccount = Schema.encodeSync(
  Schema.fromJsonString(CodexSchema.V2GetAccountResponse),
);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const probeUsage = (account: CodexSchema.V2GetAccountResponse, usageReadFails = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-usage-probe-" });
    const methodsPath = path.join(directory, "methods.log");
    const binaryPath = writeFakeCli({
      directory,
      name: "codex",
      source: execScriptSource({
        scriptPath: path.resolve(__dirname, "fixtures/codex-usage-probe.mjs"),
        expectedArgs: ["app-server"],
      }),
      env: {
        CODEX_PROBE_ACCOUNT: encodeProbeAccount(account),
        CODEX_PROBE_METHODS: methodsPath,
        CODEX_PROBE_USAGE_ERROR: String(usageReadFails),
      },
    });
    const provider = yield* checkCodexProviderStatus(
      decodeCodexSettings({ binaryPath }),
      undefined,
      {
        ...process.env,
        T3CODE_CODEX_LAUNCH_ARGS: "",
      },
    );
    const methods = (yield* fs.readFileString(methodsPath)).trim().split("\n");
    return { provider, methods };
  });

it.effect.each([
  ["custom providers without an OpenAI account", { account: null, requiresOpenaiAuth: false }],
  ["API-key accounts", { account: { type: "apiKey" }, requiresOpenaiAuth: true }],
] as const)("skips unsupported native usage reads for %s", ([, account]) =>
  Effect.gen(function* () {
    const { provider, methods } = yield* Effect.scoped(probeUsage(account, true));
    assert.equal(provider.status, "ready");
    assert.equal(provider.usageLimits?.unavailable?.reason, "unsupported");
    assert.deepStrictEqual(
      provider.models.map((model) => model.slug),
      ["gpt-test"],
    );
    assert.include(methods, "skills/list");
    assert.notInclude(methods, "account/rateLimits/read");
  }).pipe(Effect.provide(NodeServices.layer)),
);

const chatgptAccount = {
  account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
  requiresOpenaiAuth: true,
} as const;

it.effect("still reads native usage for ChatGPT accounts", () =>
  Effect.gen(function* () {
    const { provider, methods } = yield* Effect.scoped(probeUsage(chatgptAccount));
    assert.equal(provider.status, "ready");
    assert.include(methods, "account/rateLimits/read");
    assert.equal(provider.usageLimits?.unavailable, undefined);
    assert.equal(provider.usageLimits?.windows[0]?.usedPercent, 42);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves genuine ChatGPT usage-read failures without losing models or readiness", () =>
  Effect.gen(function* () {
    const { provider, methods } = yield* Effect.scoped(probeUsage(chatgptAccount, true));
    assert.equal(provider.status, "ready");
    assert.include(methods, "account/rateLimits/read");
    assert.deepStrictEqual(
      provider.models.map((model) => model.slug),
      ["gpt-test"],
    );
    assert.equal(provider.usageLimits?.unavailable?.reason, "probeFailed");
    assert.equal(
      provider.usageLimits?.unavailable?.message,
      "Codex could not read usage (JSON-RPC -32600).",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
