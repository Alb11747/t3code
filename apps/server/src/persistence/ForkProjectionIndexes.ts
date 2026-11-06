import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const ensureForkProjectionIndexes = Effect.fn("persistence.ensureForkProjectionIndexes")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE INDEX IF NOT EXISTS fork_runs_fresh_context_idx
      ON orchestration_v2_projection_runs(thread_id, ordinal DESC)
      WHERE json_extract(payload_json, '$.freshContext') = 1
    `;
  },
);
