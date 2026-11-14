import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { activeKeepWarmHold } from "@t3tools/client-runtime/state/claudeKeepWarm";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ClaudeKeepWarmAction,
  EnvironmentId,
  ScopedThreadRef,
  ThreadAccountState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { confirmThreadAccountForSend } from "../../state/thread-account-send-guard";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import type { ExistingThreadSettingsRouteParams } from "./ThreadSettingsSheet";

const formatTime = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso)).toLocaleString();

/** Fork: the quota router holds this Claude turn's requests to keep its prompt cache warm. */
export function KeepWarmStallCard({
  thread,
  threadRef,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  threadRef: ScopedThreadRef | null;
  environmentId: EnvironmentId;
}) {
  const structure = useQuietThreadStructure(threadRef);
  const runAction = useAtomCommand(orchestrationEnvironment.claudeKeepWarmAction, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.claudeKeepWarmAction.permissionAtom(environmentId),
  );
  const snooze = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnooze = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  // Fork: the thread settings sheet holds the account picker a bound conversation needs to move.
  const navigation = useNavigation();
  const accounts = useEnvironmentQuery<ThreadAccountState, unknown>(
    serverEnvironment.threadAccountState({
      environmentId,
      input: { threadId: thread.id, modelSelection: thread.modelSelection },
    }),
  ).data;
  const chooseAccount = () =>
    navigation.dispatch(
      StackActions.push("ThreadSettingsSheet", {
        environmentId,
        threadId: thread.id,
        draftKey: scopedThreadKey(environmentId, thread.id),
      } satisfies ExistingThreadSettingsRouteParams),
    );
  const hold = activeKeepWarmHold(
    structure?.projection.turnItems ?? [],
    thread.runtime?.activeRunId ?? null,
  );
  if (hold === null) return null;
  const snoozed =
    thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) === Date.parse(hold.resetAt);

  async function run(
    perform: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
    failure: string,
  ) {
    setPending(true);
    setError(null);
    const result = await perform();
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : failure);
    }
  }
  const act = async (action: ClaudeKeepWarmAction) => {
    // Compacting continues the thread on whichever account the router places it.
    if (
      action === "compact" &&
      !(await confirmThreadAccountForSend({
        environmentId,
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        routed: accounts !== null,
        kind: "compaction",
      }))
    ) {
      return;
    }
    await run(
      () => runAction({ environmentId, input: { threadId: thread.id, action } }),
      "Could not change the stalled thread.",
    );
  };
  const toggleSnooze = () =>
    run(
      () =>
        snoozed
          ? unsnooze({ environmentId, input: { threadId: thread.id, reason: "user" } })
          : snooze({ environmentId, input: { threadId: thread.id, snoozedUntil: hold.resetAt } }),
      snoozed ? "Could not wake the thread." : "Could not snooze the thread.",
    );
  const disabled = pending || !permitted;
  const limit = hold.account ? `The 5-hour limit of ${hold.account}` : "The 5-hour limit";
  const failure = error ? (
    <Text accessibilityRole="alert" className="text-sm text-destructive">
      {error}
    </Text>
  ) : null;

  if (hold.released) {
    return (
      <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3">
        <Text className="text-sm">
          {`No longer stalling to keep Claude's cache warm. ${limit} resets ${formatTime(hold.resetAt)}. Requests run normally until then; reaching the limit first can let the prompt cache expire.`}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Stall again"
            tone="secondary"
            disabled={disabled}
            onPress={() => void act("restore")}
          />
        </View>
        {failure}
      </View>
    );
  }

  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {`Stalled to keep Claude's cache warm. ${limit} resets ${formatTime(hold.resetAt)}; next request ${formatTime(hold.releaseAt)}.`}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Back to normal"
          tone="secondary"
          disabled={disabled}
          onPress={() => void act("release")}
        />
        <Button
          label="Switch account"
          tone="secondary"
          disabled={disabled}
          onPress={() => (accounts?.owner ? chooseAccount() : void act("switch"))}
        />
        {showMore ? (
          <>
            {accounts ? (
              <Button label="Choose account…" tone="secondary" onPress={chooseAccount} />
            ) : null}
            <Button
              label="Compact"
              tone="secondary"
              disabled={disabled}
              onPress={() => void act("compact")}
            />
            <Button
              label={snoozed ? "Wake now" : "Snooze until reset"}
              tone="secondary"
              disabled={disabled}
              onPress={() => void toggleSnooze()}
            />
            <Button
              label="Pause until reset"
              tone="secondary"
              disabled={disabled}
              onPress={() => void act("pause")}
            />
          </>
        ) : (
          <Button label="More" tone="secondary" onPress={() => setShowMore(true)} />
        )}
      </View>
      <Text className="text-xs text-foreground-muted">
        Switching writes the context to the other account's cache once (cold cache write); a
        conversation bound to its account also drops its earlier thinking.
      </Text>
      {failure}
    </View>
  );
}
