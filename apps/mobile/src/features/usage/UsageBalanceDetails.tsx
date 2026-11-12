import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { usageBalanceDetails } from "@t3tools/shared/usageLimits";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function UsageBalanceDetails({ limits }: { readonly limits: ServerProviderUsageLimits }) {
  return usageBalanceDetails(limits).map(({ label, value }) => (
    <View key={label} className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <Text className="text-xs tabular-nums text-foreground">{value}</Text>
    </View>
  ));
}
