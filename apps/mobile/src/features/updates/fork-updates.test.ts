import { mFallback } from "gt-react-native";
import { describe, expect, it, vi } from "vite-plus/test";

interface Snapshot {
  readonly status: string;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly lastCheck: string | null;
}

const mocks = vi.hoisted(() => ({
  pending: vi.fn<() => Promise<{ version: string; attempted: boolean } | null>>(),
  download: vi.fn<() => Promise<string | null>>(),
  install: vi.fn<(key: string, requestPermission: boolean) => Promise<string>>(),
  appState: undefined as ((state: string) => void) | undefined,
  subscribe: undefined as ((listener: () => void) => () => void) | undefined,
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { androidFork: true, androidForkUpdatePublicKey: "test-key" } } },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, read: () => Snapshot) => {
    mocks.subscribe = subscribe;
    return read();
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appState = listener;
      return { remove: vi.fn() };
    },
  },
}));
vi.mock("../../state/use-composer-drafts", () => ({ flushComposerDrafts: async () => {} }));
vi.mock("../../state/thread-outbox", () => ({ flushThreadOutbox: async () => {} }));

async function setup() {
  vi.resetModules();
  mocks.pending.mockReset().mockResolvedValue(null);
  mocks.download.mockReset().mockResolvedValue("fork-2");
  mocks.install.mockReset().mockResolvedValue("requested");
  mocks.appState = undefined;
  mocks.subscribe = undefined;
  const service = await import("./fork-updates");
  service.useForkUpdateState();
  const until = (predicate: (state: Snapshot) => boolean) =>
    new Promise<Snapshot>((resolve) => {
      const inspect = () => {
        const state = service.useForkUpdateState();
        if (predicate(state)) {
          unsubscribe();
          resolve(state);
        }
      };
      const unsubscribe = mocks.subscribe!(inspect);
      inspect();
    });
  return { service, until };
}

function releases() {
  const tag = "android-fork-202611151234-abcdef";
  return new Response(
    JSON.stringify([
      {
        draft: false,
        tag_name: tag,
        assets: ["update.json", "update.json.sig"].map((name) => ({
          name,
          browser_download_url: `https://github.com/Alb11747/t3code/releases/download/${tag}/${name}`,
        })),
      },
    ]),
  );
}

describe("Android fork update lifecycle", () => {
  it("replaces corrupt pending data with a verified remote download", async () => {
    const { service, until } = await setup();
    mocks.pending.mockRejectedValue(new Error("Saved APK changed"));
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => releases());
    const completed = until((state) => state.ready && !state.busy);
    const dispose = service.installForkUpdateChecks();
    try {
      expect(mFallback((await completed).status)).toContain("Ready: fork-2");
      expect(mocks.install).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("returns from denied permission once and keeps manual install available", async () => {
    const { service, until } = await setup();
    mocks.pending.mockResolvedValue({ version: "fork-2", attempted: false });
    mocks.install.mockResolvedValueOnce("permission").mockResolvedValueOnce("denied");
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => releases());
    const permission = until(
      (state) => !state.busy && mFallback(state.status).startsWith("Allow updates"),
    );
    const dispose = service.installForkUpdateChecks();
    try {
      await permission;
      const denied = until(
        (state) => !state.busy && mFallback(state.status).includes("permission was not granted"),
      );
      mocks.appState?.("active");
      expect((await denied).ready).toBe(true);
      mocks.appState?.("active");
      expect(mocks.install.mock.calls.map((call) => call[1])).toEqual([true, false]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.useForkUpdateState().busy).toBe(false);
    } finally {
      dispose();
    }
  });

  it("checks for newer releases after a cancelled installation without prompting again", async () => {
    const { service, until } = await setup();
    mocks.pending.mockResolvedValue({ version: "fork-1", attempted: true });
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => releases());
    const completed = until((state) => state.lastCheck !== null && !state.busy);
    const dispose = service.installForkUpdateChecks();
    try {
      expect(mFallback((await completed).status)).toContain("Ready: fork-2");
      expect(mocks.install).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("keeps a single download active when checks overlap", async () => {
    const { service } = await setup();
    const download = Promise.withResolvers<string | null>();
    const started = Promise.withResolvers<void>();
    mocks.download.mockImplementation(() => {
      started.resolve();
      return download.promise;
    });
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => releases());
    const first = service.checkForkUpdate();
    await started.promise;
    await service.checkForkUpdate();
    expect(service.useForkUpdateState()).toMatchObject({ busy: true, ready: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    download.resolve("fork-2");
    await first;
    expect(service.useForkUpdateState()).toMatchObject({ busy: false, ready: true });
  });
});
