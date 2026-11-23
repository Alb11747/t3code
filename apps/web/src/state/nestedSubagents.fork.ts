import { useAtomValue } from "@effect/atom-react";
import type {
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { stalledSubagentsByThread } from "@t3tools/client-runtime/state/claudeKeepWarm";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

export interface NestedSubagentRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** "stalled" when held or waiting on a held subagent, as direct lineage rows show it. */
  readonly status: string | null;
  readonly startedAt: string | null;
  /** 1 for a subagent's own subagent, 2 below that, and so on. */
  readonly depth: number;
}

export interface NestedSubagentTree {
  /** Running, not stalled, subagents two or more subagent hops below the thread. */
  readonly runningCount: number;
  /** Each direct subagent's live descendants in tree order; children with none are absent. */
  readonly rowsByChild: ReadonlyMap<ThreadId, ReadonlyArray<NestedSubagentRow>>;
}

const EMPTY_TREE: NestedSubagentTree = { runningCount: 0, rowsByChild: new Map() };

/**
 * Only shells with app runs report work, so this covers T3-delegated agents. Provider-native
 * subagents of a child have runless shells and stay out. Idle threads are often missing from
 * shells, so only running threads are kept.
 */
export function deriveNestedSubagentTree(
  rootId: ThreadId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): NestedSubagentTree {
  const childrenByParent = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (
      parentId === null ||
      thread.lineage.relationshipToParent !== "subagent" ||
      thread.lineage.sideChat === true
    )
      continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(parentId, [thread]);
  }
  const direct = childrenByParent.get(rootId);
  if (direct === undefined) return EMPTY_TREE;
  const waitingOnHeld = stalledSubagentsByThread(threads);
  const visited = new Set<ThreadId>([rootId, ...direct.map((child) => child.id)]);
  let runningCount = 0;
  const walk = (parentId: ThreadId, depth: number): NestedSubagentRow[] => {
    const rows: NestedSubagentRow[] = [];
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const below = walk(child.id, depth + 1);
      // Its parent's task stays running while its background work or its subagents run.
      const running =
        (child.activityRunStatus ?? child.status) === "running" ||
        (child.pendingBackgroundTasks?.length ?? 0) > 0 ||
        below.length > 0;
      if (!running) continue;
      const stalled = child.keepWarmStalled === true || waitingOnHeld.has(child.id);
      if (!stalled) runningCount += 1;
      const startedAt = child.activityRunStartedAt ?? child.latestRunStartedAt;
      rows.push(
        {
          threadId: child.id,
          title: child.title,
          providerInstanceId: child.providerInstanceId,
          status: stalled ? "stalled" : "running",
          startedAt: startedAt == null ? null : DateTime.formatIso(startedAt),
          depth,
        },
        ...below,
      );
    }
    return rows;
  };
  const rowsByChild = new Map<ThreadId, ReadonlyArray<NestedSubagentRow>>();
  for (const child of direct) {
    const rows = walk(child.id, 1);
    if (rows.length > 0) rowsByChild.set(child.id, rows);
  }
  return rowsByChild.size === 0 ? EMPTY_TREE : { runningCount, rowsByChild };
}

/**
 * How a direct subagent reads while its own subagents work, even after its own turn ended:
 * running while any of them runs, otherwise stalled with them. Undefined when none work.
 */
export function descendantRunStatus(
  rows: ReadonlyArray<NestedSubagentRow> | undefined,
): "running" | "stalled" | undefined {
  if (rows === undefined) return undefined;
  return rows.some((row) => row.status === "running") ? "running" : "stalled";
}

const sameRow = (left: NestedSubagentRow, right: NestedSubagentRow) =>
  left.threadId === right.threadId &&
  left.title === right.title &&
  left.providerInstanceId === right.providerInstanceId &&
  left.status === right.status &&
  left.startedAt === right.startedAt &&
  left.depth === right.depth;

function sameTree(left: NestedSubagentTree, right: NestedSubagentTree): boolean {
  if (left.runningCount !== right.runningCount) return false;
  if (left.rowsByChild.size !== right.rowsByChild.size) return false;
  for (const [childId, rows] of left.rowsByChild) {
    const other = right.rowsByChild.get(childId);
    if (other?.length !== rows.length || !rows.every((row, i) => sameRow(row, other[i]!)))
      return false;
  }
  return true;
}

// Compares displayed fields, so streaming-only shell changes do not re-render the panel.
const nestedSubagentTreeAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous = EMPTY_TREE;
  return Atom.make((get) => {
    const next = deriveNestedSubagentTree(
      ref.threadId,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    );
    if (sameTree(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-nested-subagent-tree:${key}`));
});

export function useNestedSubagentTree(ref: ScopedThreadRef): NestedSubagentTree {
  return useAtomValue(nestedSubagentTreeAtomFamily(threadKey(ref)));
}
