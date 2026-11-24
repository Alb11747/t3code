import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MessageSearch from "./MessageSearch.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const layerTest = Layer.mergeAll(
  MessageSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 24, 0, minute));
const project = ProjectId.make("project:messages");
const coordinator = ThreadId.make("thread:coordinator");
const worker = ThreadId.make("thread:worker");
const deleted = ThreadId.make("thread:deleted");

const createProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${project}`),
    aggregateKind: "project",
    aggregateId: project,
    occurredAt: DateTime.formatIso(at(0)),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: project,
      title: "Messages",
      workspaceRoot: "/work/messages",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at(0)),
      updatedAt: DateTime.formatIso(at(0)),
    },
  }),
);

const thread = (threadId: ThreadId, deletedAt: DateTime.Utc | null = null) =>
  ({
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: project,
      title: `Title of ${threadId}`,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt,
    },
  }) satisfies OrchestrationV2DomainEvent;

const message = (
  threadId: ThreadId,
  id: string,
  text: string,
  sender: {
    readonly role?: "user" | "assistant";
    readonly createdBy?: "user" | "agent";
    readonly senderThreadId?: ThreadId;
    readonly scheduledTaskId?: ScheduledTaskId;
    readonly streaming?: boolean;
    readonly runId?: RunId;
    // Stored order, not this time, is the order the search reads.
    readonly minute?: number;
  } = {},
) =>
  ({
    id: EventId.make(`message:${id}`),
    type: "message.updated",
    threadId,
    providerInstanceId,
    occurredAt: at(sender.minute ?? 1),
    payload: {
      createdBy: sender.createdBy ?? (sender.role === "assistant" ? "agent" : "user"),
      creationSource: sender.createdBy === "agent" ? "mcp" : "web",
      ...(sender.senderThreadId === undefined ? {} : { senderThreadId: sender.senderThreadId }),
      ...(sender.scheduledTaskId === undefined ? {} : { scheduledTaskId: sender.scheduledTaskId }),
      id: MessageId.make(id),
      threadId,
      runId: sender.runId ?? null,
      nodeId: null,
      role: sender.role ?? "user",
      text,
      attachments: [],
      streaming: sender.streaming ?? false,
      createdAt: at(sender.minute ?? 1),
      updatedAt: at(sender.minute ?? 1),
    },
  }) satisfies OrchestrationV2DomainEvent;

const ids = (result: MessageSearch.MessageSearchResult) =>
  result.matches.map((match) => match.messageId);

it.effect("filters by author and resumes from a saved cursor with only newer messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const messages = yield* MessageSearch.MessageSearch;
    const sql = yield* SqlClient.SqlClient;
    const apply = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.forEach(events, projections.apply, { discard: true });
    yield* createProject;
    yield* apply([
      thread(coordinator),
      thread(worker),
      thread(deleted, at(0)),
      // Imported history arrives with older times; it is still read after what came before.
      message(worker, "typed-1", "Farm the weekly boss first", { minute: 30 }),
      message(coordinator, "reply-1", "Noted", { role: "assistant" }),
      message(worker, "brief-1", "Do the dailies", {
        createdBy: "agent",
        senderThreadId: coordinator,
      }),
      message(worker, "scheduled-1", "Hourly check", {
        scheduledTaskId: ScheduledTaskId.make("task:hourly"),
      }),
      message(deleted, "typed-deleted", "Gone"),
      message(coordinator, "typed-2", "Never spend gems", { minute: 2 }),
    ]);

    const typed = yield* messages.search({ authors: ["user"], limit: 1, maxChars: 4 });
    assert.deepEqual(ids(typed), [MessageId.make("typed-1")]);
    assert.deepInclude(typed.matches[0], {
      author: "user",
      threadTitle: `Title of ${worker}`,
      text: "Farm",
      truncated: true,
    });
    assert.isTrue(typed.more);
    const rest = yield* messages.search({
      authors: ["user"],
      cursor: typed.nextCursor,
      limit: 10,
      maxChars: 100,
    });
    assert.deepEqual(ids(rest), [MessageId.make("typed-2")]);
    assert.isFalse(rest.more);

    // VACUUM may renumber rowids; the cursor still resumes after the same message.
    yield* sql`UPDATE orchestration_v2_projection_messages SET rowid = rowid + 50000`;
    // From the start, spans that now hold no rows still move the cursor on.
    let fromStart = yield* messages.search({ authors: ["user"], limit: 1, maxChars: 100 });
    const emptySpans = [];
    while (fromStart.matches.length === 0 && fromStart.more) {
      emptySpans.push(fromStart.nextCursor);
      fromStart = yield* messages.search({
        authors: ["user"],
        cursor: fromStart.nextCursor,
        limit: 1,
        maxChars: 100,
      });
    }
    assert.strictEqual(emptySpans.length, 2);
    assert.deepEqual(ids(fromStart), [MessageId.make("typed-1")]);
    yield* apply([message(coordinator, "typed-3", "Also skip the shop")]);
    const later = yield* messages.search({
      authors: ["user"],
      cursor: rest.nextCursor,
      limit: 10,
      maxChars: 100,
    });
    assert.deepEqual(ids(later), [MessageId.make("typed-3")]);
    const caughtUp = yield* messages.search({
      authors: ["user"],
      cursor: later.nextCursor,
      limit: 10,
      maxChars: 100,
    });
    assert.deepEqual(ids(caughtUp), []);
    assert.isFalse(caughtUp.more);

    const pastGap = emptySpans.at(-1);
    const fromCoordinator = yield* messages.search({
      cursor: pastGap,
      authors: ["agent"],
      senderThreadId: coordinator,
      limit: 10,
      maxChars: 100,
    });
    assert.deepEqual(ids(fromCoordinator), [MessageId.make("brief-1")]);
    assert.deepEqual(
      ids(
        yield* messages.search({
          threadId: worker,
          authors: ["scheduled_task"],
          limit: 10,
          maxChars: 100,
        }),
      ),
      [MessageId.make("scheduled-1")],
    );
    assert.deepEqual(
      ids(yield* messages.search({ cursor: pastGap, query: "SPEND", limit: 10, maxChars: 100 })),
      [MessageId.make("typed-2")],
    );
    const invalid = yield* Effect.flip(
      messages.search({ cursor: "not-a-cursor", limit: 10, maxChars: 100 }),
    );
    assert.strictEqual(invalid.reason, "invalid_cursor");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops before a reply still streaming in a live run, then returns it finished", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const messages = yield* MessageSearch.MessageSearch;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming");
    const runId = RunId.make("run:streaming");
    const apply = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.forEach(events, projections.apply, { discard: true });
    yield* createProject;
    yield* apply([thread(threadId)]);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, 1, 'codex', 'running', ${DateTime.formatIso(at(0))}, '{}')
    `;
    yield* apply([
      message(threadId, "streaming-reply", "Partial", {
        role: "assistant",
        streaming: true,
        runId,
      }),
      message(threadId, "after-reply", "Queued follow-up"),
    ]);

    const first = yield* messages.search({ threadId, limit: 10, maxChars: 100 });
    assert.deepEqual(ids(first), []);
    assert.isFalse(first.more);

    yield* apply([
      message(threadId, "streaming-reply", "Partial, now complete", { role: "assistant", runId }),
    ]);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    const resumed = yield* messages.search({
      threadId,
      cursor: first.nextCursor,
      limit: 10,
      maxChars: 100,
    });
    assert.deepEqual(ids(resumed), [
      MessageId.make("streaming-reply"),
      MessageId.make("after-reply"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);
