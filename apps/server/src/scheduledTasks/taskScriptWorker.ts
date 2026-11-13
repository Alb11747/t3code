// @effect-diagnostics nodeBuiltinImport:off -- isolated CLI worker; no server runtime is loaded here.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

interface WorkerInput {
  readonly source: string;
  readonly ctx: { state?: unknown };
  readonly marker: string;
  readonly logLimit: number;
}

const format = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Fork: runs one scheduled-task script, as `t3 __task-script`, so packaged single-executable
 * builds need no separate Node. Reads `{ source, ctx, marker }` from stdin, captures console
 * output, and writes one marker-prefixed JSON line so stray stdout writes cannot pass for it.
 */
export async function runTaskScriptWorker(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerInput;
  let logs = "";
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      if (logs.length >= input.logLimit) return;
      const prefix = level === "log" || level === "info" ? "" : `${level}: `;
      logs += `${prefix}${args.map(format).join(" ")}\n`;
    };
  }
  const emit = (payload: Record<string, unknown>) =>
    process.stdout.write(
      `\n${input.marker}${JSON.stringify({ ...payload, logs: logs.slice(0, input.logLimit) })}\n`,
      () => process.exit(0),
    );
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (ctx: unknown, require: NodeJS.Require) => Promise<unknown>;
    const run = new AsyncFunction("ctx", "require", input.source);
    const require = NodeModule.createRequire(NodePath.join(process.cwd(), "t3-task-script.js"));
    const result = await run(input.ctx, require);
    let state: string;
    try {
      state = JSON.stringify(input.ctx.state ?? null);
    } catch {
      throw new Error("ctx.state must be JSON-serializable.");
    }
    emit({ ok: true, hasResult: result !== undefined, result: result ?? null, state });
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
}
