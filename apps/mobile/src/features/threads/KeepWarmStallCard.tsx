import { useAtomValue } from "@effect/atom-react";
import { activeKeepWarmHold } from "@t3tools/client-runtime/state/claudeKeepWarm";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ClaudeKeepWarmAction, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

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
  const act = (action: ClaudeKeepWarmAction) =>
    run(
      () => runAction({ environmentId, input: { threadId: thread.id, action } }),
      "Could not change the stalled thread.",
    );
  const toggleSnooze = () =>
    run(
      () =>
        snoozed
          ? unsnooze({ environmentId, input: { threadId: thread.id, reason: "user" } })
          : snooze({ environmentId, input: { threadId: thread.id, snoozedUntil: hold.resetAt } }),
      snoozed ? "Could not wake the thread." : "Could not snooze the thread.",
    );
  const disabled = pending || !permitted;

  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {`Stalled to keep Claude's cache warm. The 5-hour limit resets ${formatTime(hold.resetAt)}; next request ${formatTime(hold.releaseAt)}.`}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Back to normal"
          tone="secondary"
          disabled={disabled}
          onPress={() => void act("release")}
        />
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
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
