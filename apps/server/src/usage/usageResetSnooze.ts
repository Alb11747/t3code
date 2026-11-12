import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

const MODEL_SCOPED_WINDOW_PREFIX = "seven_day_";

/**
 * Claude reports model-scoped weekly windows (`seven_day_<model name>`) beside its general ones;
 * they only gate that model. The monthly spend cap only limits paid extra usage. Other drivers'
 * model pools are left to `exhaustedUsageWindow`.
 */
function claudeWindowApplies(window: ServerProviderUsageWindow, model: string): boolean {
  if (window.id === "monthly_spend") return false;
  if (!window.id.startsWith(MODEL_SCOPED_WINDOW_PREFIX)) return true;
  const scope = window.id.slice(MODEL_SCOPED_WINDOW_PREFIX.length);
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .includes(scope);
}

/**
 * When an account next gets quota back for `model`: the first reset after which the app's
 * per-model rule (`exhaustedUsageWindow`) no longer finds a blocking window, or null when a blocker
 * never resets. An account that is not blocked reports the soonest reset among windows that can
 * limit `model` on their own, or that only limit it together; null when none can.
 */
export function accountResetAtMs(
  driver: ProviderDriverKind,
  limits: ServerProviderUsageLimits | undefined,
  model: string,
  now: number,
): number | null {
  if (!limits || limits.unavailable) return null;
  const windows =
    driver === "claudeAgent"
      ? limits.windows.filter((window) => claudeWindowApplies(window, model))
      : limits.windows;
  const blocks = (candidates: ReadonlyArray<ServerProviderUsageWindow>, at: number) =>
    exhaustedUsageWindow(
      { driver, usageLimits: { ...limits, windows: candidates } } as ServerProvider,
      at,
      model,
    ) !== undefined;
  const upcomingResets = (candidates: ReadonlyArray<ServerProviderUsageWindow>) =>
    candidates
      .map((window) => (window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)))
      .filter((at) => Number.isFinite(at) && at > now)
      .sort((a, b) => a - b);
  if (blocks(windows, now)) {
    return upcomingResets(windows).find((at) => !blocks(windows, at)) ?? null;
  }
  const exhausted = (candidates: ReadonlyArray<ServerProviderUsageWindow>) =>
    candidates.map((window) => ({ ...window, usedPercent: 100 }));
  const limiting = windows.filter((window) => blocks(exhausted([window]), now));
  if (limiting.length > 0) return upcomingResets(limiting)[0] ?? null;
  // Only together, as with Cursor Auto's two pools; windows that never gate the model don't count.
  return blocks(exhausted(windows), now) ? (upcomingResets(windows)[0] ?? null) : null;
}

/**
 * For hubs that cannot say which account they will route to: the account that recovers first,
 * skipping accounts whose subscription ends before then.
 */
export function soonestHubReset(
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  model: string,
  now: number,
): { readonly resetsAtMs: number; readonly accountLabel: string } | null {
  let best: { resetsAtMs: number; accountLabel: string } | null = null;
  for (const account of accounts) {
    const resetsAtMs = accountResetAtMs(account.driver, account.usageLimits, model, now);
    if (resetsAtMs === null) continue;
    const endsAt =
      account.subscriptionEndsAt === undefined
        ? Number.NaN
        : Date.parse(account.subscriptionEndsAt);
    if (Number.isFinite(endsAt) && endsAt <= resetsAtMs) continue;
    if (best === null || resetsAtMs < best.resetsAtMs) {
      best = { resetsAtMs, accountLabel: account.email ?? account.id.replace(/\.json$/i, "") };
    }
  }
  return best;
}
