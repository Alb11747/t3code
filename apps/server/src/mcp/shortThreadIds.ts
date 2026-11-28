/**
 * Fork: agents may name a thread by a short id, the start of the uuid or hash its id ends with
 * (`60114142` for `thread:delegated-task:…%3Adelegate-task%3A60114142-4ad8-…`), with or without
 * URL encoding. `McpToolAccess` resolves short ids in a tool's thread-id parameters before the
 * tool or its access checks read them, so every check sees the full id.
 */
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { unavailable } from "./threadAccess.ts";

/** Fewer hex digits would make collisions between a busy machine's threads common. */
const SHORT_THREAD_ID_MIN_HEX = 8;
/** Enough to list an ambiguous short id's candidates; a longer prefix narrows the rest. */
const CANDIDATE_LIMIT = 10;
/**
 * Ids that contain the prefix anywhere, before keeping those whose trailing token starts with it.
 * Delegated-task ids embed other uuids, so this stays well above the candidates listed.
 */
const SCAN_LIMIT = 500;

const decodeFully = (text: string) => {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
};

/** The lowercase hex prefix a short id names, or null when the text is not one. */
const shortThreadIdPrefix = (text: string): string | null => {
  const decoded = decodeFully(text.trim()).toLowerCase();
  if (!/^[0-9a-f][0-9a-f-]*$/.test(decoded)) return null;
  return decoded.replaceAll("-", "").length >= SHORT_THREAD_ID_MIN_HEX ? decoded : null;
};

/** The uuid or hash a thread id ends with, decoded and lowercase. */
const trailingThreadIdToken = (threadId: string): string =>
  decodeFully(threadId).toLowerCase().split(":").at(-1) ?? "";

const isThreadIdParameter = (key: string) => key === "threadId" || key.endsWith("ThreadId");

/**
 * Replaces each top-level thread-id parameter that is a short id of exactly one thread here with
 * that thread's full id. A short id of several threads fails with their links; one of none is
 * left for the tool to report as not found. Full ids and anything else pass unchanged.
 */
export const resolveShortThreadIds = Effect.fn("mcp.resolveShortThreadIds")(function* <P>(
  params: P,
) {
  if (!Predicate.isObject(params)) return params;
  let resolved: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(params)) {
    if (!isThreadIdParameter(key) || typeof value !== "string") continue;
    const prefix = shortThreadIdPrefix(value);
    if (prefix === null) continue;
    // Toolkits that never read threads do not provide the service; their ids stay as given.
    const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
    if (Option.isNone(threads)) return params;
    const exact = yield* threads.value
      .getThreadShell(ThreadId.make(value))
      .pipe(Effect.mapError(unavailable));
    if (exact !== null && exact.deletedAt === null) continue;
    const contained = yield* threads.value
      .findThreadIdsContaining(prefix, SCAN_LIMIT)
      .pipe(Effect.mapError(unavailable));
    const matches = contained.filter((id) => trailingThreadIdToken(id).startsWith(prefix));
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const listed = matches
        .slice(0, CANDIDATE_LIMIT)
        .map((id) => `- \`${id}\` ${McpInvocationContext.threadLinkFor(scope, id)}`);
      const more = matches.length > CANDIDATE_LIMIT ? "\n- (more not listed)" : "";
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `\`${value}\` is the short id of more than one thread. Pass a longer prefix or one of these full ids:\n${listed.join("\n")}${more}`,
      });
    }
    resolved = { ...(resolved ?? params), [key]: matches[0] };
  }
  return (resolved ?? params) as P;
});
