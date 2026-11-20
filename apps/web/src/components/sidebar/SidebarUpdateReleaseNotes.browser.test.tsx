import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function setup(repository = "pingdotgg/t3code"): Disposable {
  testState.addToast.mockReset();
  vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", repository);
  return { [Symbol.dispose]: () => vi.unstubAllEnvs() };
}

function renderNotes(state: DesktopUpdateState, openExternal = vi.fn().mockResolvedValue(true)) {
  // Release notes are standalone and use external links.
  return render(
    <SidebarUpdateReleaseNotes shell={{ openExternal }} state={state} tooltip="Update available" />,
    { router: false },
  );
}

function releaseLinks(container: HTMLElement) {
  return [...container.querySelectorAll("a")];
}

describe("SidebarUpdateReleaseNotes", () => {
  it("uses the configured repository for release links", async () => {
    using _repository = setup("JustYannicc/t3code");
    await using screen = await renderNotes({
      ...baseState,
      releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
      omittedReleaseCount: 1,
    });
    const anchors = releaseLinks(screen.container);

    expect(anchors.map((anchor) => anchor.href)).toEqual([
      "https://github.com/JustYannicc/t3code/releases/tag/v0.0.36-nightly.3",
      "https://github.com/JustYannicc/t3code/releases",
    ]);
  });

  it("links fork previews and omitted releases to the desktop updater's repository", async () => {
    using _repository = setup();
    const historyUrl = "https://github.com/Alb11747/t3code/releases";
    const version = "0.0.46-nightly.20261010.14.fork.1";
    await using screen = await renderNotes({
      ...baseState,
      availableVersion: version,
      releaseHistoryUrl: historyUrl,
      releaseNotes: [{ version, items: ["Fork change"], totalItems: 1 }],
      omittedReleaseCount: 1,
    });
    const anchors = releaseLinks(screen.container);

    expect(anchors.map((anchor) => anchor.href)).toEqual([
      `${historyUrl}/tag/v${version}`,
      historyUrl,
    ]);
  });

  it("links each preview to its exact release and labels hidden changes", async () => {
    using _repository = setup();
    await using screen = await renderNotes({
      ...baseState,
      releaseNotes: [
        { version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 },
        { version: "0.0.36-nightly.2", items: ["Change 2"], totalItems: 2 },
        { version: "0.0.36-nightly.1", items: ["Change 1", "Earlier"], totalItems: 4 },
      ],
    });
    const anchors = releaseLinks(screen.container);

    expect(anchors.map((anchor) => anchor.href)).toEqual([
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.2",
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.1",
    ]);
    expect(anchors.map((anchor) => anchor.textContent?.trim())).toEqual([
      "View release on GitHub",
      "1 more change on GitHub",
      "2 more changes on GitHub",
    ]);
  });

  it("links omitted releases to release history", async () => {
    using _repository = setup();
    await using screen = await renderNotes({
      ...baseState,
      releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
      omittedReleaseCount: 1,
    });
    const anchors = releaseLinks(screen.container);

    expect(anchors.at(-1)?.href).toBe("https://github.com/pingdotgg/t3code/releases");
    expect(anchors.at(-1)?.textContent?.trim()).toBe("1 older release on GitHub");
  });

  it("shows plural history text for multiple omitted releases", async () => {
    using _repository = setup();
    await using screen = await renderNotes({
      ...baseState,
      releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
      omittedReleaseCount: 3,
    });
    const anchors = releaseLinks(screen.container);

    expect(anchors.at(-1)?.textContent?.trim()).toBe("3 older releases on GitHub");
  });

  it("reports a release link that fails to open", async () => {
    using _repository = setup();
    const openExternal = vi.fn().mockResolvedValue(false);
    await using screen = await renderNotes(
      {
        ...baseState,
        releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
      },
      openExternal,
    );
    const preventedNavigation = vi.fn();
    screen.container.addEventListener(
      "click",
      (event) => {
        preventedNavigation(event.defaultPrevented);
        event.preventDefault();
      },
      { once: true },
    );

    await userEvent.click(screen.getByRole("link", { name: "View release on GitHub" }));

    expect(preventedNavigation).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
      );
      expect(testState.addToast).toHaveBeenCalledWith({
        type: "error",
        title: "Unable to open release notes",
      });
    });
  });
});
