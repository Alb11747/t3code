import type {
  OrchestrationV2ThreadShell,
  OrchestratorMcpThreadSendInput,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/** Recheck target modes under the command lock; the user can raise them after preflight. */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
  readonly parentMessageSender?: ThreadId;
}

// A delegated child may report to its recorded parent, without controlling other higher-mode threads.
// Slash commands can change provider state without the parent interpreting the report.
export const isSubagentParentMessage = (
  caller: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "lineage"> | undefined,
  targetThreadId: ThreadId,
  text: string,
  mode: OrchestratorMcpThreadSendInput["mode"] = "auto",
) =>
  caller?.runtimeMode === "auto" &&
  caller.lineage.relationshipToParent === "subagent" &&
  caller.lineage.parentThreadId === targetThreadId &&
  !text.trimStart().startsWith("/") &&
  (mode === "auto" || mode === "queue");

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "t3/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

export const exceededDispatchModeLimit = (
  limit: DispatchModes,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined =>
  runtimeModeRank[modes.runtimeMode] > runtimeModeRank[limit.runtimeMode]
    ? "runtime"
    : interactionModeRank[modes.interactionMode] > interactionModeRank[limit.interactionMode]
      ? "interaction"
      : undefined;
