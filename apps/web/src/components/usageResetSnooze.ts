import type { ScopedThreadRef, UsageResetWindowKind } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  lastUsedAccountWindows,
  usageResetSnoozeOptions,
} from "@t3tools/client-runtime/usage-reset-snooze";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { toastManager } from "./ui/toast";

/** The snooze menu's usage-reset options for these threads, from their last-used accounts. */
export function readUsageResetSnoozeOptions(threadRefs: ReadonlyArray<ScopedThreadRef>) {
  const providersByEnvironment = appAtomRegistry.get(
    environmentPresentations.providersByEnvironmentAtom,
  );
  return usageResetSnoozeOptions(
    threadRefs.flatMap((threadRef) => {
      const instanceId = readThreadShell(threadRef)?.modelSelection.instanceId;
      const provider = providersByEnvironment
        .get(threadRef.environmentId)
        ?.find((candidate) => candidate.instanceId === instanceId);
      const sources =
        appAtomRegistry.get(serverEnvironment.configValueAtom(threadRef.environmentId))
          ?.usageLimitSources ?? [];
      return lastUsedAccountWindows(provider, sources);
    }),
  );
}

/** Asks the thread's environment when `window` (else any limit) resets on its account. */
export async function resolveUsageResetSnooze(
  threadRef: ScopedThreadRef,
  window?: UsageResetWindowKind,
): Promise<{ readonly snoozedUntil: string } | undefined> {
  const thread = readThreadShell(threadRef);
  if (!thread) return undefined;
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        modelSelection: thread.modelSelection,
        ...(window ? { window } : {}),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { snoozedUntil: result.value.resetsAt };
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "warning",
      title: "Could not snooze until usage resets",
      description: error instanceof Error ? error.message : "The reset time is unknown.",
    });
  }
  return undefined;
}
