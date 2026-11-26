import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { ThreadToolkit } from "./tools.ts";

const tool = ThreadToolkit.tools.t3_thread_configure;
const decode = Schema.decodeUnknownExit(tool.parametersSchema);

// Claude Code sends a value whose schema allows a string as the text the model wrote.
it("takes the compaction switches as JSON values or their text", () => {
  for (const [sent, value] of [
    [true, true],
    ["true", true],
    ["false", false],
    ["null", null],
    ["once", "once"],
    [null, null],
  ] as const) {
    expect(decode({ compactBeforeCacheExpires: sent, compactAfterIdle: sent })).toEqual(
      Exit.succeed({ compactBeforeCacheExpires: value, compactAfterIdle: value }),
    );
  }
  expect(Exit.isFailure(decode({ compactBeforeCacheExpires: "yes" }))).toBe(true);
  const advertised = advertisedJsonSchema(tool).properties as Record<string, { anyOf: unknown }>;
  expect(advertised.compactBeforeCacheExpires?.anyOf).toEqual([
    { type: "boolean" },
    { type: "string", enum: ["once"] },
    { type: "null" },
  ]);
});
