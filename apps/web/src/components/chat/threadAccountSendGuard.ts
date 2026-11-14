import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  accountChangeMessage,
  accountShortLabel,
  createAccountSendGuard,
  previewAccount,
} from "@t3tools/client-runtime/thread-account-guard";
import type {
  EnvironmentId,
  ModelSelection,
  RouterAccountAlias,
  ThreadAccountRequestKind,
  ThreadId,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";

/** Fork: a thread's account chip target; its queries are shared by every reader with it. */
export interface AccountTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
}

export const threadAccountStateAtom = (target: AccountTarget) =>
  serverEnvironment.threadAccountState({
    environmentId: target.environmentId,
    input: { threadId: target.threadId, modelSelection: target.modelSelection },
  });

export const threadAccountPreviewAtom = (target: AccountTarget, kind: ThreadAccountRequestKind) =>
  serverEnvironment.threadAccountPreview({
    environmentId: target.environmentId,
    input: { threadId: target.threadId, modelSelection: target.modelSelection, kind },
  });

export const accountSendGuard = createAccountSendGuard({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Bumped when a send stopped for a changed account, so that thread's chip draws attention once. */
export const threadAccountAttentionAtom = Atom.make<{
  readonly threadKey: string;
  readonly count: number;
} | null>(null).pipe(Atom.keepAlive);

/** "After compacting, continues on work (Max 20x)" when a compaction would move the thread. */
export function compactionAccountNote(input: {
  readonly accounts: ReadonlyArray<UsageLimitSourceAccount>;
  readonly current: RouterAccountAlias | null;
  readonly next: RouterAccountAlias | null;
  readonly compaction: RouterAccountAlias | null;
}): string | null {
  const from = input.current ?? input.next;
  if (input.compaction === null || from === null || input.compaction === from) return null;
  const account = input.accounts.find((candidate) => candidate.routerAlias === input.compaction);
  return `After compacting, continues on ${account ? accountShortLabel(account, input.accounts) : input.compaction}.`;
}

/** The chip's note for the Compact controls; reads the chip's own queries, never more. */
export function useCompactionAccountNote(target: AccountTarget | null): string | null {
  const state = useEnvironmentQuery(target ? threadAccountStateAtom(target) : null).data;
  const routed = target !== null && (state?.accounts.length ?? 0) >= 2;
  const next = useEnvironmentQuery(routed ? threadAccountPreviewAtom(target, "next") : null).data;
  const compaction = useEnvironmentQuery(
    routed ? threadAccountPreviewAtom(target, "compaction") : null,
  ).data;
  if (!state || !routed) return null;
  return compactionAccountNote({
    accounts: state.accounts,
    current: next?.current ?? null,
    next: previewAccount(next) ?? state.next,
    compaction: previewAccount(compaction),
  });
}

// What a mounted query already holds; reading a node that does not exist would start a request.
function heldValue<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): A | null {
  const value = appAtomRegistry.getNodes().get(atom)?.valueOption();
  return value && Option.isSome(value)
    ? AsyncResult.getOrElse(value.value as AsyncResult.AsyncResult<A, E>, () => null)
    : null;
}

/**
 * Resolves false, keeping the draft, when the account the chip showed for this kind of request is
 * no longer where it would go; the toast names both and a press soon after sends. Threads without
 * a chip, an unreachable router and a slow answer (past 1.5 seconds) all send.
 */
export async function confirmAccountForSend(
  threadKey: string,
  target: AccountTarget,
  kind: ThreadAccountRequestKind,
): Promise<boolean> {
  const state = heldValue(threadAccountStateAtom(target));
  const previewAtom = threadAccountPreviewAtom(target, kind);
  const preview = heldValue(previewAtom);
  const shown =
    state === null || state.accounts.length < 2
      ? null
      : preview
        ? previewAccount(preview)
        : kind === "next"
          ? state.next
          : null;
  const decision = await accountSendGuard.check({
    threadKey,
    kind,
    shown,
    readFresh: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.checkThreadAccountPreview,
        {
          environmentId: target.environmentId,
          input: {
            threadId: target.threadId,
            modelSelection: target.modelSelection,
            kind,
            fresh: true,
          },
        },
        { reportFailure: false },
      );
      return result._tag === "Success" ? result.value : undefined;
    },
  });
  if (decision.send) return true;
  toastManager.add({
    type: "warning",
    title: kind === "compaction" ? "Compaction moved accounts" : "Account changed",
    description: accountChangeMessage({ accounts: state?.accounts ?? [], ...decision, kind }),
  });
  const previous = appAtomRegistry.get(threadAccountAttentionAtom);
  appAtomRegistry.set(threadAccountAttentionAtom, { threadKey, count: (previous?.count ?? 0) + 1 });
  appAtomRegistry.refresh(previewAtom);
  return false;
}
