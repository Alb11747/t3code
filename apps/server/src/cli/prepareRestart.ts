import {
  AuthEnvironmentMaintainScope,
  DEFAULT_PREPARE_RESTART_BUDGET_MS,
  DEFAULT_PREPARE_RESTART_DOWNTIME_MS,
  DEFAULT_PREPARE_RESTART_MARGIN_MS,
  EnvironmentHttpCommonError,
  type PrepareRestartInput,
  type PrepareRestartResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { HttpClientError } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { DurationFromString, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";

const CLI_TIMEOUT_GRACE_MS = 5_000;
const MIN_SESSION_TTL_MS = 2 * 60_000;
const SESSION_TTL_BUFFER_MS = 60_000;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PrepareRestartCliErrorReason = Schema.Literals([
  "usage",
  "server_not_running",
  "unsupported_server",
  "server_unreachable",
  "timeout",
  "server_error",
]);

export class PrepareRestartCliError extends Schema.TaggedError<PrepareRestartCliError>()(
  "PrepareRestartCliError",
  {
    reason: PrepareRestartCliErrorReason,
    baseDir: Schema.optional(Schema.String),
    origin: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Int),
    timeoutMs: Schema.optional(Schema.Int),
    code: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    switch (this.reason) {
      case "usage":
        return this.detail ?? "Invalid prepare-restart arguments.";
      case "server_not_running":
        return `No running T3 Code server uses ${this.baseDir ?? "this home"}.`;
      case "unsupported_server":
        return `The running T3 Code server at ${this.origin ?? "localhost"} does not support prepare-restart (HTTP ${this.status ?? 404}). It may be an older version.`;
      case "server_unreachable":
        return `Could not reach the T3 Code server at ${this.origin ?? "localhost"}.`;
      case "timeout":
        return `Timed out waiting for the T3 Code server at ${this.origin ?? "localhost"} to finish prepare-restart after ${Math.ceil((this.timeoutMs ?? 0) / 1000)}s.`;
      case "server_error":
        if (this.code !== undefined) {
          return `The T3 Code server at ${this.origin ?? "localhost"} rejected prepare-restart (${this.code}).`;
        }
        if (this.status !== undefined) {
          return `The T3 Code server at ${this.origin ?? "localhost"} returned HTTP ${this.status} for prepare-restart.`;
        }
        return `Prepare-restart failed against ${this.origin ?? "localhost"}.`;
    }
  }
}

const isPrepareRestartCliError = Schema.is(PrepareRestartCliError);

function mapPrepareRestartRpcError(
  origin: string,
  timeoutMs: number,
  cause: unknown,
): PrepareRestartCliError {
  if (Cause.isTimeoutError(cause)) {
    return new PrepareRestartCliError({ reason: "timeout", origin, timeoutMs });
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return new PrepareRestartCliError({
      reason: "server_error",
      origin,
      code: cause.code,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause)) {
    const status = cause.response?.status;
    if (status === 404 || status === 405) {
      return new PrepareRestartCliError({ reason: "unsupported_server", origin, status });
    }
    if (status !== undefined) {
      return new PrepareRestartCliError({ reason: "server_error", origin, status, cause });
    }
    return new PrepareRestartCliError({ reason: "server_unreachable", origin, cause });
  }
  return new PrepareRestartCliError({ reason: "server_error", origin, cause });
}

function formatPrepareRestartReport(result: PrepareRestartResult): string {
  const statusCounts = new Map<string, number>();
  for (const entry of result.sent) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
  }
  const sentSummary =
    result.sent.length === 0
      ? "0 sent"
      : `${result.sent.length} sent (${Array.from(statusCounts.entries())
          .map(([status, count]) => `${count} ${status}`)
          .join(", ")})`;
  const header = result.timedOut
    ? `Prepare restart timed out: ${sentSummary}, ${result.skipped.length} skipped.`
    : `Prepare restart complete: ${sentSummary}, ${result.skipped.length} skipped.`;
  const lines = [header];
  for (const entry of result.sent) {
    lines.push(`  sent ${entry.threadId} (${entry.status}, run ${entry.runId})`);
  }
  if (result.skipped.length > 0) {
    const skipCounts = new Map<string, number>();
    for (const entry of result.skipped) {
      skipCounts.set(entry.reason, (skipCounts.get(entry.reason) ?? 0) + 1);
    }
    lines.push(
      `  skipped: ${Array.from(skipCounts.entries())
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

const prepareRestartOnRunningServer = Effect.fn("cli.server.prepareRestartOnRunningServer")(
  function* (input: PrepareRestartInput) {
    const config = yield* ServerConfig.ServerConfig;
    const running = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(running)) {
      return yield* new PrepareRestartCliError({
        reason: "server_not_running",
        baseDir: config.baseDir,
      });
    }
    const { origin } = running.value;
    const timeoutMs = input.budgetMs + CLI_TIMEOUT_GRACE_MS;
    const sessionTtl = Duration.millis(
      Math.max(MIN_SESSION_TTL_MS, input.budgetMs + SESSION_TTL_BUFFER_MS),
    );
    return yield* RunningServer.serverClient(origin, [AuthEnvironmentMaintainScope], {
      sessionTtl,
    }).pipe(
      Effect.flatMap((client) =>
        client.maintenance.prepareRestart({
          headers: {},
          payload: input,
        }),
      ),
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.scoped,
      Effect.mapError((cause) => mapPrepareRestartRpcError(origin, timeoutMs, cause)),
    );
  },
);

const downtimeFlag = Flag.String("downtime").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Expected restart downtime (default: 10m)."),
  Flag.withDefault(Duration.millis(DEFAULT_PREPARE_RESTART_DOWNTIME_MS)),
);

const marginFlag = Flag.String("margin").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Safety margin added to downtime (default: 30m)."),
  Flag.withDefault(Duration.millis(DEFAULT_PREPARE_RESTART_MARGIN_MS)),
);

const budgetFlag = Flag.String("budget").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Maximum time to wait for compactions (default: 90s)."),
  Flag.withDefault(Duration.millis(DEFAULT_PREPARE_RESTART_BUDGET_MS)),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const prepareRestartCommand = Command.make("prepare-restart", {
  ...projectLocationFlags,
  downtime: downtimeFlag,
  margin: marginFlag,
  budget: budgetFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Compact idle threads whose prompt cache would expire during a planned restart.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const downtimeMs = Math.round(Duration.toMillis(flags.downtime));
      const marginMs = Math.round(Duration.toMillis(flags.margin));
      const budgetMs = Math.round(Duration.toMillis(flags.budget));
      if (!Number.isSafeInteger(downtimeMs) || downtimeMs < 0) {
        return yield* new PrepareRestartCliError({
          reason: "usage",
          detail: "--downtime must be a non-negative duration.",
        });
      }
      if (!Number.isSafeInteger(marginMs) || marginMs < 0) {
        return yield* new PrepareRestartCliError({
          reason: "usage",
          detail: "--margin must be a non-negative duration.",
        });
      }
      if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
        return yield* new PrepareRestartCliError({
          reason: "usage",
          detail: "--budget must be greater than 0.",
        });
      }

      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
      const minimumLogLevel = flags.json ? "Error" : config.logLevel;

      const result = yield* prepareRestartOnRunningServer({
        downtimeMs,
        marginMs,
        budgetMs,
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      yield* Console.log(flags.json ? encodeJson(result) : formatPrepareRestartReport(result));
    }).pipe(
      Effect.tapError((error) =>
        isPrepareRestartCliError(error) ? Console.error(error.message) : Effect.void,
      ),
    ),
  ),
);

export const serverCommand = Command.make("server").pipe(
  Command.withDescription("Run maintenance commands against the local T3 Code server."),
  Command.withSubcommands([prepareRestartCommand]),
);
