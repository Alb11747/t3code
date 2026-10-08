import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

// Exercise the real JSON-RPC client and process lifecycle without account access.
const account = JSON.parse(process.env.CODEX_PROBE_ACCOUNT);
const input = NodeReadline.createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  NodeFS.appendFileSync(process.env.CODEX_PROBE_METHODS, `${request.method}\n`);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        userAgent: "T3 Code/0.161.0",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
      };
      break;
    case "account/read":
      result = account;
      break;
    case "model/list":
      result = {
        data: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            description: "Test model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [],
            additionalSpeedTiers: [],
          },
        ],
        nextCursor: null,
      };
      break;
    case "skills/list":
      result = { data: [] };
      break;
    case "account/rateLimits/read":
      if (process.env.CODEX_PROBE_USAGE_ERROR === "true") {
        process.stdout.write(
          JSON.stringify({
            id: request.id,
            error: { code: -32600, message: "chatgpt authentication required to read rate limits" },
          }) + "\n",
        );
        continue;
      }
      result = {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2000000000 },
          secondary: null,
        },
      };
      break;
    default:
      throw new Error(`Unexpected app-server request: ${request.method}`);
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
}
