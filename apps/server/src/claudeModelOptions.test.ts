import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  scopeClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("resolves the auto-compact limit from the thread, then the model's default", () => {
    const pick = (value: string) =>
      selection("claude-opus-5-5", [{ id: "autoCompactLimit", value }]);
    const defaults = { "claude-opus-5-5": 300_000 };
    const compile = (input: ModelSelection, limits?: Record<string, unknown>) =>
      compileClaudeModelSelection(input, BUNDLED_CLAUDE_MODEL_CATALOG, limits).autoCompactLimit;
    expect(compile(pick("250000"))).toBe(250_000);
    expect(compile(pick("250000"), defaults)).toBe(250_000);
    expect(compile(pick("default"), defaults)).toBe(300_000);
    expect(compile(selection("claude-opus-5-5", []), defaults)).toBe(300_000);
    expect(compile(pick("default"))).toBeUndefined();
    // Only offered presets count; anything else falls back.
    expect(compile(pick("12345"), defaults)).toBe(300_000);
    expect(compile(pick("2.5e5"), defaults)).toBe(300_000);
    // An alias finds the default kept under its catalog slug.
    expect(compile(selection("opus", []), defaults)).toBe(300_000);
    // Entries outside Claude's window range, or not integers, are ignored one by one.
    expect(
      compile(selection("claude-opus-5-5", []), { "claude-opus-5-5": 75_000 }),
    ).toBeUndefined();
    expect(
      compile(selection("claude-opus-5-5", []), { "claude-opus-5-5": "250k" }),
    ).toBeUndefined();
    expect(compileClaudeModelSelection(pick("250000")).queryIdentity).not.toBe(
      compileClaudeModelSelection(pick("default")).queryIdentity,
    );
  });

  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("runs Ultracode at the chosen effort and reads the old Ultracode effort as xhigh", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "high" },
          { id: "ultracode", value: true },
        ]),
      ),
    ).toMatchObject({ effort: "high", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }]),
      ),
    ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    const legacyTurnedOff = compileClaudeModelSelection(
      selection("claude-opus-5-5", [
        { id: "effort", value: "ultracode" },
        { id: "ultracode", value: false },
      ]),
    );
    expect(legacyTurnedOff.effort).toBe("xhigh");
    expect(legacyTurnedOff.settings.ultracode).toBe(false);
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "effort", value: "high" }]))
        .settings,
    ).not.toHaveProperty("ultracode");
  });

  it("keeps old Ultracode defaults and selections at Extra High on custom models", () => {
    const customModel = (slug: string, choices: ReadonlyArray<string>) => ({
      slug,
      name: slug,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            currentValue: "ultracode",
            options: choices.map((id) => ({ id, label: id, isDefault: id === "ultracode" })),
          },
        ],
      },
    });
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      customModel("claude-custom-tuned", ["high", "xhigh", "ultracode"]),
      customModel("claude-custom-no-xhigh", ["high", "ultracode"]),
    ]);

    for (const model of ["claude-custom-tuned", "claude-custom-no-xhigh"]) {
      expect(compileClaudeModelSelection(selection(model, []), catalog)).toMatchObject({
        effort: "xhigh",
        settings: { ultracode: true },
      });
      expect(
        compileClaudeModelSelection(
          selection(model, [{ id: "effort", value: "ultracode" }]),
          catalog,
        ),
      ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    }
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("ignores thinking for catalog models without a thinking option", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "thinking", value: false }]))
        .settings,
    ).not.toHaveProperty("alwaysThinkingEnabled");
  });

  it.each(["gateway-route", "gateway-route[1m]"])(
    "keeps explicit effort and thinking for %s outside the local catalog",
    (model) => {
      for (const thinking of [true, false]) {
        expect(
          compileClaudeModelSelection(
            selection(model, [
              { id: "effort", value: "max" },
              { id: "thinking", value: thinking },
            ]),
          ),
        ).toMatchObject({
          apiModelId: model,
          effort: "max",
          settings: { alwaysThinkingEnabled: thinking },
        });
      }
      const unconfigured = compileClaudeModelSelection(selection(model, []));
      expect(unconfigured.effort).toBeUndefined();
      expect(unconfigured.settings).toEqual({});
    },
  );
});
