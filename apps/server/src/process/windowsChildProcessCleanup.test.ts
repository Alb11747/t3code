import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off - observes real native launches and signals in this spawner regression.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// Native ESM consumers need the updated built-in binding, rather than a mock
// of the test's own module namespace. Both spies call the real Node functions.
const nativeChildProcess: typeof NodeChildProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
);
const execFile = nativeChildProcess.execFile;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const observeNative = Effect.acquireRelease(
  Effect.sync(() => {
    const taskkill = vi.spyOn(nativeChildProcess, "execFile");
    const spawn = vi.spyOn(nativeChildProcess, "spawn");
    NodeModule.syncBuiltinESMExports();
    return { taskkill, spawn };
  }),
  ({ taskkill, spawn }) =>
    Effect.sync(() => {
      taskkill.mockRestore();
      spawn.mockRestore();
      NodeModule.syncBuiltinESMExports();
    }),
);

const pid = Schema.Int.check(Schema.isGreaterThan(0));
const decodePids = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ leader: pid, grandchild: pid })),
);
const readPids = Effect.fnUntraced(function* (receipt: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodePids(yield* fs.readFileString(receipt));
});

const fixture = (observation: Effect.Success<typeof observeNative>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-cleanup-" });
    const receipt = path.join(directory, "pids.json");
    const owned = { directory, receipt, grandchildTerminated: false };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // The native handle retains leader ownership even if its PID is reused.
        // Scoped spawner release normally exits it before this fallback runs.
        for (const result of observation.spawn.mock.results) {
          if (result.type !== "return") continue;
          const leader = result.value as NodeChildProcess.ChildProcess;
          if (leader.pid === undefined || leader.exitCode !== null || leader.signalCode !== null)
            continue;
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const onExit = () => resolve();
                leader.once("exit", onExit);
                if (!leader.kill("SIGKILL")) {
                  leader.removeListener("exit", onExit);
                  reject(new Error("Failed to kill owned fixture leader"));
                }
              }),
          );
        }
        // Only the detached fixture grandchild needs a PID fallback. It never
        // spawns descendants. Skip it once normal cancellation proved it exited.
        if (!owned.grandchildTerminated && (yield* fs.exists(receipt))) {
          const { grandchild } = yield* readPids(receipt);
          if (isAlive(grandchild)) {
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  execFile(
                    "taskkill",
                    ["/pid", String(grandchild), "/F"],
                    { windowsHide: true },
                    (error) => {
                      if (error && isAlive(grandchild)) reject(error);
                      else resolve();
                    },
                  );
                }),
            );
          }
          expect(isAlive(grandchild)).toBe(false);
          owned.grandchildTerminated = true;
        }
      }).pipe(Effect.orDie),
    );
    return owned;
  });

const treeCommand = (receipt: string, mode: "ignore" | "inherit", exitLeader: boolean) => {
  // Detach the grandchild so Windows does not reclaim it automatically when
  // the leader exits. taskkill /T must still kill it while the leader is live.
  const grandchild =
    "process.send('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000).unref();";
  const leader = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
      { detached: true, stdio: ['ignore', ${JSON.stringify(mode)}, 'ignore', 'ipc'] });
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({leader: process.pid, grandchild: child.pid}));
    child.once('message', () => {
      child.disconnect();
      child.unref();
      process.stdout.write('ready\\n', () => {
        ${exitLeader ? "process.exit(1);" : "setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000).unref();"}
      });
    });
  `;
  return ChildProcess.make(process.execPath, ["-e", leader]);
};

const ready = <E, R>(stdout: Stream.Stream<Uint8Array, E, R>) =>
  stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);

describe.runIf(HostProcessPlatform.defaultValue() === "win32")(
  "Windows scoped child-process cleanup",
  () => {
    it.live.each([
      { name: "missing config", args: ["config", "--get", "t3.absent.key"], expected: 1 },
      {
        name: "missing ref",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/t3-absent"],
        expected: 1,
      },
      { name: "zero exit", args: ["rev-parse", "--git-dir"], expected: 0 },
    ] as const)("does not taskkill after Git $name", ({ args, expected }) =>
      Effect.gen(function* () {
        const observation = yield* observeNative;
        const { directory } = yield* fixture(observation);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              execFile("git", ["init", "--quiet", directory], (error) =>
                error ? reject(error) : resolve(),
              );
            }),
        );
        const code = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner;
            const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: directory }));
            const code = yield* handle.exitCode;
            yield* handle.kill();
            return code;
          }),
        );
        expect(code).toBe(expected);
        expect(observation.taskkill.mock.calls).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("kill succeeds after a nonzero exit without taskkill", () =>
      Effect.gen(function* () {
        const observation = yield* observeNative;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner;
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.execPath, ["-e", "process.exit(7)"]),
            );
            expect(yield* handle.exitCode).toBe(7);
            yield* handle.kill();
            expect(yield* handle.isRunning).toBe(false);
          }),
        );
        expect(observation.taskkill.mock.calls).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("kill succeeds after a signaled exit without taskkill", () =>
      Effect.gen(function* () {
        const observation = yield* observeNative;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner;
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.execPath, [
                "-e",
                "console.log('ready'); setInterval(() => {}, 1000)",
              ]),
            );
            yield* ready(handle.stdout);
            const child = observation.spawn.mock.results.at(-1)
              ?.value as NodeChildProcess.ChildProcess;
            expect(child.kill("SIGTERM")).toBe(true);
            expect(Exit.isFailure(yield* Effect.exit(handle.exitCode))).toBe(true);
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBe("SIGTERM");
            yield* handle.kill();
          }),
        );
        expect(observation.taskkill.mock.calls).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live.each(["ignore", "inherit"] as const)(
      "preserves the existing surviving orphan limitation (%s stdout)",
      (mode) =>
        Effect.gen(function* () {
          const observation = yield* observeNative;
          const { receipt } = yield* fixture(observation);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner;
              const handle = yield* spawner.spawn(treeCommand(receipt, mode, true));
              expect(yield* handle.exitCode).toBe(1);
              const drain = Stream.runDrain(handle.stdout).pipe(Effect.timeout("100 millis"));
              if (mode === "inherit") {
                expect((yield* Effect.flip(drain))._tag).toBe("TimeoutError");
              } else {
                yield* drain;
              }
            }),
          );
          const pids = yield* readPids(receipt);
          expect(isAlive(pids.leader)).toBe(false);
          // Characterized against the unpatched dependency: stale-PID taskkill /T
          // cannot reclaim this orphan, even when it holds the stdout pipe open.
          expect(isAlive(pids.grandchild)).toBe(true);
          expect(observation.taskkill.mock.calls).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live.each(["interrupt", "timeout", "kill"] as const)(
      "kills the running leader and grandchild on %s",
      (mode) =>
        Effect.gen(function* () {
          const observation = yield* observeNative;
          const owned = yield* fixture(observation);
          const { receipt } = owned;
          const started = yield* Deferred.make<void>();
          const run = Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner;
              const handle = yield* spawner.spawn(treeCommand(receipt, "ignore", false));
              yield* ready(handle.stdout);
              const pids = yield* readPids(receipt);
              expect(isAlive(pids.leader)).toBe(true);
              expect(isAlive(pids.grandchild)).toBe(true);
              yield* Deferred.succeed(started, undefined);
              if (mode === "kill") return yield* handle.kill();
              if (mode === "timeout") return yield* Effect.never.pipe(Effect.timeout("10 millis"));
              return yield* Effect.never;
            }),
          );
          if (mode === "interrupt") {
            const fiber = yield* Effect.forkScoped(run);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          } else if (mode === "timeout") {
            expect((yield* Effect.flip(run))._tag).toBe("TimeoutError");
          } else {
            yield* run;
          }
          const pids = yield* readPids(receipt);
          const grandchildAlive = isAlive(pids.grandchild);
          owned.grandchildTerminated = !grandchildAlive;
          const calls = observation.taskkill.mock.calls;
          expect(calls.length).toBeGreaterThan(0);
          expect(calls[0]?.[1]).toEqual(["/pid", String(pids.leader), "/T", "/F"]);
          expect(isAlive(pids.leader)).toBe(false);
          expect(grandchildAlive).toBe(false);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
