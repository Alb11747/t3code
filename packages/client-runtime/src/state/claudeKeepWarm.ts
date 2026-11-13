import type { ClaudeKeepWarmHold, RunId } from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";

/**
 * The hold behind the active run's newest keep-warm stall notice: an open one, or one the user
 * `released` (the server clears that mark at the reset). Null when that run is neither.
 */
export function activeKeepWarmHold(
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  activeRunId: RunId | null,
): ClaudeKeepWarmHold | null {
  if (activeRunId === null) return null;
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.type === "system_notice" && item.runId === activeRunId && item.keepWarm) {
      return item.status === "running" || item.keepWarm.released ? item.keepWarm : null;
    }
  }
  return null;
}
