import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ServerProvider, ThreadId } from "@t3tools/contracts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { useGT, useMessages } from "gt-react";

import type { NestedSubagentRow } from "../../state/nestedSubagents.fork";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

const INDENT_REM = 0.875;

/** Live subagents below a direct subagent's lineage row, indented by depth. */
export function ThreadLineageNestedRows(props: {
  readonly rows: ReadonlyArray<NestedSubagentRow> | undefined;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return props.rows?.map((row) => {
    const provider = props.providers?.find((entry) => entry.instanceId === row.providerInstanceId);
    const { status, startedAt } = row;
    const title = formatSubagentDisplayTitle(row.title);
    return (
      <li
        key={row.threadId}
        className="group relative flex h-8 items-center rounded-lg"
        style={{ marginInlineStart: `${row.depth * INDENT_REM}rem` }}
      >
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                onClick={() => props.onOpenThread(row.threadId)}
              />
            }
          >
            <ThreadRelationshipIcon
              driver={provider?.driver}
              provider={provider}
              providerEntries={props.providerEntries}
              status={status}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
                {title}
              </span>
            </span>
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              {status === "running" && startedAt ? (
                <AgentElapsed
                  agent={{
                    status: "running",
                    startedAt,
                    completedAt: null,
                  }}
                  compact
                />
              ) : (
                threadRelationshipStatusLabel(status, m)
              )}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left">
            <span className="block font-medium">{title}</span>
            <span className="block text-muted-foreground">
              {gt("Open nested subagent in this chat")}
            </span>
          </TooltipPopup>
        </Tooltip>
      </li>
    );
  });
}
