import { type OrchestrationV2DomainEvent, type ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const active = ["preparing", "queued", "starting", "running", "waiting"] as const;

class DelegatedProjectRemovedError extends Schema.TaggedError<DelegatedProjectRemovedError>()(
  "DelegatedProjectRemovedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Cannot start delegated work in ${this.threadId} because its owner or destination is being removed or was deleted. Start a new thread in an existing project.`;
  }
}

export function make(sql: SqlClient.SqlClient) {
  // One EventSink owns this environment's writer. Overlapping delete calls hold independent claims.
  const deleting = new Map<ProjectId, number>();
  const activeStatuses = sql.in(active);
  const blockedChild = (input: { owner: ProjectId } | { threads: ReadonlySet<ThreadId> }) =>
    sql<{ thread_id: ThreadId; title: string }>`
      WITH RECURSIVE owners(child_id, owner_id) AS (
        SELECT e.child_thread_id, e.thread_id FROM orchestration_v2_projection_subagents e
        WHERE e.origin = 'app_owned' AND e.child_thread_id IN (
          ${
            "owner" in input
              ? sql`SELECT r.thread_id FROM orchestration_v2_projection_runs r WHERE r.status IN ${activeStatuses}`
              : sql`SELECT value FROM json_each(${JSON.stringify([...input.threads])})`
          }
        )
        UNION
        SELECT o.child_id, e.thread_id FROM owners o
        JOIN orchestration_v2_projection_subagents e ON e.child_thread_id = o.owner_id
        WHERE e.origin = 'app_owned'
      )
      SELECT child.thread_id, child.title FROM owners o
      JOIN orchestration_v2_projection_threads child ON child.thread_id = o.child_id
      JOIN orchestration_v2_projection_threads parent ON parent.thread_id = o.owner_id
      LEFT JOIN projection_projects owner ON owner.project_id = parent.project_id
      LEFT JOIN projection_projects destination ON destination.project_id = child.project_id
      WHERE parent.project_id <> child.project_id
      AND ${
        "owner" in input
          ? sql`parent.project_id = ${input.owner} AND child.deleted_at IS NULL`
          : sql`(parent.deleted_at IS NOT NULL OR owner.deleted_at IS NOT NULL OR destination.deleted_at IS NOT NULL
          ${deleting.size ? sql`OR parent.project_id IN ${sql.in([...deleting.keys()])} OR child.project_id IN ${sql.in([...deleting.keys()])}` : sql``})`
      }
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  // Mark before reading on the writer connection. An already-committing run is visible to the read;
  // later commits see the mark until deletion finishes and the durable tombstone takes over.
  const claim = (owner: ProjectId) =>
    Effect.acquireRelease(
      Effect.sync(() => deleting.set(owner, (deleting.get(owner) ?? 0) + 1)),
      () =>
        Effect.sync(() => {
          const remaining = deleting.get(owner)! - 1;
          if (remaining === 0) deleting.delete(owner);
          else deleting.set(owner, remaining);
        }),
    ).pipe(Effect.andThen(sql.withTransaction(blockedChild({ owner }))));

  const startsWork = (
    event: Extract<OrchestrationV2DomainEvent, { type: "run.created" | "run.updated" }>,
  ) => {
    if (!active.some((status) => status === event.payload.status)) return Effect.succeed(false);
    if (event.type === "run.created") return Effect.succeed(true);
    return sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id} AND status IN ${activeStatuses}`.pipe(
      Effect.map((rows) => rows.length === 0),
    );
  };

  const checkAdmission = Effect.fn("DelegatedProjectDeletion.checkAdmission")(function* (
    threads: ReadonlySet<ThreadId>,
  ) {
    if (threads.size === 0) return;
    const child = yield* blockedChild({ threads });
    if (child !== null)
      return yield* new DelegatedProjectRemovedError({ threadId: child.thread_id });
  });
  return { claim, startsWork, checkAdmission };
}
