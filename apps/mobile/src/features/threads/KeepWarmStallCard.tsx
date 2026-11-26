import { T, useGT } from "gt-react-native";
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

/**
 * Fork: the quota router holds this Claude turn's requests, to keep its prompt cache warm,
 * because the thread's pin waits for its account, or because its account hit a short-session cap.
 */
export function KeepWarmStallCard({
  thread,
  threadRef,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  threadRef: ScopedThreadRef | null;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
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
      gt("Could not change the stalled thread."),
    );
  };
  const toggleSnooze = () =>
    run(
      () =>
        snoozed
          ? unsnooze({ environmentId, input: { threadId: thread.id, reason: "user" } })
          : snooze({ environmentId, input: { threadId: thread.id, snoozedUntil: hold.resetAt } }),
      snoozed ? gt("Could not wake the thread.") : gt("Could not snooze the thread."),
    );
  const disabled = pending || !permitted;
  const limit =
    hold.window === "7d"
      ? hold.account
        ? gt("The weekly limit of {account}", { account: hold.account })
        : gt("The weekly limit")
      : hold.account
        ? gt("The 5-hour limit of {account}", { account: hold.account })
        : gt("The 5-hour limit");
  const failure = error ? (
    <Text accessibilityRole="alert" className="text-sm text-destructive">
      {error}
    </Text>
  ) : null;

  // Fork: a pin that waits for its account, or a short-session cap. Changing the pin moves the
  // held request at once.
  if (hold.kind === "pin") {
    const pinned = hold.account ?? gt("the chosen account");
    // The cap holds a thread whether or not its pin waits, so stopping cannot end it.
    const capped = hold.reason === "short_cap";
    return (
      <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
        <Text className="text-sm text-warning-foreground">
          {capped
            ? gt(
                "{account} reached its short-session cap. The rest of its 5-hour limit, which resets at {resetAt}, is kept for long-running threads. It checks again at {releaseAt}.",
                {
                  account: hold.account ?? gt("This account"),
                  resetAt: formatTime(hold.resetAt),
                  releaseAt: formatTime(hold.releaseAt),
                },
              )
            : hold.resetUnknown
              ? gt(
                  "Waiting for {pinned} (this thread is set to wait for it). The hub cannot use it right now. It checks again at {releaseAt}.",
                  { pinned, releaseAt: formatTime(hold.releaseAt) },
                )
              : gt(
                  "Waiting for {pinned} to reset at {resetAt} (this thread is set to wait for it).",
                  { pinned, resetAt: formatTime(hold.resetAt) },
                )}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={gt("Switch account…")}
            tone="secondary"
            disabled={disabled}
            onPress={chooseAccount}
          />
          {capped ? null : (
            <Button
              label={gt("Stop waiting")}
              tone="secondary"
              disabled={disabled}
              onPress={() => void act("stop_waiting")}
            />
          )}
          {hold.resetUnknown ? null : showMore ? (
            <>
              <Button
                label={snoozed ? gt("Wake now") : gt("Snooze until reset")}
                tone="secondary"
                disabled={disabled}
                onPress={() => void toggleSnooze()}
              />
              <Button
                label={gt("Pause until reset")}
                tone="secondary"
                disabled={disabled}
                onPress={() => void act("pause")}
              />
            </>
          ) : (
            <Button label={gt("More")} tone="secondary" onPress={() => setShowMore(true)} />
          )}
        </View>
        {capped ? null : (
          <Text className="text-xs text-foreground-muted">
            <T>
              Stop waiting keeps this account but lets the request go to another one now, writing
              the context to its cache once (cold cache write).
            </T>
          </Text>
        )}
        {failure}
      </View>
    );
  }

  if (hold.released) {
    return (
      <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3">
        <Text className="text-sm">
          {gt(
            "No longer stalling to keep Claude's cache warm. {limit} resets at {resetAt}. Requests run normally until then. Reaching the limit first can let the prompt cache expire.",
            { limit, resetAt: formatTime(hold.resetAt) },
          )}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={gt("Stall again")}
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
        {gt(
          "Stalled to keep Claude's cache warm. {limit} resets at {resetAt}. The next request runs at {releaseAt}.",
          { limit, resetAt: formatTime(hold.resetAt), releaseAt: formatTime(hold.releaseAt) },
        )}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Back to normal")}
          tone="secondary"
          disabled={disabled}
          onPress={() => void act("release")}
        />
        <Button
          label={gt("Switch account")}
          tone="secondary"
          disabled={disabled}
          onPress={() => (accounts?.owner ? chooseAccount() : void act("switch"))}
        />
        {showMore ? (
          <>
            {accounts ? (
              <Button label={gt("Choose account…")} tone="secondary" onPress={chooseAccount} />
            ) : null}
            <Button
              label={gt("Compact")}
              tone="secondary"
              disabled={disabled}
              onPress={() => void act("compact")}
            />
            <Button
              label={snoozed ? gt("Wake now") : gt("Snooze until reset")}
              tone="secondary"
              disabled={disabled}
              onPress={() => void toggleSnooze()}
            />
            <Button
              label={gt("Pause until reset")}
              tone="secondary"
              disabled={disabled}
              onPress={() => void act("pause")}
            />
          </>
        ) : (
          <Button label={gt("More")} tone="secondary" onPress={() => setShowMore(true)} />
        )}
      </View>
      <Text className="text-xs text-foreground-muted">
        <T>
          Switching writes the context to the other account's cache once (cold cache write). A
          conversation bound to its account also drops its earlier thinking.
        </T>
      </Text>
      {failure}
    </View>
  );
}
