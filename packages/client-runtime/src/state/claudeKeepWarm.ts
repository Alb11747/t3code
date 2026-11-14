import type {
  ClaudeKeepWarmHold,
  OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell, ThreadStructureTurnItem } from "./models.ts";

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

const NO_STALLED_SUBAGENTS: ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>> = new Map();

/**
 * Each thread's direct subagents that are held, or have a held subagent below them, so a
 * parent waiting on one shows the stall. Side chats are not waited on, so they never count.
 */
export function stalledSubagentsByThread(
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "keepWarmStalled">>,
): ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>> {
  const isSubagent = (thread: Pick<OrchestrationV2ThreadShell, "lineage">) =>
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.sideChat !== true;
  const held = threads.filter((thread) => thread.keepWarmStalled === true && isSubagent(thread));
  if (held.length === 0) return NO_STALLED_SUBAGENTS;
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const stalled = new Map<ThreadId, ThreadId[]>();
  for (const thread of held) {
    const seen = new Set<ThreadId>([thread.id]);
    let child = thread;
    while (child.lineage.parentThreadId !== null && !seen.has(child.lineage.parentThreadId)) {
      const parentId = child.lineage.parentThreadId;
      seen.add(parentId);
      const ids = stalled.get(parentId);
      if (ids === undefined) stalled.set(parentId, [child.id]);
      else if (!ids.includes(child.id)) ids.push(child.id);
      const parent = byId.get(parentId);
      if (parent === undefined || !isSubagent(parent)) break;
      child = parent;
    }
  }
  return stalled;
}

/**
 * Whether a thread listed as Working or Waiting shows Stalling instead: its own turn is held,
 * or it is waiting while a subagent below it is held.
 */
export function threadShowsKeepWarmStall(
  thread: Pick<EnvironmentThreadShell, "keepWarmStalled" | "stalledSubagentThreadIds">,
  waiting: boolean,
): boolean {
  return (
    thread.keepWarmStalled === true ||
    (waiting && (thread.stalledSubagentThreadIds?.length ?? 0) > 0)
  );
}
