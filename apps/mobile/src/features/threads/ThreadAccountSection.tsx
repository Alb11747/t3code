import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { accountShortLabel, previewAccount } from "@t3tools/client-runtime/thread-account-guard";
import {
  THREAD_ACCOUNT_MOVE_WARNING,
  type EnvironmentId,
  type ModelSelection,
  type RouterAccountAlias,
  type ThreadAccountChoice,
  type ThreadAccountPreview,
  type ThreadAccountState,
  type ThreadId,
  type UsageLimitSourceAccount,
  threadAccountChoiceFor,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { noteThreadAccountChange } from "../../state/thread-account-send-guard";
import { useAtomCommand } from "../../state/use-atom-command";

const PROVIDER_NAMES: Record<string, string> = { claudeAgent: "Claude", codex: "Codex" };

const label = (account: UsageLimitSourceAccount) =>
  account.email ?? account.routerAlias ?? account.id;

function leftPercent(account: UsageLimitSourceAccount, kind: "session" | "weekly") {
  const window = account.usageLimits.windows.find((candidate) => candidate.kind === kind);
  return window ? Math.max(0, Math.round(100 - window.usedPercent)) : null;
}

function describe(account: UsageLimitSourceAccount) {
  const session = leftPercent(account, "session");
  const weekly = leftPercent(account, "weekly");
  return [
    account.plan,
    session === null ? undefined : `5h ${session}% left`,
    weekly === null ? undefined : `week ${weekly}% left`,
    account.subscriptionEndsAt
      ? `ends ${new Date(account.subscriptionEndsAt).toLocaleDateString()}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function isMoveRefusal(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "requiresDropThinking" in cause &&
    cause.requiresDropThinking === true
  );
}

/**
 * Fork: which CLI Proxy account the thread's requests go to, in the thread settings sheet. Shows
 * only when the provider routes through one quota-router hub with two or more accounts. A draft
 * (`threadId: null`) keeps its choice through `onDraftChange` until its first message sends.
 */
export function ThreadAccountSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly modelSelection: ModelSelection;
  readonly choice: ThreadAccountChoice | null;
  readonly onDraftChange?: (choice: ThreadAccountChoice | null) => void;
}) {
  const { threadId, onDraftChange } = props;
  const query = useEnvironmentQuery<ThreadAccountState, unknown>(
    serverEnvironment.threadAccountState({
      environmentId: props.environmentId,
      input: { ...(threadId ? { threadId } : {}), modelSelection: props.modelSelection },
    }),
  );
  const previewFor = (kind: "next" | "compaction") =>
    serverEnvironment.threadAccountPreview({
      environmentId: props.environmentId,
      input: { ...(threadId ? { threadId } : {}), modelSelection: props.modelSelection, kind },
    });
  // Only a provider with a hub of two or more accounts has a pick to preview.
  const routed = (query.data?.accounts.length ?? 0) >= 2;
  const nextPreview = useEnvironmentQuery<ThreadAccountPreview, unknown>(
    routed ? previewFor("next") : null,
  );
  const compactionPreview = useEnvironmentQuery<ThreadAccountPreview, unknown>(
    routed ? previewFor("compaction") : null,
  );
  const runSet = useAtomCommand(serverEnvironment.setThreadAccount, { reportFailure: false });
  const runSteer = useAtomCommand(serverEnvironment.steerThreadAccount, { reportFailure: false });
  const permitted = useAtomValue(
    serverEnvironment.setThreadAccount.permissionAtom(props.environmentId),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = query.data;
  if (!state || state.accounts.length < 2) return null;

  const byAlias = (alias: string | null | undefined) =>
    alias ? state.accounts.find((account) => account.routerAlias === alias) : undefined;
  const choice = threadAccountChoiceFor(props.choice, state.instanceId);
  const chosen = byAlias(choice?.account);
  const owner = byAlias(state.owner);
  const steered = byAlias(state.steer);
  const provider = PROVIDER_NAMES[state.accounts[0]?.driver ?? ""] ?? "Provider";
  const disabled = pending || (threadId !== null && !permitted);

  async function run(
    perform: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
    onMoveRefused?: () => void,
  ) {
    setPending(true);
    setError(null);
    const result = await perform();
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      // The owner can change after the sheet loaded; ask instead of showing the refusal.
      if (onMoveRefused && isMoveRefusal(cause)) onMoveRefused();
      else setError(cause instanceof Error ? cause.message : "Could not change the account.");
    }
    query.refresh();
    nextPreview.refresh();
    compactionPreview.refresh();
  }
  const confirmMove = (
    account: UsageLimitSourceAccount,
    alias: RouterAccountAlias,
    stall: boolean,
  ) =>
    Dialog.confirm({
      title: `Switch this thread to ${label(account)}?`,
      message: `${THREAD_ACCOUNT_MOVE_WARNING} The earlier thinking is tied to ${owner ? label(owner) : "the current account"}.`,
      confirmText: "Switch account",
      destructive: true,
      onConfirm: () => set(alias, stall, true),
    });
  const set = (account: RouterAccountAlias | null, stall: boolean, dropThinking = false) => {
    if (threadId !== null) noteThreadAccountChange(props.environmentId, threadId);
    if (threadId === null) {
      onDraftChange?.(
        account === null
          ? null
          : { sourceId: state.sourceId, account, stall, instanceId: state.instanceId },
      );
      return;
    }
    const target = byAlias(account);
    void run(
      () =>
        runSet({
          environmentId: props.environmentId,
          input: { threadId, account, stall, ...(dropThinking ? { dropThinking } : {}) },
        }),
      target && account && !dropThinking ? () => confirmMove(target, account, stall) : undefined,
    );
  };
  const pick = (account: UsageLimitSourceAccount | null) => {
    const alias = account?.routerAlias ?? null;
    if (alias === (choice?.account ?? null)) return;
    const stall = choice?.stall ?? false;
    if (account && alias && owner && owner.routerAlias !== alias) {
      confirmMove(account, alias, stall);
      return;
    }
    set(alias, stall);
  };

  const nextAlias = nextPreview.data ? previewAccount(nextPreview.data) : state.next;
  const next = byAlias(nextAlias);
  const afterCompaction = byAlias(previewAccount(compactionPreview.data));
  const current = nextPreview.data?.current ?? null;
  const routeNote = [
    next ? `Next request: ${accountShortLabel(next)}` : undefined,
    afterCompaction && afterCompaction.routerAlias !== (current ?? nextAlias)
      ? `after compacting: ${accountShortLabel(afterCompaction)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const rows = [
    { key: "auto", title: "Automatic", detail: "Router picks", account: null },
    ...state.accounts.map((account) => ({
      key: account.id,
      title: label(account),
      detail: [
        nextAlias === account.routerAlias ? "in use" : undefined,
        steered?.routerAlias === account.routerAlias ? "new threads" : undefined,
        describe(account),
      ]
        .filter(Boolean)
        .join(" · "),
      account,
    })),
  ];

  return (
    <View>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        {provider} account
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        {rows.map((row) => {
          const selected = (row.account?.routerAlias ?? null) === (chosen?.routerAlias ?? null);
          return (
            <Pressable
              key={row.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => pick(row.account)}
              className="min-h-11 flex-row items-center gap-3 border-b border-border-subtle bg-grouped-card px-4 py-2 active:bg-subtle"
            >
              <View className="flex-1">
                <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                  {row.title}
                </Text>
                {row.detail ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                    {row.detail}
                  </Text>
                ) : null}
              </View>
              <View className={cn(!selected && "opacity-0")}>
                <SymbolView
                  name="checkmark"
                  size={14}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </View>
            </Pressable>
          );
        })}
        <View className="min-h-11 flex-row items-center justify-between border-b border-border-subtle bg-grouped-card px-4 py-1">
          <View className="flex-1">
            <Text className="text-sm font-t3-medium text-foreground">Wait when it runs out</Text>
            <Text className="text-xs text-foreground-muted">
              {choice?.stall
                ? "On: waits for the account to reset."
                : "Off: falls back to another account."}
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel="Wait when it runs out"
            disabled={disabled || !chosen?.routerAlias}
            value={choice?.stall ?? false}
            onValueChange={(stall) => {
              if (chosen?.routerAlias) set(chosen.routerAlias, stall);
            }}
          />
        </View>
        {chosen?.routerAlias && steered?.routerAlias !== chosen.routerAlias ? (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() =>
              void run(() =>
                runSteer({
                  environmentId: props.environmentId,
                  input: { instanceId: state.instanceId, account: chosen.routerAlias ?? null },
                }),
              )
            }
            className="min-h-11 justify-center bg-grouped-card px-4 py-2 active:bg-subtle"
          >
            <Text className="text-sm text-foreground">Use for new {provider} threads too</Text>
          </Pressable>
        ) : steered ? (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() =>
              void run(() =>
                runSteer({
                  environmentId: props.environmentId,
                  input: { instanceId: state.instanceId, account: null },
                }),
              )
            }
            className="min-h-11 justify-center bg-grouped-card px-4 py-2 active:bg-subtle"
          >
            <Text className="text-sm text-foreground">
              Stop sending new {provider} threads to {label(steered)}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {routeNote ? (
        <Text className="mx-8 mt-2 text-xs text-foreground-muted">{routeNote}</Text>
      ) : null}
      {threadId === null ? null : (
        <Text className="mx-8 mt-2 text-xs text-foreground-muted">
          Switching re-sends the thread's context as a cold cache write.
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="mx-8 mt-1 text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
