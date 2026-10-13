import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerDatabase = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["sqlite", "memory"] as const)(
  "loads startup state without obsolete transcript payloads in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:completion-reads");
      const runId = RunId.make("run:completion-reads");
      const messageId = MessageId.make("message:completion-reads");
      const instanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:completion-reads"),
        title: "Completion controls",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: NodeId.make("startup:root"),
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const putThread = (value: OrchestrationV2AppThread) =>
        store.apply({
          id: EventId.make(`event:thread:${value.id}`),
          type: "thread.created",
          threadId: value.id,
          occurredAt: now,
          payload: value,
        });
      const putRun = (value: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:run:${value.id}:${value.status}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      yield* putThread(thread);
      yield* putRun(run);
      const scopeId = CheckpointScopeId.make("startup:shared-scope");
      yield* store.apply({
        id: EventId.make("startup:root-event"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: run.rootNodeId!,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: run.rootNodeId!,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("startup:scope-event"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:old"),
          nodeId: NodeId.make("startup:earlier-root"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      const message = {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Continue",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "server" as const,
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      };
      yield* store.apply({
        id: EventId.make("event:input"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      });
      const oldRunId = RunId.make("run:old");
      yield* putRun({ ...run, id: oldRunId, ordinal: 1, status: "completed" });
      const item = {
        id: TurnItemId.make("item:history"),
        threadId,
        runId: oldRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "old command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo history",
        output: "historical result",
      };
      yield* store.apply({
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: item,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0,
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            type, status, ordinal, updated_at, payload_json)
          VALUES ('obsolete-tool', ${threadId}, ${oldRunId}, NULL, NULL, NULL,
            'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const selected = yield* store.getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageIds: [messageId],
      });
      assert.deepEqual(Object.keys(selected).sort(), ["messages", "runs", "thread"]);
      assert.deepEqual(
        selected.runs.map((r) => r.id),
        [runId],
      );
      assert.deepEqual(
        selected.messages.map((m) => m.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: oldRunId,
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: runId,
        })).turnItems,
        [],
      );
      assert.equal(yield* store.getNextTurnItemOrdinal(threadId), storage === "sqlite" ? 3 : 2);
      assert.equal(yield* store.getMessageCount(threadId), storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], {
          messageRunIds: [runId],
        })).messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageRunIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunIds: [oldRunId],
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], { turnItemRunIds: [] })).turnItems,
        [],
      );
      const requestTurnId = ProviderTurnId.make("startup:request-turn");
      const requests = [requestTurnId, ProviderTurnId.make("startup:other-turn"), null].map(
        (providerTurnId, index) => ({
          id: RuntimeRequestId.make(`startup:request:${index}`),
          nodeId: NodeId.make(`startup:request-node:${index}`),
          providerTurnId,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "cancelled" as const,
          responseCapability: { type: "not_resumable" as const, reason: "Cancelled" },
          createdAt: now,
          resolvedAt: now,
        }),
      );
      for (const request of requests) {
        yield* store.apply({
          id: EventId.make(`event:${request.id}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: request,
        });
      }
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["runtimeRequests"])).runtimeRequests,
        requests,
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["runtimeRequests"], {
          runtimeRequestProviderTurnIds: [requestTurnId],
        })).runtimeRequests,
        [requests[0]!],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["runtimeRequests"], {
          runtimeRequestProviderTurnIds: [],
        })).runtimeRequests,
        [],
      );
      assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), []);
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_object('text', ${"x".repeat(512_000)}, 'attachments', json_array(json_object('id', 'attachment:old'))) WHERE message_id = 'obsolete-history'`;
        assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), ["attachment:old"]);
      }
      const page = yield* store.getTimelinePage(threadId, { view: "activity", limit: 1 });
      assert.deepEqual(
        page.items.map((row) => row.item),
        [item],
      );
      assert.equal(page.hasMore, storage === "sqlite");
      assert.equal(page.totalItems, storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getTimelinePage(threadId, { view: "messages", limit: 1 })).items,
        [],
      );
      const context = yield* store.getTurnStartContext(threadId, runId);
      assert.equal(context.thread.id, threadId);
      assert.deepEqual(
        context.checkpointScopes.map((scope) => scope.id),
        [scopeId],
      );
      assert.equal(context.messages.find((m) => m.id === messageId)?.text, "Continue");
      assert.isTrue(context.hasConversation);
      assert.deepEqual(context.turnItems, []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [oldRunId]), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      const { input: _input, output: _output, ...itemBase } = item;
      const compacted = {
        ...itemBase,
        id: TurnItemId.make("item:compaction"),
        type: "compaction" as const,
        driver: ProviderDriverKind.make("codex"),
        ordinal: 3,
        summary: "Retained context",
      };
      for (const marker of [
        compacted,
        {
          ...compacted,
          id: TurnItemId.make("item:pending-compaction"),
          status: "running" as const,
        },
      ]) {
        yield* store.apply({
          id: EventId.make(`event:${marker.id}`),
          type: "turn-item.updated",
          threadId,
          runId: oldRunId,
          occurredAt: now,
          payload: marker,
        });
      }
      const currentCompacted = {
        ...compacted,
        id: TurnItemId.make("item:current-compaction"),
        runId,
        ordinal: 4,
      };
      yield* store.apply({
        id: EventId.make("event:current-compaction"),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: currentCompacted,
      });
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const startup = yield* store
        .getTurnStartContext(threadId, runId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.deepEqual(startup.turnItems, [compacted, currentCompacted]);
      if (storage === "sqlite") {
        const itemQuery = queries.find(([query]) =>
          query.includes("FROM orchestration_v2_projection_turn_items"),
        );
        assert.isDefined(itemQuery);
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${itemQuery![0]}`,
          itemQuery![1],
        );
        const lookups = plan.map((row) => row.detail);
        assert.include(
          lookups,
          "SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_thread_run_idx (thread_id=? AND run_id=?)",
        );
        assert.include(
          lookups,
          "SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_completed_compaction_idx (thread_id=?)",
        );
        const messageQuery = queries.find(
          ([query]) =>
            query.includes("FROM orchestration_v2_projection_messages") &&
            !query.includes("SELECT EXISTS"),
        );
        assert.isDefined(messageQuery);
        const messagePlan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${messageQuery![0]}`,
          messageQuery![1],
        );
        const messageLookups = messagePlan.map((row) => row.detail);
        assert.include(
          messageLookups,
          "SEARCH orchestration_v2_projection_messages USING INDEX sqlite_autoindex_orchestration_v2_projection_messages_1 (message_id=?)",
        );
        assert.include(
          messageLookups,
          "SEARCH orchestration_v2_projection_messages USING INDEX orchestration_v2_projection_messages_compact_idx (thread_id=?)",
        );
      }
      assert.deepEqual(yield* store.getTurnStartHistory(threadId), [item]);
      // Pairing depends on IDs, not payload decoding or item status.
      const resultId = TurnItemId.make("interrupt-result");
      assert.isTrue(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, resultId, item.id));
      assert.isFalse(
        yield* store.hasUnpairedRunInterruptRequest(
          ThreadId.make("other-thread"),
          item.id,
          resultId,
        ),
      );
      yield* store.apply({
        id: EventId.make("interrupt-result-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: { ...item, id: resultId },
      });
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        const original = yield* sql<{ payload_json: string }>`SELECT payload_json
          FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = 'invalid JSON' WHERE turn_item_id = ${item.id}`;
        assert.isTrue(
          yield* store.hasUnpairedRunInterruptRequest(
            threadId,
            item.id,
            TurnItemId.make("absent-result"),
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${original[0]!.payload_json} WHERE turn_item_id = ${item.id}`;
      }
      const trimWhitespace =
        " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
      for (const text of [
        "/compact",
        ...[...trimWhitespace].map((space) => `${space}/COMPACT${space}`),
      ]) {
        yield* store.apply({
          id: EventId.make("compact-input"),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...message, text },
        });
        const compactStartup = yield* store.getTurnStartContext(threadId, runId);
        assert.isFalse(compactStartup.hasConversation);
        assert.deepEqual(compactStartup.messages, [{ ...message, text }]);
      }
      const marker = {
        ...message,
        id: MessageId.make("old-compact"),
        runId: oldRunId,
        text: "\t/COMPACT\n",
      };
      yield* store.apply({
        id: EventId.make("old-compact-input"),
        type: "message.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: marker,
      });
      assert.deepEqual(
        (yield* store.getTurnStartContext(threadId, runId)).messages.map((m) => m.id),
        [messageId, marker.id],
      );
      const other = ThreadId.make("other");
      yield* putThread({ ...thread, id: other });
      assert.deepEqual((yield* store.getTurnStartContext(other, runId)).messages, []);
      assert.deepEqual(yield* store.getTurnStartHistory(other, [oldRunId]), []);
      assert.isFalse((yield* store.getTurnStartContext(other, runId)).hasConversation);
      assert.instanceOf(
        yield* store.getTurnStartContext(ThreadId.make("missing"), runId).pipe(Effect.flip),
        ProjectionStore.ProjectionStoreThreadNotFoundError,
      );
    }).pipe(
      Effect.provide(
        storage === "sqlite"
          ? layerDatabase
          : Layer.merge(SqlitePersistence.layerMemory, ProjectionStore.layerMemory),
      ),
    ),
);
