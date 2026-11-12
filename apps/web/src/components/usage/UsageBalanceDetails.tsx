import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { usageBalanceDetails } from "@t3tools/shared/usageLimits";

export function UsageBalanceDetails({ limits }: { readonly limits: ServerProviderUsageLimits }) {
  const details = usageBalanceDetails(limits);
  if (details.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1 text-xs">
      {details.map(({ label, value }) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 wrap-anywhere text-foreground tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
