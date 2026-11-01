import "~/index.css";
import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  commandSucceeds: false,
  threadTitles: {} as Record<string, string>,
  titleLookup: { isSuccess: true, isPending: false },
  archivedThreads: [] as unknown[],
  relationshipShells: [] as unknown[],
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: state.threadTitles, ...state.titleLookup })) as never,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => false) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null
      ? []
      : [(state.projection as { thread: unknown }).thread, ...state.relationshipShells]) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({
    snapshots: [{ environmentId: "environment", snapshot: { threads: state.archivedThreads } }],
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () =>
    state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")))) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import { ScrollArea } from "../ui/scroll-area";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.commandSucceeds = false;
  state.threadTitles = { source: "Source" };
  state.titleLookup = { isSuccess: true, isPending: false };
  state.archivedThreads = [];
  state.relationshipShells = [];
  state.projection = {
    thread: {
      id: threadId,
      title: "Fork",
      activeProviderThreadId: null,
      lineage: { parentThreadId: ThreadId.make("source"), relationshipToParent: "fork" },
      forkedFrom: null,
    },
    runs: [{ id: "run", ordinal: 1, status: "completed" }],
    subagents: [],
    contextTransfers: [],
    providerThreads: [],
    providerSessions: [{ id: "session", status: "ready" }],
  };
}

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("reports a rejected %s command and clears the busy state", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
  );

  if (action === "merge") {
    await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
  } else {
    await screen.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
  }

  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  await expect
    .element(
      screen.getByRole("button", {
        name: action === "merge" ? "Merge back to source conversation" : "More thread actions",
      }),
    )
    .toBeEnabled();
});

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("clears the previous %s error after a successful retry", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
    { router: "/environment/fork" },
  );

  const runAction = async () => {
    if (action === "merge") {
      await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
    } else {
      await screen.getByRole("button", { name: "More thread actions" }).click();
      await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
    }
  };

  await runAction();
  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");

  state.commandSucceeds = true;
  await runAction();

  await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe(
      action === "merge" ? "/environment/source" : "/environment/fork",
    );
  });
  if (action === "disconnect") {
    await expect.element(screen.getByRole("button", { name: "More thread actions" })).toBeEnabled();
  }
});

it.each([
  {
    name: "an omitted existing fork",
    exists: true,
    success: true,
    pending: false,
    archived: false,
    visible: true,
  },
  {
    name: "a deleted fork",
    exists: false,
    success: true,
    pending: false,
    archived: false,
    visible: false,
  },
  {
    name: "a deleted fork in a stale archived snapshot",
    exists: false,
    success: true,
    pending: false,
    archived: true,
    visible: false,
  },
  {
    name: "an unresolved fork",
    exists: false,
    success: true,
    pending: true,
    archived: false,
    visible: true,
  },
  {
    name: "a fork after lookup failure",
    exists: false,
    success: false,
    pending: false,
    archived: false,
    visible: true,
  },
])(
  "keeps or hides $name after checking its existence",
  async ({ exists, success, pending, archived, visible }) => {
    setup();
    const projection = makeThreadProjectionFixture();
    const deletedId = ThreadId.make("510e410f-6819-4f10-8d72-c62ebf6bafe2");
    const title = "Design Agent Game Automation Architecture fork";
    state.threadTitles = exists ? { [deletedId]: title } : {};
    state.titleLookup = { isSuccess: success, isPending: pending };
    if (archived)
      state.archivedThreads = [
        {
          ...projection.thread,
          id: deletedId,
          title,
          archivedAt: projection.thread.updatedAt,
          lineage: { parentThreadId: projection.thread.id, relationshipToParent: "fork" },
        },
      ];
    state.projection = {
      ...projection,
      contextTransfers: [
        {
          sourceThreadId: projection.thread.id,
          targetThreadId: deletedId,
          status: "pending",
        },
      ],
    };
    await using screen = await render(
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={projection.thread.id}
        showLineage
        showSideChats
      />,
    );
    if (visible) {
      await expect
        .element(screen.getByText(exists || archived ? title : deletedId, { exact: true }))
        .toBeVisible();
    } else {
      await expect.element(screen.getByRole("region", { name: "Lineage" })).not.toBeInTheDocument();
    }
  },
);

it.each([1, 18])("continues scrolling the panel past a list of %i subagents", async (count) => {
  setup();
  const projection = makeThreadProjectionFixture();
  state.projection = projection;
  state.relationshipShells = Array.from({ length: count }, (_, index) => ({
    id: ThreadId.make(`subagent-${index}`),
    title: `Subagent ${index}`,
    forkedFrom: null,
    lineage: { parentThreadId: projection.thread.id, relationshipToParent: "subagent" },
    activityRunStatus: "running",
    status: "running",
  }));
  await using screen = await render(
    <div data-testid="panel" style={{ height: 320, width: 280 }}>
      <ScrollArea>
        <ThreadRelationshipsPanel
          environmentId={environmentId}
          threadId={projection.thread.id}
          showLineage
          showSideChats
        />
        <div style={{ height: 600 }} />
      </ScrollArea>
    </div>,
  );
  if (count > 6) {
    await screen.getByRole("button", { name: "Show 12 more" }).click();
    await expect.element(screen.getByText("Subagent 17", { exact: true })).toBeInTheDocument();
  }
  const list = screen.getByRole("list", { name: "Related threads" }).element();
  const viewport = screen
    .getByTestId("panel")
    .element()
    .querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
  list.scrollTop = list.scrollHeight;
  if (count > 6) expect(list.scrollTop).toBeGreaterThan(0);
  viewport.scrollTop = 0;
  await userEvent.wheel(list, { delta: { y: 300 } });
  await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
});

it("opens an idle child from Lineage when its shell has not been loaded", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("omitted-child");
  const environmentId = EnvironmentId.make("local");
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Inspect the change",
        title: "Idle child",
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: projection.thread.updatedAt,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const child = screen.getByRole("button", { name: /Idle child/ });
  await expect.element(child).toBeEnabled();
  await child.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/local/omitted-child"),
  );
});
