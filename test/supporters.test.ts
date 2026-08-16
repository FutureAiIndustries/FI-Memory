import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT } from "../src/brand.js";
import { SUPPORTERS_FILE, readSupporters, supportersPath } from "../src/ops/supporters.js";
import { ALLOWLIST, stageExport, transformPackageJson } from "../scripts/stage-export.mjs";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * SUPPORTER CREDIT (owner decision, 2026-07-30).
 *
 * Supporter names ship in SUPPORTERS.md inside the package and NEVER inside
 * LICENSE.md: the licence is a legal instrument that tooling parses to detect
 * the project's terms, so appending a growing name list to it corrupts that
 * detection and would mean editing the licence on every sale. Credit is opt-in
 * — by real name, by handle, or not at all.
 *
 * The three things that can silently break the promise, so all three are
 * guarded here:
 *   1. the file stops shipping (dropped from `files` or from the stage), and a
 *      credit file that does not ship is worse than none at all;
 *   2. the command dies instead of degrading when the file is absent;
 *   3. names start leaking into LICENSE.md.
 */

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the real CLI the way a user does, so the wiring is what is tested. */
function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    cwd: RUNTIME,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe(`${SUPPORTERS_FILE} — the shipped credit file`, () => {
  const file = path.join(RUNTIME, SUPPORTERS_FILE);

  it("exists at the package root", () => {
    expect(existsSync(file), `${SUPPORTERS_FILE} must sit at the package root`).toBe(true);
  });

  it("reads correctly while empty: no placeholder names, and it says so plainly", () => {
    const text = readFileSync(file, "utf8");
    // The file must state the empty state as a fact, not look like a broken build.
    expect(text.toLowerCase()).toContain("empty");
    expect(text).toContain("opt-in");
    // Opt-in means all three answers are named, including "no".
    expect(text.toLowerCase()).toContain("handle");
    // A fake name in a shipped file is a lie someone will screenshot. There is
    // no way to assert "no invented names" in general, so this pins the two
    // shapes a placeholder actually takes.
    expect(text).not.toMatch(/\bYour Name Here\b/i);
    expect(text).not.toMatch(/\bJohn Doe\b|\bJane Doe\b|\bexample supporter\b/i);
  });

  it("promises no capability a non-supporter lacks — the runtime gates nothing", () => {
    const text = readFileSync(file, "utf8");
    expect(text).toContain("free to everyone");
    const lower = text.toLowerCase();
    for (const forbidden of ["unlock", "licence key", "license key", "activation", "entitle"]) {
      expect(lower, `${SUPPORTERS_FILE} must not imply a software gate ("${forbidden}")`).not.toContain(
        forbidden,
      );
    }
  });

  it("records WHY it is not LICENSE.md, so nobody re-litigates it from scratch", () => {
    const text = readFileSync(file, "utf8");
    expect(text).toContain("LICENSE.md");
  });
});

describe("readSupporters — resolves the packaged file, never the cwd", () => {
  it("finds the real file from src/ops/ (and would from dist/ops/ too)", () => {
    expect(supportersPath()).toBe(path.join(RUNTIME, SUPPORTERS_FILE));
    const r = readSupporters();
    expect(r.present).toBe(true);
    expect(r.text).toContain("Supporters");
    expect(r.reason).toBeUndefined();
  });

  it("NEVER throws when the file is absent — it reports absence", () => {
    const missing = path.join(freshHome("supporters-missing"), SUPPORTERS_FILE);
    const r = readSupporters(missing);
    expect(r.present).toBe(false);
    expect(r.text).toBe("");
    expect(r.path).toBe(missing);
    // Absent is not the same as unreadable: a plain missing file carries no
    // errno, so a packaging regression stays distinguishable from EACCES/EBUSY.
    expect(r.reason).toBeUndefined();
  });
});

describe("`supporters` command", () => {
  it("prints the shipped file verbatim", () => {
    const r = cli(["supporters"]);
    expect(r.code).toBe(0);
    const shipped = readFileSync(path.join(RUNTIME, SUPPORTERS_FILE), "utf8");
    expect(r.stdout).toContain(shipped.trimEnd());
  });

  it("is listed in the help text", () => {
    const r = cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("supporters");
    expect(r.stdout).toContain(SUPPORTERS_FILE);
  });

  it("--json reports path + presence for scripts", () => {
    const r = cli(["supporters", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { present: boolean; path: string; text: string };
    expect(j.present).toBe(true);
    expect(j.path).toBe(path.join(RUNTIME, SUPPORTERS_FILE));
    expect(j.text.length).toBeGreaterThan(0);
  });

  it("needs no store at all — an empty home is not an error", () => {
    // It reads a file inside the package, so it must work before `init` and it
    // must never demand a passphrase (it is in the unlock gate's exempt set).
    const r = cli(["supporters", "--home", freshHome("supporters-no-store")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Supporters");
  });

  it("degrades gracefully when the file is missing: exit 0, no crash, honest line", () => {
    // Exercised through readSupporters + the CLI's own absent-file text rather
    // than by deleting the real file (another agent may be running this suite
    // concurrently, and a test that removes a shipped file is a landmine).
    const missing = path.join(freshHome("supporters-gone"), SUPPORTERS_FILE);
    const r = readSupporters(missing);
    expect(r.present).toBe(false);

    // The absent-file branch must not read like a store failure, and it must
    // not leave the user wondering whether they lost something they paid for.
    const src = readFileSync(path.join(RUNTIME, "src", "cli.ts"), "utf8");
    const block = src.slice(src.indexOf(`case "supporters":`));
    expect(block).toContain("if (!r.present)");
    expect(block).toContain("free to everyone");
    // No `return 1` anywhere in the branch: a missing credit file is a
    // packaging fault, not something a script should read as a broken store.
    const branch = block.slice(0, block.indexOf(`case "compact":`));
    expect(branch).not.toContain("return 1");
    expect(branch).toContain("PRODUCT"); // brand-centralised, never hardcoded
    expect(PRODUCT).toBe("FIMemory");
  });
});

describe("packaging — the credit file actually ships", () => {
  it("is in the private package.json files array", () => {
    const pkg = JSON.parse(readFileSync(path.join(RUNTIME, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain(SUPPORTERS_FILE);
  });

  it("is in the export package.json files array (npm ships only what files lists)", () => {
    const pkg = JSON.parse(readFileSync(path.join(RUNTIME, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const t = transformPackageJson(pkg);
    expect(t["files"]).toContain(SUPPORTERS_FILE);
  });

  it("is on the stage-export allowlist", () => {
    expect(ALLOWLIST.files).toContain(SUPPORTERS_FILE);
  });

  it("lands in a staged export tree, with its content intact", () => {
    const out = freshHome("supporters-stage");
    stageExport({ runtimeDir: RUNTIME, outDir: out, denyPath: undefined });
    const staged = path.join(out, SUPPORTERS_FILE);
    expect(existsSync(staged), `${SUPPORTERS_FILE} must stage`).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe(
      readFileSync(path.join(RUNTIME, SUPPORTERS_FILE), "utf8"),
    );
    // And the staged package.json lists it, so `npm pack` would include it.
    const pkg = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain(SUPPORTERS_FILE);
  });

  it("survives a re-stage (the stage is rebuilt from scratch every run)", () => {
    const out = freshHome("supporters-restage");
    stageExport({ runtimeDir: RUNTIME, outDir: out, denyPath: undefined });
    writeFileSync(path.join(out, SUPPORTERS_FILE), "clobbered\n", "utf8");
    stageExport({ runtimeDir: RUNTIME, outDir: out, denyPath: undefined });
    expect(readFileSync(path.join(out, SUPPORTERS_FILE), "utf8")).not.toBe("clobbered\n");
  });
});

describe("LICENSE.md stays a licence", () => {
  /**
   * The runbook asks for "a test asserting LICENSE.md is byte-identical to the
   * canonical FSL text". That check cannot be written here honestly: no
   * canonical copy is vendored in this repo to compare against, and the FSL
   * Notice clause is filled in with the licensor's name
   * ("Copyright 2026 FutureIndustries LLC"), so the shipped file is legitimately
   * NOT byte-identical to the upstream template. Vendoring the canonical text
   * and diffing everything outside the Notice would be the real version of that
   * guard. What is asserted instead is the thing the decision was actually
   * about: no credit list creeps into the licence.
   */
  it("carries no supporter list and no credit section", () => {
    const licence = readFileSync(path.join(RUNTIME, "LICENSE.md"), "utf8");
    const lower = licence.toLowerCase();
    expect(lower).not.toContain("supporter");
    expect(lower).not.toContain("supporters.md");
    expect(lower).not.toContain("thank");
    // Still a licence, with the licensor named.
    expect(licence).toContain("FSL-1.1-ALv2");
    expect(licence).toContain("Copyright 2026 FutureIndustries LLC");
  });
});
