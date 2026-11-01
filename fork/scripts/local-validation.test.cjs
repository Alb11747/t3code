const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { hasValidation, recordValidation } = require("./local-validation.cjs");

const sha = "a".repeat(40);
const other = "b".repeat(40);
const url = `https://github.com/Alb11747/t3code/commit/${sha}#commitcomment-1`;

test("local validation records the exact clean commit's report before its receipt", () => {
  const calls = [];
  const options = {
    git: (command) => (command === "rev-parse" ? `${sha}\n` : ""),
    api: (endpoint, body) => {
      calls.push({ endpoint, body });
      return { html_url: url };
    },
    directory: path.resolve("checkout"),
    reportPath: path.resolve("report.md"),
    report: "Focused regression: 12 passed.\nChanged-file checks: passed.",
  };
  assert.equal(recordValidation(options), url);
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    [`repos/Alb11747/t3code/commits/${sha}/comments`, `repos/Alb11747/t3code/statuses/${sha}`],
  );
  assert.ok(calls[0].body.body.includes(`Commit: ${sha}`));
  assert.ok(calls[0].body.body.includes(options.report));
  assert.deepEqual(calls[1].body, {
    state: "success",
    context: "fork-local-validation",
    description: `local@${sha}`,
    target_url: url,
  });
  for (const overrides of [
    { git: (command) => (command === "rev-parse" ? sha : " M source.ts") },
    { report: " \n" },
    { reportPath: path.resolve("checkout/report.md") },
  ]) {
    calls.length = 0;
    assert.throws(() => recordValidation({ ...options, ...overrides }), /Commit all|empty|outside/);
    assert.equal(calls.length, 0);
  }
  calls.length = 0;
  assert.throws(
    () =>
      recordValidation({
        ...options,
        api: () => {
          throw new Error("comment rejected");
        },
      }),
    /comment rejected/,
  );
  assert.throws(
    () =>
      recordValidation({
        ...options,
        api: (endpoint) => {
          calls.push(endpoint);
          if (endpoint.includes("/statuses/")) throw new Error("status rejected");
          return { html_url: url };
        },
      }),
    /status rejected/,
  );
  assert.equal(calls.length, 2);
});

test("release reuses an exact local receipt or a hosted pass from the same checks definition", () => {
  for (const { statuses, sameWorkflow = true, expected } of [
    {
      statuses: [
        { context: "fork-local-validation", state: "success", description: `local@${sha}` },
      ],
      expected: true,
    },
    {
      statuses: [
        { context: "fork-local-validation", state: "success", description: `local@${other}` },
      ],
      expected: false,
    },
    {
      statuses: [
        { context: "fork-local-validation", state: "failure", description: `local@${sha}` },
      ],
      expected: false,
    },
    {
      statuses: [{ context: "fork-checks", state: "success", description: `checks@${other}` }],
      expected: true,
    },
    {
      statuses: [{ context: "fork-checks", state: "success", description: `checks@${other}` }],
      sameWorkflow: false,
      expected: false,
    },
    {
      statuses: [{ context: "fork-checks", state: "pending", description: `checks@${other}` }],
      expected: false,
    },
    { statuses: [], expected: false },
  ]) {
    const api = (endpoint) =>
      endpoint.includes("/status?")
        ? { statuses }
        : {
            sha:
              sameWorkflow || endpoint.endsWith(sha)
                ? "current-workflow-blob"
                : "old-workflow-blob",
          };
    assert.equal(hasValidation(api, sha), expected);
  }
  assert.throws(
    () =>
      hasValidation(() => {
        throw new Error("API unavailable");
      }, sha),
    /API unavailable/,
  );
  assert.throws(() => hasValidation(() => {}, "main"), /full commit/);
});
