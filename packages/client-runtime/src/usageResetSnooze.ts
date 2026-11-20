import type {
  UsageResetSnooze,
  UsageResetSnoozeWindow,
  UsageResetWindowKind,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Fork: the snooze menu entries that wake a thread when its account's usage resets. */
const USAGE_RESET_SNOOZE_ACTION = "snooze:usage-reset";

export interface UsageResetSnoozeOption {
  readonly id: `${typeof USAGE_RESET_SNOOZE_ACTION}${"" | `:${UsageResetWindowKind}`}`;
  readonly label: string;
  /** Absent when the server gave no answer; choosing the option then asks it again. */
  readonly snoozedUntil?: string;
}

function windowSnoozeLabel(reading: UsageResetSnoozeWindow, resolve: MFunctionType): string {
  if (reading.window === "weekly") return resolve(msg("Until usage resets (Weekly)"));
  if (reading.windowDurationMins && reading.windowDurationMins % 60 === 0) {
    return resolve(
      msg("Until usage resets ({hours}h)", { hours: reading.windowDurationMins / 60 }),
    );
  }
  return resolve(msg("Until usage resets (Session)"));
}

/**
 * A thread's options from its server's answer: one per window of the account it last used, else
 * one for any reset. Servers without per-window answers send no `windows`, so they get the latter.
 */
export function usageResetSnoozeOptions(
  answer: UsageResetSnooze | undefined,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<UsageResetSnoozeOption> {
  const windows = answer?.windows ?? [];
  if (windows.length > 0) {
    return windows.map((reading) => ({
      id: `${USAGE_RESET_SNOOZE_ACTION}:${reading.window}`,
      label: windowSnoozeLabel(reading, resolve),
      snoozedUntil: reading.resetsAt,
    }));
  }
  return [
    {
      id: USAGE_RESET_SNOOZE_ACTION,
      label: resolve(msg("Until usage resets")),
      ...(answer?.resetsAt ? { snoozedUntil: answer.resetsAt } : {}),
    },
  ];
}

/** Several threads' options for one menu, each once; a thread snoozes by its own option's id. */
export function mergeUsageResetSnoozeOptions(
  perThread: ReadonlyArray<ReadonlyArray<UsageResetSnoozeOption>>,
): ReadonlyArray<UsageResetSnoozeOption> {
  const byId = new Map<string, UsageResetSnoozeOption>();
  for (const option of perThread.flat()) if (!byId.has(option.id)) byId.set(option.id, option);
  const order = (option: UsageResetSnoozeOption) =>
    option.id === USAGE_RESET_SNOOZE_ACTION ? 1 : 0;
  return [...byId.values()].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}
