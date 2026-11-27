import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => refresh }));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      refreshHttpQuota: { permissionAtom: () => Atom.make(true) },
    },
  };
});

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled next refill", () => {
  it("skips elapsed resets while waiting for refreshed account data", async () => {
    function account(instanceId: string, usedPercent: number, resetsAt: string): ServerProvider {
      return {
        ...managedChatGpt(instanceId, instanceId),
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt }],
        },
      };
    }
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              account("Work", 20, "2026-10-25T17:00:00.000Z"),
              account("Personal", 60, "2026-10-25T18:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T17:30:00Z")} />,
    );
    await expect.element(screen.getByText("↻ +30%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("↻ +30% in 30m")).toBeVisible();

    await screen.rerender(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T18:00:00Z")} />,
    );
    await expect.element(screen.getByText(/^↻ \+\d+%$/)).not.toBeInTheDocument();
  });
});

it("requests a manual quota refresh and shows the cooldown returned by the router", async () => {
  refresh
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ outcome: "rate-limited", retryAt: "2099-01-01T00:00:00.000Z" }),
    );
  const environmentId = EnvironmentId.make("desk");
  const sourceId = UsageLimitSourceId.make("quota");
  const source: UsageLimitSourceSnapshot = {
    id: sourceId,
    kind: "http",
    label: "Antigravity",
    checkedAt,
    accounts: [],
    quotaAccounts: [
      { id: "agy-owner", label: "Antigravity owner", refreshable: true, windows: [] },
    ],
  };
  const presentations = new Map([
    [
      environmentId,
      {
        entry: { target: { label: "Desk" } },
        serverConfig: { providers: [], usageLimitSources: [source] },
      },
    ],
  ]);
  await using screen = await render(
    <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
  );
  const button = screen.getByRole("button", { name: "Refresh" });
  await button.click();
  expect(refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { sourceId, accountId: "agy-owner" },
  });
  await expect.element(button).toBeDisabled();
  await expect.element(screen.getByText(/^Refresh available in /)).toBeVisible();
});
