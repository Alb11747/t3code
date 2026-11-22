import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createScratchProjectActions } from "./useScratchProject";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(
  environmentId: EnvironmentId,
  scratchWorkspaceRoot: string | null,
  phase: "connected" | "offline" = "connected",
) {
  return {
    environmentId,
    connection: { phase },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
  remoteConnection: "connected" | "offline" = "connected",
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot, remoteConnection),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("prefers a remembered machine over the primary and the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(other, remote)).toBe(remote);
  });

  it("falls back if the remembered machine is offline or has no scratch root", () => {
    expect(
      actions(local, "/local/scratch", "/remote/scratch", "offline").scratchEnvironmentId(
        other,
        remote,
      ),
    ).toBe(local);
    expect(actions(local, null, null).scratchEnvironmentId(other, remote)).toBe(other);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });
});
