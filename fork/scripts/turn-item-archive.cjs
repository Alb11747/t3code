#!/usr/bin/env node
// Moves old tool output out of T3 Code's database into zstd archive files and
// restores it on demand. It changes no schema: archived rows keep a schema-valid
// stub (head, marker, tail) that upstream T3 renders as text. Runs beside a live
// server (WAL, short BEGIN IMMEDIATE batches); see fork/CHANGES.md.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const FORMAT_VERSION = 1;
const ZSTD_LEVEL = 10;
const MIN_LEAF = 8192;
const COMMAND_HEAD = 1024;
const COMMAND_TAIL = 3072;
const TOOL_HEAD = 1536;
const TOOL_TAIL = 1536;
const NEWLINE_SNAP = 256;
const BATCH_ROWS = 25;
const BATCH_BYTES = 4 * 1024 * 1024;
const SLOW_COMMIT_MS = 500;
const CHECKPOINT_EVERY_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_WAIT_MS = 60_000;
const VERIFY_ROWID_SPAN = 2000;
const TOOL_TYPES = ["command_execution", "dynamic_tool"];
const SETTLED_STATUSES = ["completed", "failed", "cancelled", "interrupted"];
const LIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];
const MARKER_TEXT = "[t3-archive:";
const MARKER_PATTERN = /\[t3-archive:([0-9a-f]{16})\] \d+ characters archived\. Full output: /g;
// T3's own tools (every server alias T3 records) feed links, summaries and failure
// checks from their output, so they stay whole; their results are small anyway.
const T3_TOOL_PATTERN = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:[-_ ]?direct)?(?:__|[-_.:/ ])/i;

const ITEMS = "orchestration_v2_projection_turn_items";
const REQUIRED_COLUMNS = [
  "turn_item_id",
  "thread_id",
  "type",
  "status",
  "updated_at",
  "payload_json",
  "inline_work_output",
];
const sqlList = (values) => values.map((value) => `'${value}'`).join(",");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const threadKey = (threadId) => sha256(threadId).slice(0, 16);
const byteLength = (text) => Buffer.byteLength(text, "utf8");

function parseDuration(text) {
  const match = /^(\d+)([dh])$/.exec(text);
  if (!match) throw new Error(`Expected a duration like 14d or 36h, got ${text}`);
  return Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
}

function cutHead(text, size) {
  let end = Math.min(size, text.length);
  const newline = text.lastIndexOf("\n", end);
  if (newline >= end - NEWLINE_SNAP && newline > 0) end = newline + 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function cutTail(text, size) {
  let start = Math.max(0, text.length - size);
  const newline = text.indexOf("\n", start);
  if (newline !== -1 && newline < start + NEWLINE_SNAP) start = newline + 1;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

function marker(context, omitted) {
  return `\n${MARKER_TEXT}${context.archiveId}] ${omitted} characters archived. Full output: node fork/scripts/turn-item-archive.cjs view --thread ${context.threadId} --item ${context.itemId}\n`;
}

function stubText(text, head, tail, context) {
  const kept = cutHead(text, head);
  const end = cutTail(text, tail);
  return kept + marker(context, text.length - kept.length - end.length) + end;
}

function looksLikeJson(text) {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return false;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function binaryBlock(block) {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  if (block.type === "image") {
    if (typeof block.data === "string") {
      return { kind: "image", data: block.data, mime: block.mimeType };
    }
    const source = block.source;
    if (source && typeof source === "object" && typeof source.data === "string") {
      return { kind: "image", data: source.data, mime: source.media_type };
    }
  }
  if (block.type === "resource" && block.resource && typeof block.resource.blob === "string") {
    return { kind: "resource", data: block.resource.blob, mime: block.resource.mimeType };
  }
  return undefined;
}

/**
 * Returns the stubbed payload JSON for one row, or a reason to leave it alone.
 * Rows whose JSON wouldn't survive a parse/stringify round trip are skipped, so
 * the stub never rewrites a sibling field (large integers, odd escapes).
 */
function stubRow(row, archiveId) {
  if (row.inline_work_output === 1) return { skip: "inline output" };
  if (row.payload_json.includes(MARKER_TEXT)) return { skip: "already archived" };
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return { skip: "unparseable payload" };
  }
  if (JSON.stringify(payload) !== row.payload_json) return { skip: "non-canonical JSON" };
  const context = { archiveId, threadId: row.thread_id, itemId: row.turn_item_id };
  if (row.type === "command_execution") {
    if (typeof payload.output !== "string" || payload.output.length <= MIN_LEAF) {
      return { skip: "small" };
    }
    // Without an exit code, T3 decides failure from the output text itself.
    if (typeof payload.exitCode !== "number") return { skip: "no exit code" };
    if (looksLikeJson(payload.output)) return { skip: "JSON output" };
    payload.output = stubText(payload.output, COMMAND_HEAD, COMMAND_TAIL, context);
  } else if (row.type === "dynamic_tool") {
    if (typeof payload.toolName === "string" && T3_TOOL_PATTERN.test(payload.toolName)) {
      return { skip: "T3 tool" };
    }
    if (payload.output === undefined) return { skip: "small" };
    const state = { changed: false, skip: undefined, bigImage: false };
    scanBlocks(payload.output, state);
    const output = rewriteLeaves(payload.output, state, context);
    if (state.skip) return { skip: state.skip };
    if (!state.changed) return { skip: "small" };
    payload.output = output;
  } else {
    return { skip: "type" };
  }
  const stub = JSON.stringify(payload);
  if (stub.length >= row.payload_json.length) return { skip: "no saving" };
  return { stub };
}

function scanBlocks(value, state) {
  if (Array.isArray(value)) {
    for (const entry of value) scanBlocks(entry, state);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const block = binaryBlock(value);
  if (block) {
    if (block.kind === "image" && block.data.length > MIN_LEAF) state.bigImage = true;
    return;
  }
  if ("t3McpApp" in value) state.skip = "MCP app";
  for (const key of Object.keys(value)) scanBlocks(value[key], state);
}

function rewriteLeaves(value, state, context) {
  if (state.skip) return value;
  if (typeof value === "string") {
    if (value.length <= MIN_LEAF) return value;
    // JSON text is parsed by T3's summaries and failure checks; cutting it breaks them.
    if (looksLikeJson(value)) {
      state.skip = "JSON text output";
      return value;
    }
    state.changed = true;
    return stubText(value, TOOL_HEAD, TOOL_TAIL, context);
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteLeaves(entry, state, context));
  if (value === null || typeof value !== "object") return value;
  const block = binaryBlock(value);
  if (block) {
    // Once one image goes, every image does, so the image indices clients use stay consistent.
    const replace = block.kind === "image" ? state.bigImage : block.data.length > MIN_LEAF;
    if (!replace) return value;
    state.changed = true;
    const note = marker(context, block.data.length).trimEnd();
    return {
      type: "text",
      text: `[${block.kind} ${block.mime ?? "unknown type"}, ${block.data.length} base64 characters]${note}`,
    };
  }
  const result = {};
  for (const key of Object.keys(value)) result[key] = rewriteLeaves(value[key], state, context);
  return result;
}

function openDatabase(file, { write }) {
  if (!fs.existsSync(file)) throw new Error(`No database at ${file}`);
  const db = new DatabaseSync(file, write ? {} : { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
    if (mode !== "wal") throw new Error(`Expected a WAL database, found journal_mode=${mode}`);
    const columns = new Set(
      db
        .prepare(`PRAGMA table_info(${ITEMS})`)
        .all()
        .map((c) => c.name),
    );
    const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name));
    if (missing.length > 0) {
      throw new Error(`Unexpected schema: ${ITEMS} lacks ${missing.join(", ")}`);
    }
    if (write) {
      // Match the server's settings; the tool checkpoints passively between batches.
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("PRAGMA journal_size_limit = 134217728");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const hasTable = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

function idleQuery(db) {
  const transfers = hasTable(db, "orchestration_v2_projection_context_transfers")
    ? `EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers
        WHERE (source_thread_id = $thread OR target_thread_id = $thread) AND status = 'pending')`
    : "0";
  return db.prepare(`
    SELECT
      (SELECT deleted_at IS NULL FROM orchestration_v2_projection_threads WHERE thread_id = $thread) AS present,
      EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
        WHERE thread_id = $thread AND status IN (${sqlList(LIVE_RUN_STATUSES)})) AS live_run,
      EXISTS (SELECT 1 FROM orchestration_v2_projection_context_handoffs
        WHERE thread_id = $thread AND (status = 'pending' OR
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.delivery.status') = 'pending' ELSE 0 END)) AS pending_handoff,
      ${transfers} AS pending_transfer`);
}

function threadIdle(query, threadId) {
  const row = query.get({ $thread: threadId });
  return (
    row.present === 1 &&
    row.live_run === 0 &&
    row.pending_handoff === 0 &&
    row.pending_transfer === 0
  );
}

function candidateThreads(db, onlyThread) {
  if (onlyThread !== undefined) return [onlyThread];
  return db
    .prepare(
      "SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY thread_id",
    )
    .all()
    .map((row) => row.thread_id);
}

// Pages along (thread_id, type, status, rowid) in thread_type_idx, each fully read in
// its own short statement, so no read snapshot stays open across writes.
// octet_length reads no overflow pages, and UTF-8 bytes >= UTF-16 units, so nothing is missed.
function* candidateRows(db, threadId, cutoff) {
  const page = db.prepare(
    `SELECT rowid AS row_key, turn_item_id, thread_id, type, payload_json, inline_work_output FROM ${ITEMS}
     WHERE thread_id = $thread AND type = $type AND status = $status AND rowid > $after
       AND updated_at < $cutoff AND octet_length(payload_json) > ${MIN_LEAF}
     ORDER BY rowid LIMIT ${BATCH_ROWS}`,
  );
  for (const type of TOOL_TYPES) {
    for (const status of SETTLED_STATUSES) {
      let after = 0;
      for (;;) {
        const rows = page.all({
          $thread: threadId,
          $type: type,
          $status: status,
          $after: after,
          $cutoff: cutoff,
        });
        if (rows.length === 0) break;
        yield* rows;
        after = rows[rows.length - 1].row_key;
      }
    }
  }
}

// PASSIVE never waits on or blocks the server. Once every frame is copied back, the next
// writer restarts the WAL from its beginning, so the WAL stops growing.
async function checkpoint(db, sleep) {
  const started = Date.now();
  for (let wait = 250; ; wait = Math.min(wait * 2, 5000)) {
    const result = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    if (result.busy === 0 && result.log === result.checkpointed) return;
    if (Date.now() - started > CHECKPOINT_WAIT_MS) {
      throw new Error(
        "The WAL couldn't be checkpointed for a minute (a reader holds it); stopping so it can drain.",
      );
    }
    await sleep(wait);
  }
}

function writeTracker(db, sleep) {
  let written = 0;
  return {
    async wrote(bytes) {
      written += bytes;
      if (written < CHECKPOINT_EVERY_BYTES) return;
      await checkpoint(db, sleep);
      written = 0;
    },
    async finish() {
      if (written > 0) await checkpoint(db, sleep);
    },
  };
}

async function withWriteTransaction(db, body, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (!/database is locked|SQLITE_BUSY/i.test(String(error?.message)) || attempt >= 4) {
        throw error;
      }
      await sleep(250 * 2 ** attempt);
    }
  }
  const started = performance.now();
  try {
    const result = body();
    db.exec("COMMIT");
    return { result, ms: performance.now() - started };
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error explains the failure; a failed rollback adds nothing.
      }
    }
    throw error;
  }
}

function checkCommit(ms) {
  if (ms > SLOW_COMMIT_MS) {
    throw new Error(`A commit took ${Math.round(ms)} ms; stopping so the server isn't starved.`);
  }
}

// Antivirus on Windows briefly holds freshly written files open.
function retryFileOp(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * 2 ** attempt);
    }
  }
}

function fsyncDirectory(directory) {
  // Windows can't open a directory for fsync; NTFS journals the rename itself.
  if (os.platform() === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeSegment(archiveDir, threadId, archiveId, records, now) {
  const month = now.toISOString().slice(0, 7);
  const directory = path.join(archiveDir, month);
  fs.mkdirSync(directory, { recursive: true });
  const body = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const data = zlib.zstdCompressSync(body, {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [zlib.constants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const free = fs.statfsSync(directory);
  if (free.bavail * free.bsize < data.length * 4 + 64 * 1024 * 1024) {
    throw new Error(`Not enough free space in ${directory} for the archive`);
  }
  const file = path.join(directory, `${threadKey(threadId)}-${archiveId}.jsonl.zst`);
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "w");
  try {
    for (let offset = 0; offset < data.length;) {
      offset += fs.writeSync(fd, data, offset, data.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  retryFileOp(() => fs.renameSync(temporary, file));
  fsyncDirectory(directory);
  return { file, bytes: data.length };
}

function segmentFiles(archiveDir, { threadId, includeRestored = false } = {}) {
  const prefix = threadId === undefined ? undefined : `${threadKey(threadId)}-`;
  const files = [];
  const roots = [archiveDir, ...(includeRestored ? [path.join(archiveDir, "restored")] : [])];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const month of fs.readdirSync(root).sort()) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const directory = path.join(root, month);
      for (const name of fs.readdirSync(directory).sort()) {
        if (!name.endsWith(".jsonl.zst")) continue;
        if (prefix !== undefined && !name.startsWith(prefix)) continue;
        files.push(path.join(directory, name));
      }
    }
  }
  return files;
}

function readSegment(file) {
  const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function acquireLock(archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const lock = path.join(archiveDir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(lock, "utf8").trim());
      const live = Number.isInteger(pid) && pid > 0 && processAlive(pid);
      // An empty lock may belong to a run that has created it but not written its pid yet.
      const fresh = pid === 0 && Date.now() - fs.statSync(lock).mtimeMs < 5000;
      if (live || fresh) {
        throw new Error(`Another archive run (pid ${pid || "starting"}) is using ${archiveDir}`, {
          cause: error,
        });
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw new Error(`Could not take the lock in ${archiveDir}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cutoffOf = (options) => new Date(options.now.getTime() - options.olderThanMs).toISOString();

async function scan(options) {
  const db = openDatabase(options.db, { write: false });
  try {
    const cutoff = cutoffOf(options);
    const idle = idleQuery(db);
    const summary = { threads: 0, rows: 0, beforeBytes: 0, afterBytes: 0, skipped: {} };
    for (const threadId of candidateThreads(db, options.thread)) {
      let counted = false;
      let busy;
      for (const row of candidateRows(db, threadId, cutoff)) {
        busy ??= !threadIdle(idle, threadId);
        const result = busy ? { skip: "thread busy" } : stubRow(row, "0000000000000000");
        if (result.skip) {
          summary.skipped[result.skip] = (summary.skipped[result.skip] ?? 0) + 1;
          continue;
        }
        if (!counted) summary.threads += 1;
        counted = true;
        summary.rows += 1;
        summary.beforeBytes += byteLength(row.payload_json);
        summary.afterBytes += byteLength(result.stub);
      }
    }
    return summary;
  } finally {
    db.close();
  }
}

async function run(options) {
  const sleep = options.sleep ?? defaultSleep;
  const release = acquireLock(options.archiveDir);
  let db;
  try {
    db = openDatabase(options.db, { write: true });
    const cutoff = cutoffOf(options);
    const idle = idleQuery(db);
    const afterWrite = writeTracker(db, sleep);
    const summary = {
      threads: 0,
      rows: 0,
      savedBytes: 0,
      archiveBytes: 0,
      conflicts: 0,
      busyThreads: 0,
      slowestCommitMs: 0,
    };
    let budget = options.limitBytes ?? Infinity;
    for (const threadId of candidateThreads(db, options.thread)) {
      if (budget <= 0) break;
      let batch = [];
      let batchBytes = 0;
      let archiveId = crypto.randomBytes(8).toString("hex");
      let touched = false;
      let busy = false;
      const flush = async () => {
        if (batch.length === 0) return;
        const now = options.now;
        const records = batch.map(({ row, stub }) => ({
          v: FORMAT_VERSION,
          archiveId,
          threadId,
          turnItemId: row.turn_item_id,
          type: row.type,
          archivedAt: now.toISOString(),
          originalSha256: sha256(row.payload_json),
          stubSha256: sha256(stub),
          original: row.payload_json,
        }));
        const segment = writeSegment(options.archiveDir, threadId, archiveId, records, now);
        options.afterSegment?.(segment);
        const update = db.prepare(
          `UPDATE ${ITEMS} SET payload_json = $stub
           WHERE turn_item_id = $id AND thread_id = $thread AND payload_json = $original`,
        );
        const { result: stubbed, ms } = await withWriteTransaction(
          db,
          () => {
            // The thread may have started a run since the read; then nothing is stubbed.
            if (!threadIdle(idle, threadId)) return null;
            return batch.filter(
              ({ row, stub }) =>
                update.run({
                  $stub: stub,
                  $id: row.turn_item_id,
                  $thread: threadId,
                  $original: row.payload_json,
                }).changes > 0,
            );
          },
          sleep,
        );
        summary.slowestCommitMs = Math.max(summary.slowestCommitMs, ms);
        const changed = stubbed ?? [];
        // Nothing points at a segment none of whose rows were stubbed; it is only a copy.
        if (changed.length === 0) retryFileOp(() => fs.rmSync(segment.file));
        else summary.archiveBytes += segment.bytes;
        summary.rows += changed.length;
        summary.conflicts += stubbed === null ? 0 : batch.length - changed.length;
        let written = 0;
        for (const { row, stub } of changed) {
          summary.savedBytes += byteLength(row.payload_json) - byteLength(stub);
          budget -= byteLength(row.payload_json);
          // Each updated row dirties at least one 4 KiB page in the WAL.
          written += Math.max(4096, byteLength(stub));
        }
        touched ||= changed.length > 0;
        busy = stubbed === null;
        batch = [];
        batchBytes = 0;
        archiveId = crypto.randomBytes(8).toString("hex");
        checkCommit(ms);
        // Leave the writer free at least as long as the tool held it.
        await sleep(Math.max(20, ms));
        await afterWrite.wrote(written);
      };
      let checked = false;
      for (const row of candidateRows(db, threadId, cutoff)) {
        if (!checked) {
          checked = true;
          if (!threadIdle(idle, threadId)) {
            busy = true;
            break;
          }
        }
        const size = byteLength(row.payload_json);
        if (batch.length > 0 && (batchBytes + size > BATCH_BYTES || batchBytes + size > budget)) {
          await flush();
          if (busy || budget <= 0) break;
        }
        const result = stubRow(row, archiveId);
        if (result.skip) continue;
        batch.push({ row, stub: result.stub });
        batchBytes += size;
        if (batch.length >= BATCH_ROWS) {
          await flush();
          if (busy || budget <= 0) break;
        }
      }
      if (!busy) await flush();
      if (busy) summary.busyThreads += 1;
      if (touched) summary.threads += 1;
    }
    await afterWrite.finish();
    return summary;
  } finally {
    db?.close();
    release();
  }
}

function view(options) {
  const out = [];
  for (const file of segmentFiles(options.archiveDir, {
    threadId: options.thread,
    includeRestored: true,
  })) {
    for (const record of readSegment(file)) {
      if (options.thread !== undefined && record.threadId !== options.thread) continue;
      if (options.item !== undefined && record.turnItemId !== options.item) continue;
      out.push({
        turnItemId: record.turnItemId,
        threadId: record.threadId,
        type: record.type,
        output: JSON.parse(record.original).output,
      });
    }
  }
  return out;
}

function classify(read, record) {
  const current = read.get({ $id: record.turnItemId });
  if (current === undefined) return { state: "missing" };
  if (current.payload_json === record.original) return { state: "original" };
  if (sha256(current.payload_json) === record.stubSha256) {
    return { state: "stubbed", stub: current.payload_json };
  }
  return { state: "changed" };
}

function moveToRestored(archiveDir, file) {
  const target = path.join(archiveDir, "restored", path.basename(path.dirname(file)));
  fs.mkdirSync(target, { recursive: true });
  retryFileOp(() => fs.renameSync(file, path.join(target, path.basename(file))));
}

async function restore(options) {
  if (options.thread === undefined && !options.all) {
    throw new Error("restore needs --thread <id> or --all");
  }
  const sleep = options.sleep ?? defaultSleep;
  const release = acquireLock(options.archiveDir);
  let db;
  try {
    db = openDatabase(options.db, { write: true });
    const afterWrite = writeTracker(db, sleep);
    const summary = { restored: 0, alreadyOriginal: 0, missing: 0, changed: 0, segmentsDone: 0 };
    const read = db.prepare(`SELECT payload_json FROM ${ITEMS} WHERE turn_item_id = $id`);
    const leftover = [];
    for (const file of segmentFiles(options.archiveDir, { threadId: options.thread })) {
      // Segments hold one thread each (the file name is keyed by it).
      const records = readSegment(file).filter(
        (record) => options.thread === undefined || record.threadId === options.thread,
      );
      if (records.length === 0) continue;
      let unresolved = 0;
      const pending = [];
      for (const record of records) {
        if (sha256(record.original) !== record.originalSha256) {
          throw new Error(`Corrupt record in ${file}`);
        }
        const found = classify(read, record);
        if (found.state === "stubbed") pending.push({ record, stub: found.stub });
        else if (found.state === "changed") unresolved += 1;
        else if (found.state === "missing") summary.missing += 1;
        else summary.alreadyOriginal += 1;
      }
      for (let index = 0; index < pending.length; index += BATCH_ROWS) {
        const slice = pending.slice(index, index + BATCH_ROWS);
        // A fresh statement per batch so SQLite doesn't keep the last large binding alive.
        const update = db.prepare(
          `UPDATE ${ITEMS} SET payload_json = $original WHERE turn_item_id = $id AND payload_json = $stub`,
        );
        const { result: done, ms } = await withWriteTransaction(
          db,
          () =>
            slice.filter(
              ({ record, stub }) =>
                update.run({ $original: record.original, $id: record.turnItemId, $stub: stub })
                  .changes > 0,
            ),
          sleep,
        );
        summary.restored += done.length;
        unresolved += slice.length - done.length;
        checkCommit(ms);
        await sleep(Math.max(20, ms));
        await afterWrite.wrote(
          done.reduce((sum, { record }) => sum + byteLength(record.original), 0),
        );
      }
      if (unresolved === 0) {
        moveToRestored(options.archiveDir, file);
        summary.segmentsDone += 1;
      } else leftover.push({ file, records });
    }
    // A crash can leave an orphan copy that sorts before the segment that restored its rows.
    for (const { file, records } of leftover) {
      const states = records.map((record) => classify(read, record).state);
      if (states.every((state) => state === "original" || state === "missing")) {
        moveToRestored(options.archiveDir, file);
        summary.segmentsDone += 1;
      } else summary.changed += states.filter((state) => state === "changed").length;
    }
    await afterWrite.finish();
    return summary;
  } finally {
    db?.close();
    release();
  }
}

function verify(options) {
  const db = openDatabase(options.db, { write: false });
  try {
    const summary = {
      segments: 0,
      records: 0,
      stubbed: 0,
      original: 0,
      missing: 0,
      changed: 0,
      problems: [],
    };
    const read = db.prepare(`SELECT payload_json FROM ${ITEMS} WHERE turn_item_id = $id`);
    const known = new Set();
    for (const file of segmentFiles(options.archiveDir)) {
      summary.segments += 1;
      let records;
      try {
        records = readSegment(file);
      } catch (error) {
        summary.problems.push(`${file}: unreadable (${error.message})`);
        continue;
      }
      let referenced = 0;
      for (const record of records) {
        summary.records += 1;
        if (sha256(record.original) !== record.originalSha256) {
          summary.problems.push(`${file}: record ${record.turnItemId} fails its checksum`);
          continue;
        }
        known.add(`${record.archiveId}:${record.turnItemId}`);
        const found = classify(read, record);
        summary[found.state] += 1;
        if (found.state === "stubbed") referenced += 1;
      }
      if (referenced === 0) {
        summary.problems.push(`${file}: no row uses it (orphan; safe to trash)`);
      }
    }
    // Bounded rowid ranges, each its own short read, so the scan never pins the WAL.
    const last = db.prepare(`SELECT max(rowid) AS id FROM ${ITEMS}`).get().id ?? 0;
    const page = db.prepare(
      `SELECT turn_item_id, payload_json FROM ${ITEMS}
       WHERE rowid > $from AND rowid <= $to AND type IN (${sqlList(TOOL_TYPES)})
         AND instr(payload_json, '${MARKER_TEXT}') > 0`,
    );
    for (let from = 0; from < last; from += VERIFY_ROWID_SPAN) {
      for (const row of page.all({ $from: from, $to: from + VERIFY_ROWID_SPAN })) {
        const archiveIds = new Set(
          Array.from(row.payload_json.matchAll(MARKER_PATTERN), (match) => match[1]),
        );
        for (const archiveId of archiveIds) {
          if (!known.has(`${archiveId}:${row.turn_item_id}`)) {
            summary.problems.push(
              `row ${row.turn_item_id}: stub ${archiveId} has no archive record`,
            );
          }
        }
      }
    }
    return summary;
  } finally {
    db.close();
  }
}

const USAGE = `Usage: node fork/scripts/turn-item-archive.cjs <command> [options]

Commands:
  scan      Report what would be archived (read-only).
  run       Archive old tool output into compressed files.
  view      Print archived output (--thread <id>, optionally --item <id>).
  restore   Put archived output back (--thread <id> or --all).
  verify    Check archive files against the database (read-only).

Options:
  --db <path>           Database (default ~/.t3/userdata/statev2.sqlite)
  --archive-dir <path>  Archive directory (default ~/.t3/archive/turn-items)
  --older-than <dur>    Only items older than this, e.g. 14d (default 14d)
  --thread <id>         Limit to one thread
  --item <id>           One turn item (view)
  --all                 Every thread (restore)
  --limit-mb <n>        Stop after archiving about n MB of rows (run)
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    db: path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite"),
    archiveDir: path.join(os.homedir(), ".t3", "archive", "turn-items"),
    olderThanMs: parseDuration("14d"),
    now: new Date(),
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--db") options.db = value();
    else if (flag === "--archive-dir") options.archiveDir = value();
    else if (flag === "--older-than") options.olderThanMs = parseDuration(value());
    else if (flag === "--thread") options.thread = value();
    else if (flag === "--item") options.item = value();
    else if (flag === "--all") options.all = true;
    else if (flag === "--limit-mb") {
      const megabytes = Number(value());
      if (!Number.isFinite(megabytes) || megabytes <= 0) {
        throw new Error("--limit-mb needs a positive number");
      }
      options.limitBytes = megabytes * 1024 * 1024;
    } else throw new Error(`Unknown option ${flag}`);
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  const commands = { scan, run, view, restore, verify };
  if (!(command in commands)) {
    process.stdout.write(USAGE);
    return command === undefined || command === "help" ? 0 : 2;
  }
  if (command === "view" && options.thread === undefined && options.item === undefined) {
    throw new Error("view needs --thread <id> or --item <id>");
  }
  const result = await commands[command](options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return command === "verify" && result.problems.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}

module.exports = { stubRow, scan, run, view, restore, verify, parseArgs, T3_TOOL_PATTERN };
