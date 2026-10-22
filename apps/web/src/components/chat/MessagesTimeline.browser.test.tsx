import { type OrchestrationV2Subagent } from "@t3tools/contracts";

import { type ReactElement } from "react";

import { NodeId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { useState } from "react";

import { userEvent } from "vite-plus/test/browser";

import { environmentThreadDetails } from "../../state/threads";

import { readTimelinePosition } from "./timelineScrollAnchoring";

import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline work rows", () => {
  it.each(["delegated", "legacy", "missing"] as const)(
    "uses the reported task for %s completion notifications",
    async (source) => {
      const now = DateTime.makeUnsafe(CREATED_AT);
      const childThreadId = ThreadId.make("shared-child");
      const task = (
        id: string,
        status: OrchestrationV2Subagent["status"],
        result: string,
      ): OrchestrationV2Subagent => ({
        id: NodeId.make(id),
        threadId: ThreadId.make("thread-1"),
        runId: null,
        parentNodeId: NodeId.make("parent-root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Simplify delivery",
        title: "Simplify delivery",
        model: null,
        status,
        result,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const tasks = [
        task("original", "interrupted", "Old interrupted progress"),
        task("continued", "completed", "Final implementation report"),
        task("follow-up", "completed", "Follow-up explanation"),
      ];
      vi.spyOn(environmentThreadDetails, "threadAtom").mockReturnValue(
        Atom.make({
          projection: { subagents: tasks, turnItems: [], visibleTurnItems: [] },
        }) as never,
      );
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        (source === "delegated" ? ["continued", "follow-up"] : [source]).map((id) =>
          work(`notification-${id}`, {
            label: "Notification fallback",
            tone: "info",
            itemType: "notification",
            projectedItem: v2Item("notification", {
              id: `notification-${id}`,
              source:
                source === "legacy"
                  ? { kind: "subagent", childThreadId }
                  : { kind: "delegated_task", childThreadId, taskIds: [NodeId.make(id)] },
              outcome: "completed",
              summary: "Notification fallback",
            }),
          }),
        ),
        { onOpenThread },
      );
      if (source === "delegated") {
        expect(screen.text()).toContain("Final implementation report");
        expect(screen.text()).toContain("Follow-up explanation");
        expect(screen.text()).not.toContain("Old interrupted progress");
        await click(screen.buttons("Open Simplify delivery")[0]!);
        expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
      } else if (source === "legacy") {
        expect(screen.text()).toContain("Old interrupted progress");
      } else {
        expect(screen.text()).toContain("Notification fallback");
        expect(screen.text()).not.toContain("Old interrupted progress");
      }
    },
  );
});

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

describe("MessagesTimeline scroll position", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it("restores a manual reading position after reopening and switching threads", async () => {
    const props = baseProps();
    const onIsAtEndChange = vi.fn();
    function Chat({ routeThreadKey = props.routeThreadKey }: { routeThreadKey?: string }) {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      // The chat view stops following the live edge when the reader scrolls.
      return (
        <div className="contents" onWheelCapture={() => setLiveFollowEnabled(false)}>
          <MessagesTimeline
            {...props}
            routeThreadKey={routeThreadKey}
            timelineEntries={tallEntries}
            liveFollowEnabled={liveFollowEnabled}
            onManualNavigation={() => setLiveFollowEnabled(false)}
            onIsAtEndChange={onIsAtEndChange}
          />
        </div>
      );
    }
    await using initial = await renderElement(<Chat />);
    const viewport = await waitForList(props);
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

    await userEvent.wheel(viewport, { delta: { y: -600 } });
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
    const offset = viewport.scrollTop;
    await initial.unmount();
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });

    const timeline = (routeThreadKey: string) => <Chat routeThreadKey={routeThreadKey} />;
    onIsAtEndChange.mockClear();
    await using reopened = await renderElement(timeline(props.routeThreadKey));
    const reopenedViewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
    // Restoration disables live follow before normal scroll handling resumes.
    await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenCalledWith(false));
    expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false);

    await reopened.rerender(timeline(`${props.routeThreadKey}-other`));
    await vi.waitFor(() =>
      expect(
        reopenedViewport.scrollHeight - reopenedViewport.clientHeight - reopenedViewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    await reopened.rerender(timeline(props.routeThreadKey));
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});
