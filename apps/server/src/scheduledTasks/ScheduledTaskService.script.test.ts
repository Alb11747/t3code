import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as TaskScripts from "./ScheduledTaskScript.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "script-gate",
  title: "Keep warm",
  prompt: "Reply ok.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: "project-script",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  script: "return true;",
};

const evaluation = (
  decision: Partial<NonNullable<TaskScripts.ScriptEvaluation["decision"]>> | { error: string },
): TaskScripts.ScriptEvaluation =>
  "error" in decision
    ? {
        outcome: "error",
        decision: null,
        error: decision.error,
        logs: "",
        durationMs: 1,
        contextJson: "{}",
      }
    : {
        outcome: decision.run === false ? "skip" : "run",
        decision: {
          run: decision.run ?? true,
          prompt: decision.prompt ?? null,
          nextRunAtMs: decision.nextRunAtMs ?? null,
          reason: decision.reason ?? null,
          stateJson: decision.stateJson ?? null,
        },
        error: null,
        logs: "checked\n",
        durationMs: 1,
        contextJson: "{}",
      };

const harness = Effect.gen(function* () {
  const launches = yield* Ref.make<ReadonlyArray<string>>([]);
  const next = yield* Ref.make<TaskScripts.ScriptEvaluation>(evaluation({}));
  const seen = yield* Ref.make<ReadonlyArray<TaskScripts.ScriptEvaluateInput>>([]);
  const sql = yield* SqlClient.SqlClient;
  // Runs while the "script" runs, as a concurrent edit would.
  const during = yield* Ref.make<string | null>(null);
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (launch) =>
            Ref.update(launches, (all) => [...all, launch.initialMessage?.text ?? ""]).pipe(
              Effect.as({ threadId: "thread-script", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.succeed(TaskScripts.ScheduledTaskScripts, {
          evaluate: (scriptInput) =>
            Ref.update(seen, (all) => [...all, scriptInput]).pipe(
              Effect.andThen(Ref.get(during)),
              Effect.andThen((statement) =>
                statement === null ? Effect.void : sql.unsafe(statement).pipe(Effect.orDie),
              ),
              Effect.andThen(Ref.get(next)),
            ),
        }),
      ),
    ),
  );
  return { launches, next, seen, during, layer };
});

const run = <A, E>(
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    test: Effect.Success<typeof harness>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const test = yield* harness;
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService, test);
    }).pipe(Effect.provide(test.layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  );

it.effect("a skipping script records its check and state and moves the next run", () =>
  run((service, { launches, next, seen }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      expect(created.task.script).toEqual({ source: "return true;", state: null, lastCheck: null });
      const later = NOW + 3 * 3_600_000;
      yield* Ref.set(
        next,
        evaluation({ run: false, reason: "usage low", nextRunAtMs: later, stateJson: '{"n":1}' }),
      );
      const result = yield* service.runNow({ id: created.task.id });
      expect(result.threadId).toBeNull();
      expect(yield* Ref.get(launches)).toEqual([]);
      expect((yield* Ref.get(seen))[0]).toMatchObject({ trigger: "manual", stateJson: null });
      const [task] = (yield* service.list()).tasks;
      expect(task).toMatchObject({
        lastRunStatus: "never",
        runCount: 0,
        nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(later)),
        script: {
          state: '{"n":1}',
          lastCheck: { outcome: "skip", message: "usage low", logs: "checked\n" },
        },
      });
    }),
  ),
);

it.effect("a running script can replace the prompt and the next run time", () =>
  run((service, { launches, next }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      const later = NOW + 50 * 60_000;
      yield* Ref.set(next, evaluation({ prompt: "Still there?", nextRunAtMs: later }));
      const result = yield* service.runNow({ id: created.task.id });
      expect(yield* Ref.get(launches)).toEqual(["Still there?"]);
      expect(result.task).toMatchObject({
        lastRunStatus: "succeeded",
        runCount: 1,
        nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(later)),
      });
    }),
  ),
);

it.effect("a failing script fails the run without dispatching it or saving state", () =>
  run((service, { launches, next }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      yield* Ref.set(next, evaluation({ error: "boom" }));
      yield* service.runNow({ id: created.task.id });
      expect(yield* Ref.get(launches)).toEqual([]);
      expect((yield* service.list()).tasks[0]).toMatchObject({
        lastRunStatus: "failed",
        lastRunError: "The task script failed: boom",
        script: { state: null, lastCheck: { outcome: "error", message: "boom" } },
      });
    }),
  ),
);

it.effect("saves keep, reset or remove a script, and deleting the task removes it", () =>
  run((service, { next }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      const id = created.task.id;
      yield* Ref.set(next, evaluation({ run: false, stateJson: '{"seen":true}' }));
      yield* service.runNow({ id });
      const { script: _script, ...withoutScript } = input;
      const kept = yield* service.upsert(
        yield* decodeInput({ ...withoutScript, id, title: "Renamed" }),
      );
      expect(kept.task.script).toMatchObject({ source: "return true;", state: '{"seen":true}' });
      const edited = yield* service.upsert(
        yield* decodeInput({ ...withoutScript, id, script: "return false;" }),
      );
      expect(edited.task.script).toMatchObject({ source: "return false;", state: '{"seen":true}' });
      const reset = yield* service.upsert(
        yield* decodeInput({ ...withoutScript, id, resetScriptState: true }),
      );
      expect(reset.task.script).toMatchObject({ source: "return false;", state: null });
      const removed = yield* service.upsert(
        yield* decodeInput({ ...withoutScript, id, script: null }),
      );
      expect(removed.task.script).toBeUndefined();

      yield* service.upsert(yield* decodeInput({ ...input, id }));
      yield* service.delete({ id });
      const recreated = yield* service.upsert(yield* decodeInput({ ...withoutScript, id }));
      expect(recreated.task.script).toBeUndefined();
    }),
  ),
);

it.effect("an edit while the script runs stops that run", () =>
  run((service, { launches, during }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      yield* Ref.set(
        during,
        "UPDATE scheduled_tasks SET title = 'Edited', updated_at = '2026-11-13T12:00:01.000Z'",
      );
      const error = yield* service.runNow({ id: created.task.id }).pipe(Effect.flip);
      expect(error.message).toBe("The task changed while its script ran.");
      expect(yield* Ref.get(launches)).toEqual([]);
      expect((yield* service.list()).tasks[0]).toMatchObject({ title: "Edited", runCount: 0 });
    }),
  ),
);

it.effect.each([
  { label: "saved", initial: '{"n":1}' },
  { label: "empty", initial: null },
])("a check that finishes after Reset state of $label state does not save", ({ initial }) =>
  run((service, { next, during }) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput(input));
      if (initial !== null) {
        yield* Ref.set(next, evaluation({ run: false, stateJson: initial }));
        yield* service.runNow({ id: created.task.id });
      }
      // What a save with resetScriptState does to the row.
      yield* Ref.set(
        during,
        "UPDATE fork_scheduled_task_scripts SET state_json = NULL, state_version = state_version + 1",
      );
      yield* Ref.set(next, evaluation({ run: false, stateJson: '{"n":2}' }));
      yield* service.runNow({ id: created.task.id });
      expect((yield* service.list()).tasks[0]?.script).toMatchObject({
        state: null,
        lastCheck: { outcome: "skip" },
      });
    }),
  ),
);
