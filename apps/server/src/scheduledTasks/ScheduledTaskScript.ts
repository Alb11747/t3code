/**
 * Fork: check scripts for scheduled tasks. A script is the body of an async JavaScript function
 * that receives `ctx` (usage, providers, the bound thread, persisted state) and decides whether a
 * run goes ahead and on which model. It runs in a child Node process, so a hung or crashing script
 * cannot stall the server.
 */
import {
  MAX_SCHEDULED_TASK_SCRIPT_STATE_CHARS,
  type ModelSelection,
  type ProjectId,
  type ScheduledTask,
  ScheduledTaskScriptCheck,
  type ScheduledTaskScript,
  type ScheduledTaskScriptDecision,
  type ServerProvider,
  type ThreadId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { modelFamilyName, resolveLatestFamilyModel } from "@t3tools/shared/latestModel";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { behindHub, hubSourceOf } from "../usage/ThreadAccountService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import { withOfferedOptions } from "./latestModel.ts";

export type ScriptTrigger = "scheduled" | "manual" | "webhook" | "test";

const SCRIPT_TIMEOUT_MS = 30_000;
const LOG_LIMIT_CHARS = 16_000;
const REASON_LIMIT_CHARS = 500;
const MIN_NEXT_RUN_DELAY_MS = 60_000;
const MAX_NEXT_RUN_DELAY_MS = 366 * 24 * 60 * 60_000;

export interface ScriptEvaluation {
  readonly outcome: "run" | "skip" | "error";
  readonly decision: {
    readonly run: boolean;
    readonly prompt: string | null;
    readonly nextRunAtMs: number | null;
    readonly reason: string | null;
    readonly stateJson: string | null;
    /** The script's model for this run only, checked against `ScriptModels`. */
    readonly modelSelection: ModelSelection | null;
  } | null;
  readonly error: string | null;
  readonly logs: string;
  readonly durationMs: number;
  readonly contextJson: string;
}

export interface ScriptEvaluateInput {
  readonly source: string;
  readonly trigger: ScriptTrigger;
  readonly task: ScheduledTask | null;
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly stateJson: string | null;
  readonly webhook: ScriptWebhookRequest | null;
  /** The task's model, or the editor's for a test; a bound thread's own model takes its place. */
  readonly modelSelection: ModelSelection | null;
}

/** What a script's `model` is resolved and checked against. */
export interface ScriptModels {
  /** The model the run uses unless the script picks one; a bare slug stays on its instance. */
  readonly current: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ScriptWebhookRequest {
  readonly deliveryId: string;
  readonly method: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function scriptDecisionForClient(
  evaluation: ScriptEvaluation,
): ScheduledTaskScriptDecision | null {
  const decision = evaluation.decision;
  if (decision === null) return null;
  return {
    run: decision.run,
    prompt: decision.prompt,
    nextRunAt:
      decision.nextRunAtMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(decision.nextRunAtMs)),
    reason: decision.reason,
    state: decision.stateJson,
    ...(decision.modelSelection === null ? {} : { modelSelection: decision.modelSelection }),
  };
}

/** Stored checks reach every client with the task list, so they keep only the log's end. */
const CHECK_LOG_LIMIT_CHARS = 2_000;

export function scriptCheck(evaluation: ScriptEvaluation, at: string): ScheduledTaskScriptCheck {
  const logs = evaluation.logs;
  return {
    at,
    outcome: evaluation.outcome,
    message: (evaluation.error ?? evaluation.decision?.reason ?? null)?.slice(0, 2_000) ?? null,
    logs: logs.length <= CHECK_LOG_LIMIT_CHARS ? logs : `…${logs.slice(-CHECK_LOG_LIMIT_CHARS)}`,
    durationMs: evaluation.durationMs,
  };
}

/** The message a skipped or failed check leaves where run errors and delivery logs show it. */
export function scriptSkipMessage(evaluation: ScriptEvaluation): string {
  const reason = evaluation.decision?.reason;
  return reason ? `Skipped by script: ${reason}` : "Skipped by script.";
}

const RunnerPayload = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    hasResult: Schema.Boolean,
    result: Schema.Unknown,
    state: Schema.String,
    logs: Schema.String,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String, logs: Schema.String }),
]);
type RunnerPayload = typeof RunnerPayload.Type;
const decodeRunnerPayload = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerPayload));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeCheck = Schema.encodeEffect(Schema.fromJsonString(ScheduledTaskScriptCheck));

type Decided = Pick<ScriptEvaluation, "outcome" | "decision" | "error">;

const failed = (error: string): Decided => ({ outcome: "error", decision: null, error });

function parseNextRunAt(value: unknown, nowMs: number): number | string {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(ms)) return "nextRunAt must be an ISO date, a Date or epoch milliseconds.";
  if (ms - nowMs > MAX_NEXT_RUN_DELAY_MS) return "nextRunAt must be within a year.";
  // A minute's floor keeps a buggy script from firing in a tight loop.
  return Math.max(Math.ceil(ms), nowMs + MIN_NEXT_RUN_DELAY_MS);
}

const isOptionValue = (value: unknown): value is string | boolean =>
  typeof value === "boolean" || (typeof value === "string" && value.trim() !== "");

function parseOptions(value: unknown): ModelSelection["options"] | string {
  const invalid = "`model.options` must be an object such as { effort: 'low' }.";
  if (Array.isArray(value)) {
    const options = value.map((entry: unknown) => {
      const { id, value: choice } = (entry ?? {}) as Record<string, unknown>;
      return typeof id === "string" && id.trim() !== "" && isOptionValue(choice)
        ? { id: id.trim(), value: choice }
        : null;
    });
    return options.every((option) => option !== null) ? options : invalid;
  }
  if (typeof value !== "object" || value === null) return invalid;
  const entries = Object.entries(value);
  return entries.every(([id, choice]) => id.trim() !== "" && isOptionValue(choice))
    ? entries.map(([id, choice]) => ({ id: id.trim(), value: choice as string | boolean }))
    : invalid;
}

/** A slug on the current instance, or `{ instanceId?, model, options? }`; checked, never trusted. */
function resolveScriptModel(value: unknown, models: ScriptModels): ModelSelection | string {
  const choice = typeof value === "string" ? { model: value } : value;
  if (typeof choice !== "object" || choice === null || Array.isArray(choice))
    return "`model` must be a model slug or { instanceId, model, options }.";
  const fields = choice as Record<string, unknown>;
  if (typeof fields.model !== "string" || fields.model.trim() === "")
    return "`model` needs a model slug from ctx.providers.";
  if (fields.instanceId != null && typeof fields.instanceId !== "string")
    return "`model.instanceId` must be text.";
  const instanceId = fields.instanceId ?? models.current?.instanceId;
  if (instanceId === undefined)
    return "No provider instance to run on; return { instanceId, model }.";
  const enabled = models.providers.filter((provider) => provider.enabled);
  const provider = enabled.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined)
    return `No enabled provider instance "${instanceId}". Choose one of: ${enabled.map((candidate) => candidate.instanceId).join(", ") || "none"}.`;
  const slug = fields.model.trim();
  if (!provider.models.some((model) => model.slug === slug))
    return `${provider.instanceId} does not list the model "${slug}". See ctx.providers.`;
  const options = fields.options == null ? undefined : parseOptions(fields.options);
  if (typeof options === "string") return options;
  // Unless the script names options, the current ones carry over where the new model offers them.
  const carried =
    options ??
    (models.current?.instanceId === provider.instanceId ? models.current.options : undefined);
  return withOfferedOptions(provider.instanceId, slug, carried, provider.models);
}

/** Turns what the script returned into a decision; anything ambiguous fails closed. */
export function decideScriptResult(
  payload: RunnerPayload,
  nowMs: number,
  models: ScriptModels,
): Decided {
  if (!payload.ok) return failed(payload.error);
  // An untouched `ctx.state` starts as {}, which is the same as none.
  const stateJson = payload.state === "null" || payload.state === "{}" ? null : payload.state;
  if (stateJson !== null && stateJson.length > MAX_SCHEDULED_TASK_SCRIPT_STATE_CHARS)
    return failed(
      `ctx.state is ${stateJson.length} characters; the limit is ${MAX_SCHEDULED_TASK_SCRIPT_STATE_CHARS}.`,
    );
  const decide = (input: {
    readonly run: boolean;
    readonly prompt?: string | null;
    readonly nextRunAtMs?: number | null;
    readonly reason?: string | null;
    readonly modelSelection?: ModelSelection | null;
  }): Decided => ({
    outcome: input.run ? "run" : "skip",
    decision: {
      run: input.run,
      prompt: input.prompt ?? null,
      nextRunAtMs: input.nextRunAtMs ?? null,
      reason: input.reason ?? null,
      stateJson,
      modelSelection: input.modelSelection ?? null,
    },
    error: null,
  });
  const result = payload.result;
  if (!payload.hasResult || result === true) return decide({ run: true });
  if (result === false) return decide({ run: false });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return failed("Return true, false, or an object such as { run: false, reason: '...' }.");
  const fields = result as Record<string, unknown>;
  if (fields.run !== undefined && typeof fields.run !== "boolean")
    return failed("`run` must be true or false.");
  if (fields.prompt != null && (typeof fields.prompt !== "string" || fields.prompt.trim() === ""))
    return failed("`prompt` must be non-empty text.");
  if (fields.reason != null && typeof fields.reason !== "string")
    return failed("`reason` must be text.");
  let nextRunAtMs: number | null = null;
  if (fields.nextRunAt != null) {
    const parsed = parseNextRunAt(fields.nextRunAt, nowMs);
    if (typeof parsed === "string") return failed(parsed);
    nextRunAtMs = parsed;
  }
  let modelSelection: ModelSelection | null = null;
  if (fields.model != null) {
    const resolved = resolveScriptModel(fields.model, models);
    if (typeof resolved === "string") return failed(resolved);
    modelSelection = resolved;
  }
  const reason =
    typeof fields.reason === "string" && fields.reason.trim() !== ""
      ? fields.reason.trim().slice(0, REASON_LIMIT_CHARS)
      : null;
  return decide({
    run: fields.run ?? true,
    prompt: typeof fields.prompt === "string" ? fields.prompt.trim() : null,
    nextRunAtMs,
    reason,
    modelSelection,
  });
}

function seconds(ms: number): string {
  const count = Math.round(ms / 1000);
  return count === 1 ? "1 second" : `${count} seconds`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

// In a bundle import.meta.url is bin.mjs; development and tests use this source module.
const CLI_ENTRY = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
);

export const runScript = Effect.fn("ScheduledTaskScript.run")(function* (input: {
  readonly source: string;
  readonly context: unknown;
  readonly cwd: string;
  readonly taskId: string | null;
  readonly models: ScriptModels;
  readonly timeoutMs?: number;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const executable = yield* HostProcess.ExecutablePath;
  // A single-executable CLI runs its own commands; Node and Electron need the entry script.
  const isExecutable = yield* HostProcess.IsExecutable;
  const random = yield* SecureRandom.SecureRandom;
  const marker = `T3-SCRIPT-RESULT-${yield* random.uuidV4().pipe(Effect.orDie)}:`;
  const startedMs = DateTime.toEpochMillis(yield* DateTime.now);
  const stdin = yield* encodeJson({
    source: input.source,
    ctx: input.context,
    marker,
    logLimit: LOG_LIMIT_CHARS,
  }).pipe(Effect.orDie);
  const output = yield* runner
    .run({
      command: executable,
      args: [...(isExecutable ? [] : [CLI_ENTRY]), "__task-script"],
      cwd: input.cwd,
      // The desktop app's server runs on Electron's binary, which this turns back into Node.
      env: { ELECTRON_RUN_AS_NODE: "1", T3_SCHEDULED_TASK_ID: input.taskId ?? "" },
      stdin,
      timeout: input.timeoutMs ?? SCRIPT_TIMEOUT_MS,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 1024 * 1024,
      outputMode: "truncate",
    })
    .pipe(Effect.result);
  const durationMs = DateTime.toEpochMillis(yield* DateTime.now) - startedMs;
  const nowMs = startedMs + durationMs;
  if (output._tag === "Failure") {
    return {
      ...failed(`The script could not start: ${output.failure.message}`),
      logs: "",
      durationMs,
    };
  }
  const { stdout, stderr, timedOut } = output.success;
  const markerAt = stdout.lastIndexOf(marker);
  const stray = [markerAt === -1 ? stdout : stdout.slice(0, markerAt), stderr]
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n");
  if (timedOut || markerAt === -1) {
    return {
      ...failed(
        timedOut
          ? `The script did not finish within ${seconds(input.timeoutMs ?? SCRIPT_TIMEOUT_MS)}.`
          : "The script exited before returning a result.",
      ),
      logs: truncate(stray, LOG_LIMIT_CHARS),
      durationMs,
    };
  }
  const payload = decodeRunnerPayload(stdout.slice(markerAt + marker.length).split("\n", 1)[0]);
  if (Option.isNone(payload)) {
    return {
      ...failed("The script returned a value that is not JSON."),
      logs: truncate(stray, LOG_LIMIT_CHARS),
      durationMs,
    };
  }
  return {
    ...decideScriptResult(payload.value, nowMs, input.models),
    logs: truncate(
      [payload.value.logs.trimEnd(), stray].filter(Boolean).join("\n"),
      LOG_LIMIT_CHARS,
    ),
    durationMs,
  };
});

const iso = (value: DateTime.DateTime | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

const parseState = (stateJson: string | null): unknown =>
  stateJson === null ? {} : Option.getOrElse(decodeJson(stateJson), () => ({}));

/** Fork: builds `ctx` and runs scripts. The default exists so tests can omit it. */
export class ScheduledTaskScripts extends Context.Reference<{
  readonly evaluate: (input: ScriptEvaluateInput) => Effect.Effect<ScriptEvaluation>;
}>("t3/scheduledTasks/ScheduledTaskScripts", {
  defaultValue: () => ({
    evaluate: () =>
      Effect.succeed({
        ...failed("Task scripts are not available on this server."),
        logs: "",
        durationMs: 0,
        contextJson: "{}",
      }),
  }),
}) {}

export const layer = Layer.effect(
  ScheduledTaskScripts,
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const random = yield* SecureRandom.SecureRandom;

    // A provider behind a hub reports the windows of whichever hub account served its last turn,
    // so it is left out here; its accounts are listed under the hub, as `t3_usage` does.
    const usageAccounts = (
      providerList: ReadonlyArray<ServerProvider>,
      snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) => {
      const native = providerList.flatMap((provider) =>
        provider.enabled && provider.usageLimits && !behindHub(provider)
          ? [
              {
                source: "native" as const,
                sourceId: null,
                sourceLabel: provider.displayName ?? provider.instanceId,
                instanceId: provider.instanceId,
                driver: provider.driver,
                email: provider.auth.email ?? null,
                plan: null,
                subscriptionEndsAt: null,
                ...provider.usageLimits,
              },
            ]
          : [],
      );
      const hubs = snapshots.flatMap((source) =>
        source.accounts.map((account) => ({
          source: "cliproxy" as const,
          sourceId: source.id,
          sourceLabel: source.label,
          instanceId: null,
          driver: account.driver,
          email: account.email ?? null,
          plan: account.plan ?? null,
          subscriptionEndsAt: account.subscriptionEndsAt ?? null,
          ...account.usageLimits,
        })),
      );
      return [...native, ...hubs];
    };

    // Small on purpose: what a script needs to pick a model, joined to usage by `hub.sourceId`.
    const providerContext = (
      providerList: ReadonlyArray<ServerProvider>,
      snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) =>
      providerList
        .filter((provider) => provider.enabled)
        .map((provider) => {
          const hub = hubSourceOf(provider, snapshots);
          return {
            instanceId: provider.instanceId,
            driver: provider.driver,
            name: provider.displayName ?? provider.instanceId,
            hub: hub === null ? null : { sourceId: hub.id, label: hub.label },
            models: provider.models.map((model) => {
              const family = modelFamilyName(model.slug);
              const options = Object.fromEntries(
                (model.capabilities?.optionDescriptors ?? []).map((descriptor) => [
                  descriptor.id,
                  descriptor.type === "select"
                    ? descriptor.options.map((option) => option.id)
                    : [true, false],
                ]),
              );
              return {
                slug: model.slug,
                name: model.name,
                ...(family === null ? {} : { family }),
                ...(family !== null &&
                resolveLatestFamilyModel(model.slug, provider.models) === model.slug
                  ? { latest: true }
                  : {}),
                ...(Object.keys(options).length === 0 ? {} : { options }),
              };
            }),
          };
        });

    const threadContext = Effect.fn("ScheduledTaskScripts.threadContext")(function* (
      threadId: ThreadId,
    ) {
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null || shell.deletedAt != null) return null;
      const active = shell.activeProviderThreadId;
      const records =
        active === null
          ? null
          : yield* projections.getThreadRecords(threadId, ["providerThreads", "providerTurns"], {
              providerThreadIds: [active],
              providerTurnThreadIds: [active],
              latestProviderTurnUsageOnly: true,
            });
      const providerThread = records?.providerThreads.find((thread) => thread.id === active);
      const usage = records?.providerTurns
        .filter((turn) => turn.providerThreadId === active && turn.tokenUsage !== undefined)
        .map((turn) => turn.tokenUsage!)
        .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      return {
        modelSelection: shell.modelSelection,
        id: shell.id,
        title: shell.title,
        projectId: shell.projectId,
        status: shell.status,
        running: shell.activeRunId !== null,
        providerInstanceId: shell.providerInstanceId,
        driver: providerThread?.driver ?? null,
        model: shell.modelSelection.model,
        worktreePath: shell.worktreePath,
        latestRunStartedAt: iso(shell.latestRunStartedAt),
        latestRunCompletedAt: iso(shell.latestRunCompletedAt),
        latestUserMessageAt: iso(shell.latestUserMessageAt),
        latestMessage:
          shell.latestVisibleMessage === null
            ? null
            : {
                role: shell.latestVisibleMessage.role,
                at: iso(shell.latestVisibleMessage.updatedAt),
              },
        lastError: shell.lastError ?? null,
        usageLimitResetAt: shell.usageLimitResetAt ?? null,
        snoozedUntil: iso(shell.snoozedUntil),
        archived: shell.archivedAt !== null,
        settled: shell.settledAt !== null,
        context:
          usage === undefined
            ? null
            : { usedTokens: usage.usedTokens, maxTokens: usage.maxTokens ?? null },
        // Claude reports the TTL of its latest cache write; a request served wholly from cache
        // reports none, which leaves `expiresAt` null.
        promptCache:
          providerThread?.driver === "claudeAgent" && usage !== undefined
            ? {
                ttlMs: usage.promptCacheTtlMs ?? null,
                expiresAt: usage.promptCacheExpiresAt ?? null,
                updatedAt: usage.updatedAt,
              }
            : null,
      };
    });

    const resolveCwd = Effect.fn("ScheduledTaskScripts.resolveCwd")(function* (
      projectId: ProjectId | null,
      worktreePath: string | null,
    ) {
      const project =
        projectId === null ? Option.none() : yield* projects.get(projectId).pipe(Effect.option);
      const candidates = [
        worktreePath,
        Option.isSome(project) && Option.isSome(project.value)
          ? project.value.value.workspaceRoot
          : null,
      ];
      for (const candidate of candidates) {
        if (candidate && (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))))
          return candidate;
      }
      return NodeOS.homedir();
    });

    const evaluate = Effect.fn("ScheduledTaskScripts.evaluate")(function* (
      input: ScriptEvaluateInput,
    ) {
      const now = yield* DateTime.now;
      const thread =
        input.threadId === null
          ? null
          : yield* threadContext(input.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Task script could not read its thread.", { cause }).pipe(
                  Effect.as(null),
                ),
              ),
            );
      const providerList = yield* providers.getProviders.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Task script could not read providers.", { cause }).pipe(Effect.as([])),
        ),
      );
      const snapshots = yield* sources.current.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Task script could not read usage.", { cause }).pipe(Effect.as([])),
        ),
      );
      const { script: _script, webhook: _endpoint, ...task } = input.task ?? {};
      // A bound thread runs on its own model, so that is what a script's choice replaces.
      const models: ScriptModels = {
        current: thread?.modelSelection ?? input.modelSelection,
        providers: providerList,
      };
      const { modelSelection: _threadModel, ...threadFields } = thread ?? {};
      const context = {
        now: DateTime.formatIso(now),
        trigger: input.trigger,
        task: input.task === null ? null : task,
        prompt: input.prompt,
        model: models.current,
        providers: providerContext(providerList, snapshots),
        state: parseState(input.stateJson),
        usage: { accounts: usageAccounts(providerList, snapshots) },
        thread: thread === null ? null : threadFields,
        webhook: input.webhook,
      };
      const cwd = yield* resolveCwd(input.projectId, thread?.worktreePath ?? null);
      const result = yield* runScript({
        source: input.source,
        context,
        cwd,
        taskId: input.task?.id ?? null,
        models,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      return { ...result, contextJson: yield* encodeJson(context).pipe(Effect.orDie) };
    });

    return { evaluate };
  }),
);

const decodeCheck = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskScriptCheck));

interface ScriptRow {
  readonly task_id: string;
  readonly source: string;
  readonly state_json: string | null;
  readonly last_check_json: string | null;
}

const toScript = (row: ScriptRow): ScheduledTaskScript => ({
  source: row.source,
  state: row.state_json,
  lastCheck:
    row.last_check_json === null ? null : Option.getOrNull(decodeCheck(row.last_check_json)),
});

/** Script rows for the scheduled task service, bound to its SQL client. */
export function makeScriptStore(sql: SqlClient.SqlClient) {
  const all = Effect.fnUntraced(function* () {
    const rows = yield* sql<ScriptRow>`
      SELECT task_id, source, state_json, last_check_json FROM fork_scheduled_task_scripts
    `;
    return new Map(rows.map((row) => [row.task_id, toScript(row)] as const));
  });

  const attach = <T extends ScheduledTask>(
    tasks: ReadonlyArray<T>,
    scripts: Map<string, ScheduledTaskScript>,
  ) =>
    tasks.map((task) => {
      const script = scripts.get(task.id);
      return script === undefined ? task : { ...task, script };
    });

  return {
    attachAll: <T extends ScheduledTask>(tasks: ReadonlyArray<T>) =>
      tasks.length === 0
        ? Effect.succeed(tasks)
        : all().pipe(Effect.map((scripts) => attach(tasks, scripts))),
    attachOne: <T extends ScheduledTask>(task: T) =>
      sql<ScriptRow>`
        SELECT task_id, source, state_json, last_check_json FROM fork_scheduled_task_scripts
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.map(([row]) => (row === undefined ? task : { ...task, script: toScript(row) })),
      ),
    /** `script` omitted keeps the stored one; null removes it with its state. */
    save: Effect.fn("ScheduledTaskScripts.save")(function* (input: {
      readonly taskId: string;
      readonly script: string | null | undefined;
      readonly resetState: boolean;
      readonly now: string;
    }) {
      if (input.script === null) {
        yield* sql`DELETE FROM fork_scheduled_task_scripts WHERE task_id = ${input.taskId}`;
        return;
      }
      if (input.script !== undefined) {
        yield* sql`
            INSERT INTO fork_scheduled_task_scripts (task_id, source, state_json, last_check_json, updated_at)
            VALUES (${input.taskId}, ${input.script}, NULL, NULL, ${input.now})
            ON CONFLICT (task_id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at
          `;
      }
      if (input.resetState) {
        yield* sql`
            UPDATE fork_scheduled_task_scripts
            SET state_json = NULL, state_version = state_version + 1, updated_at = ${input.now}
            WHERE task_id = ${input.taskId}
          `;
      }
    }),
    /** The state a check starts from, with the version that guards saving its result. */
    readForCheck: (taskId: string) =>
      sql<{ readonly state_json: string | null; readonly state_version: number }>`
        SELECT state_json, state_version FROM fork_scheduled_task_scripts WHERE task_id = ${taskId}
      `.pipe(
        Effect.map(([row]) =>
          row === undefined ? null : { stateJson: row.state_json, version: row.state_version },
        ),
      ),
    /**
     * Saves the check and, after a script that finished, its state. Only for the source it ran,
     * and the state only if nothing (such as Reset state) replaced the state the script read.
     */
    recordCheck: Effect.fn("ScheduledTaskScripts.recordCheck")(function* (input: {
      readonly taskId: string;
      readonly source: string;
      readonly check: ScheduledTaskScriptCheck;
      readonly stateVersion: number;
      readonly stateJson: string | null | undefined;
    }) {
      const checkJson = yield* encodeCheck(input.check);
      yield* sql`
        UPDATE fork_scheduled_task_scripts
        SET last_check_json = ${checkJson},
            state_json = CASE WHEN ${input.stateJson === undefined ? 0 : 1} = 1
                AND state_version = ${input.stateVersion}
              THEN ${input.stateJson ?? null} ELSE state_json END,
            updated_at = ${input.check.at}
        WHERE task_id = ${input.taskId} AND source = ${input.source}
      `;
    }),
  };
}
export type ScriptStore = ReturnType<typeof makeScriptStore>;
