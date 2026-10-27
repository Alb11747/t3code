import {
  OrchestrationV2CompactionForkSupport,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const encodeTimelineSources = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ threadId: Schema.String, id: Schema.String })),
  ),
);
const decodeCompactionForkSupport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CompactionForkSupport),
);

// Hydration shares the enclosing projection read's span.
export const hydrateCompactionForkSupport = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  const compactions = items.filter(
    (row) => row.item.type === "compaction" && row.item.status === "completed",
  );
  if (compactions.length === 0) return items;
  const sources = yield* encodeTimelineSources(
    compactions.map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
  );
  // Fetch only the evidence for these markers, including inherited sources.
  // History paging deliberately does not load full provider/control records.
  const rows = yield* sql<{
    thread_id: string;
    turn_item_id: string;
    support_json: string;
  }>`
        SELECT item.thread_id, item.turn_item_id,
          CASE WHEN session.payload_json IS NULL THEN
            json_object('runStatus', run.status,
              'nativeTurnRef', json_extract(turn.payload_json, '$.nativeTurnRef'))
          ELSE
            -- Merge patch deletes null-valued capability fields; preserve the stored JSON.
            json_object('runStatus', run.status,
              'nativeTurnRef', json_extract(turn.payload_json, '$.nativeTurnRef'),
              'capabilities', json_extract(session.payload_json, '$.capabilities'))
          END AS support_json
        FROM orchestration_v2_projection_turn_items item
        JOIN json_each(${sources}) wanted
          ON item.thread_id = json_extract(wanted.value, '$.threadId')
          AND item.turn_item_id = json_extract(wanted.value, '$.id')
        JOIN orchestration_v2_projection_runs run
          ON run.thread_id = item.thread_id AND run.run_id = item.run_id
        LEFT JOIN orchestration_v2_projection_provider_turns turn
          ON turn.thread_id = item.thread_id
          AND turn.provider_turn_id = json_extract(item.payload_json, '$.providerTurnId')
        LEFT JOIN orchestration_v2_projection_provider_threads provider_thread
          ON provider_thread.thread_id = item.thread_id
          AND provider_thread.provider_thread_id = json_extract(item.payload_json, '$.providerThreadId')
        LEFT JOIN orchestration_v2_projection_provider_sessions session
          ON session.provider_session_id = json_extract(provider_thread.payload_json, '$.providerSessionId')
      `;
  const support = new Map(
    yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const value = yield* decodeCompactionForkSupport(row.support_json);
        return [`${row.thread_id}:${row.turn_item_id}`, value] as const;
      }),
    ),
  );
  return items.map((row) => {
    const retained = support.get(`${row.sourceThreadId}:${row.sourceItemId}`);
    return retained === undefined ? row : { ...row, compactionForkSupport: retained };
  });
});
