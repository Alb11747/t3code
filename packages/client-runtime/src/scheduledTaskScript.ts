import type { ScheduledTask, ScheduledTaskUpsertInput } from "@t3tools/contracts";

/** Fork: the script part of a scheduled-task form, kept apart from the upstream draft. */
export interface ScheduledTaskScriptDraft {
  readonly source: string;
  /** The source the form opened with, so an untouched script is not resent. */
  readonly saved: string;
  readonly resetState: boolean;
}

export function scheduledTaskScriptDraft(task: ScheduledTask | null): ScheduledTaskScriptDraft {
  const source = task?.script?.source ?? "";
  return { source, saved: source, resetState: false };
}

/**
 * Upsert fields for the script. Only a change is sent: saving a script needs terminal access,
 * so an untouched one must not stop someone without it from editing the rest of the task.
 */
export function scheduledTaskScriptUpsertFields(
  draft: ScheduledTaskScriptDraft,
): Pick<ScheduledTaskUpsertInput, "script" | "resetScriptState"> {
  const source = draft.source.trim() === "" ? "" : draft.source;
  return {
    ...(source === draft.saved ? {} : { script: source === "" ? null : source }),
    ...(draft.resetState && source !== "" ? { resetScriptState: true } : {}),
  };
}

export interface ScheduledTaskScriptExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
}

export const SCHEDULED_TASK_SCRIPT_EXAMPLES: ReadonlyArray<ScheduledTaskScriptExample> = [
  {
    id: "usage-gate",
    label: "Skip when usage is high",
    description: "Runs only while every Codex account has weekly usage left.",
    source: `// ctx.usage.accounts lists native and CLI Proxy accounts with their usage windows.
const codex = ctx.usage.accounts.filter((account) => account.driver === "codex");
const weekly = codex.flatMap((account) => account.windows.filter((w) => w.kind === "weekly"));
if (weekly.some((window) => window.usedPercent >= 80)) {
  return { run: false, reason: "Codex weekly usage is above 80%" };
}
return true;
`,
  },
  {
    id: "slow-down",
    label: "Run less often when usage is low",
    description: "A daily task that waits three days between runs while weekly usage left is low.",
    source: `// ctx.state is saved after every check. Return false to skip this run.
const weekly = ctx.usage.accounts
  .filter((account) => account.driver === "claudeAgent")
  .flatMap((account) => account.windows.filter((w) => w.kind === "weekly"));
const low = weekly.some((window) => window.usedPercent >= 70);
const lastRun = ctx.state.lastRun ? Date.parse(ctx.state.lastRun) : 0;
if (low && Date.now() - lastRun < 3 * 24 * 60 * 60 * 1000) {
  return { run: false, reason: "Weekly usage is low; waiting three days" };
}
ctx.state.lastRun = ctx.now;
return true;
`,
  },
  {
    id: "keep-warm",
    label: "Keep a Claude cache warm",
    description:
      "Post runs in a Claude thread on an interval such as 15 minutes; it pings just before the prompt cache expires.",
    source: `// Pings the bound thread a few minutes before Claude's prompt cache expires.
const thread = ctx.thread;
const expiresAt = Date.parse(thread?.promptCache?.expiresAt ?? "");
if (!thread || thread.running || Number.isNaN(expiresAt)) {
  return { run: false, reason: "Nothing to keep warm" };
}
const pingAt = expiresAt - 4 * 60 * 1000;
if (Date.now() >= expiresAt) return { run: false, reason: "The cache has already expired" };
// Until then, wake up again exactly when the ping is due.
if (Date.now() < pingAt) return { run: false, nextRunAt: pingAt, reason: "Cache is warm" };
return { prompt: "Keep-alive check. Reply with just OK." };
`,
  },
];
