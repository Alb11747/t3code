import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const fileName = "acp-turns.ndjson";
const encodeRecord = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("AcpTurnLog.make")(function* (directory: string) {
  const path = yield* Path.Path;
  const filePath = path.join(directory, fileName);
  let warned = false;
  const warnOnce = (reason: string) =>
    Effect.suspend(() => {
      if (warned) return Effect.void;
      warned = true;
      return Effect.logWarning("Failed to record ACP turn metrics.", { filePath, reason });
    });
  const sink = yield* makeAsyncRotatingFileSink({
    filePath,
    maxBytes: 8 * 1024 * 1024,
    maxFiles: 12,
  }).pipe(Effect.catch((error) => warnOnce(error.message).pipe(Effect.as(undefined))));
  if (sink === undefined) return undefined;
  const queue = yield* Queue.dropping<unknown, Cause.Done>(1_024);
  const writer = yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach((event) =>
      encodeRecord(event).pipe(
        Effect.flatMap((line) => sink.write(`${line}\n`)),
        Effect.catch((error) => warnOnce(error._tag)),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Queue.end(queue).pipe(Effect.andThen(Fiber.join(writer))));

  return (event: unknown) =>
    Queue.offer(queue, event).pipe(
      Effect.flatMap((queued) =>
        queued ? Effect.void : warnOnce("Metrics queue is full or closed"),
      ),
    );
});
