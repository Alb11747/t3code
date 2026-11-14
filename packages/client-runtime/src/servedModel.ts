// Fork: when a CLI Proxy hub answers a retired model ID with another model, say which one ran.
import {
  latestProviderTurnForAttempt,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";

// Claude Code's 1M-context suffix selects an option of the same model, not another model.
const baseModel = (slug: string) => slug.replace(/\[1m\]$/i, "");

/** "Claude Opus 5.5, asked for Claude Opus 4.7", or null when the requested model ran. */
function servedModelNote(requested: string, executed: string | null | undefined): string | null {
  if (!executed || baseModel(executed) === baseModel(requested)) return null;
  return `${formatModelSlugName(executed)}, asked for ${formatModelSlugName(requested)}`;
}

/** The note for a run, from the model its latest provider turn reported. */
export function runServedModelNote(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  runId: RunId,
): string | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return null;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  return servedModelNote(run.modelSelection.model, turn?.model);
}

/** The picker note for a retired ID the hub answers with `servedBy`. */
export function servedByNote(servedBy: string): string {
  return `Answered by ${formatModelSlugName(servedBy)}`;
}
