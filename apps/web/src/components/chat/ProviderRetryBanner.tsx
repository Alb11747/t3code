import {
  type ActiveProviderRetry,
  providerRetryNotice,
} from "@t3tools/client-runtime/state/providerRetry";
import type { ThreadId } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { RefreshCwIcon } from "lucide-react";

import { formatUpcomingTimestamp } from "../../timestampFormat";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Fork: the run is held open while T3 retries a failed provider request. */
export function providerRetryBannerItem(props: {
  threadId: ThreadId;
  retry: ActiveProviderRetry;
  timestampFormat: TimestampFormat;
}): ComposerBannerStackItem {
  const notice = providerRetryNotice(props.retry, (iso) =>
    formatUpcomingTimestamp(iso, props.timestampFormat),
  );
  return {
    id: `provider-retry:${props.threadId}`,
    variant: "warning",
    icon: <RefreshCwIcon />,
    title: notice.title,
    description: notice.description,
  };
}
