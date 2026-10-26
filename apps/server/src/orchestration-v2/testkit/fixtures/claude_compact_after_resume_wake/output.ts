import { assert } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import { claudeCompactRuns } from "../claude_compact_after_peer_turn/output.ts";

// The acknowledged prompt uuid proves the unechoed wake result is foreign; it must not settle /compact.
// Already streamed wake text remains on the /compact run.
export function assertClaudeCompactAfterResumeWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const compaction = projection.turnItems.find((item) => item.type === "compaction");
  assert.deepEqual(
    projection.providerTurns.find((turn) => turn.id === compaction?.providerTurnId)?.nativeTurnRef,
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: "947bf546-b12e-4883-abb9-d2d208701877",
      strength: "strong",
    },
  );
  assert.deepEqual(claudeCompactRuns(projection), [
    {
      text: CLAUDE_COMPACT_FIRST_PROMPT,
      fromUser: true,
      status: "completed",
      replies: ["compact probe first turn"],
      compactions: [],
    },
    {
      text: "/compact",
      fromUser: true,
      status: "completed",
      replies: ["A_REPORTED"],
      compactions: [[27445, 1192]],
    },
  ]);
}
