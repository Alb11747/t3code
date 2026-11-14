import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";

import { runServedModelNote } from "./servedModel.ts";

const runId = "run-1" as RunId;
const projection = (requested: string, turns: ReadonlyArray<{ ordinal: number; model?: string }>) =>
  ({
    runs: [{ id: runId, activeAttemptId: "attempt-1", modelSelection: { model: requested } }],
    providerTurns: [
      ...turns.map((turn) => ({ runAttemptId: "attempt-1", ...turn })),
      // Another attempt's turn never speaks for this run.
      { runAttemptId: "attempt-0", ordinal: 9, model: "gpt-5.5" },
    ],
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">;

describe("runServedModelNote", () => {
  it.each([
    [
      "claude-opus-4-7",
      [{ ordinal: 1, model: "claude-opus-5-5" }],
      "Claude Opus 5.5, asked for Claude Opus 4.7",
    ],
    [
      "gpt-6-sol",
      [{ ordinal: 1 }, { ordinal: 2, model: "gpt-6.1-sol" }],
      "GPT-6.1-Sol, asked for GPT-6-Sol",
    ],
    ["claude-opus-5-5", [{ ordinal: 1, model: "claude-opus-5-5" }], null],
    ["claude-opus-5-5[1m]", [{ ordinal: 1, model: "claude-opus-5-5" }], null],
    ["gpt-6.1-sol", [{ ordinal: 1 }], null],
  ])("%s with %j reads %s", (requested, turns, expected) => {
    expect(runServedModelNote(projection(requested, turns), runId)).toBe(expected);
  });
});
