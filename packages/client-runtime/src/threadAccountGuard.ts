import type {
  RouterAccountAlias,
  ServerProvider,
  ThreadAccountPreview,
  ThreadAccountRequestKind,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";

/**
 * Fork: the check before a send that the CLI Proxy account the composer showed is still where
 * the request goes. Web and mobile share it; each renders the warning its own way.
 */

const COMPACT_COMMAND = /^\/compact(?:\s|$)/i;

/**
 * Whether the provider can route through a CLI Proxy hub, as the server decides: a gateway endpoint,
 * or usage that is unsupported without an API key. Other providers skip the check before a send.
 */
export function mayRouteThroughHub(
  provider: Pick<ServerProvider, "auth" | "usageLimits"> | undefined,
): boolean {
  return (
    provider !== undefined &&
    (provider.auth.type === "customEndpoint" ||
      (provider.usageLimits?.unavailable?.reason === "unsupported" &&
        provider.auth.type !== "apiKey"))
  );
}

/** A typed `/compact`, or a message that compacts first, runs after a compaction. */
export function accountRequestKind(input: {
  readonly text: string;
  readonly compactsFirst: boolean;
}): ThreadAccountRequestKind {
  return input.compactsFirst || COMPACT_COMMAND.test(input.text.trim()) ? "compaction" : "next";
}

/** The account a preview names, unless an older router answered for another request kind. */
export function previewAccount(
  preview: ThreadAccountPreview | null | undefined,
): RouterAccountAlias | null {
  return preview && !preview.approximate ? preview.account : null;
}

type AccountNaming = Pick<UsageLimitSourceAccount, "email" | "routerAlias" | "id" | "plan">;

/** "work" for work@example.com; the router alias when the hub lists no email. */
function accountShortName(account: AccountNaming): string {
  const label = account.email ?? account.routerAlias ?? account.id;
  const at = label.indexOf("@");
  return at > 0 ? label.slice(0, at) : label;
}

/** "Max 20x" for "Claude Max 20x"; nothing for a plan that names no tier. */
function accountPlanTier(account: AccountNaming): string | undefined {
  const tier = account.plan?.replace(/^(Claude|ChatGPT)\s+/i, "").trim();
  return tier && !/^subscription$/i.test(tier) ? tier : undefined;
}

export function accountShortLabel(account: AccountNaming): string {
  const tier = accountPlanTier(account);
  return tier ? `${accountShortName(account)} (${tier})` : accountShortName(account);
}

export function accountChangeMessage(input: {
  readonly accounts: ReadonlyArray<AccountNaming>;
  readonly from: RouterAccountAlias;
  readonly to: RouterAccountAlias;
  readonly kind: ThreadAccountRequestKind;
}): string {
  const name = (alias: RouterAccountAlias) => {
    const account = input.accounts.find((candidate) => candidate.routerAlias === alias);
    return account ? accountShortLabel(account) : alias;
  };
  return input.kind === "compaction"
    ? `After compacting, this thread will now continue on ${name(input.to)}, not ${name(input.from)}. Press again to confirm.`
    : `This will now use ${name(input.to)}, not ${name(input.from)}. Send again to confirm.`;
}

export type AccountSendCheck =
  | { readonly send: true }
  | { readonly send: false; readonly from: RouterAccountAlias; readonly to: RouterAccountAlias };

/** A send goes ahead unless both the shown and the fresh account are known and differ. */
function accountSendDecision(
  shown: RouterAccountAlias | null,
  fresh: ThreadAccountPreview | null | undefined,
): AccountSendCheck {
  const to = previewAccount(fresh);
  return shown === null || to === null || to === shown
    ? { send: true }
    : { send: false, from: shown, to };
}

// The user's own pick changes the route before the chip's preview catches up, and a press soon
// after a warning is the confirmation it asked for, whatever the router answers meanwhile.
const CONFIRM_GRACE_MS = 30_000;
// Sending is never held on the router for longer than this.
const ACCOUNT_CHECK_BUDGET_MS = 1_500;

export function createAccountSendGuard(options: {
  readonly now: () => number;
  /** Resolves after `ms`; the check gives up on the router then and lets the send through. */
  readonly sleep: (ms: number) => Promise<void>;
}) {
  const ownChangeAt = new Map<string, number>();
  const warnedAt = new Map<string, number>();
  const recent = (at: number | undefined) =>
    at !== undefined && options.now() - at < CONFIRM_GRACE_MS;
  return {
    /** The user picked an account (or Automatic) for the thread. */
    noteOwnChange(threadKey: string) {
      ownChangeAt.set(threadKey, options.now());
    },
    async check(input: {
      readonly threadKey: string;
      readonly kind: ThreadAccountRequestKind;
      /**
       * What the chip showed when the user pressed send; `current` where no chip shows one, so a
       * send that would move the conversation off its account is the surprise.
       */
      readonly shown: RouterAccountAlias | null | "current";
      /** A fresh preview; any failure counts as unknown. */
      readonly readFresh: () => Promise<ThreadAccountPreview | null | undefined>;
    }): Promise<AccountSendCheck> {
      const slot = `${input.threadKey}\n${input.kind}`;
      if (
        input.shown === null ||
        recent(ownChangeAt.get(input.threadKey)) ||
        recent(warnedAt.get(slot))
      ) {
        return { send: true };
      }
      const fresh = await Promise.race([
        input.readFresh().catch(() => undefined),
        options.sleep(ACCOUNT_CHECK_BUDGET_MS).then(() => undefined),
      ]);
      const decision = accountSendDecision(
        input.shown === "current" ? (fresh?.current ?? null) : input.shown,
        fresh,
      );
      if (!decision.send) warnedAt.set(slot, options.now());
      return decision;
    },
  };
}

export type AccountSendGuard = ReturnType<typeof createAccountSendGuard>;
