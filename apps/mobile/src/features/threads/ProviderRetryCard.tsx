import {
  activeProviderRetry,
  providerRetryNotice,
} from "@t3tools/client-runtime/state/providerRetry";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

const formatTime = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso)).toLocaleString();

/** Fork: the run is held open while T3 retries a failed provider request. */
export function ProviderRetryCard({
  thread,
  threadRef,
}: {
  thread: EnvironmentThreadShell;
  threadRef: ScopedThreadRef | null;
}) {
  const structure = useQuietThreadStructure(threadRef);
  const retry = activeProviderRetry(
    structure?.projection.turnItems ?? [],
    thread.runtime?.activeRunId ?? null,
  );
  if (retry === null) return null;
  const notice = providerRetryNotice(retry, formatTime);
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm font-medium text-warning-foreground">{notice.title}</Text>
      <Text className="text-sm text-warning-foreground">{notice.description}</Text>
    </View>
  );
}
