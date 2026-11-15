import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  UsageResetWindowKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  lastUsedAccountWindows,
  type UsageResetSnoozeOption,
  usageResetSnoozeOptions,
} from "@t3tools/client-runtime/usage-reset-snooze";
import { Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const sameOptions = (
  a: ReadonlyArray<UsageResetSnoozeOption>,
  b: ReadonlyArray<UsageResetSnoozeOption>,
) => a.length === b.length && a.every((option, index) => option.label === b[index]?.label);

// Keyed by environment and provider instance; rows re-render only when the options change.
const optionsAtom = Atom.family((key: string) => {
  const [environmentId, instanceId] = key.split("\u0000") as [EnvironmentId, string];
  return Atom.make((get) => {
    const provider = get(environmentPresentations.providersByEnvironmentAtom)
      .get(environmentId)
      ?.find((candidate) => candidate.instanceId === instanceId);
    const sources = get(serverEnvironment.configValueAtom(environmentId))?.usageLimitSources ?? [];
    return usageResetSnoozeOptions(lastUsedAccountWindows(provider, sources));
  }).pipe(Atom.withEquality(sameOptions));
});

/** The snooze menu's usage-reset options for a thread, from its last-used account. */
export function useUsageResetSnoozeOptions(environmentId: EnvironmentId, instanceId: string) {
  return useAtomValue(optionsAtom(`${environmentId}\u0000${instanceId}`));
}

/** When `window` (else any limit) resets on the account the thread last used. */
export async function resolveUsageResetSnooze(
  threadRef: ScopedThreadRef,
  modelSelection: ModelSelection,
  window?: UsageResetWindowKind,
): Promise<string | undefined> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, modelSelection, ...(window ? { window } : {}) },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value.resetsAt;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      "Could not snooze until usage resets",
      error instanceof Error ? error.message : "The reset time is unknown.",
    );
  }
  return undefined;
}
