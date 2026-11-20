import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import type { ScopedThreadRef, UsageResetSnooze } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type UsageResetSnoozeOption,
  usageResetSnoozeOptions,
} from "@t3tools/client-runtime/usage-reset-snooze";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { toastManager } from "./ui/toast";

// A menu waits this long for the server; after it, it offers the option that asks again.
const ANSWER_WAIT_MS = 1_000;

function askServer(threadRef: ScopedThreadRef) {
  const thread = readThreadShell(threadRef);
  if (!thread) return undefined;
  return runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, modelSelection: thread.modelSelection },
    },
    { reportFailure: false },
  );
}

/** Each thread's usage-reset snooze options, from its server, before a snooze menu opens. */
export function loadUsageResetSnoozeOptions(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): Promise<ReadonlyArray<ReadonlyArray<UsageResetSnoozeOption>>> {
  return Promise.all(
    threadRefs.map(async (threadRef) => {
      const result = await Promise.race([
        askServer(threadRef),
        new Promise<undefined>((resolve) => setTimeout(resolve, ANSWER_WAIT_MS)),
      ]);
      const answer: UsageResetSnooze | undefined =
        result?._tag === "Success" ? result.value : undefined;
      return usageResetSnoozeOptions(answer, m);
    }),
  );
}

/** When a chosen option wakes the thread, asking again when the menu had no answer. */
export async function usageResetSnoozeChoice(
  threadRef: ScopedThreadRef,
  option: UsageResetSnoozeOption | undefined,
): Promise<{ readonly snoozedUntil: string } | undefined> {
  if (!option) return undefined;
  if (option.snoozedUntil) return { snoozedUntil: option.snoozedUntil };
  const result = await askServer(threadRef);
  if (!result) return undefined;
  if (result._tag === "Success" && result.value.resetsAt) {
    return { snoozedUntil: result.value.resetsAt };
  }
  if (result._tag === "Success" || !isAtomCommandInterrupted(result)) {
    const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : undefined;
    toastManager.add({
      type: "warning",
      title: m(msg("Could not snooze until usage resets")),
      description: error instanceof Error ? error.message : m(msg("The reset time is unknown.")),
    });
  }
  return undefined;
}
