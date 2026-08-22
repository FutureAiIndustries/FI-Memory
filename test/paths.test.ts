import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { defaultHome, fsPath, resolveHome, resolveHomeWithSource } from "../src/paths.js";
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

describe("R2 — resolveHomeWithSource provenance", () => {
  it("--home flag wins and reports source 'flag'", () => {
    const r = resolveHomeWithSource({ home: "C:/tmp/explicit", env: { FIMEMORY_STORE: "C:/tmp/env" } });
    expect(r.home).toContain("explicit");
    expect(r.source).toBe("flag");
  });
  it("FIMEMORY_STORE outranks FIMEMORY_HOME and names itself", () => {
    const r = resolveHomeWithSource({ env: { FIMEMORY_STORE: "C:/tmp/via-store", FIMEMORY_HOME: "C:/tmp/via-home" } });
    expect(r.home).toContain("via-store");
    expect(r.source).toBe("FIMEMORY_STORE");
  });
  it("legacy GESTALT_HOME still resolves, and the source says so honestly", () => {
    const r = resolveHomeWithSource({ env: { GESTALT_HOME: "C:/tmp/legacy-home" } });
    expect(r.home).toContain("legacy-home");
    expect(r.source).toBe("GESTALT_HOME");
  });
  it("GESTALT_STORE (legacy) outranks FIMEMORY_HOME — STORE is the more specific suffix, and the suffix ranks before the prefix", () => {
    const r = resolveHomeWithSource({ env: { GESTALT_STORE: "C:/tmp/legacy-store", FIMEMORY_HOME: "C:/tmp/new-home" } });
    expect(r.home).toContain("legacy-store");
    expect(r.source).toBe("GESTALT_STORE");
  });
  it("empty env values are ignored, falling through to the default with provenance", () => {
    const r = resolveHomeWithSource({ env: { FIMEMORY_STORE: "  ", FIMEMORY_HOME: "" }, userHome: "C:/tmp/nonexistent-user-home-r2" });
    expect(r.source).toBe("default");
  });
  it("resolveHome stays a thin wrapper — same path, no provenance", () => {
    const env = { FIMEMORY_STORE: "C:/tmp/wrapper-check" };
    expect(resolveHome({ env })).toBe(resolveHomeWithSource({ env }).home);
  });
});
