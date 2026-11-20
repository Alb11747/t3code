import { useGT, T } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useId, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useEnvironmentScope } from "~/state/session";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { contextNoteDialogThreadAtom } from "./contextNoteDialogState";

export function ContextNoteDialogHost() {
  const threadRef = useAtomValue(contextNoteDialogThreadAtom);
  return threadRef === null ? null : (
    <ContextNoteDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(contextNoteDialogThreadAtom, null)}
    />
  );
}

function ContextNoteDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const thread = useThreadShell(threadRef);
  const note = thread?.contextNote;
  const [text, setText] = useState(note?.text ?? "");
  const [mode, setMode] = useState<"prepend" | "replace">(note?.mode ?? "prepend");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUpdate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const save = async (remove: boolean) => {
    setSaving(true);
    setError(null);
    const result = await updateMetadata({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        contextNote: remove ? null : { text, mode, author: { kind: "user" } },
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not save the context note."));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Context note</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Give agents current context when they read or attach this thread. Markdown is
                supported. The note does not send a message or change the conversation.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={id}>
                  <T>Note</T>
                </Label>
                <Textarea
                  id={id}
                  value={text}
                  maxLength={4000}
                  rows={7}
                  disabled={!canUpdate || saving}
                  onChange={(event) => setText(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {text.length.toLocaleString()} / 4,000 characters
                </p>
              </div>
              <RadioGroup
                aria-label={gt("Opening context")}
                value={mode}
                disabled={!canUpdate || saving}
                onValueChange={(value) => {
                  if (value === "prepend" || value === "replace") setMode(value);
                }}
              >
                <Label>
                  <Radio value="prepend" />
                  <T>Before the starting messages</T>
                </Label>
                <Label>
                  <Radio value="replace" />
                  <T>Instead of the starting messages</T>
                </Label>
              </RadioGroup>
              {note && (
                <p className="text-xs text-muted-foreground">
                  {gt("Last edited by {author} · {timestamp}", {
                    author: note.author.kind === "agent" ? gt("an agent") : gt("a user"),
                    timestamp: new Date(note.updatedAt).toLocaleString(),
                  })}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {note && (
              <Button
                type="button"
                variant="destructive-outline"
                disabled={!canUpdate || saving}
                onClick={() => void save(true)}
              >
                <T>Remove note</T>
              </Button>
            )}
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={!canUpdate || saving || !text.trim()}>
              {saving ? gt("Saving…") : gt("Save note")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
