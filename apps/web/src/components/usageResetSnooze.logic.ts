import type { ScopedThreadRef } from "@t3tools/contracts";

/** Fork: the snooze menu entry that wakes a thread when its provider's usage resets. */
export const USAGE_RESET_SNOOZE_ACTION = "snooze:usage-reset" as const;
export const USAGE_RESET_SNOOZE_LABEL = "Until usage resets";

/** Loaded on use: the composer store the resolver reads is heavy for menu module graphs. */
export function resolveUsageResetSnoozeLazily(threadRef: ScopedThreadRef) {
  return import("./usageResetSnooze").then((module) => module.resolveUsageResetSnooze(threadRef));
}
