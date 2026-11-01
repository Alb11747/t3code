const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const repository = "Alb11747/t3code";
const root = path.resolve(__dirname, "../..");

function recordValidation({ git, api, report, reportPath, directory = root }) {
  const sha = git("rev-parse", "HEAD").trim();
  if (git("status", "--porcelain").trim())
    throw new Error("Commit all changes before recording local validation.");
  const relative = path.relative(directory, path.resolve(reportPath));
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    throw new Error("Keep the validation report outside the repository.");
  if (!report.trim()) throw new Error("The validation report is empty.");
  const comment = api(`repos/${repository}/commits/${sha}/comments`, {
    body: `## Local validation\n\nCommit: ${sha}\n\n${report.trim()}\n\nRecorded locally; this is not a full hosted-suite pass.`,
  });
  api(`repos/${repository}/statuses/${sha}`, {
    state: "success",
    context: "fork-local-validation",
    description: `local@${sha}`,
    target_url: comment.html_url,
  });
  return comment.html_url;
}

function hasValidation(api, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Use a full commit SHA.");
  const { statuses } = api(`repos/${repository}/commits/${sha}/status?per_page=100`);
  const local = statuses.find((status) => status.context === "fork-local-validation");
  if (local?.state === "success" && local.description === `local@${sha}`) return true;
  const hosted = statuses.find((status) => status.context === "fork-checks");
  const workflowSha =
    hosted?.state === "success" && /^checks@([0-9a-f]{40})$/.exec(hosted.description)?.[1];
  if (!workflowSha) return false;
  const file = `repos/${repository}/contents/.github/workflows/fork-checks.yml`;
  return api(`${file}?ref=${workflowSha}`).sha === api(`${file}?ref=${sha}`).sha;
}

module.exports = { hasValidation, recordValidation };

if (require.main === module) {
  const api = (endpoint, body) =>
    JSON.parse(
      execFileSync("gh", ["api", endpoint, ...(body ? ["--input", "-"] : [])], {
        encoding: "utf8",
        input: body ? JSON.stringify(body) : undefined,
        stdio: ["pipe", "pipe", "inherit"],
      }),
    );
  const [command, value] = process.argv.slice(2);
  if (command === "record" && value) {
    console.log(
      recordValidation({
        git: (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }),
        api,
        reportPath: value,
        report: readFileSync(value, "utf8"),
      }),
    );
  } else if (command === "check" && value) {
    console.log(hasValidation(api, value));
  } else {
    throw new Error("Usage: node fork/scripts/local-validation.cjs <record report.md | check SHA>");
  }
}
