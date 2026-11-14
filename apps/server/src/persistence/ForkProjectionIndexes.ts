import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const ensureForkProjectionIndexes = Effect.fn("persistence.ensureForkProjectionIndexes")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    // One-shot compaction follows start time when a pending steer jumps an older queued run.
    yield* sql`
      CREATE INDEX IF NOT EXISTS fork_runs_latest_started_idx
      ON orchestration_v2_projection_runs(thread_id, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.startedAt') END DESC)
      WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.startedAt') END IS NOT NULL
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS fork_runs_fresh_context_idx
      ON orchestration_v2_projection_runs(thread_id, ordinal DESC)
      WHERE CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.freshContext') = 1
        ELSE 0 END
    `;
  },
);
