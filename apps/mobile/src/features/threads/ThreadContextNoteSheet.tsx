import { T, useGT } from "gt-react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ThreadContextNoteInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadContextNoteSheet(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const note = props.thread.contextNote;
  const [text, setText] = useState(note?.text ?? "");
  const [mode, setMode] = useState<ThreadContextNoteInput["mode"]>(note?.mode ?? "prepend");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const close = () => {
    if (!saving) props.onClose();
  };
  const save = async (value: ThreadContextNoteInput | null) => {
    if (!readEnvironmentScope(props.thread.environmentId, AuthOrchestrationOperateScope)) {
      setError(gt("This connection cannot change threads."));
      return;
    }
    setSaving(true);
    setError(null);
    const result = await updateMetadata({
      environmentId: props.thread.environmentId,
      input: {
        threadId: props.thread.id,
        contextNote: value === null ? null : { ...value, author: { kind: "user" } },
      },
    });
    setSaving(false);
    if (result._tag === "Success") props.onClose();
    else {
      const failure = Cause.squash(result.cause);
      setError(
        failure instanceof Error ? failure.message : gt("The context note could not be saved."),
      );
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-6"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="max-h-[85%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 24, paddingBottom: 24, gap: 20 }}
        >
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            <T>Context note</T>
          </AppText>
          <AppText className="text-base text-foreground-secondary">
            <T>
              Give agents current context when they read or attach this thread. The note stays
              outside its conversation history.
            </T>
          </AppText>
          <View className="gap-2">
            <AppText>
              <T>Note (Markdown)</T>
            </AppText>
            <TextInput
              accessibilityLabel={gt("Context note (Markdown)")}
              className="min-h-40 rounded-xl bg-subtle p-3 text-base text-foreground"
              multiline
              textAlignVertical="top"
              maxLength={4000}
              editable={!saving}
              value={text}
              onChangeText={setText}
            />
            <AppText className="text-sm text-foreground-secondary">{text.length}/4,000</AppText>
          </View>
          <View className="gap-2">
            <AppText>
              <T>Starting messages</T>
            </AppText>
            <SegmentedControl
              options={
                [
                  { value: "prepend", label: gt("Show after note") },
                  { value: "replace", label: gt("Replace with note") },
                ] as const
              }
              selected={mode}
              onSelect={setMode}
            />
            <AppText className="text-sm text-foreground-secondary">
              <T>Original messages remain available in history.</T>
            </AppText>
          </View>
          {note && (
            <AppText className="text-sm text-foreground-secondary">
              {gt("{kind, select, agent {Edited by agent} other {Edited by user}}", {
                kind: note.author.kind,
              })}
              {note.author.threadId ? ` (${note.author.threadId})` : ""} ·{" "}
              {new Date(note.updatedAt).toLocaleString()}
            </AppText>
          )}
          {error && (
            <AppText accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </AppText>
          )}
          <View className="gap-3">
            <View className="flex-row justify-end gap-3">
              <Button label={gt("Cancel")} tone="text" disabled={saving} onPress={close} />
              <Button
                label={gt("Save")}
                loading={saving}
                disabled={!text.trim()}
                onPress={() => void save({ text, mode })}
              />
            </View>
            {note && (
              <Button
                label={gt("Remove note")}
                tone="danger"
                disabled={saving}
                onPress={() => void save(null)}
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
