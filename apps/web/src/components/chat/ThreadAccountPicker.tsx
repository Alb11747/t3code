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
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useComposerDraftAccountChoice, useComposerDraftStore } from "../../composerDraftStore";
import { usePrimarySettings } from "../../hooks/useSettings";
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
  shortAccountLabel,
  useThreadAccountPickerOpen,
} from "./threadAccountChoice";
import {
  accountSendGuard,
  compactionAccountNote,
  publishShownAccounts,
  threadAccountAttentionAtom,
} from "./threadAccountSendGuard";

const PROVIDER_NAMES: Record<string, string> = { claudeAgent: "Claude", codex: "Codex" };
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
      : serverEnvironment.threadAccountState({
          environmentId: input.environmentId,
          input: { threadId: input.threadId, modelSelection: input.modelSelection },
        }),
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
  const { environmentId, threadId, modelSelection } = props;
  const atomFor = (kind: "next" | "compaction") =>
    serverEnvironment.threadAccountPreview({
      environmentId,
      input: { threadId, modelSelection, kind },
    });
  const nextAtom = atomFor("next");
  const compactionAtom = atomFor("compaction");
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

  // The router's small-context switch can change the pick once the context crosses its threshold.
  const threshold = next?.switchBelowContextTokens ?? null;
  const below =
    threshold === null || props.contextTokens === null ? null : props.contextTokens < threshold;
  const belowRef = useRef(below);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the router when the context crosses its switch threshold
  useEffect(() => {
    if (belowRef.current === below) return;
    belowRef.current = below;
    if (below !== null) refreshNow();
  }, [below]);

  return { next, compaction, refresh, nextAtom, compactionAtom };
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
  const compactionNote = compactionAccountNote({
    accounts: state.accounts,
    current,
    next: nextAlias,
    compaction: compactionAlias,
  });
  const { nextAtom, compactionAtom } = previews;
  const { modelSelection } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shares what the chip shows with send handlers and Compact controls outside this tree
  useEffect(
    () =>
      publishShownAccounts(threadKey, {
        environmentId,
        input: { threadId, modelSelection },
        accounts: state.accounts,
        current,
        next: nextAlias,
        compaction: compactionAlias,
        refresh: () => refreshPreviews(nextAtom, compactionAtom),
      }),
    [
      threadKey,
      environmentId,
      threadId,
      modelSelection,
      state.accounts,
      current,
      nextAlias,
      compactionAlias,
      nextAtom,
      compactionAtom,
    ],
  );
  // A pinned thread whose account is out spills elsewhere; show where.
  const deviates =
    chosen !== undefined && next !== undefined && next.routerAlias !== chosen.routerAlias;
  const provider = providerName(state);
  const contextNote =
    props.contextTokens !== null && props.contextTokens > 0
      ? `Switching re-sends this thread's ${formatContextWindowTokens(props.contextTokens)} context as a cold cache write.`
      : "Switching re-sends this thread's context as a cold cache write.";

  const fail = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: cause instanceof Error ? cause.message : "An error occurred.",
    });
  };

  async function apply(
    account: RouterAccountAlias | null,
    stall: boolean,
    dropThinking = false,
  ): Promise<void> {
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
      fail("Could not switch accounts", result);
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
    if (result._tag === "Failure") fail("Could not change the account for new threads", result);
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
              aria-label={`${provider} account: ${chosen ? accountLabel(chosen) : "automatic"}${
                next ? `, next request on ${accountLabel(next)}` : ""
              }${compactionNote ? `. ${compactionNote}` : ""}`}
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
                  {shortAccountLabel(chosen)}
                  <ArrowRightIcon aria-hidden className="size-3" />
                  {accountShortLabel(next)}
                </>
              ) : (
                shortAccountLabel(chosen)
              )
            ) : next ? (
              `Auto · ${accountShortLabel(next)}`
            ) : (
              "Auto"
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
              <span>{provider} account</span>
              <span>this thread</span>
            </div>
            <AccountOption
              selected={chosen === undefined}
              disabled={busy || (!isDraft && !permitted)}
              title="Automatic"
              detail={
                next ? `Router picks · would use ${shortAccountLabel(next)} next` : "Router picks"
              }
              onSelect={() => pick(null)}
            />
            {state.accounts.map((account) => (
              <AccountOption
                key={account.id}
                selected={chosen?.routerAlias === account.routerAlias}
                disabled={busy || (!isDraft && !permitted)}
                title={accountLabel(account)}
                marks={[
                  ...(next?.routerAlias === account.routerAlias ? ["in use"] : []),
                  ...(steered?.routerAlias === account.routerAlias ? ["new threads"] : []),
                ]}
                detail={describeAccount(account, timestampFormat)}
                windows={accountWindows(account)}
                onSelect={() => pick(account)}
              />
            ))}
            <div className="mt-1 flex flex-col gap-2 border-t px-1 pt-2">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="flex flex-col">
                  <span>Wait when it runs out</span>
                  <span className="text-xs text-muted-foreground">
                    {choice?.stall
                      ? "On: waits for this account to reset."
                      : "Off: falls back to another account."}
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
              {deviates && chosen && next ? (
                <p className="text-xs text-warning-foreground">
                  {shortAccountLabel(chosen)} cannot take the next request, so it goes to{" "}
                  {accountShortLabel(next)}. Turn on Wait when it runs out to wait instead.
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
                  Use for new {provider} threads too
                </Button>
              ) : steered ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !permitted}
                  onClick={() => void steer(null)}
                >
                  Stop sending new {provider} threads to {shortAccountLabel(steered)}
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
              Switch this thread to {pendingMove ? accountLabel(pendingMove) : "another account"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Earlier thinking will be dropped. It is tied to{" "}
              {owner ? accountLabel(owner) : "the current account"} and the new account cannot read
              it. Messages, tool results and files stay.{" "}
              {contextNote.replace("Switching", "This also")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              disabled={busy}
              onClick={() => {
                const target = pendingMove?.routerAlias;
                setPendingMove(null);
                if (target) void apply(target, choice?.stall ?? false, true);
              }}
            >
              Switch account
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

function providerName(state: NonNullable<ThreadAccountState>): string {
  return PROVIDER_NAMES[state.accounts[0]?.driver ?? ""] ?? "Provider";
}

function describeAccount(
  account: UsageLimitSourceAccount,
  timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1],
): string {
  const at = (iso: string) => formatUpcomingTimestamp(iso, timestampFormat);
  const parts = account.plan ? [account.plan] : [];
  const exhausted = exhaustedWindow(account);
  const { session } = accountWindows(account);
  if (exhausted?.resetsAt) {
    const name = exhausted.kind === "weekly" ? "weekly" : exhausted.label;
    parts.push(`${name} limit · back ${at(exhausted.resetsAt)}`);
  } else if (session?.resetsAt) {
    parts.push(`5h resets ${at(session.resetsAt)}`);
  }
  if (account.subscriptionEndsAt) parts.push(`ends ${at(account.subscriptionEndsAt)}`);
  return parts.join(" · ");
}

function AccountOption(props: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly title: string;
  readonly detail: string;
  readonly marks?: ReadonlyArray<string>;
  readonly windows?: ReturnType<typeof accountWindows>;
  readonly onSelect: () => void;
}) {
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
          {props.marks?.map((mark) => (
            <Badge key={mark} size="sm" variant={mark === "in use" ? "info" : "secondary"}>
              {mark}
            </Badge>
          ))}
        </span>
        {props.detail ? (
          <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      {props.windows ? (
        <span className="flex shrink-0 flex-col gap-1 pt-1">
          <UsageBar label="5h" window={props.windows.session} />
          <UsageBar label="wk" window={props.windows.weekly} />
        </span>
      ) : null}
    </button>
  );
}

function UsageBar(props: {
  readonly label: string;
  readonly window: ServerProviderUsageWindow | undefined;
}) {
  const left = props.window ? Math.max(0, Math.min(100, 100 - props.window.usedPercent)) : null;
  return (
    <span
      className="flex items-center gap-1 text-3xs text-muted-foreground tabular-nums"
      aria-label={
        left === null ? `${props.label}: unknown` : `${props.label}: ${Math.round(left)}% left`
      }
    >
      <span className="w-4">{props.label}</span>
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
