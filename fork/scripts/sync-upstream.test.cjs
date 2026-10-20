const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const HostProcess = require("../../packages/shared/src/HostProcess.ts");

// Git Bash on Windows; a bare `bash` there may resolve to WSL.
const bash =
  HostProcess.Platform.defaultValue() === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
const script = path.join(__dirname, "sync-upstream.sh").replaceAll("\\", "/");
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

// Upstream gets a nightly, then PR #1 merged, then another nightly. The fork
// branched before all of them and carries PR #1 and the still-open PR #2.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "t3-sync-upstream-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  const bin = path.join(root, "bin");
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(globalConfig, "");
  mkdirSync(bin);

  const env = {
    ...process.env,
    [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    // Serves the script's fetch of upstream from the local repository.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${upstream.replaceAll("\\", "/")}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/pingdotgg/t3code.git",
    GIT_AUTHOR_NAME: "Sync test",
    GIT_AUTHOR_EMAIL: "sync@example.com",
    GIT_COMMITTER_NAME: "Sync test",
    GIT_COMMITTER_EMAIL: "sync@example.com",
  };
  for (const key of ["GITHUB_OUTPUT", "UPSTREAM_REPO", "UPSTREAM_BRANCH"]) delete env[key];

  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (cwd, file, content, message) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content, { encoding: "utf8" });
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };

  mkdirSync(upstream);
  git(upstream, "init", "-q", "--initial-branch=main");
  commit(upstream, "base.txt", "base\n", "upstream base");
  git(root, "clone", "-q", upstream, fork);

  const nightly1 = commit(upstream, "nightly.txt", "1\n", "nightly 1");
  git(upstream, "switch", "-qc", "pr-1");
  commit(upstream, "feature-1.txt", "upstream\n", "upstream PR 1");
  git(upstream, "switch", "-q", "main");
  git(upstream, "merge", "-q", "--no-ff", "-m", "Merge PR 1", "pr-1");
  const merge = git(upstream, "rev-parse", "HEAD");
  const nightly2 = commit(upstream, "nightly.txt", "2\n", "nightly 2");

  const pr = (n) => `https://github.com/pingdotgg/t3code/pull/${n}`;
  const entry = (n) => `- Feature ${n}. Upstream PR: ${pr(n)}`;
  commit(fork, "fork/CHANGES.md", `${entry(1)}\n${entry(2)}\n`, "docs(fork): changes");
  commit(fork, "fork-1.txt", "fork\n", `feat: feature 1\n\nUpstream-PR: ${pr(1)}`);
  commit(fork, "fork-2.txt", "fork\n", `feat: feature 2\n\nUpstream-PR: ${pr(2)}`);

  // Stands in for `gh pr view <n> ... --jq <filter>`, printing the filter's
  // result saved for PR <n>: the merge SHA if merged, nothing if open. A PR
  // without a saved result fails like an API error.
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
cat "\${0%/*}/pr-$3" 2>/dev/null || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, "pr-1"), `${merge}\n`);
  writeFileSync(path.join(bin, "pr-2"), "");

  const sync = (...args) =>
    spawnSync(bash, [script, ...args], { cwd: fork, env, encoding: "utf8" });
  const forkCommits = [git(fork, "rev-parse", "HEAD~1"), git(fork, "rev-parse", "HEAD")];
  const parents = () => git(fork, "log", "-1", "--format=%P").split(" ");
  const subjects = (range) => git(fork, "log", "--format=%s", range).split("\n");
  const changes = () => git(fork, "show", "HEAD:fork/CHANGES.md").split("\n");
  const files = () => git(fork, "ls-tree", "--name-only", "HEAD").split("\n");
  return {
    git,
    fork,
    bin,
    commit,
    sync,
    forkCommits,
    parents,
    subjects,
    changes,
    files,
    entry,
    nightly1,
    nightly2,
  };
}

test("merges the pinned nightly and keeps a PR's patch merged after it", (t) => {
  const { git, fork, sync, forkCommits, parents, changes, entry, nightly1 } = fixture(t);
  const before = git(fork, "rev-parse", "HEAD");

  const result = sync("--onto", nightly1);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^status=synced$/m);
  assert.deepEqual(parents(), [before, nightly1]);
  for (const sha of forkCommits) git(fork, "merge-base", "--is-ancestor", sha, "HEAD");
  assert.deepEqual(changes(), [entry(1), entry(2)]);
  assert.match(sync("--onto", nightly1).stdout, /^status=current$/m);
});

test("reverts a merged PR's patch and entry before merging", (t) => {
  const { git, fork, sync, forkCommits, parents, subjects, changes, files, entry, nightly2 } =
    fixture(t);

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Reverting feat: feature 1: upstream PR #1 merged\.$/m);
  assert.match(result.stdout, /^status=synced$/m);
  assert.equal(parents()[1], nightly2);
  assert.deepEqual(subjects("HEAD^1~1..HEAD^1"), ['Revert "feat: feature 1"']);
  assert.match(
    git(fork, "log", "-1", "--format=%B", "HEAD^1"),
    new RegExp(`This reverts commit ${forkCommits[0]}`),
  );
  assert.deepEqual(changes(), [entry(2)]);
  assert.ok(!files().includes("fork-1.txt"));
  assert.ok(files().includes("feature-1.txt"));
});

test("reverts every commit for a merged PR, including ones that edited its entry", (t) => {
  const { git, fork, sync, changes, files, entry, nightly2 } = fixture(t);
  const pr1 = "https://github.com/pingdotgg/t3code/pull/1";
  // Two follow-ups each revise the code and the entry, so reverting them one
  // by one would conflict on the entry.
  for (const round of [1, 2]) {
    writeFileSync(path.join(fork, "fork-1.txt"), `fork, revision ${round}\n`);
    writeFileSync(
      path.join(fork, "fork/CHANGES.md"),
      `${entry(1)} (revision ${round})\n${entry(2)}\n`,
    );
    git(fork, "add", "fork-1.txt", "fork/CHANGES.md");
    git(fork, "commit", "-qm", `fix: feature 1 revision ${round}\n\nUpstream-PR: ${pr1}`);
  }

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^Reverting /gm).length, 3);
  assert.ok(!files().includes("fork-1.txt"));
  assert.deepEqual(changes(), [entry(2)]);
});

test("refuses to sync over staged changes", (t) => {
  const { git, fork, sync, nightly2 } = fixture(t);
  writeFileSync(path.join(fork, "unrelated.txt"), "staged\n");
  git(fork, "add", "unrelated.txt");
  const before = git(fork, "rev-parse", "HEAD");

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be clean/);
  assert.equal(git(fork, "rev-parse", "HEAD"), before);
});

test("keeps a merged PR's patch named by a Related-PR trailer", (t) => {
  const { git, fork, sync, changes, files, entry, nightly2 } = fixture(t);
  git(
    fork,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "chore: keep feature 1\n\nRelated-PR: https://github.com/pingdotgg/t3code/pull/1",
  );

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^Reverting/m);
  assert.ok(files().includes("fork-1.txt"));
  assert.deepEqual(changes(), [entry(1), entry(2)]);
});

test("continues after a resolved conflict without reverting twice", (t) => {
  const { git, fork, commit, sync, subjects, nightly2 } = fixture(t);
  commit(fork, "nightly.txt", "fork\n", "feat: fork nightly marker");

  const stopped = sync("--onto", nightly2);
  assert.equal(stopped.status, 2, stopped.stderr);
  assert.match(stopped.stdout, /^status=conflict$/m);
  git(fork, "rev-parse", "--verify", "MERGE_HEAD");
  commit(fork, "nightly.txt", "resolved\n", "chore(fork): merge upstream nightly 2");

  const resumed = sync("--onto", nightly2);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /^status=current$/m);
  assert.equal(subjects("HEAD~3..HEAD").filter((s) => s.startsWith("Revert")).length, 1);
});

test("continues after a resolved revert conflict", (t) => {
  const { git, fork, commit, sync, changes, entry, nightly2 } = fixture(t);
  commit(fork, "fork-1.txt", "fork, extended\n", "feat: extend feature 1 locally");

  const stopped = sync("--onto", nightly2);
  assert.equal(stopped.status, 2, stopped.stderr);
  git(fork, "rev-parse", "--verify", "REVERT_HEAD");
  git(fork, "rm", "-q", "fork-1.txt");
  git(fork, "commit", "-q", "--no-edit");

  const resumed = sync("--onto", nightly2);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(resumed.stdout, /^Reverting/m);
  assert.match(resumed.stdout, /^status=synced$/m);
  assert.deepEqual(changes(), [entry(2)]);
});

test("stops before changing anything when PR metadata cannot be read", (t) => {
  const { git, fork, bin, sync, nightly2 } = fixture(t);
  rmSync(path.join(bin, "pr-1"));
  const before = git(fork, "rev-parse", "HEAD");

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 502/);
  assert.equal(git(fork, "rev-parse", "HEAD"), before);
});
