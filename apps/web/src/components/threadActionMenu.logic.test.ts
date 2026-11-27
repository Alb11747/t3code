import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  pacedChoiceAction,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
  usageResetSnoozeOptions: [{ id: "snooze:usage-reset", label: "Until usage resets" }],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "context-note",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "context-note",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("hides Paced when undefined and marks the active window choice when supported", () => {
    expect(buildThreadActionMenuItems(baseState).map((item) => item.id)).not.toContain("paced");

    const offMenu = buildThreadActionMenuItems({ ...baseState, paced: null }).find(
      (item) => item.id === "paced",
    );
    expect(offMenu?.children?.map((child) => [child.id, child.checked])).toEqual([
      ["paced:off", true],
      ["paced:5h", false],
      ["paced:7d", false],
      ["paced:both", false],
    ]);

    const bothMenu = buildThreadActionMenuItems({
      ...baseState,
      paced: { windows: ["5h", "7d"] },
    }).find((item) => item.id === "paced");
    expect(bothMenu?.children?.find((child) => child.checked)?.id).toBe("paced:both");

    expect(pacedChoiceAction("paced:off")).toBeNull();
    expect(pacedChoiceAction("paced:5h")).toEqual({ windows: ["5h"] });
    expect(pacedChoiceAction("paced:7d")).toEqual({ windows: ["7d"] });
    expect(pacedChoiceAction("paced:both")).toEqual({ windows: ["5h", "7d"] });
  });
});
