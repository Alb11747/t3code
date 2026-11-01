import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const readThreadTitles = Effect.fn("ThreadTitles.read")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
) {
  if (threadIds.length === 0) return {};
  const rows = yield* sql<{ thread_id: ThreadId; title: string }>`
    SELECT thread_id, title FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND thread_id IN ${sql.in(threadIds)}`;
  return Object.fromEntries(rows.map((row) => [row.thread_id, row.title]));
});
