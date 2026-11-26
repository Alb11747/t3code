const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const archive = require("./turn-item-archive.cjs");

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-03-01T00:00:00.000Z");
const noSleep = async () => {};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-item-archive-"));
  const file = path.join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_context_handoffs (context_handoff_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      inline_work_output INTEGER NOT NULL DEFAULT 0);
  `);
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, type, status, updated_at, payload_json, inline_work_output) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const add = (
    id,
    thread,
    type,
    payload,
    { status = "completed", updatedAt = OLD, inline = 0 } = {},
  ) =>
    insert.run(
      id,
      thread,
      type,
      status,
      updatedAt,
      JSON.stringify({ id, type, ...payload }),
      inline,
    );
  const thread = (id, deleted = null) =>
    db
      .prepare(
        "INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES (?, ?)",
      )
      .run(id, deleted);
  const payload = (id) =>
    db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ?",
      )
      .get(id).payload_json;
  return { dir, file, db, add, thread, payload, archiveDir: path.join(dir, "archive") };
}

const big = (char, size = 20_000) =>
  `${"line of output ".repeat(4)}\n`.repeat(Math.ceil(size / 61)).slice(0, size) + char;

test("command output keeps head and tail with a marker, and restores byte-identically", async () => {
  const f = fixture();
  f.thread("t1");
  const output = `${big("x")}\nERROR: the tail is kept`;
  f.add("i1", "t1", "command_execution", { input: "ls", output, exitCode: 1 });
  const before = f.payload("i1");
  const opts = {
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  };

  const result = await archive.run(opts);
  assert.equal(result.rows, 1);
  const stubbed = JSON.parse(f.payload("i1"));
  assert.match(stubbed.output, /\[t3-archive:[0-9a-f]{16}\] \d+ characters archived/);
  assert.ok(stubbed.output.endsWith("ERROR: the tail is kept"));
  assert.ok(stubbed.output.length < 5_000);
  assert.equal(stubbed.exitCode, 1);

  assert.deepEqual(archive.view({ ...opts, item: "i1" })[0].output, output);
  const checked = archive.verify(opts);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.stubbed, 1);

  const restored = await archive.restore({ ...opts, all: true });
  assert.equal(restored.restored, 1);
  assert.equal(f.payload("i1"), before);
  assert.equal(archive.verify(opts).segments, 0);
  // View still works after restore, from the restored/ folder.
  assert.equal(archive.view({ ...opts, item: "i1" })[0].output, output);
});

test("leaves recent, live, small, T3, inline, JSON and exit-code-less items alone", async () => {
  const f = fixture();
  f.thread("idle");
  f.thread("busy");
  f.thread("gone", "2026-02-01T00:00:00.000Z");
  f.db
    .prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('r', 'busy', 'running')")
    .run();
  const output = big("y");
  f.add(
    "recent",
    "idle",
    "command_execution",
    { output, exitCode: 0 },
    { updatedAt: "2026-02-28T12:00:00.000Z" },
  );
  f.add("running", "idle", "command_execution", { output, exitCode: 0 }, { status: "running" });
  f.add("small", "idle", "command_execution", { output: "ok", exitCode: 0 });
  f.add("no-exit", "idle", "command_execution", { output });
  f.add("json-out", "idle", "command_execution", {
    output: JSON.stringify({ stdout: output }),
    exitCode: 0,
  });
  f.add("t3", "idle", "dynamic_tool", { toolName: "t3-code.t3_thread_read", output });
  f.add("inline", "idle", "dynamic_tool", { toolName: "x.y", output }, { inline: 1 });
  f.add("json-text", "idle", "dynamic_tool", {
    toolName: "x.y",
    output: [{ type: "text", text: JSON.stringify({ a: output }) }],
  });
  f.add("app", "idle", "dynamic_tool", {
    toolName: "x.y",
    output: { t3McpApp: {}, result: { text: output } },
  });
  f.add("busy-item", "busy", "command_execution", { output, exitCode: 0 });
  f.add("gone-item", "gone", "command_execution", { output, exitCode: 0 });
  const before = Object.fromEntries(
    [
      "recent",
      "running",
      "small",
      "no-exit",
      "json-out",
      "t3",
      "inline",
      "json-text",
      "app",
      "busy-item",
      "gone-item",
    ].map((id) => [id, f.payload(id)]),
  );
  const result = await archive.run({
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  });
  assert.equal(result.rows, 0);
  for (const [id, payload] of Object.entries(before)) assert.equal(f.payload(id), payload, id);
});

test("tool output keeps its structure and small fields; every image becomes text", async () => {
  const f = fixture();
  f.thread("t");
  const image = "A".repeat(30_000);
  f.add("tool", "t", "dynamic_tool", {
    toolName: "agentbridge.browser_snapshot",
    output: {
      isError: false,
      content: [
        { type: "text", text: big("z") },
        { type: "image", mimeType: "image/png", data: "QUJD" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      ],
      taskId: "task-1",
    },
  });
  await archive.run({
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  });
  const stubbed = JSON.parse(f.payload("tool"));
  assert.equal(stubbed.output.isError, false);
  assert.equal(stubbed.output.taskId, "task-1");
  assert.equal(stubbed.output.content.length, 3);
  assert.match(stubbed.output.content[0].text, /\[t3-archive:/);
  assert.equal(stubbed.output.content[1].type, "text");
  assert.match(stubbed.output.content[2].text, /^\[image image\/jpeg, 30000 base64 characters\]/);
});

test("a row changed after archiving is neither overwritten nor restored", async () => {
  const f = fixture();
  f.thread("t");
  f.add("i", "t", "command_execution", { output: big("q"), exitCode: 0 });
  const opts = {
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  };
  await archive.run(opts);
  f.db
    .prepare(
      "UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = 'i'",
    )
    .run('{"id":"i","output":"server rewrote it"}');
  const restored = await archive.restore({ ...opts, thread: "t" });
  assert.equal(restored.changed, 1);
  assert.equal(f.payload("i"), '{"id":"i","output":"server rewrote it"}');
  assert.equal(archive.verify(opts).segments, 1);
});

test("a segment written before a crash, with no row stubbed, is reported as an orphan", async () => {
  const f = fixture();
  f.thread("t");
  f.add("i", "t", "command_execution", { output: big("c"), exitCode: 0 });
  const before = f.payload("i");
  const opts = {
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  };
  await assert.rejects(
    archive.run({
      ...opts,
      afterSegment: () => {
        throw new Error("crash");
      },
    }),
    /crash/,
  );
  assert.equal(f.payload("i"), before);
  const checked = archive.verify(opts);
  assert.equal(checked.problems.length, 1);
  assert.match(checked.problems[0], /orphan/);
  // The lock was released, and a second pass archives normally.
  const result = await archive.run(opts);
  assert.equal(result.rows, 1);
});

test("refuses a database that isn't WAL or lacks the expected columns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-item-archive-"));
  const file = path.join(dir, "bad.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT)");
  db.close();
  await assert.rejects(archive.scan({ db: file, olderThanMs: 1, now: NOW }), /WAL/);
  const wal = new DatabaseSync(file);
  wal.exec("PRAGMA journal_mode = WAL");
  wal.close();
  await assert.rejects(archive.scan({ db: file, olderThanMs: 1, now: NOW }), /Unexpected schema/);
});

const row = (type, payload, extra = {}) => ({
  turn_item_id: "i",
  thread_id: "t",
  type,
  inline_work_output: 0,
  payload_json: JSON.stringify(payload),
  ...extra,
});

test("cuts never split a surrogate pair and snap to nearby newlines", () => {
  const emoji = "😀";
  const output = `${"a".repeat(1023)}${emoji}${"b".repeat(9000)}\n${"c".repeat(100)}${emoji}${"d".repeat(2970)}`;
  const { stub } = archive.stubRow(
    row("command_execution", { output, exitCode: 0 }),
    "0123456789abcdef",
  );
  const text = JSON.parse(stub).output;
  assert.doesNotMatch(
    text,
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  );
  const tail = text.slice(text.indexOf("Full output: "));
  assert.ok(tail.split("\n")[1].startsWith("c"), "the tail starts at the newline");
});

test("skips non-canonical JSON, earlier stubs and every T3 tool alias", () => {
  const output = big("n");
  const canonical = row("command_execution", { output, exitCode: 0 });
  assert.equal(
    archive.stubRow({ ...canonical, payload_json: canonical.payload_json.replace("{", "{ ") }, "0")
      .skip,
    "non-canonical JSON",
  );
  assert.equal(
    archive.stubRow(row("command_execution", { output: `[t3-archive:${output}`, exitCode: 0 }), "0")
      .skip,
    "already archived",
  );
  for (const toolName of [
    "t3-code.preview_snapshot",
    "t3-code-direct.t3_thread_read",
    "mcp__t3-code__html_render",
    "mcp__t3-code-direct__send_to_user",
    "mcp__t3_code__t3_thread_read",
    "t3_code.delegate_task",
    "t3code.t3_thread_list",
    "t3-code/preview_recording_stop",
  ]) {
    assert.equal(
      archive.stubRow(row("dynamic_tool", { toolName, output }), "0").skip,
      "T3 tool",
      toolName,
    );
  }
  assert.ok(
    archive.stubRow(row("dynamic_tool", { toolName: "agentbridge.browser_snapshot", output }), "0")
      .stub,
  );
});

test("a large resource blob becomes a note without touching small images", () => {
  const { stub } = archive.stubRow(
    row("dynamic_tool", {
      toolName: "x.y",
      output: [
        { type: "image", mimeType: "image/png", data: "QUJD" },
        { type: "resource", resource: { mimeType: "application/pdf", blob: "B".repeat(20_000) } },
      ],
    }),
    "0123456789abcdef",
  );
  const output = JSON.parse(stub).output;
  assert.deepEqual(output[0], { type: "image", mimeType: "image/png", data: "QUJD" });
  assert.match(output[1].text, /^\[resource application\/pdf, 20000 base64 characters\]/);
});

test("pending handoffs, and a run that starts mid-pass, keep a thread whole", async () => {
  const f = fixture();
  f.thread("handoff");
  f.thread("starts");
  f.db
    .prepare(
      "INSERT INTO orchestration_v2_projection_context_handoffs VALUES ('h', 'handoff', 'ready', ?)",
    )
    .run(JSON.stringify({ delivery: { status: "pending" } }));
  f.add("h1", "handoff", "command_execution", { output: big("h"), exitCode: 0 });
  f.add("s1", "starts", "command_execution", { output: big("s"), exitCode: 0 });
  const before = { h1: f.payload("h1"), s1: f.payload("s1") };
  const result = await archive.run({
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
    afterSegment: () =>
      f.db
        .prepare(
          "INSERT OR IGNORE INTO orchestration_v2_projection_runs VALUES ('r', 'starts', 'running')",
        )
        .run(),
  });
  assert.equal(result.rows, 0);
  assert.equal(result.busyThreads, 2);
  assert.deepEqual({ h1: f.payload("h1"), s1: f.payload("s1") }, before);
  assert.equal(archive.verify({ db: f.file, archiveDir: f.archiveDir }).segments, 0);
});

test("verify catches a stub without its record and ignores quoted markers", async () => {
  const f = fixture();
  f.thread("t");
  f.add("a", "t", "command_execution", { output: big("a"), exitCode: 0 });
  f.add("b", "t", "command_execution", { output: big("b"), exitCode: 0 });
  f.add("prose", "t", "command_execution", {
    output: "see [t3-archive:0123456789abcdef] in the docs",
    exitCode: 0,
  });
  const opts = {
    db: f.file,
    archiveDir: f.archiveDir,
    olderThanMs: 86_400_000,
    now: NOW,
    sleep: noSleep,
  };
  await archive.run(opts);
  assert.deepEqual(archive.verify(opts).problems, []);
  // Drop row b's record from the shared segment: its stub no longer has a record.
  const zlib = require("node:zlib");
  const [file] = fs
    .readdirSync(path.join(f.archiveDir, "2026-03"))
    .map((name) => path.join(f.archiveDir, "2026-03", name));
  const kept = zlib
    .zstdDecompressSync(fs.readFileSync(file))
    .toString()
    .split("\n")
    .filter((line) => line && !line.includes('"turnItemId":"b"'));
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${kept.join("\n")}\n`)));
  const problems = archive.verify(opts).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^row b: stub [0-9a-f]{16} has no archive record/);
});

test("releases the lock when the database can't be opened", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-item-archive-"));
  const opts = {
    db: path.join(dir, "missing.sqlite"),
    archiveDir: path.join(dir, "archive"),
    olderThanMs: 1,
    now: NOW,
  };
  await assert.rejects(archive.run(opts), /No database/);
  assert.equal(fs.existsSync(path.join(dir, "archive", ".lock")), false);
});
