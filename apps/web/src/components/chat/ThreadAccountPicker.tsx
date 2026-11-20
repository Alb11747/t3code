import { msg, T, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { accountShortLabel, previewAccount } from "@t3tools/client-runtime/thread-account-guard";
import {
  type EnvironmentId,
  type ModelSelection,
  type RouterAccountAlias,
  type ServerProviderUsageWindow,
  type ThreadAccountPreview,
  type ThreadAccountState,
  type ThreadId,
  type UsageLimitSourceAccount,
  threadAccountChoiceFor,
} from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useComposerDraftAccountChoice, useComposerDraftStore } from "../../composerDraftStore";
import { usePrimarySettings } from "../../hooks/useSettings";
import type { MessageResolver } from "../../i18n/messages";
import {
  getDocumentActivity,
  subscribeDocumentActivity,
  subscribeDocumentReturn,
} from "../../lib/documentActivity";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  accountLabel,
  accountWindows,
  exhaustedWindow,
  openThreadAccountPicker,
  useThreadAccountPickerOpen,
} from "./threadAccountChoice";
import {
  accountSendGuard,
  compactionAccountNote,
  threadAccountAttentionAtom,
  threadAccountPreviewAtom,
  threadAccountStateAtom,
} from "./threadAccountSendGuard";

const PROVIDER_NAMES: Record<string, string> = { claudeAgent: "Claude", codex: "Codex" };
const WINDOW_LIMIT_LABELS = {
  session: msg("Session limit"),
  weekly: msg("Weekly limit"),
  monthly: msg("Monthly limit"),
};
// The pick moves with usage across every thread on the hub. A send re-checks it anyway, so this
// only keeps the chip honest while it is looked at: two small reads per visible composer, which
// the server shares across clients.
const PREVIEW_REFRESH_MS = 20_000;

interface PickerProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** A draft stores its choice locally until its first message creates the thread. */
  readonly isDraft: boolean;
  readonly modelSelection: ModelSelection;
  readonly contextTokens: number | null;
  readonly size: ComposerControlSize;
}

/** Shares the composer chip's query, so the stall banner knows whether a move needs a pick. */
export function useThreadAccountState(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection | null;
}) {
  return useEnvironmentQuery<ThreadAccountState, unknown>(
    input.modelSelection === null
      ? null
      : threadAccountStateAtom({ ...input, modelSelection: input.modelSelection }),
  );
}

/**
 * Fork: the composer chip that picks which CLI Proxy account a thread uses. Renders only when the
 * provider routes through one quota-router hub with two or more accounts.
 */
export function ThreadAccountPicker(props: PickerProps) {
  const query = useThreadAccountState(props);
  const state = query.data;
  if (!state || state.accounts.length < 2) return null;
  return <ThreadAccountPickerChip {...props} state={state} refresh={query.refresh} />;
}

/** Where the next request and a compaction would go, kept fresh while the window is in front. */
function useAccountPreviews(props: PickerProps) {
  const nextAtom = threadAccountPreviewAtom(props, "next");
  const compactionAtom = threadAccountPreviewAtom(props, "compaction");
  const next = useEnvironmentQuery<ThreadAccountPreview, unknown>(nextAtom).data;
  const compaction = useEnvironmentQuery<ThreadAccountPreview, unknown>(compactionAtom).data;
  const refresh = () => refreshPreviews(nextAtom, compactionAtom);
  const refreshNow = useEffectEvent(refresh);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the router only while this window is visible and focused
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      const { visible, focused } = getDocumentActivity();
      timer = visible && focused ? setInterval(() => refreshNow(), PREVIEW_REFRESH_MS) : undefined;
    };
    const stopActivity = subscribeDocumentActivity(sync);
    const stopReturn = subscribeDocumentReturn(() => refreshNow());
    sync();
    return () => {
      clearInterval(timer);
      stopActivity();
      stopReturn();
    };
  }, []);

  // A context crossing the router's small-context threshold can move the pick too; the 20-second
  // refresh catches it and the check before each send reads the router fresh.
  return { next, compaction, refresh };
}

function refreshPreviews(...atoms: ReadonlyArray<Parameters<typeof appAtomRegistry.refresh>[0]>) {
  for (const atom of atoms) appAtomRegistry.refresh(atom);
}

function ThreadAccountPickerChip(
  props: PickerProps & {
    readonly state: NonNullable<ThreadAccountState>;
    readonly refresh: () => void;
  },
) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, threadId, isDraft, state } = props;
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const previews = useAccountPreviews(props);
  const attention = useAtomValue(threadAccountAttentionAtom);
  const shell = useQuietThreadShell(isDraft ? null : scopeThreadRef(environmentId, threadId));
  const draftChoice = useComposerDraftAccountChoice(scopeThreadRef(environmentId, threadId));
  const choice = threadAccountChoiceFor(
    isDraft ? draftChoice : shell?.accountChoice,
    state.instanceId,
  );
  const externallyOpen = useThreadAccountPickerOpen(threadKey);
  const [open, setOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<UsageLimitSourceAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const runSet = useAtomCommand(serverEnvironment.setThreadAccount, { reportFailure: false });
  const runSteer = useAtomCommand(serverEnvironment.steerThreadAccount, { reportFailure: false });
  const permitted = useAtomValue(serverEnvironment.setThreadAccount.permissionAtom(environmentId));
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);

  const byAlias = (alias: string | null) =>
    alias === null ? undefined : state.accounts.find((account) => account.routerAlias === alias);
  const chosen = byAlias(choice?.account ?? null);
  const owner = byAlias(state.owner);
  const nextAlias = previews.next ? previewAccount(previews.next) : state.next;
  const next = byAlias(nextAlias);
  const current = previews.next?.current ?? null;
  const compactionAlias = previewAccount(previews.compaction);
  const compactionNote = compactionAccountNote(
    {
      accounts: state.accounts,
      current,
      next: nextAlias,
      compaction: compactionAlias,
    },
    messages,
  );
  // A pinned thread whose account is out spills elsewhere; show where. Without a session the
  // router answers as for a new thread, which the first turn's pin overrides.
  const deviates =
    !isDraft &&
    shell?.activeProviderThreadId != null &&
    chosen !== undefined &&
    next !== undefined &&
    next.routerAlias !== chosen.routerAlias;
  const driver = state.accounts[0]?.driver;
  const provider = PROVIDER_NAMES[driver ?? ""] ?? gt("Provider");
  const triggerLabel = [
    gt("{provider} account: {account}", {
      provider,
      account: chosen ? accountLabel(chosen) : gt("Automatic"),
    }),
    next ? gt("Next request: {account}", { account: accountLabel(next) }) : undefined,
    compactionNote,
  ]
    .filter(Boolean)
    .join(". ");
  const canWaitForAccount = driver === "claudeAgent";
  const fallbackNote =
    deviates && chosen && next
      ? {
          chosen: accountShortLabel(chosen, state.accounts),
          next: accountShortLabel(next, state.accounts),
        }
      : null;
  const contextNote =
    props.contextTokens !== null && props.contextTokens > 0
      ? gt("Switching re-sends the thread's {tokens} context as a cold cache write.", {
          tokens: formatContextWindowTokens(props.contextTokens),
        })
      : gt("Switching re-sends the thread's context as a cold cache write.");

  const fail = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: cause instanceof Error ? cause.message : gt("An error occurred."),
    });
  };

  async function apply(
    account: RouterAccountAlias | null,
    waitWhenOut: boolean,
    dropThinking = false,
  ): Promise<void> {
    const stall = canWaitForAccount && waitWhenOut;
    if (isDraft) {
      accountSendGuard.noteOwnChange(threadKey);
      useComposerDraftStore
        .getState()
        .setAccountChoice(
          scopeThreadRef(environmentId, threadId),
          account === null
            ? null
            : { sourceId: state.sourceId, account, stall, instanceId: state.instanceId },
        );
      return;
    }
    setBusy(true);
    const result = await runSet({
      environmentId,
      input: { threadId, account, stall, ...(dropThinking ? { dropThinking } : {}) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      // The owner can change after the menu opened; ask instead of failing.
      const target = byAlias(account);
      if (target && isMoveRefusal(cause)) {
        setPendingMove(target);
        return;
      }
      fail(gt("Could not switch accounts"), result);
    } else {
      accountSendGuard.noteOwnChange(threadKey);
    }
    props.refresh();
    previews.refresh();
  }

  function pick(account: UsageLimitSourceAccount | null) {
    const alias = account?.routerAlias ?? null;
    if (alias === (choice?.account ?? null)) return;
    if (!isDraft && account && owner && owner.routerAlias !== alias) {
      setPendingMove(account);
      return;
    }
    void apply(alias, choice?.stall ?? false);
  }

  async function steer(account: RouterAccountAlias | null) {
    setBusy(true);
    const result = await runSteer({
      environmentId,
      input: { instanceId: state.instanceId, account },
    });
    setBusy(false);
    if (result._tag === "Failure") fail(gt("Could not change the account for new threads"), result);
    // A steer moves where Automatic sends the next request; that is the user's own change.
    else accountSendGuard.noteOwnChange(threadKey);
    props.refresh();
    previews.refresh();
  }

  const isOpen = open || externallyOpen;
  const steered = byAlias(state.steer);
  return (
    <>
      <Popover
        open={isOpen}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) openThreadAccountPicker(null);
          // The router's pick moves with usage, so a menu shows a fresh preview.
          else {
            props.refresh();
            previews.refresh();
          }
        }}
      >
        <PopoverTrigger
          render={
            <ComposerControl
              size={props.size}
              aria-label={triggerLabel}
              title={compactionNote ?? undefined}
            />
          }
        >
          {/* Keyed by the stopped-send count, so each stop replays the one-shot highlight. */}
          <span
            key={attention?.threadKey === threadKey ? attention.count : 0}
            data-composer-control-label
            className={cn(
              "inline-flex items-center gap-1",
              attention?.threadKey === threadKey && "animate-stash-pulse-row",
              deviates && "text-warning-foreground",
            )}
          >
            {chosen ? (
              deviates && next ? (
                <>
                  {accountShortLabel(chosen, state.accounts)}
                  <ArrowRightIcon aria-hidden className="size-3" />
                  {accountShortLabel(next, state.accounts)}
                </>
              ) : (
                accountShortLabel(chosen, state.accounts)
              )
            ) : next ? (
              gt("Auto · {account}", { account: accountShortLabel(next, state.accounts) })
            ) : (
              gt("Auto")
            )}
          </span>
          <ChevronDownIcon data-composer-control-chevron aria-hidden />
        </PopoverTrigger>
        <PopoverPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          width="md"
          padding="compact"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>{gt("{provider} account", { provider })}</span>
              <span>
                <T>this thread</T>
              </span>
            </div>
            <AccountOption
              selected={chosen === undefined}
              disabled={busy || (!isDraft && !permitted)}
              title={gt("Automatic")}
              detail={
                next
                  ? gt("Router picks · would use {account} next", {
                      account: accountShortLabel(next, state.accounts),
                    })
                  : gt("Router picks")
              }
              onSelect={() => pick(null)}
            />
            {state.accounts.map((account) => (
              <AccountOption
                key={account.id}
                selected={chosen?.routerAlias === account.routerAlias}
                disabled={busy || (!isDraft && !permitted)}
                title={accountLabel(account)}
                inUse={next?.routerAlias === account.routerAlias}
                forNewThreads={steered?.routerAlias === account.routerAlias}
                detail={describeAccount(account, timestampFormat, messages)}
                windows={accountWindows(account)}
                onSelect={() => pick(account)}
              />
            ))}
            <div className="mt-1 flex flex-col gap-2 border-t px-1 pt-2">
              {canWaitForAccount ? (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex flex-col">
                    <span>
                      <T>Wait when it runs out</T>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {choice?.stall
                        ? gt("On: waits for this account to reset.")
                        : gt("Off: falls back to another account.")}
                    </span>
                  </span>
                  <Switch
                    size="sm"
                    checked={choice?.stall ?? false}
                    disabled={busy || chosen === undefined || (!isDraft && !permitted)}
                    onCheckedChange={(stall) => {
                      if (chosen?.routerAlias) void apply(chosen.routerAlias, stall);
                    }}
                  />
                </label>
              ) : null}
              {fallbackNote ? (
                <p className="text-xs text-warning-foreground">
                  {canWaitForAccount
                    ? gt(
                        "{chosen} cannot take the next request, so it goes to {next}. Turn on Wait when it runs out to wait instead.",
                        fallbackNote,
                      )
                    : gt(
                        "{chosen} cannot take the next request, so it goes to {next}.",
                        fallbackNote,
                      )}
                </p>
              ) : null}
              {compactionNote ? (
                <p className="text-xs text-muted-foreground">{compactionNote}</p>
              ) : null}
              {isDraft ? null : <p className="text-xs text-muted-foreground">{contextNote}</p>}
              {chosen?.routerAlias && steered?.routerAlias !== chosen.routerAlias ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !permitted}
                  onClick={() => void steer(chosen.routerAlias ?? null)}
                >
                  {gt("Use for new {provider} threads too", { provider })}
                </Button>
              ) : steered ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !permitted}
                  onClick={() => void steer(null)}
                >
                  {gt("Stop sending new {provider} threads to {account}", {
                    provider,
                    account: accountShortLabel(steered, state.accounts),
                  })}
                </Button>
              ) : null}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <AlertDialog
        open={pendingMove !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingMove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Switch this thread to {account}?", {
                account: pendingMove ? accountLabel(pendingMove) : gt("another account"),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "Earlier thinking will be dropped. It is tied to {account} and the new account cannot read it. Messages, tool results and files stay.",
                {
                  account: owner ? accountLabel(owner) : gt("the current account"),
                },
              )}{" "}
              {contextNote}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              disabled={busy}
              onClick={() => {
                const target = pendingMove?.routerAlias;
                setPendingMove(null);
                if (target) void apply(target, choice?.stall ?? false, true);
              }}
            >
              <T>Switch account</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function isMoveRefusal(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "requiresDropThinking" in cause &&
    cause.requiresDropThinking === true
  );
}

function describeAccount(
  account: UsageLimitSourceAccount,
  timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1],
  resolve: MessageResolver,
): string {
  const at = (iso: string) =>
    formatUpcomingTimestamp(iso, timestampFormat, undefined, undefined, resolve);
  const parts = account.plan ? [account.plan] : [];
  const exhausted = exhaustedWindow(account);
  const { session } = accountWindows(account);
  if (exhausted?.resetsAt) {
    const limit =
      exhausted.kind === "other" ? exhausted.label : resolve(WINDOW_LIMIT_LABELS[exhausted.kind]);
    parts.push(resolve(msg("{limit} · back {time}", { limit, time: at(exhausted.resetsAt) })));
  } else if (session?.resetsAt) {
    parts.push(resolve(msg("5-hour limit resets {time}", { time: at(session.resetsAt) })));
  }
  if (account.subscriptionEndsAt) {
    parts.push(resolve(msg("Plan ends {date}", { date: at(account.subscriptionEndsAt) })));
  }
  return parts.join(" · ");
}

function AccountOption(props: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly title: string;
  readonly detail: string;
  readonly inUse?: boolean;
  readonly forNewThreads?: boolean;
  readonly windows?: ReturnType<typeof accountWindows>;
  readonly onSelect: () => void;
}) {
  const gt = useGT();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-start outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-64",
        props.selected && "bg-accent/60",
      )}
    >
      <CheckIcon
        aria-hidden
        className={cn("mt-0.5 size-3.5 shrink-0", props.selected ? "opacity-100" : "opacity-0")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate">{props.title}</span>
          {props.inUse ? (
            <Badge size="sm" variant="info">
              {gt("in use")}
            </Badge>
          ) : null}
          {props.forNewThreads ? (
            <Badge size="sm" variant="secondary">
              {gt("new threads")}
            </Badge>
          ) : null}
        </span>
        {props.detail ? (
          <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      {props.windows ? (
        <span className="flex shrink-0 flex-col gap-1 pt-1">
          <UsageBar label={gt("5h")} window={props.windows.session} />
          <UsageBar
            label={gt("wk", { $context: "short weekly quota label" })}
            window={props.windows.weekly}
          />
        </span>
      ) : null}
    </button>
  );
}

function UsageBar(props: {
  readonly label: string;
  readonly window: ServerProviderUsageWindow | undefined;
}) {
  const gt = useGT();
  const left = props.window ? Math.max(0, Math.min(100, 100 - props.window.usedPercent)) : null;
  return (
    <span
      className="flex items-center justify-end gap-1 text-3xs text-muted-foreground tabular-nums"
      aria-label={
        left === null
          ? gt("{label}: unknown", { label: props.label })
          : gt("{label}: {left}% left", { label: props.label, left: Math.round(left) })
      }
    >
      <span className="min-w-4 whitespace-nowrap">{props.label}</span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        {left === null ? null : (
          <span
            className={cn(
              "block h-full rounded-full",
              left < 10 ? "bg-destructive" : "bg-foreground/60",
            )}
            style={{ width: `${left}%` }}
          />
        )}
      </span>
    </span>
  );
}
