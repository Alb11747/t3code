import { EnvironmentId, ThreadId, type ClaudeKeepWarmHold } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { keepWarmStallBannerItem } from "./KeepWarmStallBanner";

function bannerItem(hold: ClaudeKeepWarmHold) {
  return keepWarmStallBannerItem({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    hold,
    snoozedUntil: null,
    timestampFormat: "24-hour",
  });
}

const pinHold = {
  kind: "pin",
  account: "work@example.com",
  releaseAt: "2026-11-25T05:18:00.000Z",
  resetAt: "2026-11-25T08:00:00.000Z",
} as const;

describe("keepWarmStallBannerItem", () => {
  it("says a pin hold waits for the thread's chosen account", () => {
    const item = bannerItem(pinHold);
    expect(item.title).toBe("Waiting for work@example.com");
    expect(item.description).toContain("This thread is set to wait for work@example.com");
  });

  // The router holds any shorter thread on a capped account, so no pin is implied.
  it("names a short-session cap hold without claiming the thread waits for the account", () => {
    const item = bannerItem({ ...pinHold, reason: "short_cap" });
    expect(item.title).toBe("work@example.com reached its short-session cap");
    expect(item.description).toContain("is kept for long-running threads");
    expect(`${item.title} ${item.description}`).not.toContain("set to wait");
  });
});
