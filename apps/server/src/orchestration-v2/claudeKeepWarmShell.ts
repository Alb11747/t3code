import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";

export function deriveKeepWarmStalled(
  activeRunId: RunId | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  return (
    activeRunId !== null &&
    turnItems.some(
      (item) =>
        item.runId === activeRunId &&
        item.type === "system_notice" &&
        item.status === "running" &&
        item.keepWarm !== undefined,
    )
  );
}
