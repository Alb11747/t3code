const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyBudgetFailure } = require("./release-fallback.cjs");
const { publish, releaseAssets } = require("./publish-release.cjs");

const run = {
  path: ".github/workflows/fork-release.yml",
  head_branch: "main",
  status: "completed",
  conclusion: "failure",
  updated_at: "2026-10-20T06:00:00Z",
};
const jobs = [{ name: "Job budget / Check job budget", conclusion: "failure" }];
const receipt = "::error::The fork ran 160 jobs in the last 24 hours (limit 150).";

test("fallback requires actual budget exhaustion, not an arbitrary failed gate", () => {
  verifyBudgetFailure(run, jobs, receipt, []);
  verifyBudgetFailure(run, jobs, receipt.replace("::error::", "##[error]"), []);
  assert.throws(() => verifyBudgetFailure(run, jobs, "HTTP 403", []), /No job-budget/);
  assert.throws(
    () => verifyBudgetFailure({ ...run, head_branch: "feature" }, jobs, receipt, []),
    /on main/,
  );
  assert.throws(
    () =>
      verifyBudgetFailure(run, jobs, receipt, [
        { draft: false, published_at: "2026-10-20T07:00:00Z" },
      ]),
    /newer budget-blocked/,
  );
});

const version = "0.1.1-nightly.20261020.3386.fork.1";
const sha = "a".repeat(40);

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "t3-release-fallback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const names = [
    `T3-Code-${version}-x86_64.AppImage`,
    `T3-Code-${version}-amd64.deb`,
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.exe.blockmap`,
    "nightly.yml",
    "nightly-linux.yml",
    "SHA256SUMS",
    `t3-${version}-linux-x64.tar.gz`,
    `t3-${version}-win32-x64.zip`,
    `t3-${version}-darwin-arm64.tar.gz`,
    `t3-${version}-linux-arm64.tar.gz`,
    `t3-${version}-win32-arm64.zip`,
  ];
  for (const name of names) writeFileSync(path.join(directory, name), name);
  const notes = path.join(directory, "notes.md");
  writeFileSync(notes, "Release notes");
  return { directory, notes, files: releaseAssets(directory, version) };
}

function publisher(
  fixture,
  {
    assets,
    releases = [],
    main = sha,
    mainAfterUpload,
    changedFiles = ["apps/server/source.ts"],
  } = {},
) {
  const calls = [];
  let uploaded = false;
  const gh = (...args) => {
    calls.push(args);
    if (args[0] !== "api") {
      if (args[1] === "upload") uploaded = true;
      return "";
    }
    if (args.includes("POST")) return JSON.stringify({ id: 123 });
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    if (endpoint.endsWith("/commits/main"))
      return JSON.stringify({ sha: uploaded && mainAfterUpload ? mainAfterUpload : main });
    if (endpoint.includes("/releases?")) return JSON.stringify([releases]);
    if (endpoint.includes("/git/matching-refs/")) return "[]";
    if (endpoint.includes("/assets?"))
      return JSON.stringify([
        assets ?? fixture.files.map((file) => ({ ...file, state: "uploaded" })),
      ]);
    if (endpoint.includes("/compare/"))
      return JSON.stringify({
        status: "ahead",
        files: changedFiles.map((filename) => ({ filename })),
      });
    throw new Error(`Unexpected test API call: ${endpoint}`);
  };
  return {
    calls,
    execute: () =>
      publish({
        gh,
        repository: "test/scratch",
        tag: `v${version}`,
        sha,
        name: "test",
        ...fixture,
      }),
  };
}

test("publisher creates a draft, uploads the complete inventory, verifies it, then publishes", (t) => {
  const fixtureData = fixture(t);
  const p = publisher(fixtureData);
  p.execute();
  const create = p.calls.findIndex((args) => args.includes("POST"));
  const upload = p.calls.findIndex((args) => args[1] === "upload");
  const edit = p.calls.findIndex((args) => args[1] === "edit");
  assert.ok(p.calls[create].includes("draft=true"));
  assert.ok(create < upload && upload < edit);
  assert.equal(
    p.calls[upload].filter((arg) => fixtureData.files.some((file) => file.file === arg)).length,
    12,
  );
});

test("failed or corrupted attachment leaves the release unpublished", (t) => {
  const fixtureData = fixture(t);
  for (const assets of [
    [],
    fixtureData.files.map((file) => ({ ...file, state: "uploaded", digest: "sha256:corrupt" })),
  ]) {
    const p = publisher(fixtureData, { assets });
    assert.throws(p.execute, /leaving the release as a draft/);
    assert.ok(!p.calls.some((args) => args[1] === "edit"));
  }
});

test("existing releases and newer source prevent any release writes", (t) => {
  const fixtureData = fixture(t);
  for (const overrides of [
    { releases: [{ tag_name: `v${version}`, draft: false }] },
    { releases: [{ tag_name: `v${version.replace("fork.1", "fork.2")}`, draft: false }] },
    { main: "b".repeat(40) },
  ]) {
    const p = publisher(fixtureData, overrides);
    assert.throws(p.execute, /already exists|Main changed|refusing to roll/);
    assert.ok(!p.calls.some((args) => args.includes("POST") || args[0] === "release"));
  }
});

test("missing native archive or desktop package prevents release creation", (t) => {
  const fixtureData = fixture(t);
  rmSync(path.join(fixtureData.directory, `t3-${version}-win32-arm64.zip`));
  const p = publisher(fixtureData);
  assert.throws(p.execute, /Missing release asset/);
  assert.equal(p.calls.length, 0);
});

test("source changes during upload keep the draft private; docs-only changes may publish", (t) => {
  const fixtureData = fixture(t);
  const stale = publisher(fixtureData, { mainAfterUpload: "b".repeat(40) });
  assert.throws(stale.execute, /Main changed/);
  assert.ok(stale.calls.some((args) => args[1] === "upload"));
  assert.ok(!stale.calls.some((args) => args[1] === "edit"));
  const docs = publisher(fixtureData, {
    mainAfterUpload: "b".repeat(40),
    changedFiles: ["fork/README.md"],
  });
  docs.execute();
  assert.ok(docs.calls.some((args) => args[1] === "edit"));
});
