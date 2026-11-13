import type { ClaudeKeepWarmHold, OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";

/** The hold behind the active run's open keep-warm stall notice, for the thread shell. */
export function deriveKeepWarmHold(
  activeRunId: RunId | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ClaudeKeepWarmHold | null {
  if (activeRunId === null) return null;
  for (const item of turnItems) {
    if (
      item.runId === activeRunId &&
      item.type === "system_notice" &&
      item.status === "running" &&
      item.keepWarm !== undefined
    ) {
      return item.keepWarm;
    }
  }
  return null;
}

/** The shell's two views of that hold, for constructors that build a shell directly. */
export function keepWarmShellFields(
  activeRunId: RunId | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const keepWarmHold = deriveKeepWarmHold(activeRunId, turnItems);
  return { keepWarmStalled: keepWarmHold !== null, keepWarmHold };
}
