import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { defaultHome, resolveHome } from "../src/paths.js";

/**
 * PROOF that `npm test` never touches the real store (BUILD-PLAN B0 accept).
 * Two parts: (1) the sandbox is provably active, and (2) exercising the whole
 * command surface with DEFAULT options leaves the real ~/.gestalt byte-for-byte
 * unchanged, while a store IS created — in the temp sandbox.
 */
describe("store isolation — npm test never touches the real store", () => {
  it("the temp sandbox is active: default resolveHome() lands in the run-root, not ~/.gestalt", () => {
    expect(process.env.GESTALT_HOME).toBeTruthy();
    expect(process.env.GESTALT_TEST_ROOT).toBeTruthy();

    const resolved = resolveHome(); // no --home → reads GESTALT_HOME (sandbox)
    const realStore = path.resolve(os.homedir(), ".gestalt");

    expect(resolved).not.toBe(realStore);
    expect(resolved.startsWith(path.resolve(process.env.GESTALT_TEST_ROOT!))).toBe(
      true,
    );
  });

  it("running init + status with DEFAULT opts leaves the real ~/.gestalt untouched", () => {
    const realStore = defaultHome(); // os.homedir()/.gestalt — the REAL path
    const before = snapshot(realStore);

    // Exercise every command with default options (no --home). Thanks to the
    // sandbox these hit the temp store; none of them can reach the real one.
    runInit(); // creates the sandbox store
    runStatus(); // reads the sandbox store
    expect(() => runInit()).toThrow(); // second init refuses (store exists)

    // Positive control: a store really WAS created — just the temp one.
    expect(
      existsSync(path.join(process.env.GESTALT_HOME!, "config.json")),
    ).toBe(true);

    // The proof: the real store is exactly as it was (absent stays absent;
    // present stays present with an unchanged mtime).
    expect(snapshot(realStore)).toEqual(before);
  });
});

function snapshot(p: string): { exists: boolean; mtimeMs: number | null } {
  if (!existsSync(p)) return { exists: false, mtimeMs: null };
  return { exists: true, mtimeMs: statSync(p).mtimeMs };
}
