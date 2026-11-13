import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DevRunnerLiveHomeError extends Schema.TaggedError<DevRunnerLiveHomeError>()(
  "DevRunnerLiveHomeError",
  { home: Schema.String },
) {
  override get message(): string {
    return `Refusing to start a dev server on ${this.home}, your live T3 Code data. Pass --home-dir <other dir>, run from a git worktree, or unset T3CODE_HOME. --allow-live-home overrides this.`;
  }
}

/**
 * An explicit `~/.t3` home makes a dev server use the live `~/.t3/userdata`
 * (without one it uses `~/.t3/dev`). Agent shells inherit the live T3CODE_HOME and
 * the main checkout honours it. The server's ownership lock only covers a running owner.
 */
export const assertNotLiveHome = Effect.fn("dev-runner.assertNotLiveHome")(function* (
  home: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const liveHome = path.join(yield* HostProcess.HomeDirectory, ".t3");
  const canonical = (dir: string) =>
    fs.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir)));
  if ((yield* canonical(home)) === (yield* canonical(liveHome))) {
    return yield* new DevRunnerLiveHomeError({ home });
  }
});
