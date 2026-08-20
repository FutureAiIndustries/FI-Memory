/**
 * The shipped binary and the advice must agree (2026-07-28).
 *
 * Found by the first ever cold install: the package ships as `fimemory`, but
 * ~200 user-facing strings still told the reader to run `gestalt <verb>`. The
 * very first thing a stranger sees after `fimemory init` was a "Try it:" block
 * naming a command they do not have. That is the fastest possible way to lose
 * someone in their first ten minutes, and nothing caught it because every test
 * ran from inside the repo where a `gestalt` alias happens to exist.
 *
 * This guards the source so it cannot come back.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BIN, PRODUCT, cmd } from "../src/brand.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every CLI verb a hint might name. */
const VERBS = [
  "list", "get", "review", "search", "log", "init", "doctor", "unlock", "lock",
  "status", "create", "update", "compact", "export", "merge", "reindex",
  "encrypt", "recover", "brief", "context", "join", "demo", "mcp",
  "install-rules", "uninstall-rules", "install-hooks", "uninstall-hooks",
  "install-mcp", "uninstall-mcp", "hook-retrieve", "hook-capture",
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("brand consistency: the binary and the advice agree", () => {
  it("no source string tells the user to run a command we do not ship", () => {
    const re = new RegExp(`\\bgestalt (?=(?:${VERBS.join("|")})\\b)`);
    const bad: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (re.test(line)) bad.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad, `these name a command the shipped bin (${BIN}) does not provide:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no source string calls the product Gestalt to the user", () => {
    // The class name GestaltError, fimemory_* tool ids, ~/.gestalt paths and
    // GESTALT_* env vars are deliberately NOT renamed: they are identifiers
    // and on-disk contracts, not prose. This catches display prose only.
    const re = /\b(?:A|a|the|No|not a) Gestalt (?:store|write|brief|doctor)\b/;
    const bad: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (re.test(line)) bad.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad, `user-facing prose still says Gestalt:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no source string tells the reader to run a private tool this package does not ship", () => {
    // `nexus` is the operator's own cockpit CLI, and it lives in a different,
    // PRIVATE repo. Nobody who installs this package has it. Both src/ and
    // dist/ go into the published tarball, so a hint naming it hands a stranger
    // an instruction they cannot follow — the same failure as the `gestalt
    // <verb>` hints above, and exactly the policy stage-export.mjs states when
    // it strips the dev manifest's comments rather than "hand a stranger notes
    // about a file they will never see, referencing a Harness they do not
    // have". Say what the condition MEANS and what to check instead.
    // Case-SENSITIVE and verb-shaped, because it is the instruction that does
    // the damage, not the word. `nexus doctor` is something the reader is being
    // told to type; "Nexus first-run" in an internal comment is a product being
    // named. Widening this to the bare name would flag the latter and get the
    // test deleted, which is how a tripwire stops working.
    const re = /\bnexus\s+[a-z][a-z-]*/;
    const bad: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (re.test(line)) bad.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(bad, `these point at a private tool the reader does not have:\n${bad.join("\n")}`).toEqual([]);
  });

  it("the brand helpers build correct examples", () => {
    expect(BIN).toBe("fimemory");
    expect(PRODUCT).toBe("FIMemory");
    expect(cmd('search "wave difficulty"')).toBe('fimemory search "wave difficulty"');
  });
});

/**
 * The README the export ships must agree with the binary too (2026-08-19).
 *
 * Found the night before 0.3.0 publish: the gate-attested artifact's README
 * told the reader `claude mcp add gestalt -s user` while the shipped CLI
 * registers `fimemory`, said the store lives at `~/.gestalt` while a fresh
 * `init` creates `~/.fimemory`, named a tool id (`gestalt_search`) the MCP
 * server does not export, and introduced the package as "not published yet,
 * private beta" — on what becomes the npm landing page. The src/ sweep above
 * never sees any of it because the README is generated by
 * scripts/stage-export.mjs, outside src/. Guard the generator's output, not
 * the tree it happens to be staged into.
 *
 * The staged export runs this same test file, but the generator script is
 * deliberately NOT part of the export (it is the private packaging tool), so
 * inside the stage this test skips: the README there is already the frozen
 * OUTPUT this test validated at generation time in the private repo.
 */
const GENERATOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "stage-export.mjs",
);
describe("brand consistency: the shipped README and the binary agree", () => {
  it.skipIf(!existsSync(GENERATOR))("generateReadme() never contradicts the shipped surface", async () => {
    const { generateReadme } = await import("../scripts/stage-export.mjs");
    const readme: string = generateReadme();
    const banned: Array<[RegExp, string]> = [
      [/claude mcp (add|remove) gestalt\b/, "the MCP server key is `fimemory`"],
      [/\bgestalt_(search|get|log|create|update|compact|status)\b/, "tool ids are `fimemory_*`"],
      [/not published yet/, "the README ships on the npm page of the published package"],
      [/only when there is no store at `~\/\.gestalt`/, "a fresh init creates `~/.fimemory`"],
      [/rm -rf ~\/\.gestalt`/, "teardown names the current default store path"],
      [/keep the runtime's internal name/, "the 0.3.0 rename shipped; the old naming note is false"],
    ];
    const hits = banned
      .filter(([re]) => re.test(readme))
      .map(([re, why]) => `${re} — ${why}`);
    expect(hits, `README contradicts the shipped binary:\n${hits.join("\n")}`).toEqual([]);
  });
});
