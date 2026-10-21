const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const repository = "Alb11747/t3code";
// Fork release checks the budget in its settle job; runs from before October
// 2026 checked it in a separate reusable job.
const budgetJobs = ["Wait for pushes to settle", "Job budget / Check job budget"];
const failedBudgetJob = (jobs) =>
  jobs.find((job) => budgetJobs.includes(job.name) && job.conclusion === "failure");

function verifyBudgetFailure(run, jobs, logs, releases) {
  if (
    run.path !== ".github/workflows/fork-release.yml" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "failure"
  ) {
    throw new Error("Expected a completed, failed Fork release on main.");
  }
  if (!failedBudgetJob(jobs)) {
    throw new Error("The release did not fail its job budget gate.");
  }
  const match = /The fork ran (\d+) jobs in the last 24 hours \(limit (\d+)\)/.exec(logs);
  if (!match || Number(match[1]) < Number(match[2])) {
    throw new Error("No job-budget exhaustion receipt; API or runner failures do not qualify.");
  }
  if (releases.flat().some((release) => !release.draft && release.published_at > run.updated_at)) {
    throw new Error(
      "A release was published after this failure; supply a newer budget-blocked run.",
    );
  }
}

module.exports = { verifyBudgetFailure };

if (require.main === module) {
  const runId = process.env.BLOCKED_RUN_ID;
  if (!/^\d+$/.test(runId ?? "")) throw new Error("Supply the numeric blocked_run_id.");
  const gh = (...args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));
  const run = api(`actions/runs/${runId}`);
  const jobs = api(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
  const budget = failedBudgetJob(jobs);
  const logs = budget
    ? gh("api", "--paginate", `${budget.check_run_url}/annotations`, "--jq", ".[].message")
    : "";
  const releases = JSON.parse(
    gh("api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`),
  );
  verifyBudgetFailure(run, jobs, logs, releases);
  // Include finished patches pushed since the blocked run, but pin the source
  // before checks and builds. A rewritten or unrelated main is not eligible.
  const sha = api("commits/main").sha;
  const comparison = api(`compare/${run.head_sha}...${sha}`);
  if (!["ahead", "identical"].includes(comparison.status)) {
    throw new Error("Current main does not contain the budget-blocked source.");
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  console.log(`Budget-blocked run ${runId}; building ${repository}@${sha}.`);
}
