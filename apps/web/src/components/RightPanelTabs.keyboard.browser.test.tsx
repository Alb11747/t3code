import { type ComponentProps } from "react";

import { act, render, fakeTimers, stubGlobal } from "../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { RightPanelTabs } from "./RightPanelTabs";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

const addFiles = vi.fn();
const noop = () => undefined;

async function setup() {
  using stack = new DisposableStack();
  // The real pointer stays wherever an earlier test file left it. If the menu opens under it,
  // closing the menu fires a mouseleave that Base UI treats as a hover close, and focus does not
  // return to the trigger. Park it in the far corner, away from the panel and its menu.
  const pointerRest = document.createElement("div");
  Object.assign(pointerRest.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "16px",
    height: "16px",
  });
  document.body.append(pointerRest);
  await userEvent.hover(pointerRest);
  pointerRest.remove();
  stack.use(fakeTimers());
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    ),
  );
  stack.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  addFiles.mockClear();
  return stack.move();
}

function panelElement(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  return (
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={addFiles}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...overrides}
    >
      content
    </RightPanelTabs>
  );
}

async function renderPanel(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  const screen = await render(panelElement(overrides));
  await act(() => vi.advanceTimersByTimeAsync(0));
  return screen;
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
  return event;
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      using _setup = await setup();
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await using _screen = await renderPanel();
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("opens Files while a closed popup remains mounted", async () => {
    using _setup = await setup();
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("f")).defaultPrevented).toBe(true);
    expect(addFiles).toHaveBeenCalledOnce();
  });

  it("opens the add-surface menu while a closed popup remains mounted", async () => {
    using _setup = await setup();
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).not.toBeNull();
  });

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    using _setup = await setup();
    await using _screen = await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      using _setup = await setup();
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await using screen = await renderPanel({
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      screen.container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    using _setup = await setup();
    const input = document.createElement("input");
    await using screen = await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    // The menu hands focus back to its trigger once its close finishes, a few frames later.
    // Timers are fake here, so advance them instead of polling in real time.
    const trigger = screen.container.querySelector('[aria-label="Add panel surface"]');
    for (let frame = 0; frame < 10 && document.activeElement !== trigger; frame++) {
      await act(() => vi.advanceTimersToNextFrame());
    }
    expect(document.activeElement).toBe(trigger);
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    using _setup = await setup();
    await using screen = await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    dialog.dataset.open = "";
    screen.container.append(dialog);
    for (const state of ["data-open", "data-ending-style"]) {
      dialog.setAttribute(state, "");
      expect((await press("f")).defaultPrevented, state).toBe(false);
      expect(addFiles, state).not.toHaveBeenCalled();
      expect((await press("t", { metaKey: true })).defaultPrevented, state).toBe(false);
      expect(document.querySelector('[role="menu"]'), state).toBeNull();
      dialog.removeAttribute(state);
    }
  });

  it("blocks panel shortcuts until a mounted popup finishes closing", async () => {
    using _setup = await setup();
    await using screen = await renderPanel();
    const popover = document.createElement("div");
    popover.dataset.slot = "popover-popup";
    popover.dataset.open = "";
    screen.container.append(popover);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();

    delete popover.dataset.open;
    popover.dataset.closed = "";
    popover.dataset.endingStyle = "";
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(addFiles).not.toHaveBeenCalled();

    delete popover.dataset.endingStyle;
    popover.hidden = true;
    expect((await press("f")).defaultPrevented).toBe(true);
    expect(addFiles).toHaveBeenCalledOnce();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Files");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    using _setup = await setup();
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await using screen = await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await screen.rerender(panelElement({ ...panel, open: false }));
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await screen.rerender(panelElement(panel));
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});

describe("right panel tab middle click", () => {
  it("cancels middle-button defaults and closes once while preserving other buttons", async () => {
    using _setup = await setup();
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    const files = { id: "files" as const, kind: "files" as const };
    await using screen = await renderPanel({
      surfaces: [files],
      activeSurfaceId: files.id,
      onActivate,
      onCloseSurface,
    });
    const tabLabel = screen.container.querySelector("[data-active-tab] span.truncate")!;
    const mouse = async (type: string, button: number) => {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      await act(() => tabLabel.dispatchEvent(event));
      return event;
    };

    expect((await mouse("mousedown", 0)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 0)).defaultPrevented).toBe(false);
    expect((await mouse("click", 0)).defaultPrevented).toBe(false);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(files);
    expect((await mouse("mousedown", 2)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 2)).defaultPrevented).toBe(false);
    expect((await mouse("auxclick", 2)).defaultPrevented).toBe(false);
    expect(onCloseSurface).not.toHaveBeenCalled();

    expect((await mouse("mousedown", 1)).defaultPrevented).toBe(true);
    expect((await mouse("mouseup", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).not.toHaveBeenCalled();
    expect((await mouse("auxclick", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).toHaveBeenCalledExactlyOnceWith(files);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
