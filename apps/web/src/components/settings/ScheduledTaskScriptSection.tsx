import { useAtomValue } from "@effect/atom-react";
import {
  SCHEDULED_TASK_SCRIPT_EXAMPLES,
  type ScheduledTaskScriptDraft,
} from "@t3tools/client-runtime/scheduled-task-script";
import {
  type EnvironmentId,
  MAX_SCHEDULED_TASK_SCRIPT_CHARS,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskId,
  type ScheduledTaskScript,
  type ScheduledTaskTestScriptResult,
  type ThreadId,
} from "@t3tools/contracts";
import { BookOpenIcon, ChevronDownIcon, FlaskConicalIcon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";

const OUTCOME_LABELS: Record<string, string> = { run: "Runs", skip: "Skips", error: "Failed" };

function outcomeVariant(outcome: string) {
  if (outcome === "run") return "success";
  if (outcome === "skip") return "warning";
  return "error";
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function describeModel(selection: ModelSelection): string {
  const options = (selection.options ?? []).map((option) => `${option.id} ${option.value}`);
  return `${selection.model} on ${selection.instanceId}${options.length ? ` (${options.join(", ")})` : ""}`;
}

function CodeBlock({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

/** Fork: the Advanced section of the scheduled-task editor, holding the task's check script. */
export function ScheduledTaskScriptSection({
  environmentId,
  taskId,
  script,
  draft,
  onChange,
  testTarget,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId | null;
  /** The saved script as the server last reported it. */
  readonly script: ScheduledTaskScript | undefined;
  readonly draft: ScheduledTaskScriptDraft;
  readonly onChange: (draft: ScheduledTaskScriptDraft) => void;
  readonly testTarget: {
    readonly prompt: string;
    readonly projectId: ProjectId | null;
    readonly threadId: ThreadId | null;
    readonly modelSelection: ModelSelection | null;
  };
  readonly disabled: boolean;
}) {
  const canEdit = useAtomValue(
    serverEnvironment.testScheduledTaskScript.permissionAtom(environmentId),
  );
  const testScript = useAtomCommand(serverEnvironment.testScheduledTaskScript, {
    label: "scheduled task test script",
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ScheduledTaskTestScriptResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const hasSource = draft.source.trim() !== "";
  const lastCheck = script?.lastCheck ?? null;

  const runTest = async () => {
    if (!hasSource || testing) return;
    setTesting(true);
    setTestError(null);
    const outcome = await testScript({
      environmentId,
      input: {
        source: draft.source,
        ...(taskId === null ? {} : { id: taskId }),
        prompt: testTarget.prompt,
        ...(testTarget.projectId === null ? {} : { projectId: testTarget.projectId }),
        threadId: testTarget.threadId,
        ...(testTarget.modelSelection === null
          ? {}
          : { modelSelection: testTarget.modelSelection }),
      },
    });
    setTesting(false);
    if (outcome._tag === "Success") setResult(outcome.value);
    else if (!isAtomCommandInterrupted(outcome))
      setTestError(String(squashAtomCommandFailure(outcome)));
  };

  return (
    <div className="rounded-lg border border-border/70">
      <Collapsible defaultOpen={hasSource}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium">
          <span className="flex-1">Advanced</span>
          {hasSource ? (
            <Badge variant="info" size="sm">
              Script
            </Badge>
          ) : null}
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-3 border-t border-border/70 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="scheduled-task-script">Check script</Label>
                <p className="text-xs text-muted-foreground">
                  JavaScript that runs on the server before each run, including webhook runs. Return{" "}
                  <code>false</code> to skip, or{" "}
                  <code>{"{ run, prompt, model, nextRunAt, reason }"}</code>; <code>model</code>{" "}
                  picks this run&apos;s model from <code>ctx.providers</code>. <code>ctx</code> also
                  holds usage for every account, the bound thread (including its Claude cache
                  expiry), the webhook request, and <code>ctx.state</code>, which is saved after
                  each check. If it throws, the run fails.
                </p>
              </div>
              <Menu>
                <MenuTrigger
                  render={<Button size="sm" variant="outline" disabled={disabled || !canEdit} />}
                >
                  <BookOpenIcon />
                  Examples
                </MenuTrigger>
                <MenuPopup align="end">
                  {SCHEDULED_TASK_SCRIPT_EXAMPLES.map((example) => (
                    <MenuItem
                      key={example.id}
                      onClick={() => onChange({ ...draft, source: example.source })}
                    >
                      <div className="flex flex-col">
                        <span>{example.label}</span>
                        <span className="text-xs text-muted-foreground">{example.description}</span>
                      </div>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            <div className="font-mono">
              <Textarea
                id="scheduled-task-script"
                rows={8}
                spellCheck={false}
                placeholder="return true;"
                maxLength={MAX_SCHEDULED_TASK_SCRIPT_CHARS}
                readOnly={!canEdit}
                disabled={disabled}
                value={draft.source}
                onChange={(event) => onChange({ ...draft, source: event.target.value })}
              />
            </div>
            {!canEdit ? (
              <p className="text-xs text-muted-foreground">
                Editing or testing a script needs terminal access to this environment.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !canEdit || !hasSource || testing}
                onClick={() => void runTest()}
              >
                <FlaskConicalIcon />
                {testing ? "Testing…" : "Test script"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Runs it now without starting a run or saving state.
              </span>
            </div>
            {testError ? <p className="text-xs text-destructive-foreground">{testError}</p> : null}
            {result ? (
              <div className="space-y-2 rounded-md border border-border/60 p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={outcomeVariant(result.outcome)}>
                    {OUTCOME_LABELS[result.outcome] ?? result.outcome}
                  </Badge>
                  <span className="text-muted-foreground">{result.durationMs} ms</span>
                  {result.decision?.reason ? <span>{result.decision.reason}</span> : null}
                </div>
                {result.error ? <CodeBlock label="Error" text={result.error} /> : null}
                {result.decision?.prompt ? (
                  <CodeBlock label="Prompt" text={result.decision.prompt} />
                ) : null}
                {result.decision?.modelSelection ? (
                  <p className="text-xs">
                    Runs on {describeModel(result.decision.modelSelection)}.
                  </p>
                ) : null}
                {result.decision?.nextRunAt ? (
                  <p className="text-xs">
                    Next run moves to {new Date(result.decision.nextRunAt).toLocaleString()}.
                  </p>
                ) : null}
                {result.logs ? <CodeBlock label="Logs" text={result.logs} /> : null}
                {result.decision?.state ? (
                  <CodeBlock label="State it would save" text={prettyJson(result.decision.state)} />
                ) : null}
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">ctx</summary>
                  <CodeBlock label="Context" text={prettyJson(result.context)} />
                </details>
              </div>
            ) : null}
            {lastCheck ? (
              <div className="space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Last check</span>
                  <Badge variant={outcomeVariant(lastCheck.outcome)} size="sm">
                    {OUTCOME_LABELS[lastCheck.outcome] ?? lastCheck.outcome}
                  </Badge>
                  <span className="text-muted-foreground">
                    {new Date(lastCheck.at).toLocaleString()}
                  </span>
                </div>
                {lastCheck.message ? <p className="break-words">{lastCheck.message}</p> : null}
                {lastCheck.modelSelection ? (
                  <p>Ran on {describeModel(lastCheck.modelSelection)}.</p>
                ) : null}
                {lastCheck.logs ? <CodeBlock label="Logs" text={lastCheck.logs} /> : null}
              </div>
            ) : null}
            {script?.state ? (
              <div className="space-y-1.5">
                <CodeBlock label="Saved state" text={prettyJson(script.state)} />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || !canEdit}
                  onClick={() => onChange({ ...draft, resetState: !draft.resetState })}
                >
                  {draft.resetState ? "Keep state" : "Reset state"}
                </Button>
                {draft.resetState ? (
                  <span className="ms-2 text-xs text-muted-foreground">
                    State clears when you save.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
