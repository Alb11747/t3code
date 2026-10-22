import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { vi } from "vite-plus/test";

const trays = vi.hoisted(() => [] as Array<{ icon: string; destroy: () => void }>);

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: vi.fn(function (this: Record<string, unknown>, icon: string) {
    Object.assign(this, {
      icon,
      destroy: vi.fn(),
      on: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
    });
    trays.push(this as unknown as (typeof trays)[number]);
  }),
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const layerTest = (ico: Option.Option<string>) =>
  DesktopTray.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "C:\\T3\\resources\\app\\dist-electron",
          homeDirectory: "C:\\Users\\alice",
          platform: "win32",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "C:\\T3\\resources\\app",
          isPackaged: true,
          resourcesPath: "C:\\T3\\resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({ ico, icns: Option.none(), png: Option.none() }),
          resolveResourcePath: () => Effect.succeedNone,
        }),
        Layer.mock(DesktopClientSettings.DesktopClientSettings)({ get: Effect.succeedNone }),
        Layer.mock(DesktopWindow.DesktopWindow)({ activate: Effect.void }),
        Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
      ),
    ),
    Layer.provideMerge(DesktopState.layer),
  );

const closeToTray = (enabled: boolean) => ({ ...DEFAULT_CLIENT_SETTINGS, closeToTray: enabled });

describe("DesktopTray", () => {
  it.effect("hides on close only while its tray icon exists", () =>
    Effect.gen(function* () {
      trays.length = 0;
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;

      yield* tray.configure(closeToTray(true));
      assert.isTrue(yield* Ref.get(state.closeToTray));
      assert.deepEqual(
        trays.map((created) => created.icon),
        ["C:\\T3\\resources\\icon.ico"],
      );

      yield* tray.configure(closeToTray(false));
      assert.isFalse(yield* Ref.get(state.closeToTray));
      assert.equal(vi.mocked(trays[0]!.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest(Option.some("C:\\T3\\resources\\icon.ico")))),
  );

  it.effect("keeps closing the window when no tray icon is available", () =>
    Effect.gen(function* () {
      trays.length = 0;
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;

      yield* tray.configure(closeToTray(true));
      assert.isFalse(yield* Ref.get(state.closeToTray));
      assert.equal(trays.length, 0);
    }).pipe(Effect.provide(layerTest(Option.none()))),
  );
});
