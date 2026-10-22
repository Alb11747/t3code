import { resolveServerConfigVersionMismatch } from "./versionSkew";
import { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.34" }));
vi.mock("./branding", () => branding);

import { APP_VERSION } from "./branding";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  manualServerUpdateCommand,
  resolveVersionMismatch,
  serverUpdateTargetVersion,
} from "./versionSkew";

const MISMATCH_HINT =
  "Version mismatch. Try syncing the client and server to the same T3 Code version.";

describe("versionSkew", () => {
  it("keeps fork versions for desktop feeds and upstream versions for server installs", () => {
    const upstream = "0.0.46-nightly.20261015.3176";
    const fork = `${upstream}.fork.1`;
    expect(serverUpdateTargetVersion(fork, "desktop-managed")).toBe(fork);
    expect(serverUpdateTargetVersion(fork, "boot-service")).toBe(upstream);
    expect(serverUpdateTargetVersion(`${upstream}.fork`, "respawn")).toBe(upstream);
    expect(serverUpdateTargetVersion(upstream)).toBe(upstream);
    expect(serverUpdateTargetVersion("0.0.46")).toBe("0.0.46");
    expect(manualServerUpdateCommand(fork)).toBe(`npx t3@${upstream}`);
    expect(manualServerUpdateCommand(fork, { kind: "npm-global", prefix: "/opt/node" })).toBe(
      `npm install --global --prefix '/opt/node' t3@${upstream}`,
    );
  });

  it.each([".fork", ".fork.1"])("keeps a standalone %s server on fork releases", (suffix) => {
    const fork = "0.0.46-nightly.20261015.3176.fork.3";
    const olderFork = `0.0.46-nightly.20261014.3132${suffix}`;
    expect(serverUpdateTargetVersion(fork, "boot-service", olderFork)).toBe(fork);
    expect(serverUpdateTargetVersion(fork, null, olderFork)).toBe(fork);
    branding.APP_VERSION = fork;
    const environment = {
      environmentId: EnvironmentId.make("server"),
      label: "server",
      platform: { os: "linux", arch: "x64" } as const,
      serverVersion: olderFork,
      capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" as const },
    };
    expect(resolveServerConfigVersionMismatch({ environment })).toMatchObject({
      clientVersion: fork,
    });
    expect(
      resolveServerConfigVersionMismatch({
        environment: { ...environment, serverVersion: "0.0.46-nightly.20261015.3176.fork.2" },
      }),
    ).toMatchObject({ clientVersion: fork });
    expect(
      resolveServerConfigVersionMismatch({ environment: { ...environment, serverVersion: fork } }),
    ).toBeNull();
  });

  it("does not keep offering an upstream server its client's fork-only patches", () => {
    const upstream = "0.0.46-nightly.20261015.3176";
    branding.APP_VERSION = `${upstream}.fork.1`;
    const environment = {
      environmentId: EnvironmentId.make("server"),
      label: "server",
      platform: { os: "linux", arch: "x64" } as const,
      serverVersion: upstream,
      capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" as const },
    };
    expect(resolveServerConfigVersionMismatch({ environment })).toBeNull();
    expect(
      resolveServerConfigVersionMismatch({
        environment: { ...environment, serverVersion: "0.0.46-nightly.20261014.3100" },
      }),
    ).toMatchObject({ clientVersion: upstream });
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          ...environment,
          capabilities: { repositoryIdentity: true, serverSelfUpdate: "desktop-managed" },
        },
      }),
    ).toMatchObject({ clientVersion: branding.APP_VERSION });
  });

  it("updates only the proven npm prefix and safely quotes its path", () => {
    expect(manualServerUpdateCommand("0.0.45", { kind: "npm-global", prefix: "/opt/node" })).toBe(
      "npm install --global --prefix '/opt/node' t3@0.0.45",
    );
    expect(
      manualServerUpdateCommand("0.0.45", { kind: "npm-global", prefix: "/opt/maria's node" }),
    ).toBe("npm install --global --prefix '/opt/maria'\\''s node' t3@0.0.45");
  });
  beforeEach(() => {
    branding.APP_VERSION = "0.0.34";
  });

  it("dismisses only the current failed attempt without clearing its retry state", () => {
    const failure = {
      status: "failed",
      stage: "downloading",
      fromVersion: "0.0.33",
      targetVersion: "0.0.34",
      message: "Download failed.",
    } as const satisfies ServerUpdateState;
    const retryFailure = { ...failure };
    const otherEnvironmentFailure = { ...failure };

    dismissServerUpdateFailure(failure);

    expect(isServerUpdateFailureDismissed(failure)).toBe(true);
    expect(failure.status).toBe("failed");
    expect(failure.message).toBe("Download failed.");
    expect(isServerUpdateFailureDismissed(retryFailure)).toBe(false);
    expect(isServerUpdateFailureDismissed(otherEnvironmentFailure)).toBe(false);
  });

  it("returns a mismatch when the server is behind the client", () => {
    expect(resolveVersionMismatch("0.0.33")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "0.0.33",
      hint: MISMATCH_HINT,
    });
  });

  it("does not warn when the server is ahead of the client", () => {
    expect(resolveVersionMismatch("0.0.35")).toBeNull();
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when a nightly and a stable build share a core version", () => {
    expect(resolveVersionMismatch("0.0.34-nightly.20260818.1124")).toBeNull();

    branding.APP_VERSION = "0.0.34-nightly.20260818.1124";
    expect(resolveVersionMismatch("0.0.34")).toBeNull();
  });

  it.each(["0.0.34-nightly.20260823.1124", "0.0.34-nightly.20260824.1124"])(
    "warns when nightly server %s is behind a nightly client on the same release",
    (serverVersion) => {
      branding.APP_VERSION = "0.0.34-nightly.20260824.1125";

      expect(resolveVersionMismatch(serverVersion)).toEqual({
        clientVersion: "0.0.34-nightly.20260824.1125",
        serverVersion,
        hint: MISMATCH_HINT,
      });
    },
  );

  // regression: #7579 versions were compared as strings, not semver
  it("treats a nightly server built past the client as ahead, not skew", () => {
    expect(resolveVersionMismatch("0.0.35-nightly.20260818.1124")).toBeNull();
  });

  it("still warns when a nightly client outruns the server by a release", () => {
    branding.APP_VERSION = "0.0.35-nightly.20260818.1124";

    expect(resolveVersionMismatch("0.0.34")).toEqual({
      clientVersion: "0.0.35-nightly.20260818.1124",
      serverVersion: "0.0.34",
      hint: MISMATCH_HINT,
    });
  });

  it("falls back to string inequality when a version is not semver", () => {
    expect(resolveVersionMismatch("dev")).toEqual({
      clientVersion: "0.0.34",
      serverVersion: "dev",
      hint: MISMATCH_HINT,
    });

    branding.APP_VERSION = "dev";
    expect(resolveVersionMismatch("dev")).toBeNull();
    expect(resolveVersionMismatch("0.0.34")).toMatchObject({ serverVersion: "0.0.34" });
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });
});
