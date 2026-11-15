import type {
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
  UsageResetWindowKind,
} from "@t3tools/contracts";

/** Fork: the snooze menu entries that wake a thread when its account's usage resets. */
const USAGE_RESET_SNOOZE_ACTION = "snooze:usage-reset";

export interface UsageResetSnoozeOption {
  readonly id: `${typeof USAGE_RESET_SNOOZE_ACTION}${"" | `:${UsageResetWindowKind}`}`;
  readonly label: string;
  /** Absent: whenever the account has quota again, for plans that report no windows. */
  readonly window?: UsageResetWindowKind;
}

const WINDOW_KINDS: ReadonlyArray<UsageResetWindowKind> = ["session", "weekly"];

/**
 * The usage readings of the provider's last-used account: its own (behind a Claude gateway, the
 * account that served the last turn), else its hub's accounts', which share one plan in practice.
 */
export function lastUsedAccountWindows(
  provider: ServerProvider | undefined,
  sources: UsageLimitSourceSnapshots,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (!provider) return [];
  const own = provider.usageLimits;
  if (own && !own.unavailable && own.windows.length > 0) return own.windows;
  return sources.flatMap((source) =>
    source.accounts.flatMap((account) =>
      account.driver === provider.driver && !account.usageLimits.unavailable
        ? account.usageLimits.windows
        : [],
    ),
  );
}

const windowName = (reading: ServerProviderUsageWindow) =>
  reading.kind === "weekly"
    ? "Weekly"
    : reading.windowDurationMins && reading.windowDurationMins % 60 === 0
      ? `${reading.windowDurationMins / 60}h`
      : reading.label;

/** One option per session and weekly window the readings carry, else one for any reset. */
export function usageResetSnoozeOptions(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<UsageResetSnoozeOption> {
  const options = WINDOW_KINDS.flatMap((kind): UsageResetSnoozeOption[] => {
    const reading = windows.find((candidate) => candidate.kind === kind);
    return reading
      ? [
          {
            id: `${USAGE_RESET_SNOOZE_ACTION}:${kind}`,
            label: `Until usage resets (${windowName(reading)})`,
            window: kind,
          },
        ]
      : [];
  });
  return options.length > 0
    ? options
    : [{ id: USAGE_RESET_SNOOZE_ACTION, label: "Until usage resets" }];
}

/** The option a snooze menu action picked, or undefined for other actions. */
export function usageResetSnoozeOptionOf(
  action: string,
): Pick<UsageResetSnoozeOption, "window"> | undefined {
  if (action === USAGE_RESET_SNOOZE_ACTION) return {};
  const kind = WINDOW_KINDS.find(
    (candidate) => action === `${USAGE_RESET_SNOOZE_ACTION}:${candidate}`,
  );
  return kind ? { window: kind } : undefined;
}
