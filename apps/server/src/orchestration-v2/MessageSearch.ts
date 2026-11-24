import { IsoDateTime, MessageId, ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { withoutWebhookUrlToken } from "../scheduledTasks/webhookUrlToken.ts";
import { messageSearchText, nonPlaceholderMessageCondition } from "./messageSearchIndex.ts";

/**
 * Who wrote a message: `user` a person typing, `agent` another agent or T3's own tools,
 * `scheduled_task` a scheduled prompt, `assistant` the thread's own agent.
 */
export const MessageAuthor = Schema.Literals(["user", "agent", "scheduled_task", "assistant"]);
export type MessageAuthor = typeof MessageAuthor.Type;

export class MessageSearchError extends Schema.TaggedError<MessageSearchError>()(
  "MessageSearchError",
  {
    reason: Schema.Literals(["invalid_cursor", "query"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "invalid_cursor"
      ? "The cursor is not one this search returned."
      : "Message search failed.";
  }
}

/**
 * A place in the messages table's insertion order. Rowids are not durable (VACUUM may renumber
 * them), so the message id anchors the place and the rowid is only the fallback when that
 * message is gone. `from` resumes at the anchor itself, for a message still being written.
 */
const CursorPosition = Schema.Struct({
  v: Schema.Literal(1),
  rowid: Schema.Int,
  id: Schema.NullOr(Schema.String),
  from: Schema.optional(Schema.Boolean),
});
type CursorPosition = typeof CursorPosition.Type;
const CURSOR_PREFIX = "msg1.";
const decodeCursorJson = Schema.decodeUnknownOption(Schema.fromJsonString(CursorPosition));

const encodeCursor = (position: CursorPosition) =>
  CURSOR_PREFIX + Buffer.from(JSON.stringify(position)).toString("base64url");

const decodeCursor = (cursor: string) =>
  cursor.startsWith(CURSOR_PREFIX)
    ? decodeCursorJson(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString())
    : decodeCursorJson(undefined);

// Rows one call reads across all threads, so a rare author or word cannot read all history
// in one call. One thread reads through its own index and needs no window.
const SCAN_WINDOW_ROWS = 20_000;

const authorSql = `CASE
  WHEN messages.role = 'assistant' THEN 'assistant'
  WHEN json_extract(messages.payload_json, '$.scheduledTaskId') IS NOT NULL THEN 'scheduled_task'
  WHEN COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user' THEN 'user'
  ELSE 'agent'
END`;

const TokenList = Schema.fromJsonString(Schema.Array(Schema.String));
const CandidatesRequest = Schema.Struct({
  after: Schema.Number,
  through: Schema.Number,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  roles: TokenList,
  authors: TokenList,
  senderThreadId: Schema.NullOr(ThreadId),
  query: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});
const CandidateRow = Schema.Struct({
  rowid: Schema.Number,
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  author: MessageAuthor,
  senderThreadId: Schema.NullOr(ThreadId),
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  createdAt: IsoDateTime,
  unfinished: Schema.Number,
  text: Schema.NullOr(Schema.String),
});
const RowRef = Schema.Struct({ rowid: Schema.Number, messageId: Schema.String });

export interface MessageSearchInput {
  readonly threadId?: ThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly authors?: ReadonlyArray<MessageAuthor> | undefined;
  readonly senderThreadId?: ThreadId | undefined;
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly maxChars: number;
}

export interface MessageSearchMatch {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly author: MessageAuthor;
  readonly senderThreadId?: ThreadId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly createdAt: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface MessageSearchResult {
  readonly matches: ReadonlyArray<MessageSearchMatch>;
  /** Pass back as `cursor` for only the messages stored after these. */
  readonly nextCursor: string;
  /** True when more stored messages remain to read now; false when caught up. */
  readonly more: boolean;
}

export class MessageSearch extends Context.Service<
  MessageSearch,
  {
    /** Messages in the order they were stored, from `cursor` on, filtered by thread and author. */
    readonly search: (
      input: MessageSearchInput,
    ) => Effect.Effect<MessageSearchResult, MessageSearchError>;
  }
>()("t3/orchestration-v2/MessageSearch") {}

const rolesFor = (authors: ReadonlyArray<MessageAuthor>) => [
  ...new Set(authors.map((author) => (author === "assistant" ? "assistant" : "user"))),
];

/** A cut inside a surrogate pair would leave half an emoji. */
const truncate = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return { text, truncated: false };
  const last = text.charCodeAt(maxChars - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars;
  return { text: text.slice(0, end), truncated: true };
};

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const anchorRowid = SqlSchema.findAll({
    Request: Schema.Struct({ messageId: Schema.String }),
    Result: Schema.Struct({ rowid: Schema.Number }),
    execute: ({ messageId }) => sql`
      SELECT rowid FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}
    `,
  });

  const lastRow = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RowRef,
    execute: () => sql`
      SELECT rowid, message_id AS "messageId" FROM orchestration_v2_projection_messages
      ORDER BY rowid DESC LIMIT 1
    `,
  });

  const lastAtOrBefore = SqlSchema.findAll({
    Request: Schema.Struct({ rowid: Schema.Number }),
    Result: RowRef,
    execute: ({ rowid }) => sql`
      SELECT rowid, message_id AS "messageId" FROM orchestration_v2_projection_messages
      WHERE rowid <= ${rowid}
      ORDER BY rowid DESC LIMIT 1
    `,
  });

  // A message still streaming in a live run is returned as `unfinished` whatever its text, so
  // the page can stop before it instead of passing it before it is written.
  const candidates = SqlSchema.findAll({
    Request: CandidatesRequest,
    Result: CandidateRow,
    execute: (request) => sql`
      SELECT
        messages.rowid AS rowid,
        messages.message_id AS "messageId",
        messages.thread_id AS "threadId",
        threads.project_id AS "projectId",
        threads.title AS "threadTitle",
        ${sql.literal(authorSql)} AS author,
        json_extract(messages.payload_json, '$.senderThreadId') AS "senderThreadId",
        json_extract(messages.payload_json, '$.scheduledTaskId') AS "scheduledTaskId",
        messages.created_at AS "createdAt",
        (messages.streaming = 1 AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS runs
          WHERE runs.run_id = messages.run_id
            AND runs.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        )) AS unfinished,
        json_extract(messages.payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages AS messages
      INNER JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = messages.thread_id
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE ${
        request.threadId === null
          ? sql`messages.rowid > ${request.after} AND messages.rowid <= ${request.through}`
          : // Unary + keeps SQLite on the thread's index instead of a rowid range over all threads.
            sql`messages.thread_id = ${request.threadId}
              AND +messages.rowid > ${request.after} AND +messages.rowid <= ${request.through}`
      }
        AND messages.role IN (SELECT value FROM json_each(${request.roles}))
        AND threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        AND (${request.projectId} IS NULL OR threads.project_id = ${request.projectId})
        AND ${sql.literal(authorSql)} IN (SELECT value FROM json_each(${request.authors}))
        AND (${request.senderThreadId} IS NULL
          OR json_extract(messages.payload_json, '$.senderThreadId') = ${request.senderThreadId})
        AND (
          unfinished
          OR (
            (${request.query} IS NULL
              OR instr(lower(${messageSearchText(sql)}), lower(${request.query})) > 0)
            AND ${nonPlaceholderMessageCondition(sql)}
          )
        )
      ORDER BY messages.rowid
      LIMIT ${request.limit}
    `,
  });

  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new MessageSearchError({ reason: "query", cause })),
    );

  const startAfter = Effect.fn("MessageSearch.startAfter")(function* (
    position: CursorPosition | null,
  ) {
    if (position === null) return 0;
    if (position.id === null) return position.rowid;
    const [anchor] = yield* anchorRowid({ messageId: position.id });
    // A purged anchor's rowid can be reused by the next insert, so resume at it, not after. Rows
    // that fill purged rowids below it are missed; only purging the newest messages does that.
    if (anchor === undefined) return position.rowid - 1;
    return position.from === true ? anchor.rowid - 1 : anchor.rowid;
  });

  const search: MessageSearch["Service"]["search"] = Effect.fn("MessageSearch.search")(
    function* (input) {
      const position =
        input.cursor === undefined
          ? null
          : yield* Effect.fromOption(decodeCursor(input.cursor)).pipe(
              Effect.mapError(() => new MessageSearchError({ reason: "invalid_cursor" })),
            );
      const authors = input.authors ?? MessageAuthor.literals;
      return yield* read(
        Effect.gen(function* () {
          const after = yield* startAfter(position);
          const [last] = yield* lastRow(undefined);
          if (last === undefined || last.rowid <= after) {
            return {
              matches: [],
              nextCursor: input.cursor ?? encodeCursor({ v: 1, rowid: after, id: null }),
              more: false,
            };
          }
          // Rowids are dense enough that a fixed span bounds the rows read without walking them.
          const windowed = input.threadId === undefined && after + SCAN_WINDOW_ROWS < last.rowid;
          const [end] = windowed
            ? yield* lastAtOrBefore({ rowid: after + SCAN_WINDOW_ROWS })
            : [undefined];
          // A span with no rows left still moves the cursor past it.
          const through = !windowed
            ? last
            : end !== undefined && end.rowid > after
              ? end
              : { rowid: after + SCAN_WINDOW_ROWS, messageId: null };
          const rows = yield* candidates({
            after,
            through: through.rowid,
            threadId: input.threadId ?? null,
            projectId: input.projectId ?? null,
            roles: rolesFor(authors),
            authors: [...authors],
            senderThreadId: input.senderThreadId ?? null,
            query: input.query ?? null,
            limit: input.limit + 1,
          });
          const matches: Array<(typeof rows)[number]> = [];
          let next: { readonly cursor: CursorPosition; readonly more: boolean } | undefined;
          for (const row of rows) {
            if (row.unfinished !== 0) {
              next = {
                cursor: { v: 1, rowid: row.rowid, id: row.messageId, from: true },
                more: false,
              };
              break;
            }
            if (matches.length === input.limit) break;
            matches.push(row);
          }
          const lastMatch = matches.at(-1);
          next ??=
            rows.length > input.limit && lastMatch !== undefined
              ? { cursor: { v: 1, rowid: lastMatch.rowid, id: lastMatch.messageId }, more: true }
              : {
                  cursor: { v: 1, rowid: through.rowid, id: through.messageId },
                  more: through.rowid < last.rowid,
                };
          return {
            matches: matches.map((row) => {
              const { text, truncated } = truncate(
                withoutWebhookUrlToken(row.text ?? ""),
                input.maxChars,
              );
              return {
                messageId: row.messageId,
                threadId: row.threadId,
                projectId: row.projectId,
                threadTitle: row.threadTitle,
                author: row.author,
                ...(row.senderThreadId === null ? {} : { senderThreadId: row.senderThreadId }),
                ...(row.scheduledTaskId === null ? {} : { scheduledTaskId: row.scheduledTaskId }),
                createdAt: row.createdAt,
                text,
                truncated,
              };
            }),
            nextCursor: encodeCursor(next.cursor),
            more: next.more,
          };
        }),
      );
    },
  );

  return MessageSearch.of({ search });
});

export const layer = Layer.effect(MessageSearch, make);
