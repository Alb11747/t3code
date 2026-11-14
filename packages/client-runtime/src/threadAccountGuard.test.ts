import type { RouterAccountAlias, ThreadAccountPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { accountRequestKind, createAccountSendGuard } from "./threadAccountGuard.ts";

const MAX = "account-1111111111111111" as RouterAccountAlias;
const PRO = "account-2222222222222222" as RouterAccountAlias;

const preview = (account: RouterAccountAlias, approximate = false): ThreadAccountPreview => ({
  account,
  current: MAX,
  basis: "placed",
  approximate,
  switchBelowContextTokens: null,
});

function setup() {
  let now = 0;
  let expire = () => {};
  const guard = createAccountSendGuard({
    now: () => now,
    // The budget elapses only when the test says so.
    sleep: () => new Promise<void>((resolve) => (expire = resolve)),
  });
  const check = (shown: RouterAccountAlias | null, fresh: ThreadAccountPreview | null) =>
    guard.check({ threadKey: "t", kind: "next", shown, readFresh: async () => fresh });
  return { guard, check, advance: (ms: number) => (now += ms), expire: () => expire() };
}

describe("createAccountSendGuard", () => {
  it("stops one send when the account changed, then lets the next press through", async () => {
    const { check } = setup();
    expect(await check(MAX, preview(MAX))).toEqual({ send: true });
    expect(await check(MAX, preview(PRO))).toEqual({ send: false, from: MAX, to: PRO });
    // The chip may not have refreshed yet; the warning already showed the new account.
    expect(await check(MAX, preview(PRO))).toEqual({ send: true });
    expect(await check(PRO, preview(MAX))).toEqual({ send: false, from: PRO, to: MAX });
  });

  it("compares with the conversation's current account where no chip shows a pick", async () => {
    const { guard } = setup();
    const check = (fresh: ThreadAccountPreview) =>
      guard.check({ threadKey: "t", kind: "next", shown: "current", readFresh: async () => fresh });
    expect(await check(preview(MAX))).toEqual({ send: true });
    expect(await check(preview(PRO))).toEqual({ send: false, from: MAX, to: PRO });
    expect(await check(preview(PRO))).toEqual({ send: true });
  });

  it("sends when nothing was shown, the router cannot tell, or answered for another kind", async () => {
    const { check } = setup();
    expect(await check(null, preview(PRO))).toEqual({ send: true });
    expect(await check(MAX, null)).toEqual({ send: true });
    expect(await check(MAX, preview(PRO, true))).toEqual({ send: true });
  });

  it("never holds a send on a router that does not answer within the budget", async () => {
    const { guard, expire } = setup();
    const pending = guard.check({
      threadKey: "t",
      kind: "compaction",
      shown: MAX,
      readFresh: () => new Promise(() => {}),
    });
    expire();
    expect(await pending).toEqual({ send: true });
    const failed = guard.check({
      threadKey: "t",
      kind: "compaction",
      shown: MAX,
      readFresh: () => Promise.reject(new Error("hub down")),
    });
    expect(await failed).toEqual({ send: true });
  });

  it("does not treat the user's own account pick as a surprise for a while", async () => {
    const { guard, check, advance } = setup();
    guard.noteOwnChange("t");
    expect(await check(MAX, preview(PRO))).toEqual({ send: true });
    advance(30_000);
    expect(await check(MAX, preview(PRO))).toEqual({ send: false, from: MAX, to: PRO });
  });
});

describe("accountRequestKind", () => {
  it.each([
    ["/compact", false, "compaction"],
    [" /COMPACT keep the plan ", false, "compaction"],
    ["/compaction notes", false, "next"],
    ["fix the bug", true, "compaction"],
    ["fix the bug", false, "next"],
  ] as const)("%j (compacts first: %s) is %s", (text, compactsFirst, kind) => {
    expect(accountRequestKind({ text, compactsFirst })).toBe(kind);
  });
});
