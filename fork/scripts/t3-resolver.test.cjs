const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bash =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone shell tests have no Effect runtime.
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const scripts = path.join(__dirname, "t3-resolver");

function fakeGh() {
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.env.RESOLVER_TEST_STATE, "utf8"));
  const args = process.argv.slice(2);
  if (args[0] === "api" && args[1].endsWith("/git/ref/heads/main")) {
    console.log(state.sha);
  } else if (args[0] === "pr" && args[1] === "list") {
    const run = state.advanced ? state.run : "100";
    const result = state.advanced ? state.result : state.staleResult;
    console.log(
      JSON.stringify({
        number: 7,
        headRefOid: state.sha,
        createdAt: "2026-01-01T00:00:00Z",
        body: `Merged as candidate \`${state.sha}\`.\nChecks: **${result}** (https://github.com/Alb11747/t3code/actions/runs/${run})`,
      }),
    );
  } else if (args[0] === "api" && args.includes("--paginate")) {
    console.log(
      `<!-- codex-review-state:v1 ${JSON.stringify({
        code_review: { commit_sha: state.sha, status: "completed", has_any_findings: false },
      })} -->`,
    );
  } else if (args[0] === "workflow" && args[1] === "run") {
    state.dispatches.push(args.find((arg) => arg.startsWith("mode=")));
    console.log(`https://github.com/Alb11747/t3code/actions/runs/${state.run}`);
  } else if ((args[0] === "issue" || args[0] === "pr") && args[1] === "comment") {
    if (args.includes("--body-file")) fs.readFileSync(0, "utf8");
  } else {
    throw new Error(`Unexpected gh call: ${JSON.stringify(args)}`);
  }
  fs.writeFileSync(process.env.RESOLVER_TEST_STATE, JSON.stringify(state));
}

function advanceChecks() {
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.env.RESOLVER_TEST_STATE, "utf8"));
  if (state.advanced) throw new Error("The helper did not consume the retry result");
  state.advanced = true;
  fs.writeFileSync(process.env.RESOLVER_TEST_STATE, JSON.stringify(state));
}

function fixture(t, result, staleResult) {
  const root = mkdtempSync(path.join(tmpdir(), "t3-resolver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const statePath = path.join(root, "state.json");
  const ledgerPath = path.join(root, "requests", "1.json");
  const summary = path.join(root, "summary.md");
  for (const directory of [bin, repo, path.dirname(ledgerPath)]) mkdirSync(directory);
  for (const [name, handler] of [
    ["resolver-gh", fakeGh],
    ["sleep", advanceChecks],
  ]) {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n(${handler.toString()})();\n`, {
      mode: 0o755,
    });
  }
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: "Resolver test",
    GIT_AUTHOR_EMAIL: "resolver@example.com",
    GIT_COMMITTER_NAME: "Resolver test",
    GIT_COMMITTER_EMAIL: "resolver@example.com",
    FORK_RESOLVER_HOME: root.replaceAll("\\", "/"),
    FORK_PUSH_URL: remote.replaceAll("\\", "/"),
    FORK_GH: "resolver-gh",
    RESOLVER_TEST_STATE: statePath,
  };
  delete env.FORK_SETTLE_TIMEOUT;
  delete env.FORK_FIX_ATTEMPTS;
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  git(repo, "init", "-q", "--initial-branch=main");
  writeFileSync(path.join(repo, "README.md"), "Fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "fixture");
  git(root, "init", "-q", "--bare", remote);
  const sha = git(repo, "rev-parse", "HEAD");
  writeFileSync(summary, "Validated fixture.\n");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      request_run_id: 1,
      run_attempt: 1,
      main_sha: sha,
      upstream_sha: sha,
      stopped_commit: sha,
      stopped_subject: "fixture",
      created_at: "2026-01-01T00:00:00Z",
      status: "published",
      issue_number: 7,
      candidate_sha: sha,
      published_at: 1_800_000_000,
      checks_run_id: "200",
      fix_attempts: 0,
    }),
  );
  writeFileSync(
    statePath,
    JSON.stringify({ sha, run: "200", result, staleResult, advanced: false, dispatches: [] }),
  );
  return {
    run: (name, ...args) =>
      spawnSync(bash, [path.join(scripts, name).replaceAll("\\", "/"), "1", ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
      }),
    ledger: () => JSON.parse(readFileSync(ledgerPath, "utf8")),
    setLedger: (ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger)),
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    summary: summary.replaceAll("\\", "/"),
  };
}

test("same-SHA retry ignores an old failure and promotes only after its own checks pass", (t) => {
  const f = fixture(t, "success", "failure");
  const result = f.run("settle-candidate.sh");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.state().advanced, true);
  assert.deepEqual(f.state().dispatches, ["mode=promote"]);
  assert.equal(f.ledger().status, "published");
  assert.equal(f.ledger().fix_attempts, 0);
});

test("same-SHA retry ignores an old pass and returns its own failed run for repair", (t) => {
  const f = fixture(t, "failure", "success");
  const result = f.run("settle-candidate.sh");
  assert.equal(result.status, 5, result.stderr);
  assert.equal(f.state().advanced, true);
  assert.deepEqual(f.state().dispatches, []);
  assert.equal(f.ledger().status, "claimed");
  assert.equal(f.ledger().fix_attempts, 1);
  assert.match(result.stderr, /actions\/runs\/200/);
});

test("publication pins the dispatched check run even when the candidate SHA is unchanged", (t) => {
  const f = fixture(t, "success", "failure");
  f.setLedger({ ...f.ledger(), status: "claimed", checks_run_id: "100" });
  const result = f.run("publish-candidate.sh", f.summary);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ledger().checks_run_id, "200");
  assert.equal(f.ledger().status, "published");
  assert.deepEqual(f.state().dispatches, ["mode=resume"]);
});

test("a publication without validation-run metadata cannot promote or reopen the claim", (t) => {
  const f = fixture(t, "success", "success");
  const { checks_run_id: _checksRunId, ...ledger } = f.ledger();
  f.setLedger(ledger);
  const result = f.run("settle-candidate.sh");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing its validation run ID/);
  assert.deepEqual(f.state().dispatches, []);
  assert.equal(f.ledger().status, "published");
  assert.equal(f.ledger().fix_attempts, 0);
});
