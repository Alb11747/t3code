import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_run_created_threads_idx
    ON orchestration_events(
      json_extract(metadata_json, '$.runId'),
      json_extract(metadata_json, '$.nodeId')
    )
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'thread.created'
  `;
});
