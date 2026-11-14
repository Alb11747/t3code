import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  ScheduledTaskUpsertInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "latest-model",
  title: "Nightly",
  prompt: "Reply ok.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: "project-latest",
  workspaceStrategy: { type: "root" },
  modelSelection: {
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "fastMode", value: true },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  followLatestModel: true,
};

const effort = (...ids: string[]) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: ids.map((id) => ({ id, label: id })),
    },
  ],
});

const providers = [
  {
    instanceId: "codex",
    models: [
      { slug: "gpt-6.1-sol", capabilities: effort("high", "xhigh") },
      { slug: "gpt-6.2-sol", capabilities: effort("high") },
      { slug: "gpt-7-terra", capabilities: null },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

const harness = Effect.gen(function* () {
  const launches = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
  const sends = yield* Ref.make<ReadonlyArray<ModelSelection | undefined>>([]);
  const threadSelection: ModelSelection = input.modelSelection as never;
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (launch) =>
            Ref.update(launches, (all) => [...all, launch.modelSelection]).pipe(
              Effect.as({ threadId: "thread-latest", resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              projectId: "project-latest",
              archivedAt: null,
              deletedAt: null,
              modelSelection: threadSelection,
            } as never),
          sendToThread: (send) =>
            Ref.update(sends, (all) => [...all, send.modelSelection]).pipe(Effect.as({} as never)),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return { launches, sends, layer };
});

const run = <A, E>(
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    test: Effect.Success<typeof harness>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-13T12:00:00.000Z"));
    const test = yield* harness;
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService, test);
    }).pipe(Effect.provide(test.layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  );

const newest = {
  instanceId: "codex",
  model: "gpt-6.2-sol",
  options: [{ id: "fastMode", value: true }],
};

it.effect("a following task launches on its family's newest model and keeps it", () =>
  run((service, { launches }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      expect(created.task.followLatestModel).toBe(true);
      const result = yield* service.runNow({ id: created.task.id });
      // The new model offers no xhigh, so that choice falls back to its default.
      expect(yield* Ref.get(launches)).toEqual([newest]);
      expect(result.task).toMatchObject({ modelSelection: newest, followLatestModel: true });

      // A save that omits the flag, as older clients send, keeps it.
      const { followLatestModel: _omitted, ...withoutFlag } = input;
      const resaved = yield* service.upsert(yield* decodeInput(withoutFlag));
      expect(resaved.task.followLatestModel).toBe(true);
      const cleared = yield* service.upsert(
        yield* decodeInput({ ...input, followLatestModel: false }),
      );
      expect(cleared.task.followLatestModel).toBeUndefined();
      yield* service.runNow({ id: created.task.id });
      expect((yield* Ref.get(launches))[1]?.model).toBe("gpt-6.1-sol");

      // A model outside the followed families cannot keep the flag.
      const unfollowable = yield* service.upsert(
        yield* decodeInput({
          ...input,
          modelSelection: { instanceId: "codex", model: "gpt-6-chat-thinking" },
        }),
      );
      expect(unfollowable.task.followLatestModel).toBeUndefined();
    }),
  ),
);

it.effect("a following bound task moves its thread to the newest model", () =>
  run((service, { sends }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(
        yield* decodeInput({ ...input, threadId: "thread-bound" }),
      );
      yield* service.runNow({ id: created.task.id });
      const cleared = yield* service.upsert(
        yield* decodeInput({ ...input, threadId: "thread-bound", followLatestModel: false }),
      );
      yield* service.runNow({ id: cleared.task.id });
      expect(yield* Ref.get(sends)).toEqual([newest, undefined]);
    }),
  ),
);
