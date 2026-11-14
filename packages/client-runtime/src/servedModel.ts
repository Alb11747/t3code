// Fork: when a CLI Proxy hub answers a retired model ID with another model, say which one ran.
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";

// Claude Code's 1M-context suffix selects an option of the same model, not another model.
const baseModel = (slug: string) => slug.replace(/\[1m\]$/i, "");

/** "Claude Opus 5.5, asked for Claude Opus 4.7", or null when the requested model ran. */
function servedModelNote(requested: string, executed: string | null | undefined): string | null {
  if (!executed || baseModel(executed) === baseModel(requested)) return null;
  return `${formatModelSlugName(executed)}, asked for ${formatModelSlugName(requested)}`;
}

/**
 * Each run's note, from the model its active attempt's latest provider turn reported, in one pass
 * over the thread so reply rows can look theirs up.
 */
export function runServedModelNotes(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): ReadonlyMap<RunId, string> {
  const latest = new Map<
    string,
    { readonly ordinal: number; readonly model?: string | undefined }
  >();
  for (const turn of projection.providerTurns) {
    if (turn.runAttemptId === null) continue;
    const previous = latest.get(turn.runAttemptId);
    if (previous === undefined || turn.ordinal > previous.ordinal)
      latest.set(turn.runAttemptId, turn);
  }
  const notes = new Map<RunId, string>();
  for (const run of projection.runs) {
    const model = run.activeAttemptId === null ? undefined : latest.get(run.activeAttemptId)?.model;
    const note = servedModelNote(run.modelSelection.model, model);
    if (note !== null) notes.set(run.id, note);
  }
  return notes;
}

/** The picker note for a retired ID the hub answers with `servedBy`. */
export function servedByNote(servedBy: string): string {
  return `Answered by ${formatModelSlugName(servedBy)}`;
}
