import { useGT, useMessages } from "gt-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatDateTimeTimestamp, formatRelativeTimeLabel } from "../../timestampFormat";

/** Fork: an HTTP quota source can serve a reading taken hours ago, so show when it was read. */
export function QuotaReadAt({ readAt, now }: { readonly readAt: string; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  if (!Number.isFinite(Date.parse(readAt))) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {gt("Read {age} · {time}", {
        age: formatRelativeTimeLabel(readAt, now, m),
        time: formatDateTimeTimestamp(readAt, timestampFormat),
      })}
    </span>
  );
}
