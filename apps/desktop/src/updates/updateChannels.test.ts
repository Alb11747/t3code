import { describe, expect, it } from "vite-plus/test";

import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(desktopUpdateChannelOf("0.0.41-preview.20260911.7")).toBe("latest");
    expect(desktopUpdateChannelOf("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("keeps fork builds of a nightly on the nightly channel", () => {
    for (const version of ["0.0.41-nightly.20260911.7.fork", "0.0.41-nightly.20260911.7.fork.2"]) {
      expect(isNightlyDesktopVersion(version)).toBe(true);
      expect(desktopUpdateChannelOf(version)).toBe("nightly");
    }
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
