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
  const subjects = () => git(fork, "log", "--format=%s", "-4").split("\n");
  const changes = () => git(fork, "show", "HEAD:fork/CHANGES.md").split("\n");
  return { git, fork, bin, sync, subjects, changes, entry, nightly1, nightly2 };
}

test("keeps a merged PR's patch when the pinned nightly predates the merge", (t) => {
  const { sync, subjects, changes, entry, nightly1 } = fixture(t);

  const result = sync("--onto", nightly1);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^status=rebased$/m);
  assert.deepEqual(subjects(), [
    "feat: feature 2",
    "feat: feature 1",
    "docs(fork): changes",
    "nightly 1",
  ]);
  assert.deepEqual(changes(), [entry(1), entry(2)]);
});

test("drops a merged PR's patch and entry once the new base contains the merge", (t) => {
  const { sync, subjects, changes, entry, nightly2 } = fixture(t);

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Dropping feat: feature 1: upstream PR #1 merged\.$/m);
  assert.match(result.stdout, /^status=rebased$/m);
  assert.deepEqual(subjects(), [
    "feat: feature 2",
    "docs(fork): changes",
    "nightly 2",
    "Merge PR 1",
  ]);
  assert.deepEqual(changes(), [entry(2)]);
});

test("stops before rebasing when PR metadata cannot be read", (t) => {
  const { git, fork, bin, sync, nightly2 } = fixture(t);
  rmSync(path.join(bin, "pr-1"));
  const before = git(fork, "rev-parse", "HEAD");

  const result = sync("--onto", nightly2);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 502/);
  assert.equal(git(fork, "rev-parse", "HEAD"), before);
});
