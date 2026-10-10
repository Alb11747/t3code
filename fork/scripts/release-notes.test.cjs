const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildReleaseNotes, previousReleaseTag } = require("./release-notes.cjs");
const {
  normalizeDesktopUpdateReleaseNotes,
} = require("../../apps/desktop/src/updates/releaseNotes.ts");

const previousTag = "v0.0.46-nightly.20261010.14";
const currentTag = "v0.0.46-nightly.20261010.15";
const release = (tag_name, overrides = {}) => ({
  tag_name,
  published_at: "2026-10-10T10:13:15Z",
  draft: false,
  ...overrides,
});

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "t3-release-notes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "--initial-branch=upstream");
  git("config", "user.name", "Release notes test");
  git("config", "user.email", "release-notes@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  const commit = (file, content, subject) => {
    writeFileSync(path.join(cwd, file), content, { encoding: "utf8" });
    git("add", file);
    git("commit", "-qm", subject);
    return git("rev-parse", "HEAD");
  };
  commit("upstream.txt", "initial\n", "Initial upstream");
  git("switch", "-qc", "fork");
  const carried = commit("carried.txt", "old patch\n", "feat: carried patch");
  git("tag", previousTag);
  const notes = (releases = [release(previousTag)]) =>
    buildReleaseNotes({
      cwd,
      releases,
      currentTag,
      repository: "example/fork",
      upstreamRef: "upstream",
    });
  return { git, commit, notes, carried };
}

test("uses the newest earlier published nightly, ignoring drafts, future tags and publication order", () => {
  assert.equal(
    previousReleaseTag(
      [
        release("v0.0.46-nightly.20261010.9", { published_at: "2026-10-11T00:00:00Z" }),
        release(previousTag),
        release(currentTag),
        release("v0.0.46-nightly.20261010.16"),
        release("v0.0.46-nightly.20261010.13", { draft: true }),
        release("v0.0.46-nightly.20261010.12", { published_at: null }),
        release("v0.0.46-preview.20261010.14"),
        release("v0.0.46"),
      ],
      currentTag,
    ),
    previousTag,
  );
  assert.equal(previousReleaseTag([], currentTag), null);
  assert.throws(() => previousReleaseTag([], "not-a-nightly"), /Invalid fork nightly tag/);
});

test("includes new upstream and fork changes without repeating rebased carried patches", (t) => {
  const { git, commit, notes, carried } = fixture(t);
  git("switch", "upstream");
  commit("upstream.txt", "initial\nnew upstream\n", "fix: upstream change");
  git("switch", "fork");
  git("rebase", "upstream");
  assert.notEqual(git("rev-parse", "HEAD"), carried);
  commit("new.txt", "new patch\n", "feat: new fork patch");

  const body = notes();
  assert.match(body, /Upstream: fix: upstream change/);
  assert.match(body, /Fork: feat: new fork patch/);
  assert.doesNotMatch(body, /carried patch/);
  assert.match(body, /github.com\/example\/fork\/releases\/tag\/v0.0.46-nightly.20261010.14/);
  const normalized = normalizeDesktopUpdateReleaseNotes(body, currentTag.slice(1), "nightly");
  assert.equal(normalized.releaseNotes[0].totalItems, 2);
  assert.match(normalized.releaseNotes[0].items[0], /^Fork: feat: new fork patch/);
});

test("detects changed patch content even when the commit subject stays the same", (t) => {
  const { git, notes } = fixture(t);
  const cwd = git("rev-parse", "--show-toplevel");
  writeFileSync(path.join(cwd, "carried.txt"), "updated patch\n", { encoding: "utf8" });
  git("add", "carried.txt");
  git("commit", "--amend", "--no-edit", "-q");
  assert.match(notes(), /Fork: feat: carried patch/);
  assert.doesNotMatch(notes(), /### Upstream changes/);
});

test("detects whitespace changes inside a fork patch", (t) => {
  const { git, notes } = fixture(t);
  const cwd = git("rev-parse", "--show-toplevel");
  writeFileSync(path.join(cwd, "carried.txt"), "old  patch\n", { encoding: "utf8" });
  git("add", "carried.txt");
  git("commit", "--amend", "--no-edit", "-q");
  assert.match(notes(), /Fork: feat: carried patch/);
});

test("does not repeat a carried patch when upstream changes its surrounding context", (t) => {
  const { git, commit, notes } = fixture(t);
  commit("upstream.txt", "initial\nfork addition\n", "feat: adjacent fork patch");
  git("tag", "-f", previousTag);
  git("switch", "upstream");
  commit("upstream.txt", "changed context\n", "fix: upstream context");
  // Recreate the same edit atop the new base, as a resolved rebase would.
  git("switch", "-c", "rebased-fork");
  commit("carried.txt", "old patch\n", "feat: carried patch");
  commit("upstream.txt", "changed context\nfork addition\n", "feat: adjacent fork patch");
  assert.match(notes(), /Upstream: fix: upstream context/);
  assert.doesNotMatch(notes(), /Fork: feat: adjacent fork patch/);
  assert.doesNotMatch(notes(), /Fork: feat: carried patch/);
});

test("detects an identical edit moved to a different location in the same file", (t) => {
  const { git, commit, notes } = fixture(t);
  git("switch", "upstream");
  const source =
    "function first() {\n  return true;\n}\n\nfunction second() {\n  return true;\n}\n";
  commit("functions.js", source, "Add upstream functions");
  git("switch", "fork");
  git("rebase", "upstream");
  commit(
    "functions.js",
    source.replace("return true;", "return false;"),
    "fix: disable a function",
  );
  git("tag", "-f", previousTag);
  const cwd = git("rev-parse", "--show-toplevel");
  writeFileSync(
    path.join(cwd, "functions.js"),
    source.replace(/return true;(?=\n}\n$)/, "return false;"),
    { encoding: "utf8" },
  );
  git("add", "functions.js");
  git("commit", "--amend", "--no-edit", "-q");
  assert.match(notes(), /Fork: fix: disable a function/);
});

test("keeps the same edit carried when upstream inserts or removes lines before it", (t) => {
  for (const prefix of ["new line\nalpha\n", ""]) {
    const { git, commit, notes } = fixture(t);
    git("switch", "upstream");
    commit("source.txt", "alpha\nbeta\ngamma\n", "Add upstream source");
    git("switch", "fork");
    git("rebase", "upstream");
    commit("source.txt", "alpha\nfork beta\ngamma\n", "fix: carried source edit");
    git("tag", "-f", previousTag);
    git("switch", "upstream");
    commit("source.txt", `${prefix}beta\ngamma\n`, "fix: upstream line shift");
    git("switch", "-c", "rebased-fork");
    commit("carried.txt", "old patch\n", "feat: carried patch");
    commit("source.txt", `${prefix}fork beta\ngamma\n`, "fix: carried source edit");
    assert.match(notes(), /Upstream: fix: upstream line shift/);
    assert.doesNotMatch(notes(), /Fork: fix: carried source edit/);
  }
});

test("reports a fork patch absorbed upstream only as an upstream change", (t) => {
  const { git, commit, notes, carried } = fixture(t);
  git("switch", "upstream");
  commit("upstream.txt", "new upstream\n", "fix: upstream change");
  git("cherry-pick", carried);
  git("switch", "fork");
  git("rebase", "upstream");
  const body = notes();
  assert.match(body, /Upstream: feat: carried patch/);
  assert.doesNotMatch(body, /Fork: feat: carried patch/);
});

test("covers all changes after the previous published release when builds were skipped", (t) => {
  const { git, commit, notes } = fixture(t);
  commit("first.txt", "first\n", "feat: first unpublished patch");
  git("tag", "v0.0.46-nightly.20261010.15");
  commit("second.txt", "second\n", "feat: second unpublished patch");
  // A tag alone (for example, from a failed build) is not a published release.
  const body = buildReleaseNotes({
    cwd: git("rev-parse", "--show-toplevel"),
    releases: [release(previousTag)],
    currentTag: "v0.0.46-nightly.20261010.17",
    repository: "example/fork",
    upstreamRef: "upstream",
  });
  assert.match(body, /first unpublished patch/);
  assert.match(body, /second unpublished patch/);
  assert.doesNotMatch(body, /carried patch/);
  assert.doesNotMatch(notes(), /carried patch/);
});

test("handles the first release and an unchanged rebuild", (t) => {
  const { notes } = fixture(t);
  assert.match(notes([]), /Initial fork release/);
  assert.match(notes([]), /Fork: feat: carried patch/);
  assert.match(notes(), /No new upstream changes or fork patches/);
  assert.doesNotMatch(notes(), /Fork: feat: carried patch/);
});

test("combines per-release deltas when an installed client skips a release", (t) => {
  const { git, commit, notes } = fixture(t);
  commit("first.txt", "first\n", "feat: first new fork patch");
  const firstNotes = notes();
  git("tag", currentTag);
  commit("second.txt", "second\n", "feat: second new fork patch");
  const nextTag = "v0.0.46-nightly.20261010.16";
  const secondNotes = buildReleaseNotes({
    cwd: git("rev-parse", "--show-toplevel"),
    releases: [[release(previousTag)], [release(currentTag)]],
    currentTag: nextTag,
    repository: "example/fork",
    upstreamRef: "upstream",
  });
  assert.doesNotMatch(secondNotes, /first new fork patch/);
  const normalized = normalizeDesktopUpdateReleaseNotes(
    [
      { version: nextTag.slice(1), note: secondNotes },
      { version: currentTag.slice(1), note: firstNotes },
    ],
    nextTag.slice(1),
    "nightly",
  );
  assert.equal(normalized.releaseNotes.length, 2);
  assert.match(normalized.releaseNotes[0].items[0], /second new fork patch/);
  assert.match(normalized.releaseNotes[1].items[0], /first new fork patch/);
  assert.deepEqual(
    normalized.releaseNotes.map((group) => group.totalItems),
    [1, 1],
  );
});

test("keeps new fork patches visible in the popover when upstream has many changes", (t) => {
  const { git, commit, notes } = fixture(t);
  git("switch", "upstream");
  for (let index = 1; index <= 10; index += 1) {
    commit("upstream.txt", `upstream ${index}\n`, `fix: upstream ${index}`);
  }
  git("switch", "fork");
  git("rebase", "upstream");
  commit("new.txt", "new patch\n", "feat: new fork patch");
  const normalized = normalizeDesktopUpdateReleaseNotes(notes(), currentTag.slice(1), "nightly");
  assert.equal(normalized.releaseNotes[0].totalItems, 11);
  assert.equal(normalized.releaseNotes[0].items.length, 8);
  assert.match(normalized.releaseNotes[0].items[0], /^Fork: feat: new fork patch/);
});

test("rejects missing previous release history instead of silently repeating every patch", (t) => {
  const { git, notes } = fixture(t);
  git("tag", "-d", previousTag);
  assert.throws(() => notes());
});
