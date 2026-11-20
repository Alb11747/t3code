import { msg } from "gt-react-native";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { usageResetSnoozeOptions } from "@t3tools/client-runtime/usage-reset-snooze";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

/** Fork: the snooze menu entry that wakes a thread when its account's usage resets. */
export const USAGE_RESET_SNOOZE_ACTION = "snooze:usage-reset";

/**
 * Native menus are fixed before they open, so the menu has one entry; when the account the thread
 * last used reports windows, this asks which one, as web's submenu lists them.
 */
export async function chooseUsageResetSnooze(
  threadRef: ScopedThreadRef,
  modelSelection: ModelSelection,
): Promise<string | undefined> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.resolveUsageResetSnooze,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, modelSelection },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Could not snooze until usage resets")),
        error instanceof Error ? error.message : m(msg("The reset time is unknown.")),
      );
    }
    return undefined;
  }
  const options = usageResetSnoozeOptions(result.value, m);
  if (options.length === 1) {
    if (!options[0]!.snoozedUntil) {
      Dialog.alert(
        m(msg("Could not snooze until usage resets")),
        m(msg("The reset time is unknown.")),
      );
    }
    return options[0]!.snoozedUntil;
  }
  return new Promise((resolve) =>
    Dialog.alert(
      m(msg("Snooze until usage resets")),
      undefined,
      [
        ...options.map((option) => ({
          text: option.label,
          onPress: () => resolve(option.snoozedUntil),
        })),
        { text: m(msg("Cancel")), style: "cancel" as const, onPress: () => resolve(undefined) },
      ],
      { cancelable: true, onDismiss: () => resolve(undefined) },
    ),
  );
}
