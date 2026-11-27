// @effect-diagnostics nodeBuiltinImport:off -- CLI tests create temporary state paths.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { PrepareRestartCliError } from "./prepareRestart.ts";

const isPrepareRestartCliError = Schema.is(PrepareRestartCliError);

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const seedRunningServer = Effect.fn("test.prepareRestart.seedRunningServer")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-prepare-restart-" });
  const baseDir = NodePath.join(root, "state");
  yield* persistServerRuntimeState({
    path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    }),
  });
  return baseDir;
});

function expectCliError(exit: Exit.Exit<unknown, unknown>): PrepareRestartCliError {
  if (Exit.isSuccess(exit)) {
    assert.fail("Expected prepare-restart CLI command to fail.");
  }
  const failure = Cause.squash(exit.cause);
  if (!isPrepareRestartCliError(failure)) {
    assert.fail(`Expected PrepareRestartCliError, got ${String(failure)}`);
  }
  return failure;
}

it.layer(layerCliRuntime)("t3 server prepare-restart", (it) => {
  it.effect("calls POST /api/server/prepare-restart with auth and prints JSON", () =>
    Effect.gen(function* () {
      const baseDir = yield* seedRunningServer();
      const seen = {
        url: "",
        method: "",
        auth: null as string | null,
        body: null as unknown,
      };

      const fetch: typeof globalThis.fetch = async (input, init) => {
        seen.url = input instanceof Request ? input.url : String(input);
        seen.method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        seen.auth = headers.get("authorization");
        const rawBody =
          init?.body != null
            ? await new Response(init.body).text()
            : input instanceof Request
              ? await input.text()
              : "";
        seen.body = rawBody ? JSON.parse(rawBody) : null;
        return Response.json({
          sent: [
            {
              threadId: "thread-1",
              runId: "run-compact-1",
              status: "completed",
            },
          ],
          skipped: [{ threadId: "thread-2", reason: "outside_window" }],
          timedOut: false,
        });
      };

      const exit = yield* runCli([
        "server",
        "prepare-restart",
        "--base-dir",
        baseDir,
        "--downtime",
        "10m",
        "--budget",
        "90s",
        "--json",
      ]).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.exit);

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(seen.method, "POST");
      assert.isTrue(seen.url.endsWith("/api/server/prepare-restart"));
      assert.isTrue(seen.auth?.startsWith("Bearer ") === true);
      assert.deepStrictEqual(seen.body, {
        downtimeMs: 600_000,
        marginMs: 1_800_000,
        budgetMs: 90_000,
      });

      const lines = yield* TestConsole.logLines;
      const parsed = JSON.parse(String(lines.at(-1)));
      assert.deepStrictEqual(parsed, {
        sent: [
          {
            threadId: "thread-1",
            runId: "run-compact-1",
            status: "completed",
          },
        ],
        skipped: [{ threadId: "thread-2", reason: "outside_window" }],
        timedOut: false,
      });
    }),
  );

  it.effect("exits non-zero with a clear message when no server is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-no-server-" });
      const baseDir = NodePath.join(root, "state");

      const exit = yield* runCli(["server", "prepare-restart", "--base-dir", baseDir]).pipe(
        Effect.exit,
      );

      const failure = expectCliError(exit);
      assert.equal(failure.reason, "server_not_running");
      const errors = yield* TestConsole.errorLines;
      assert.isTrue(errors.some((line) => String(line).includes("No running T3 Code server")));
    }),
  );

  it.effect("exits non-zero cleanly when an older server lacks the prepare-restart RPC (404)", () =>
    Effect.gen(function* () {
      const baseDir = yield* seedRunningServer();
      const fetch: typeof globalThis.fetch = async () => new Response("Not Found", { status: 404 });

      const exit = yield* runCli(["server", "prepare-restart", "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit,
      );

      const failure = expectCliError(exit);
      assert.equal(failure.reason, "unsupported_server");
      assert.equal(failure.status, 404);
      const errors = yield* TestConsole.errorLines;
      assert.isTrue(
        errors.some((line) => String(line).includes("does not support prepare-restart")),
      );
    }),
  );

  it.effect("exits non-zero cleanly on server errors and connection refusals", () =>
    Effect.gen(function* () {
      const baseDir = yield* seedRunningServer();

      const serverErrorFetch: typeof globalThis.fetch = async () =>
        new Response("Service Unavailable", { status: 503 });
      const serverExit = yield* runCli(["server", "prepare-restart", "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, serverErrorFetch),
        Effect.exit,
      );
      const serverFailure = expectCliError(serverExit);
      assert.equal(serverFailure.reason, "server_error");
      assert.equal(serverFailure.status, 503);

      const refusedFetch: typeof globalThis.fetch = () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          }),
        );
      const refusedExit = yield* runCli(["server", "prepare-restart", "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, refusedFetch),
        Effect.exit,
      );
      assert.equal(expectCliError(refusedExit).reason, "server_unreachable");
    }),
  );

  it.effect("never hangs past budget plus grace period when the server stalls", () =>
    Effect.gen(function* () {
      const baseDir = yield* seedRunningServer();
      const requestStarted = yield* Deferred.make<void>();
      const hangingFetch: typeof globalThis.fetch = (_input, init) => {
        Deferred.doneUnsafe(requestStarted, Effect.void);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };

      const fiber = yield* runCli([
        "server",
        "prepare-restart",
        "--base-dir",
        baseDir,
        "--budget",
        "5s",
      ]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, hangingFetch),
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(requestStarted);
      // Budget (5s) + CLI grace (5s) = 10s ceiling.
      yield* TestClock.adjust("10 seconds");
      const exit = yield* Fiber.join(fiber);

      assert.equal(expectCliError(exit).reason, "timeout");
    }),
  );
});
