import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { defaultHome, fsPath, resolveHome } from "../src/paths.js";
import { freshHome } from "./helpers.js";

describe("home resolution precedence (SPEC §1)", () => {
  it("--home beats GESTALT_HOME beats ~/.gestalt", () => {
    const flag = path.resolve(os.tmpdir(), "explicit-flag-home");
    // env is the sandbox (set by setup.ts); the flag must win.
    expect(resolveHome({ home: flag })).toBe(flag);
    // no flag → env (sandbox)
    expect(resolveHome({})).toBe(path.resolve(process.env.GESTALT_HOME!));
    // no flag, no env → default ~/.gestalt
    expect(resolveHome({ env: {} as NodeJS.ProcessEnv })).toBe(defaultHome());
  });

  it("ignores empty / whitespace-only overrides", () => {
    const env = { GESTALT_HOME: "   " } as NodeJS.ProcessEnv;
    expect(resolveHome({ home: "  ", env })).toBe(defaultHome());
  });
});

/**
 * Windows path tests (BUILD-PLAN B0 accept). These exercise the shapes that
 * break naive Windows path code — spaces, non-ASCII, and paths beyond the
 * classic 260-char MAX_PATH. They run on every platform (the store must be
 * correct everywhere) and specifically prove the win32 long-path handling in
 * `fsPath`. Each does a full init → status round-trip and reads a file back.
 */
describe("Windows-flavored path handling (Windows is first-class, SPEC §1/§8)", () => {
  function roundTrip(home: string): void {
    const init = runInit({ home });
    expect(init.topicCount).toBe(1);
    expect(existsSync(fsPath(path.join(home, "config.json")))).toBe(true);

    const status = runStatus({ home });
    expect(status.topicCount).toBe(1);
    expect(status.pendingProposals).toBe(1);
    expect(status.warnings).toEqual([]);

    const note = readFileSync(
      fsPath(path.join(home, "topics", "gestalt-example.md")),
      "utf8",
    );
    expect(note).toContain("## Owner notes");
  }

  it("profile path with spaces", () => {
    roundTrip(path.join(freshHome(), "Eric Smith", "App Data", "gestalt store"));
  });

  it("non-ASCII username / path segments", () => {
    roundTrip(path.join(freshHome(), "Éric-Ñoño-用户", ".gestalt"));
  });

  it("long path beyond MAX_PATH (> 260 chars)", () => {
    const deep = path.join(
      freshHome(),
      "a".repeat(80),
      "b".repeat(80),
      "c".repeat(80),
      "d".repeat(80),
      ".gestalt",
    );
    expect(deep.length).toBeGreaterThan(260);
    roundTrip(deep);
  });
});
