import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { invalidAutoCompactLimit } from "./autoCompactLimit.ts";

const withOptions = (options: ModelSelection["options"]): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  ...(options === undefined ? {} : { options }),
});

describe("invalidAutoCompactLimit", () => {
  it("accepts only one preset id or default", () => {
    const limit = (...values: Array<string | boolean>) =>
      invalidAutoCompactLimit(
        withOptions(values.map((value) => ({ id: "autoCompactLimit", value }))),
      );
    expect(invalidAutoCompactLimit(withOptions(undefined))).toBeUndefined();
    expect(limit("default")).toBeUndefined();
    expect(limit("250000")).toBeUndefined();
    for (const rejected of [["275000"], ["2.5e5"], [true], ["250000", "2.5e5"]]) {
      expect(limit(...rejected), String(rejected)).toBeDefined();
    }
  });
});
