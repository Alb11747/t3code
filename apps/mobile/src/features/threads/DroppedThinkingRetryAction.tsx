import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type NodeId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  claudeThinkingRecoveryTarget,
  retriedWithDroppedThinking,
} from "@t3tools/shared/orchestrationV2ClaudeThinkingRecovery";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function DroppedThinkingRetryAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId | null;
}) {
  const target = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => {
      const target = thread ? claudeThinkingRecoveryTarget(thread.projection) : null;
      return target &&
        thread?.projection.attempts.find((attempt) => attempt.id === target.attemptId)
          ?.rootNodeId === props.nodeId
        ? target
        : null;
    },
  );
  const dropped = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) =>
      thread !== undefined &&
      thread !== null &&
      retriedWithDroppedThinking(thread.projection.attempts, props.runId, props.nodeId),
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const retry = useAtomCommand(threadEnvironment.retryRun);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  if (dropped)
    return (
      <Text className="ml-7 mt-2 text-xs text-warning-foreground">
        Retried with earlier thinking dropped. Claude may not recall its reasoning from before this
        point.
      </Text>
    );
  if (target?.runId !== props.runId) return null;

  async function recover() {
    if (!target || !canOperate || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await retry({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, ...target, recovery: "drop_thinking" },
    });
    inFlight.current = false;
    setBusy(false);
  }

  return (
    <View className="ml-7 mt-2 gap-1">
      <Button
        label="Retry with dropped thinking"
        tone="secondary"
        disabled={!canOperate || busy}
        loading={busy}
        onPress={() => void recover()}
        icon="arrow.clockwise"
      />
      <Text className="text-xs text-foreground-subtle">
        This retry may run without earlier reasoning.
      </Text>
    </View>
  );
}
