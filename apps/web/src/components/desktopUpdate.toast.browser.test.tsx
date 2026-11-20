import type { ReactNode } from "react";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

function getDescription(): ReactNode {
  const toast = testState.addToast.mock.calls[0]?.[0] as { description?: ReactNode } | undefined;
  return toast?.description ?? null;
}

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

function setup(repository = "pingdotgg/t3code"): Disposable {
  testState.addToast.mockReset();
  vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", repository);
  return { [Symbol.dispose]: () => vi.unstubAllEnvs() };
}

function renderDescription() {
  // The toast has no router dependency.
  return render(getDescription(), { router: false });
}

describe("showDesktopUpdateDownloadedToast", () => {
  it("opens release notes from the configured repository", async () => {
    using _repository = setup("JustYannicc/t3code");
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateDownloadedToast({ openExternal }, downloadedState());
    await using screen = await renderDescription();
    await userEvent.click(screen.getByRole("button", { name: "Read more" }));

    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/JustYannicc/t3code/releases/tag/v0.0.30",
      );
    });
  });

  it("opens the downloaded version's release notes", async () => {
    using _repository = setup("Alb11747/t3code");
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateDownloadedToast(
      { openExternal },
      downloadedState({
        availableVersion: "0.0.31",
        releaseHistoryUrl: "https://github.com/pingdotgg/t3code/releases",
      }),
    );
    await using screen = await renderDescription();
    await userEvent.click(screen.getByRole("button", { name: "Read more" }));
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
      );
    });
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });

  it("falls back to the version the download was started for", async () => {
    using _repository = setup();
    const openExternal = vi.fn().mockResolvedValue(true);

    // The `update-downloaded` event can land after the download RPC resolves.
    showDesktopUpdateDownloadedToast(
      { openExternal },
      downloadedState({ downloadedVersion: null }),
    );
    await using screen = await renderDescription();
    await userEvent.click(screen.getByRole("button", { name: "Read more" }));

    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
      );
    });
  });

  it.each(["fork", "fork.1"])(
    "opens %s release notes using the desktop updater's repository",
    async (suffix) => {
      using _repository = setup();
      const openExternal = vi.fn().mockResolvedValue(true);
      const version = `0.0.46-nightly.20261010.14.${suffix}`;
      showDesktopUpdateDownloadedToast(
        { openExternal },
        downloadedState({
          downloadedVersion: version,
          releaseHistoryUrl: "https://github.com/Alb11747/t3code/releases",
        }),
      );
      await using screen = await renderDescription();
      await userEvent.click(screen.getByRole("button", { name: "Read more" }));
      await vi.waitFor(() => {
        expect(openExternal).toHaveBeenCalledWith(
          `https://github.com/Alb11747/t3code/releases/tag/v${version}`,
        );
      });
    },
  );

  it("omits the link when the updater reports no version at all", async () => {
    using _repository = setup();
    showDesktopUpdateDownloadedToast(
      { openExternal: vi.fn() },
      downloadedState({ availableVersion: null, downloadedVersion: null }),
    );

    await using screen = await renderDescription();
    await expect
      .element(screen.getByText("Restart the app from the update button to install it."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Read more" })).not.toBeInTheDocument();
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("shows an error when opening release notes %s", async (_description, openExternal) => {
    using _repository = setup();
    showDesktopUpdateDownloadedToast({ openExternal }, downloadedState());
    await using screen = await renderDescription();
    await userEvent.click(screen.getByRole("button", { name: "Read more" }));

    await vi.waitFor(() => {
      expect(testState.addToast).toHaveBeenLastCalledWith({
        type: "error",
        title: "Unable to open release notes",
      });
    });
  });
});
