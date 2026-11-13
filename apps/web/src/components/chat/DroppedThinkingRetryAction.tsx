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
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";

const DROPPED_THINKING_NOTICE =
  "Retried with earlier thinking dropped. Claude may not recall its reasoning from before this point.";

export function DroppedThinkingRetryAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId | null;
}) {
  const thread = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const target = thread ? claudeThinkingRecoveryTarget(thread.projection) : null;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const retry = useOrchestrationCommand(threadEnvironment.retryRun);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  if (thread && retriedWithDroppedThinking(thread.projection.attempts, props.runId, props.nodeId))
    return (
      <p className="ms-7 flex items-center gap-1.5 pb-1 text-xs text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        {DROPPED_THINKING_NOTICE}
      </p>
    );
  if (
    target?.runId !== props.runId ||
    thread?.projection.attempts.find((attempt) => attempt.id === target.attemptId)?.rootNodeId !==
      props.nodeId
  )
    return null;

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
    <div className="ms-7 space-y-1 pb-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!canOperate || busy}
        aria-busy={busy}
        onClick={() => void recover()}
      >
        <RotateCcwIcon aria-hidden />
        Retry with dropped thinking
      </Button>
      <p className="text-xs text-muted-foreground">This retry may run without earlier reasoning.</p>
    </div>
  );
}
