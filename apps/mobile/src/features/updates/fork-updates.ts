import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { msg } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { selectForkUpdate } from "./fork-updates.logic";

interface ForkUpdateModule {
  pending(publicKey: string): Promise<{ version: string; attempted: boolean } | null>;
  download(manifestUrl: string, signatureUrl: string, publicKey: string): Promise<string | null>;
  install(
    publicKey: string,
    requestPermission: boolean,
  ): Promise<"permission" | "requested" | "denied">;
}
export const isAndroidFork =
  Platform.OS === "android" && Constants.expoConfig?.extra?.androidFork === true;
const native = isAndroidFork
  ? requireOptionalNativeModule<ForkUpdateModule>("T3ForkUpdates")
  : null;
const publicKey = Constants.expoConfig?.extra?.androidForkUpdatePublicKey ?? "";
interface ForkUpdateState {
  /** Marked message resolved by Settings so an open status follows language changes. */
  readonly status: string;
  readonly busy: boolean;
  readonly ready: boolean;
  readonly lastCheck: string | null;
}
let state: ForkUpdateState = {
  status:
    isAndroidFork && !native
      ? msg("Updates unavailable: Android updater module is missing")
      : msg("Not checked"),
  busy: false,
  ready: false,
  lastCheck: null,
};
const listeners = new Set<() => void>();
let permissionPending = false;
let checkedAt = 0;
const RECHECK_MS = 4 * 60 * 60 * 1000;
function update(patch: Partial<ForkUpdateState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useForkUpdateState() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
function fail(error: unknown) {
  update({
    status: msg("Update failed: {detail}", {
      detail: error instanceof Error ? error.message : String(error),
    }),
  });
}
export async function checkForkUpdate(): Promise<void> {
  if (!native || state.busy) return;
  update({ busy: true, status: msg("Checking for fork updates…") });
  checkedAt = Date.now();
  try {
    const response = await fetch(
      "https://api.github.com/repos/Alb11747/t3code/releases?per_page=100",
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Release check HTTP ${response.status}`);
    const { manifestUrl, signatureUrl } = selectForkUpdate(await response.json());
    update({ status: msg("Downloading and verifying update…") });
    const version = await native.download(manifestUrl, signatureUrl, publicKey);
    update({
      ready: version !== null,
      status: version
        ? msg("Ready: {version}. Installs on next launch, or choose Install now.", { version })
        : msg("Up to date"),
      lastCheck: new Date().toLocaleString(),
    });
  } catch (error) {
    fail(error);
  } finally {
    update({ busy: false });
  }
}
export async function installForkUpdate(requestPermission = true): Promise<void> {
  if (!native || state.busy || !state.ready) return;
  update({ busy: true });
  try {
    const [drafts, outbox] = await Promise.all([
      import("../../state/use-composer-drafts"),
      import("../../state/thread-outbox"),
    ]);
    await Promise.all([drafts.flushComposerDrafts(), outbox.flushThreadOutbox()]);
    const result = await native.install(publicKey, requestPermission);
    permissionPending = result === "permission";
    update({
      status: permissionPending
        ? msg("Allow updates from T3 Code Fork, then return to finish installing.")
        : result === "denied"
          ? msg("Update permission was not granted. Choose Install now to try again.")
          : msg("Installer opened. Confirm the update in Android."),
    });
  } catch (error) {
    permissionPending = false;
    fail(error);
  } finally {
    update({ busy: false });
  }
}
export function installForkUpdateChecks(): () => void {
  if (!native) return () => undefined;
  let disposed = false;
  const start = async () => {
    update({ busy: true });
    try {
      const pending = await native.pending(publicKey);
      if (disposed) return;
      update({
        busy: false,
        ready: pending !== null,
        status: pending
          ? msg("Ready: {version}", { version: pending.version })
          : msg("Not checked"),
      });
      if (pending && !pending.attempted) await installForkUpdate();
      else await checkForkUpdate();
    } catch (error) {
      fail(error);
      update({ busy: false, ready: false });
      if (!disposed) await checkForkUpdate();
    } finally {
      update({ busy: false });
    }
  };
  void start();
  const subscription = AppState.addEventListener("change", (next) => {
    if (next !== "active" || state.busy) return;
    if (permissionPending) {
      permissionPending = false;
      void installForkUpdate(false);
    } else if (!state.ready && Date.now() - checkedAt >= RECHECK_MS) void checkForkUpdate();
  });
  return () => {
    disposed = true;
    subscription.remove();
  };
}
