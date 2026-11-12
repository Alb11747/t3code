import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";

/** Fork: the snooze menu entry that wakes a thread when its provider's usage resets. */
export const USAGE_RESET_SNOOZE_ACTION = "snooze:usage-reset";
export const USAGE_RESET_SNOOZE_LABEL = "Until usage resets";

/** When the account the thread's next message would use gets quota back, counting an unsent provider switch or fresh session. */
export async function resolveUsageResetSnooze(
  threadRef: ScopedThreadRef,
  threadModelSelection: ModelSelection,
): Promise<string | undefined> {
  const draft = getComposerDraftSnapshot(
    scopedThreadKey(threadRef.environmentId, threadRef.threadId),
  );
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        modelSelection: draft.modelSelection ?? threadModelSelection,
        ...(draft.freshContext === true ? { freshContext: true } : {}),
      },
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
