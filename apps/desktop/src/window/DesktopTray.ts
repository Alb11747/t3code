import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

/** Windows close-to-tray: the tray icon exists exactly while closing hides the main window. */
export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let tray: Electron.Tray | undefined;

  const destroyTray = () => {
    tray?.destroy();
    tray = undefined;
  };
  yield* Effect.addFinalizer(() => Effect.sync(destroyTray));

  const showMainWindow = () => {
    void runPromise(
      desktopWindow.activate.pipe(
        Effect.catch((error) =>
          logTrayWarning("failed to show main window from tray", { message: error.message }),
        ),
      ),
    );
  };

  const createTray = Effect.gen(function* () {
    const icon = (yield* assets.iconPaths).ico;
    if (Option.isNone(icon)) {
      // Hiding without an icon would leave no way back to the window.
      yield* logTrayWarning("tray icon not found; close to tray stays off");
      return false;
    }
    tray = new Electron.Tray(icon.value);
    tray.setToolTip(environment.displayName);
    tray.setContextMenu(
      Electron.Menu.buildFromTemplate([
        { label: `Open ${environment.displayName}`, click: showMainWindow },
        { type: "separator" },
        {
          label: `Quit ${environment.displayName}`,
          click: () => void runPromise(electronApp.quit),
        },
      ]),
    );
    tray.on("click", showMainWindow);
    return true;
  });

  const configure = Effect.fn("desktop.tray.configure")(function* (settings: ClientSettings) {
    if (environment.platform !== "win32") return;
    let enabled = settings.closeToTray;
    if (enabled && tray === undefined) enabled = yield* createTray;
    if (!enabled) destroyTray();
    yield* Ref.set(state.closeToTray, enabled);
  });

  return DesktopTray.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
      ),
      Effect.ignore,
    ),
    configure,
  });
});

export const layer = Layer.effect(DesktopTray, make);
