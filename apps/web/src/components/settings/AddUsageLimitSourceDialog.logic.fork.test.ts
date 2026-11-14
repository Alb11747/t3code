import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { sourceIdFromUrl, withSavedSteers } from "./AddUsageLimitSourceDialog.logic";

describe("re-adding a usage limit source", () => {
  it("keeps the quota-router steers saved for that hub", () => {
    const url = "http://proxy.test:8318";
    const steers = { claude: "account-1111111111111111" } as const;
    const id = sourceIdFromUrl(url, {});
    let settings: ServerSettings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usageLimitSources: {
        [id]: { kind: "cliproxy", url, managementKey: "old-key", enabled: true, steers },
      },
    });
    const savedId = sourceIdFromUrl(url, settings.usageLimitSources);
    settings = applyServerSettingsPatch(settings, {
      usageLimitSources: {
        [savedId]: withSavedSteers(
          { kind: "cliproxy", url, label: "Hub", managementKey: "new-key", enabled: true },
          settings.usageLimitSources[savedId],
        ),
      },
    });
    expect(settings.usageLimitSources[id]).toEqual({
      kind: "cliproxy",
      url,
      label: "Hub",
      managementKey: "new-key",
      enabled: true,
      steers,
    });
  });
});
