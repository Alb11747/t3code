import type { ClaudeKeepWarmHold, RunId } from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";

/** The hold behind the active run's open keep-warm stall notice; null when that run is not stalled. */
export function activeKeepWarmHold(
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  activeRunId: RunId | null,
): ClaudeKeepWarmHold | null {
  if (activeRunId === null) return null;
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.type === "system_notice" && item.runId === activeRunId && item.keepWarm) {
      return item.status === "running" ? item.keepWarm : null;
    }
  }
  return null;
}
