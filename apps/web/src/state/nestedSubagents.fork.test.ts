import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveNestedSubagentTree, descendantRunStatus } from "./nestedSubagents.fork";

const shell = (
  id: string,
  parentThreadId: string | null,
  options: {
    readonly status?: string;
    readonly relationship?: "fork" | "subagent";
    readonly sideChat?: boolean;
    readonly held?: boolean;
    readonly backgroundTasks?: number;
  } = {},
) =>
  ({
    id,
    title: id,
    status: options.status ?? "running",
    activityRunStatus: null,
    activityRunStartedAt: null,
    keepWarmStalled: options.held,
    pendingBackgroundTasks: Array.from({ length: options.backgroundTasks ?? 0 }, () => ({})),
    lineage: {
      parentThreadId,
      relationshipToParent: options.relationship ?? "subagent",
      sideChat: options.sideChat,
    },
  }) as unknown as OrchestrationV2ThreadShell;

const root = "root" as OrchestrationV2ThreadShell["id"];

const rowsOf = (tree: ReturnType<typeof deriveNestedSubagentTree>) =>
  Object.fromEntries(
    [...tree.rowsByChild].map(([childId, rows]) => [
      childId,
      rows.map((row) => `${row.threadId}@${row.depth}:${row.status}`),
    ]),
  );

describe("deriveNestedSubagentTree", () => {
  it("counts and lists live work below direct subagents, as direct rows show it", () => {
    const tree = deriveNestedSubagentTree(root, [
      shell("root", null),
      shell("child", "root"),
      shell("done-child", "root", { status: "completed" }),
      shell("idle-child", "root", { status: "completed" }),
      shell("grandchild", "child"),
      shell("great-grandchild", "grandchild"),
      // Waiting on a held leaf reads as stalled, like the child's own panel shows it.
      shell("waiting", "child"),
      shell("held-leaf", "waiting", { held: true }),
      shell("idle-grandchild", "child", { status: "completed" }),
      shell("idle-under-idle", "idle-child", { status: "completed" }),
      shell("fork-grandchild", "child", { relationship: "fork" }),
      shell("side-chat", "child", { sideChat: true }),
      // A turn that ended still runs, as its parent's task does, while its own work goes on.
      shell("under-done", "done-child", { status: "completed" }),
      shell("under-under-done", "under-done"),
      shell("backgrounded", "done-child", { status: "completed", backgroundTasks: 1 }),
    ]);

    expect(tree.runningCount).toBe(5);
    expect(rowsOf(tree)).toEqual({
      child: [
        "grandchild@1:running",
        "great-grandchild@2:running",
        "waiting@1:stalled",
        "held-leaf@2:stalled",
      ],
      "done-child": [
        "under-done@1:running",
        "under-under-done@2:running",
        "backgrounded@1:running",
      ],
    });
    // A direct subagent whose own turn ended reads as running while its subagents run.
    expect(descendantRunStatus(tree.rowsByChild.get("done-child" as typeof root))).toBe("running");
    expect(descendantRunStatus(tree.rowsByChild.get("idle-child" as typeof root))).toBeUndefined();
  });

  it("keeps the root out of its own tree when lineage loops", () => {
    const tree = deriveNestedSubagentTree(root, [
      shell("root", "grandchild"),
      shell("child", "root"),
      shell("grandchild", "child"),
    ]);

    expect(rowsOf(tree)).toEqual({ child: ["grandchild@1:running"] });
  });

  it("shows a paced-waiting Codex grandchild as stalled and out of runningCount", () => {
    const pacedGrandchild = {
      ...shell("paced-grandchild", "child", { status: "queued" }),
      activeRunId: null,
      pacedUntil: "2026-11-27T11:00:00.000Z",
    } as unknown as OrchestrationV2ThreadShell;
    const tree = deriveNestedSubagentTree(root, [
      shell("root", null),
      shell("child", "root"),
      pacedGrandchild,
    ]);

    expect(tree.runningCount).toBe(0);
    expect(rowsOf(tree)).toEqual({ child: ["paced-grandchild@1:stalled"] });
  });
});
