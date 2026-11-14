import { useAtomValue } from "@effect/atom-react";
import type { ServerProviderUsageWindow, UsageLimitSourceAccount } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

/** The thread whose composer account picker should open, e.g. from the stall banner. */
const openPickerAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

export function openThreadAccountPicker(threadKey: string | null) {
  appAtomRegistry.set(openPickerAtom, threadKey);
}

export function useThreadAccountPickerOpen(threadKey: string): boolean {
  return useAtomValue(openPickerAtom) === threadKey;
}

export function accountLabel(
  account: Pick<UsageLimitSourceAccount, "email" | "routerAlias" | "id">,
) {
  return account.email ?? account.routerAlias ?? account.id;
}

export function accountWindows(account: UsageLimitSourceAccount): {
  readonly session: ServerProviderUsageWindow | undefined;
  readonly weekly: ServerProviderUsageWindow | undefined;
} {
  const windows = account.usageLimits.windows;
  return {
    session: windows.find((window) => window.kind === "session"),
    weekly: windows.find((window) => window.kind === "weekly"),
  };
}

/** A window the account has used up, for "weekly limit · back Tue 9:00 AM". */
export function exhaustedWindow(account: UsageLimitSourceAccount) {
  return account.usageLimits.windows
    .filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined)
    .toSorted((left, right) => Date.parse(right.resetsAt!) - Date.parse(left.resetsAt!))[0];
}
