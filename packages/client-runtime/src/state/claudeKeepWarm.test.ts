import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stalledSubagentsByThread, threadPacedWait } from "./claudeKeepWarm.ts";

const UNTIL = "2026-11-27T11:00:00.000Z";

describe("threadPacedWait", () => {
  it("is true only for queued work behind pacedUntil with no active run on wire shells", () => {
    const queued = {
      status: "queued" as const,
      activeRunId: null,
      activityRunStatus: null,
      pacedUntil: UNTIL,
    };
    expect(threadPacedWait(queued)).toBe(true);
    expect(threadPacedWait({ ...queued, pacedUntil: null })).toBe(false);
    expect(threadPacedWait({ ...queued, pacedUntil: undefined })).toBe(false);
    expect(threadPacedWait({ ...queued, status: "completed" })).toBe(false);
    // A running turn with a queued follow-up is working, not paced.
    expect(
      threadPacedWait({
        ...queued,
        activeRunId: RunId.make("run-1"),
        activityRunStatus: "running",
      }),
    ).toBe(false);
  });

  it("reads presented shells, including a runtime parked at idle by background work", () => {
    const queued = {
      pacedUntil: UNTIL,
      latestRun: { status: "queued" as const },
      runtime: { status: "queued" as const, activeRunId: null },
    };
    expect(threadPacedWait(queued)).toBe(true);
    expect(threadPacedWait({ ...queued, runtime: { status: "idle", activeRunId: null } })).toBe(
      true,
    );
    expect(
      threadPacedWait({
        ...queued,
        runtime: { status: "running", activeRunId: RunId.make("run-1") },
      }),
    ).toBe(false);
    expect(threadPacedWait({ ...queued, latestRun: { status: "completed" } })).toBe(false);
    expect(threadPacedWait({ ...queued, pacedUntil: null })).toBe(false);
  });
});

describe("stalledSubagentsByThread", () => {
  it("rolls a paced-waiting subagent up to its parent, but not an idle one or a side chat", () => {
    const rootId = ThreadId.make("root");
    const shell = (
      id: string,
      overrides: Partial<Parameters<typeof stalledSubagentsByThread>[0][number]> = {},
    ) => ({
      id: ThreadId.make(id),
      lineage: {
        rootThreadId: rootId,
        parentThreadId: rootId,
        relationshipToParent: "subagent" as const,
      },
      keepWarmStalled: false,
      status: "queued" as const,
      activeRunId: null,
      activityRunStatus: null,
      pacedUntil: UNTIL,
      ...overrides,
    });
    const result = stalledSubagentsByThread([
      shell("root", {
        lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
        pacedUntil: null,
        status: "running",
      }),
      shell("paced-child"),
      shell("idle-child", { status: "completed" }),
      shell("side-chat", {
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
          sideChat: true,
        },
      }),
    ]);
    expect(result.get(rootId)).toEqual([ThreadId.make("paced-child")]);
  });
});
