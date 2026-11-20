import { m, type MessageResolver } from "~/i18n/messages";
import { msg, useGT, T } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeKeepWarmAction,
  ClaudeKeepWarmHold,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { EllipsisIcon, HourglassIcon, SnowflakeIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { openThreadAccountPicker } from "./threadAccountChoice";
import { useThreadAccountState } from "./ThreadAccountPicker";
import { confirmAccountForSend, useCompactionAccountNote } from "./threadAccountSendGuard";

type StallProps = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  hold: ClaudeKeepWarmHold;
  snoozedUntil: string | null;
  timestampFormat: TimestampFormat;
};

/**
 * Fork: the quota router holds this Claude turn's requests, to keep its prompt cache warm or
 * because the thread's pin waits for its account.
 */
export function keepWarmStallBannerItem(
  props: StallProps,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const { hold, timestampFormat } = props;
  const reset = formatUpcomingTimestamp(hold.resetAt, timestampFormat);
  const id = `keep-warm-stall:${props.threadId}`;
  if (hold.kind === "pin") {
    const pinned = hold.account ?? resolve(msg("the chosen account"));
    return {
      id,
      variant: "warning",
      icon: <HourglassIcon />,
      title: resolve(msg("Waiting for {account}", { account: pinned })),
      description: hold.resetUnknown
        ? resolve(
            msg(
              "This thread is set to wait for {account}, which the hub cannot use right now. It checks again {releaseAt}.",
              {
                account: pinned,
                releaseAt: formatUpcomingTimestamp(hold.releaseAt, timestampFormat),
              },
            ),
          )
        : resolve(
            msg("This thread is set to wait for {account}, which resets {resetAt}.", {
              account: pinned,
              resetAt: reset,
            }),
          ),
      actions: <StallActions key={hold.resetAt} {...props} />,
    };
  }
  const account = hold.account
    ? resolve(msg("Claude account {account}", { account: hold.account }))
    : "Claude";
  if (hold.released) {
    return {
      id,
      variant: "info",
      icon: <SnowflakeIcon />,
      title: resolve(msg("No longer stalling to keep cache warm")),
      description: resolve(
        msg(
          "{account} is nearly out of its 5-hour limit, which resets {resetAt}. Requests run normally until then; reaching the limit first can let the prompt cache expire.",
          { account, resetAt: reset },
        ),
      ),
      // Same key as the stall's actions: a release still in flight keeps them disabled.
      actions: <StallActions key={hold.resetAt} {...props} />,
    };
  }
  return {
    id,
    variant: "warning",
    icon: <SnowflakeIcon />,
    title: resolve(msg("Stalled to keep cache warm")),
    description: resolve(
      msg(
        "{account} is nearly out of its 5-hour limit, which resets {resetAt}. Next request {releaseAt}.",
        {
          account,
          resetAt: reset,
          releaseAt: formatUpcomingTimestamp(hold.releaseAt, timestampFormat),
        },
      ),
    ),
    actions: <StallActions key={hold.resetAt} {...props} />,
  };
}

const ACTION_FAILURES: Record<ClaudeKeepWarmAction, string> = {
  release: msg("Could not resume normal requests"),
  restore: msg("Could not turn stalling back on"),
  switch: msg("Could not switch accounts"),
  compact: msg("Could not compact the thread"),
  pause: msg("Could not pause the thread"),
  stop_waiting: msg("Could not stop waiting"),
};

function StallActions({ environmentId, threadId, hold, snoozedUntil }: StallProps) {
  const gt = useGT();
  const runAction = useAtomCommand(orchestrationEnvironment.claudeKeepWarmAction, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.claudeKeepWarmAction.permissionAtom(environmentId),
  );
  const { snoozeThread, unsnoozeThread } = useThreadActions();
  const [pending, setPending] = useState(false);
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) === Date.parse(hold.resetAt);
  // Fork: the composer's account picker, which a bound conversation needs to move at all.
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const accounts = useThreadAccountState({
    environmentId,
    threadId,
    modelSelection: shell?.modelSelection ?? null,
  }).data;
  const chooseAccount = () => openThreadAccountPicker(scopedThreadKey(threadRef));
  // The chip's target uses the composer's model, which is the thread's unless changed unsent.
  const accountTarget = shell
    ? { environmentId, threadId, modelSelection: shell.modelSelection }
    : null;
  const compactionNote = useCompactionAccountNote(accountTarget);

  async function act(action: ClaudeKeepWarmAction) {
    setPending(true);
    // Compacting continues the thread on whichever account the router places it.
    if (
      action === "compact" &&
      accountTarget !== null &&
      !(await confirmAccountForSend(scopedThreadKey(threadRef), accountTarget, "compaction"))
    ) {
      setPending(false);
      return;
    }
    const result = await runAction({ environmentId, input: { threadId, action } });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: m(ACTION_FAILURES[action]),
        description: cause instanceof Error ? cause.message : m(msg("An error occurred.")),
      });
    }
  }

  async function toggleSnooze() {
    setPending(true);
    const target = { environmentId, threadId };
    const result = snoozed
      ? await unsnoozeThread(target)
      : await snoozeThread(target, hold.resetAt);
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: snoozed ? gt("Could not wake thread") : gt("Could not snooze thread"),
        description: cause instanceof Error ? cause.message : gt("An error occurred."),
      });
    }
  }

  const disabled = pending || !permitted;
  // Fork: a pin that waits for its account. Changing the pin moves the held request at once.
  if (hold.kind === "pin") {
    return (
      <>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={chooseAccount}>
          <T>Switch account…</T>
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => void act("stop_waiting")}
              >
                <T>Stop waiting</T>
              </Button>
            }
          />
          <TooltipPopup side="top">
            <T>
              Keeps this account but turns off Wait when it runs out, so the request goes to another
              account now (cold cache write).
            </T>
          </TooltipPopup>
        </Tooltip>
        {hold.resetUnknown ? null : (
          <Menu>
            <MenuTrigger
              disabled={disabled}
              render={
                <Button size="icon-xs" variant="ghost" aria-label={gt("More stall actions")} />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
              <MenuItem onClick={() => void toggleSnooze()}>
                {snoozed ? gt("Wake now") : gt("Snooze until reset")}
              </MenuItem>
              <MenuItem onClick={() => void act("pause")}>
                <T>Pause until reset</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </>
    );
  }
  if (hold.released) {
    return (
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void act("restore")}>
        <T>Stall again</T>
      </Button>
    );
  }
  return (
    <>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void act("release")}>
        <T>Back to normal</T>
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => (accounts?.owner ? chooseAccount() : void act("switch"))}
            >
              <T>Switch account</T>
            </Button>
          }
        />
        <TooltipPopup side="top">
          <T>
            Moves this thread to another account. Its context is written to that account's cache
            once (cold cache write). A conversation bound to its account also drops its earlier
            thinking.
          </T>
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={<Button size="icon-xs" variant="ghost" aria-label={gt("More stall actions")} />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
          {accounts ? (
            <MenuItem onClick={chooseAccount}>
              <T>Choose account…</T>
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => void act("compact")}>
            {compactionNote ? (
              <span className="flex flex-col">
                <span>
                  <T>Compact</T>
                </span>
                <span className="text-xs text-muted-foreground">{compactionNote}</span>
              </span>
            ) : (
              gt("Compact")
            )}
          </MenuItem>
          <MenuItem onClick={() => void toggleSnooze()}>
            {snoozed ? gt("Wake now") : gt("Snooze until reset")}
          </MenuItem>
          <MenuItem onClick={() => void act("pause")}>
            <T>Pause until reset</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
