import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeKeepWarmAction,
  ClaudeKeepWarmHold,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { SnowflakeIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type StallProps = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  hold: ClaudeKeepWarmHold;
  snoozedUntil: string | null;
  timestampFormat: TimestampFormat;
};

/** Fork: the quota router holds this Claude turn's requests to keep its prompt cache warm. */
export function keepWarmStallBannerItem(props: StallProps): ComposerBannerStackItem {
  const { hold, timestampFormat } = props;
  return {
    id: `keep-warm-stall:${props.threadId}`,
    variant: "warning",
    icon: <SnowflakeIcon />,
    title: "Stalled to keep cache warm",
    description: `Claude is nearly out of its 5-hour limit, which resets ${formatUpcomingTimestamp(
      hold.resetAt,
      timestampFormat,
    )}. Next request ${formatUpcomingTimestamp(hold.releaseAt, timestampFormat)}.`,
    actions: <StallActions key={hold.resetAt} {...props} />,
  };
}

const ACTION_FAILURES: Record<ClaudeKeepWarmAction, string> = {
  release: "Could not resume normal requests",
  compact: "Could not compact the thread",
  pause: "Could not pause the thread",
};

function StallActions({ environmentId, threadId, hold, snoozedUntil }: StallProps) {
  const runAction = useAtomCommand(orchestrationEnvironment.claudeKeepWarmAction, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.claudeKeepWarmAction.permissionAtom(environmentId),
  );
  const { snoozeThread, unsnoozeThread } = useThreadActions();
  const [pending, setPending] = useState(false);
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) === Date.parse(hold.resetAt);

  async function act(action: ClaudeKeepWarmAction) {
    setPending(true);
    const result = await runAction({ environmentId, input: { threadId, action } });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: ACTION_FAILURES[action],
        description: cause instanceof Error ? cause.message : "An error occurred.",
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
        title: snoozed ? "Could not wake thread" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
  }

  const disabled = pending || !permitted;
  return (
    <>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void act("release")}>
        Back to normal
      </Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void act("compact")}>
        Compact
      </Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void toggleSnooze()}>
        {snoozed ? "Wake now" : "Snooze until reset"}
      </Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void act("pause")}>
        Pause until reset
      </Button>
    </>
  );
}
