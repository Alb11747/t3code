import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerProvider } from "@t3tools/contracts";

import * as ProcessRunner from "../processRunner.ts";
import { decideScriptResult, runScript, type ScriptModels } from "./ScheduledTaskScript.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const ok = (result: unknown, state = "{}") => ({
  ok: true as const,
  hasResult: result !== undefined,
  result: result ?? null,
  state,
  logs: "",
});

const choices = (id: string, ...ids: string[]) => ({
  optionDescriptors: [
    {
      id,
      label: "Effort",
      type: "select",
      options: ids.map((id) => ({ id, label: id })),
    },
  ],
});
const MODELS: ScriptModels = {
  current: {
    instanceId: "claude" as never,
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "max" }],
  },
  providers: [
    {
      instanceId: "claude",
      enabled: true,
      models: [
        { slug: "claude-opus-5-5", capabilities: choices("effort", "high", "max") },
        { slug: "claude-haiku-5-5", capabilities: choices("effort", "low", "high") },
      ],
    },
    {
      instanceId: "codex",
      enabled: true,
      models: [{ slug: "gpt-6-luna", capabilities: choices("reasoningEffort", "minimal", "low") }],
    },
    { instanceId: "off", enabled: false, models: [{ slug: "gpt-6-luna", capabilities: null }] },
    { instanceId: "grok", enabled: true, models: [{ slug: "grok-5", capabilities: null }] },
  ] as unknown as ReadonlyArray<ServerProvider>,
  disabledForProject: ["grok"],
};

describe("decideScriptResult", () => {
  it.each([
    [undefined, { outcome: "run", decision: { run: true, prompt: null, nextRunAtMs: null } }],
    [true, { outcome: "run" }],
    [false, { outcome: "skip", decision: { run: false } }],
    [
      { run: false, reason: "  usage low ", nextRunAt: "2026-11-14T12:00:00Z" },
      {
        outcome: "skip",
        decision: { reason: "usage low", nextRunAtMs: Date.parse("2026-11-14T12:00:00Z") },
      },
    ],
    // Anything sooner than a minute waits a minute, so a bad script cannot spin.
    [{ nextRunAt: NOW + 1000 }, { outcome: "run", decision: { nextRunAtMs: NOW + 60_000 } }],
    [{ prompt: " ping " }, { outcome: "run", decision: { prompt: "ping" } }],
    [5, { outcome: "error" }],
    [{ run: "no" }, { outcome: "error", error: "`run` must be true or false." }],
    [{ prompt: "" }, { outcome: "error" }],
    [{ nextRunAt: "tomorrow" }, { outcome: "error" }],
    [{ nextRunAt: NOW + 400 * 86_400_000 }, { outcome: "error" }],
    // A bare slug stays on the current instance, and the current options carry over.
    [
      { model: "claude-haiku-5-5" },
      {
        outcome: "run",
        decision: { modelSelection: { instanceId: "claude", model: "claude-haiku-5-5" } },
      },
    ],
    [
      { model: { model: "claude-opus-5-5" } },
      {
        decision: {
          modelSelection: { model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] },
        },
      },
    ],
    [
      { model: { instanceId: "codex", model: "gpt-6-luna", options: { reasoningEffort: "low" } } },
      {
        decision: {
          modelSelection: {
            instanceId: "codex",
            model: "gpt-6-luna",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        },
      },
    ],
    // Options the script names must exist; only carried-over ones fall back silently.
    [
      { model: { instanceId: "codex", model: "gpt-6-luna", options: { effort: "low" } } },
      {
        outcome: "error",
        error: "gpt-6-luna does not offer effort: low. It offers reasoningEffort (minimal, low).",
      },
    ],
    [{ model: { model: "claude-haiku-5-5", options: { effort: "max" } } }, { outcome: "error" }],
    [
      { model: { instanceId: "grok", model: "grok-5" } },
      { outcome: "error", error: expect.stringContaining("turned off for this task's project") },
    ],
    // A skip runs nothing, so its model is ignored.
    [
      { run: false, model: "claude-sonnet-9" },
      { outcome: "skip", decision: { modelSelection: null } },
    ],
    [
      { model: { model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] } },
      { decision: { modelSelection: { options: [{ id: "effort", value: "low" }] } } },
    ],
    [
      { model: "claude-sonnet-9" },
      {
        outcome: "error",
        error: expect.stringContaining('does not list the model "claude-sonnet-9"'),
      },
    ],
    [
      { model: { instanceId: "off", model: "gpt-6-luna" } },
      { outcome: "error", error: expect.stringContaining('"off"') },
    ],
    [
      { model: { instanceId: "nope", model: "x" } },
      { outcome: "error", error: expect.stringContaining("claude, codex") },
    ],
    [{ model: 5 }, { outcome: "error" }],
    [{ model: { model: "claude-haiku-5-5", options: { effort: {} } } }, { outcome: "error" }],
  ] as const)("decides %j", (result, expected) => {
    expect(decideScriptResult(ok(result), NOW, MODELS)).toMatchObject(expected);
  });

  it("needs an instance when the task has no model", () => {
    expect(
      decideScriptResult(ok({ model: "gpt-6-luna" }), NOW, { ...MODELS, current: null }),
    ).toMatchObject({
      outcome: "error",
    });
  });

  it("keeps state, treats null as none, and refuses oversized state", () => {
    expect(decideScriptResult(ok(true, '{"n":1}'), NOW, MODELS).decision?.stateJson).toBe(
      '{"n":1}',
    );
    expect(decideScriptResult(ok(true, "null"), NOW, MODELS).decision?.stateJson).toBeNull();
    expect(decideScriptResult(ok(true, "{}"), NOW, MODELS).decision?.stateJson).toBeNull();
    // A refused return still saves the state of a script that finished.
    expect(decideScriptResult(ok({ model: "nope" }, '{"n":1}'), NOW, MODELS)).toMatchObject({
      outcome: "error",
      stateJson: '{"n":1}',
    });
    expect(
      decideScriptResult(ok(true, JSON.stringify("x".repeat(20_000))), NOW, MODELS),
    ).toMatchObject({
      outcome: "error",
    });
  });
});

const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const script = (source: string, timeoutMs?: number) =>
  runScript({
    source,
    context: { state: { count: 1 }, prompt: "hello" },
    cwd: NodeOS.tmpdir(),
    taskId: "task-1",
    models: MODELS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).pipe(Effect.provide(layer));

describe("runScript", () => {
  it.live("runs the source in Node with ctx, keeps state changes and captures logs", () =>
    Effect.gen(function* () {
      const result = yield* script(`
        const { readFileSync } = await import("node:fs");
        console.log("count", ctx.state.count, typeof readFileSync, typeof require);
        process.stdout.write("stray\\n");
        ctx.state.count += 1;
        return { prompt: ctx.prompt + " again", reason: process.env.T3_SCHEDULED_TASK_ID };
      `);
      expect(result).toMatchObject({
        outcome: "run",
        decision: { prompt: "hello again", reason: "task-1", stateJson: '{"count":2}' },
        logs: "count 1 function function\nstray",
      });
    }),
  );

  it.live("reports a thrown error, a missing result and a timeout as failures", () =>
    Effect.gen(function* () {
      const thrown = yield* script(`console.warn("before"); throw new Error("nope");`);
      expect(thrown.outcome).toBe("error");
      expect(thrown.error).toContain("nope");
      expect(thrown.logs).toBe("warn: before");

      const exited = yield* script(`process.exit(3);`);
      expect(exited).toMatchObject({
        outcome: "error",
        error: "The script exited before returning a result.",
      });

      const hung = yield* script(`setInterval(() => {}, 1000); await new Promise(() => {});`, 1000);
      expect(hung).toMatchObject({
        outcome: "error",
        error: "The script did not finish within 1 second.",
      });
    }),
  );
});
