import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  accountChangeMessage,
  accountShortLabel,
  createAccountSendGuard,
} from "@t3tools/client-runtime/thread-account-guard";
import type {
  EnvironmentId,
  RouterAccountAlias,
  ThreadAccountRequestKind,
  ThreadAccountStateInput,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";

/** Fork: what a thread's account chip shows, so sends and the Compact controls can use it. */
export interface ShownAccounts {
  readonly environmentId: EnvironmentId;
  readonly input: ThreadAccountStateInput;
  readonly accounts: ReadonlyArray<UsageLimitSourceAccount>;
  readonly current: RouterAccountAlias | null;
  readonly next: RouterAccountAlias | null;
  readonly compaction: RouterAccountAlias | null;
  readonly refresh: () => void;
}

const shownAccountsAtom = Atom.family((_threadKey: string) =>
  Atom.make<ShownAccounts | null>(null).pipe(Atom.keepAlive),
);

export const accountSendGuard = createAccountSendGuard({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Bumped when a send stopped for a changed account, so that thread's chip draws attention once. */
export const threadAccountAttentionAtom = Atom.make<{
  readonly threadKey: string;
  readonly count: number;
} | null>(null).pipe(Atom.keepAlive);

/** The chip reports what it shows; the returned function withdraws it. */
export function publishShownAccounts(threadKey: string, shown: ShownAccounts): () => void {
  appAtomRegistry.set(shownAccountsAtom(threadKey), shown);
  return () => {
    if (appAtomRegistry.get(shownAccountsAtom(threadKey)) === shown) {
      appAtomRegistry.set(shownAccountsAtom(threadKey), null);
    }
  };
}

/** "After compacting, continues on work (Max 20x)" when a compaction would move the thread. */
export function compactionAccountNote(
  shown: Pick<ShownAccounts, "accounts" | "current" | "next" | "compaction"> | null,
): string | null {
  const from = shown?.current ?? shown?.next ?? null;
  if (!shown?.compaction || from === null || shown.compaction === from) return null;
  const account = shown.accounts.find((candidate) => candidate.routerAlias === shown.compaction);
  return `After compacting, continues on ${account ? accountShortLabel(account) : shown.compaction}.`;
}

export function useCompactionAccountNote(threadKey: string | null): string | null {
  // Selects the note itself, so a republished chip with the same note re-renders nothing.
  return useAtomValue(
    threadKey === null ? NO_SHOWN_ACCOUNTS : shownAccountsAtom(threadKey),
    compactionAccountNote,
  );
}

const NO_SHOWN_ACCOUNTS = Atom.make<ShownAccounts | null>(null);

/**
 * Resolves false, keeping the draft, when the account the chip showed for this kind of request is
 * no longer where it would go; the toast names both and the next press sends. Threads without a
 * chip, an unreachable router and a slow answer (past 1.5 seconds) all send.
 */
export async function confirmAccountForSend(
  threadKey: string,
  kind: ThreadAccountRequestKind,
): Promise<boolean> {
  const shown = appAtomRegistry.get(shownAccountsAtom(threadKey));
  if (shown === null) return true;
  const decision = await accountSendGuard.check({
    threadKey,
    kind,
    shown: shown[kind],
    readFresh: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.checkThreadAccountPreview,
        { environmentId: shown.environmentId, input: { ...shown.input, kind, fresh: true } },
        { reportFailure: false },
      );
      return result._tag === "Success" ? result.value : undefined;
    },
  });
  if (decision.send) return true;
  toastManager.add({
    type: "warning",
    title: kind === "compaction" ? "Compaction moved accounts" : "Account changed",
    description: accountChangeMessage({ accounts: shown.accounts, ...decision, kind }),
  });
  const previous = appAtomRegistry.get(threadAccountAttentionAtom);
  appAtomRegistry.set(threadAccountAttentionAtom, { threadKey, count: (previous?.count ?? 0) + 1 });
  shown.refresh();
  return false;
}
