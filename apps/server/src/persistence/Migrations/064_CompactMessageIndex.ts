import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep the literal JavaScript trim character set aligned with getTurnStartContext.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_compact_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE role = 'user' AND lower(trim(json_extract(payload_json, '$.text'),
      char(32, 9, 10, 13, 11, 12, 160, 5760, 8192, 8193, 8194, 8195, 8196,
        8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = '/compact'
  `;
});
