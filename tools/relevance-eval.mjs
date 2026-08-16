#!/usr/bin/env node
// Lane F (F-B) — relevance eval: pre-registered queries vs a store, READ-ONLY.
//
//   node tools/relevance-eval.mjs --home <storeDir> --queries <file.json>
//                                 [--json-out <file>] [--md-out <file>]
//
// Prints the Markdown report to stdout; --json-out/--md-out also write files.
// Query file: [{ id, question, queryTerms: [..], expectedTopics: [..] }] — see
// tools/fixtures/demo-store-queries.json for the registered demo-store set.
// Encrypted stores unlock the same way the CLI does (GESTALT_PASSPHRASE /
// GESTALT_KEY / warm session cache). Run `npm run build` first — this imports
// the compiled dist.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node tools/relevance-eval.mjs --home <storeDir> --queries <file.json> [--json-out <file>] [--md-out <file>]",
  );
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
let home, queriesFile, jsonOut, mdOut;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--home") home = args[++i];
  else if (args[i] === "--queries") queriesFile = args[++i];
  else if (args[i] === "--json-out") jsonOut = args[++i];
  else if (args[i] === "--md-out") mdOut = args[++i];
  else if (args[i] === "-h" || args[i] === "--help") usage();
  else usage(`unknown argument ${args[i]}`);
}
if (!home) usage("--home <storeDir> is required");
if (!queriesFile) usage("--queries <file.json> is required");

const dist = (rel) => pathToFileURL(path.join(TOOLS_DIR, "..", "dist", rel)).href;

let parseQueryFile, runRelevanceEval, renderEvalMarkdown, ensureStoreUnlocked;
try {
  ({ parseQueryFile, runRelevanceEval, renderEvalMarkdown } = await import(
    dist("ops/relevanceEval.js")
  ));
  ({ ensureStoreUnlocked } = await import(dist("ops/unlockOp.js")));
} catch (err) {
  console.error("Could not load the compiled runtime — run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

try {
  const storeHome = path.resolve(home);
  ensureStoreUnlocked(storeHome); // no-op for plaintext stores
  const queries = parseQueryFile(readFileSync(queriesFile, "utf8"));
  const report = await runRelevanceEval(storeHome, queries);
  const md = renderEvalMarkdown(report);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (mdOut) writeFileSync(mdOut, md, "utf8");
  process.stdout.write(md);
  // Non-zero when anything missed at hit@3, so CI can gate on it directly.
  process.exit(report.misses.length === 0 ? 0 : 2);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
