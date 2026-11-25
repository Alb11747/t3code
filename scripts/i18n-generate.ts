#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot dev script; synchronous Node APIs keep it small.
// Runs an app's `gt generate` (the node script and args passed in), then puts its catalogs back in
// their committed order. gt writes keys in source-scan order, but catalogs grow by appending, here
// and in upstream merges, so a plain run moves thousands of lines in every locale. Kept entries
// keep their place and text, new entries go at the end, removed ones drop out.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// Catalogs are flat, so a top-level entry starts at a two-space-indented key and runs (JSX entries
// over several lines) until the next one or the closing brace.
const entries = (text: string) => {
  const result = new Map<string, string>();
  const body = text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"));
  for (const chunk of body.split(/\n(?= {2}")/)) {
    const entry = chunk.replace(/^\n/, "").replace(/,?\s*$/, "");
    const key = /^ {2}"([^"]+)":/.exec(entry)?.[1];
    if (key !== undefined) result.set(key, entry);
  }
  return result;
};
const valueOf = (entry: string) => JSON.parse(`{${entry}}`);
const sameValue = (a: string, b: string) =>
  JSON.stringify(Object.values(valueOf(a))) === JSON.stringify(Object.values(valueOf(b)));

const [script, ...args] = process.argv.slice(2);
if (script === undefined) throw new Error("Pass the gt generate script and its arguments.");
// Additional CLI flags can change the config, locales or output. Pass those invocations through.
const before = new Map<string, string>();
if (args.length === 1 && args[0] === "generate") {
  const config = JSON.parse(NodeFS.readFileSync("gt.config.json", "utf8"));
  for (const locale of [config.defaultLocale, ...config.locales]) {
    const file = config.files.gt.output.replace("[locale]", locale);
    if (NodeFS.statSync(file, { throwIfNoEntry: false }) !== undefined) {
      before.set(file, NodeFS.readFileSync(file, "utf8"));
    }
  }
}
const gt = NodeChildProcess.spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
if (gt.error !== undefined) throw gt.error;
if (gt.status !== 0) process.exit(gt.status ?? 1);

for (const [file, text] of before) {
  const old = entries(text);
  const generated = entries(NodeFS.readFileSync(file, "utf8"));
  const kept = [...old].flatMap(([key, entry]) => {
    const next = generated.get(key);
    if (next === undefined) return [];
    return [sameValue(entry, next) ? entry : next];
  });
  const added = [...generated].filter(([key]) => !old.has(key)).map(([, entry]) => entry);
  NodeFS.writeFileSync(file, `{\n${[...kept, ...added].join(",\n")}\n}\n`);
}
if (before.size > 0) console.log(`Kept the committed key order in ${before.size} catalogs.`);
