import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useComposerDraftStore } from "../composerDraftStore";
import { readFreshSessionArm } from "./chat/freshSessionArms";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { toastManager } from "./ui/toast";

/**
 * Asks the thread's environment when the account its next message would use gets quota back.
 * An unsent provider switch in the composer counts as the provider that message would use.
 */
export async function resolveUsageResetSnooze(
  threadRef: ScopedThreadRef,
): Promise<{ readonly snoozedUntil: string } | undefined> {
  const thread = readThreadShell(threadRef);
  if (!thread) return undefined;
  const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
  const modelSelection =
    (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : undefined) ??
    thread.modelSelection;
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        modelSelection,
        ...(readFreshSessionArm(scopedThreadKey(threadRef)) === undefined
          ? {}
          : { freshContext: true }),
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
