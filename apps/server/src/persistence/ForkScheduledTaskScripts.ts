import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Fork-only tables must not consume upstream migration IDs, so this runs at startup instead. */
export const ensureScheduledTaskScriptTable = Effect.fn(
  "persistence.ensureScheduledTaskScriptTable",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_scheduled_task_scripts (
      task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      state_json TEXT,
      -- Bumped by Reset state, so a check that read older state cannot save over it.
      state_version INTEGER NOT NULL DEFAULT 0,
      last_check_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
