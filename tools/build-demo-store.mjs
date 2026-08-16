#!/usr/bin/env node
// Lane F (F-D) — build the fictional Halfmoon Games demo store.
//
//   node tools/build-demo-store.mjs --out <dir>
//
// Thin CLI over src/ops/demoStore.ts (run `npm run build` first — this imports
// the compiled dist). The store is wholly fictional, plaintext, and
// deterministic: two runs produce byte-identical stores. See the module
// docblock in src/ops/demoStore.ts for what's inside.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node tools/build-demo-store.mjs --out <dir>");
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
let out;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else if (args[i] === "-h" || args[i] === "--help") usage();
  else usage(`unknown argument ${args[i]}`);
}
if (!out) usage("--out <dir> is required");

const distUrl = pathToFileURL(
  path.join(TOOLS_DIR, "..", "dist", "ops", "demoStore.js"),
).href;

let buildDemoStore;
try {
  ({ buildDemoStore } = await import(distUrl));
} catch (err) {
  console.error("Could not load the compiled runtime — run `npm run build` first.");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

try {
  const r = await buildDemoStore(path.resolve(out));
  console.log(`Built the Halfmoon Games demo store at ${r.home}`);
  console.log(
    `  ${r.topics.length} demo topics (+ the worked example), ${r.entries} log entries, ` +
      `${r.approved} curated notes approved, ${r.pending} suggested edit left pending.`,
  );
  console.log(`Try: gestalt list --home "${r.home}"`);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
