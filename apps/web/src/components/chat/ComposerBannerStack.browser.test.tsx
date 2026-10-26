import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { InfoIcon } from "lucide-react";

import "../../index.css";

import { render } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

it("only offers notice details when the description cannot fit", async () => {
  const container = document.createElement("div");
  container.style.width = "700px";
  const banner = (description: string) => (
    <ComposerBannerStack
      items={[{ id: "usage", variant: "info", icon: null, title: "Usage limits", description }]}
    />
  );
  await using screen = await render(banner("OpenCode"), { container });
  const hasDetails = () => container.querySelector('[aria-label="Show notice details"]') !== null;
  await vi.waitFor(() => expect(hasDetails()).toBe(false));

  await screen.rerender(banner("OpenCode ".repeat(40)));
  await vi.waitFor(() => expect(hasDetails()).toBe(true));

  container.style.width = "4000px";
  await vi.waitFor(() => expect(hasDetails()).toBe(false));

  await screen.rerender(banner("OpenCode"));
  await vi.waitFor(() => expect(hasDetails()).toBe(false));

  // A narrow composer hides the description entirely, so details are the only way to read it.
  container.style.width = "300px";
  await vi.waitFor(() => expect(hasDetails()).toBe(true));
});

it("keeps only the usage limit attached while an active goal waits in the collapsible stack", async () => {
  // A pointer left at the top of the page can expand the stack as soon as it mounts.
  await userEvent.hover(document.body, { position: { x: 0, y: window.innerHeight - 1 } });
  await using screen = await render(
    <ComposerBannerStack
      items={[
        {
          id: "goal",
          variant: "default",
          priority: "activity",
          icon: null,
          title: "Goal active",
          description: "Finish the banner fix",
        },
        {
          id: "limit",
          variant: "default",
          priority: "urgent",
          icon: null,
          title: "Usage limit reached",
        },
      ]}
    />,
  );

  const container = screen.container;
  const visibleBanners = () =>
    Array.from(container.querySelectorAll('[data-slot="composer-banner"]')).filter((banner) =>
      banner.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    );
  const limit = page.getByText("Usage limit reached", { exact: true });
  const goal = page.getByText("Goal active", { exact: true });

  expect(visibleBanners()).toHaveLength(1);
  await expect.element(limit).toBeVisible();
  await expect.element(goal).not.toBeVisible();
  expect(container.querySelector('[data-slot="composer-banner-attachment"]')?.textContent).toBe(
    "Usage limit reached",
  );

  const peek = page.getByRole("button", { name: "Show other notices" });
  // Pointer entry opens the stack before a click can hit its disappearing peek.
  // Keyboard activation exercises the click handler without that hover transition.
  await userEvent.tab();
  await expect.element(peek).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(goal).toBeVisible();
  await expect.element(limit).toBeVisible();
  await expect.poll(visibleBanners).toHaveLength(2);

  await userEvent.keyboard("{Escape}");
  await expect.element(goal).not.toBeVisible();
  await expect.element(limit).toBeVisible();
  expect(visibleBanners()).toHaveLength(1);

  await expect.element(peek).toHaveFocus();
  // Pointer entry hides the peek, but the stack remains mounted during expansion.
  await userEvent.hover(container.querySelector<HTMLElement>("[data-composer-banner-stack]")!);
  await expect.element(goal).toBeVisible();
  await expect.element(limit).toBeVisible();
  await expect.poll(visibleBanners).toHaveLength(2);

  await userEvent.keyboard("{Escape}");
  await expect.element(goal).not.toBeVisible();
  await expect.element(limit).toBeVisible();
  expect(visibleBanners()).toHaveLength(1);
});

it("reveals the full running command only while its title is clipped", async () => {
  const command =
    "Running: /usr/bin/zsh -lc 'sleep 600 > /tmp/t3-background-command-with-a-long-log-filename-for-truncation.log 2>&1'";
  const container = document.createElement("div");
  container.style.width = "240px";
  await using _screen = await render(
    <ComposerBannerStack
      items={[
        {
          id: "background-work",
          variant: "default",
          priority: "activity",
          icon: null,
          title: command,
        },
      ]}
    />,
    { container },
  );

  const details = page.getByRole("button", { name: "Show title details", exact: true });
  await expect.element(details).toBeVisible();
  await userEvent.hover(details);
  const popup = page.getByRole("dialog", { name: "Notice details", exact: true });
  await expect.element(popup).toBeVisible();
  await expect.element(popup).toHaveTextContent(command);

  container.style.width = "4000px";
  await expect.element(details).not.toBeInTheDocument();
  await expect.element(popup).not.toBeInTheDocument();
});

it("commits a dismissal when the thread switches during the exit transition", async () => {
  const onDismiss = vi.fn();
  const item: ComposerBannerStackItem = {
    id: "notice",
    variant: "info",
    icon: <InfoIcon />,
    title: "Thread A notice",
    dismissLabel: "Dismiss notice",
    onDismiss,
  };
  await using screen = await render(<ComposerBannerStack key="thread-a" items={[item]} />);

  await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  // The composer keys the stack by thread, so switching threads remounts it mid-exit.
  await screen.rerender(<ComposerBannerStack key="thread-b" items={[]} />);

  await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
});
