import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  accountChangeMessage,
  createAccountSendGuard,
} from "@t3tools/client-runtime/thread-account-guard";
import type {
  EnvironmentId,
  ModelSelection,
  ThreadAccountRequestKind,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

/**
 * Fork: mobile has no account chip, so a send stops once when it would move the conversation off
 * the account it is on now; the next press sends. Shares the web composer's guard logic.
 */
const guard = createAccountSendGuard({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export function noteThreadAccountChange(environmentId: EnvironmentId, threadId: ThreadId) {
  guard.noteOwnChange(scopedThreadKey(environmentId, threadId));
}

export async function confirmThreadAccountForSend(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  /** Whether the provider can route through a hub; other threads skip the round trip. */
  readonly routed: boolean;
  readonly kind: ThreadAccountRequestKind;
}): Promise<boolean> {
  if (!input.routed) return true;
  const target = { threadId: input.threadId, modelSelection: input.modelSelection };
  const decision = await guard.check({
    threadKey: scopedThreadKey(input.environmentId, input.threadId),
    kind: input.kind,
    shown: "current",
    readFresh: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.checkThreadAccountPreview,
        { environmentId: input.environmentId, input: { ...target, kind: input.kind, fresh: true } },
        { reportFailure: false },
      );
      return result._tag === "Success" ? result.value : undefined;
    },
  });
  if (decision.send) return true;
  // Names come from the thread settings' account list when it has been read.
  const state = AsyncResult.getOrElse(
    appAtomRegistry.get(
      serverEnvironment.threadAccountState({ environmentId: input.environmentId, input: target }),
    ),
    () => null,
  );
  Dialog.alert(
    input.kind === "compaction" ? "Compaction moves accounts" : "Account changes",
    accountChangeMessage({ accounts: state?.accounts ?? [], ...decision, kind: input.kind }),
  );
  return false;
}
