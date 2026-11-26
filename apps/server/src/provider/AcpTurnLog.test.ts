import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as AcpTurnLog from "./AcpTurnLog.ts";

it.live("drains queued ACP turn records on shutdown and appends after restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-acp-turn-log-" });

    for (const ids of [["one", "two"], ["three"]]) {
      yield* Effect.gen(function* () {
        const write = yield* AcpTurnLog.make(directory);
        if (write === undefined) return assert.fail("ACP turn log must open");
        for (const id of ids) yield* write({ id });
      }).pipe(Effect.scoped);
    }

    const file = yield* fs.readFileString(path.join(directory, AcpTurnLog.fileName));
    assert.equal(file, '{"id":"one"}\n{"id":"two"}\n{"id":"three"}\n');
  }).pipe(Effect.provide(NodeServices.layer)),
);
