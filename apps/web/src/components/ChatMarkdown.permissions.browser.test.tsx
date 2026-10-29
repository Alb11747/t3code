import ChatMarkdown from "./ChatMarkdown";
import { type AuthEnvironmentScope } from "@t3tools/contracts";

import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EditorId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";
import { useRightPanelStore } from "../rightPanelStore";

const state = vi.hoisted(() => ({
  allowed: true,
  canReadFiles: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  pullRequests: [] as ThreadPullRequestLink[],
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.search) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.linkPullRequest
        ? state.link
        : command === threadEnvironment.unlinkPullRequest
          ? state.unlink
          : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed) &&
    (scope !== AuthFilesystemReadScope || state.canReadFiles);
  return {
    ...(await original()),
    readEnvironmentScope,
    readPreparedConnection: () => ({
      environmentId: threadRef.environmentId,
      label: "Test environment",
      httpBaseUrl: "http://host",
      socketUrl: "ws://host",
      httpAuthorization: null,
      target: new PrimaryConnectionTarget({
        environmentId: threadRef.environmentId,
        label: "Test environment",
        httpBaseUrl: "http://host",
        wsBaseUrl: "ws://host",
      }),
    }),
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ pullRequests: state.pullRequests })) as never,
  useProjects: (() => [{ id: projectId, environmentId: threadRef.environmentId }]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("@t3tools/client-runtime/change-request-links"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const projectId = ProjectId.make("project");
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
  source: "manual",
  linkedAt: "2026-09-08T00:00:00.000Z",
  snapshot: null,
  stack: null,
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: {} },
};

function setup() {
  using stack = new DisposableStack();
  state.allowed = true;
  state.canReadFiles = true;
  state.listeners.clear();
  state.pullRequests = [];
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.link.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.unlink.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  stack.use(vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy));
  stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      await state.copy(await (await item.getType("text/plain")).text());
    }),
  );
  return stack.move();
}

async function renderMarkdown(text: string) {
  const screen = await render(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
  const anchor = () => screen.container.querySelector("a")!;
  return Object.assign(screen, {
    anchor,
    openContextMenu: () =>
      act(async () => {
        anchor().dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      }),
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  using _setup = setup();
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full", "download"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full", "download"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => screen.anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("offers file downloads only while the connection can read host files", async () => {
  using _setup = setup();
  state.canReadFiles = false;
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).not.toContain("download");
});

it("downloads the workspace file a bare filename link resolves to", async () => {
  using _setup = setup();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  // The mocked query runner serves both the workspace lookup and the asset URL.
  state.search
    .mockResolvedValueOnce(
      AsyncResult.success({ entries: [{ path: "docs/nested/report.pdf", kind: "file" }] }),
    )
    .mockResolvedValueOnce(AsyncResult.success({ relativeUrl: "/api/assets/report" }));
  state.choose.mockResolvedValue("download");
  await using screen = await renderMarkdown("[Report](report.pdf)");
  await screen.openContextMenu();
  await vi.waitFor(() =>
    expect(state.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          resource: expect.objectContaining({
            path: "/work/docs/nested/report.pdf",
            disposition: "attachment",
          }),
        },
      }),
    ),
  );
});

it("sends a minted file URL to the desktop download command without navigating", async () => {
  using _setup = setup();
  const downloadFile = vi.fn().mockResolvedValue(true);
  using _bridge = stubGlobal("desktopBridge", { downloadFile });
  state.search
    .mockResolvedValueOnce(
      AsyncResult.success({ entries: [{ path: "docs/nested/report.pdf", kind: "file" }] }),
    )
    .mockResolvedValueOnce(AsyncResult.success({ relativeUrl: "/api/assets/report" }));
  state.choose.mockResolvedValue("download");
  await using screen = await renderMarkdown("[Report](report.pdf)");
  using anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await screen.openContextMenu();
  await vi.waitFor(() =>
    expect(downloadFile).toHaveBeenCalledWith("http://host/api/assets/report"),
  );
  expect(anchorClick).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  using _setup = setup();
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  using _setup = setup();
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await using screen = await renderMarkdown("[Readme](readme.md)");
  await screen.openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    using _setup = setup();
    state.pullRequests = action === "unlink-from-thread" ? [linkedPullRequest] : [];
    const command = action === "link-to-thread" ? state.link : state.unlink;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await using screen = await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await screen.openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(command).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await screen.openContextMenu();
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          repository: "example/repo",
          number: 42,
        }),
      }),
    );
  },
);
