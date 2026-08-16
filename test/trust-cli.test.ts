import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { sessionCachePath, wipeSessionCache } from "../src/sessionKeyCache.js";
import { clearActiveKey } from "../src/store/codec.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * The trust-surface CLI verbs, end-to-end through the real cli.ts:
 * `unlock` (warms the cache, prints TTL), `lock --status` (read-only warm/cold),
 * `doctor` (exit 1 on a locked store), install/uninstall-rules (markers).
 * Same spawn pattern as session-key-cache.test.ts.
 */

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function spawnCli(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, GESTALT_KEY: "", GESTALT_PASSPHRASE: "", ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function initEnc(label: string): string {
  const home = freshHome(label);
  runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
  clearActiveKey();
  wipeSessionCache(home);
  return home;
}

describe("fimemory unlock", () => {
  it("unlocks with --passphrase, warms the cache, and prints the time remaining", () => {
    const home = initEnc("unlock-warm");
    const r = spawnCli(["unlock", "--home", home, "--passphrase", PASS]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Unlocked");
    expect(r.stdout).toMatch(/stay fast for/);
    expect(existsSync(sessionCachePath(home))).toBe(true); // the cache is warm on disk
  });

  it("a wrong passphrase fails non-zero and caches nothing", () => {
    const home = initEnc("unlock-wrong");
    const r = spawnCli(["unlock", "--home", home, "--passphrase", "not the passphrase"]);
    expect(r.status).toBe(1);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("a plaintext store has nothing to unlock (exit 0, says so)", () => {
    const home = freshHome("unlock-plain");
    runInit({ home });
    const r = spawnCli(["unlock", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not encrypted");
  });

  it("--json reports source + cache expiry", () => {
    const home = initEnc("unlock-json");
    const r = spawnCli(["unlock", "--home", home, "--passphrase", PASS, "--json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { unlocked: boolean; source: string; cache: { state: string } };
    expect(j.unlocked).toBe(true);
    expect(j.cache.state).toBe("warm");
  });
});

describe("fimemory lock --status (read-only)", () => {
  it("cold: LOCKED, and the cache file is NOT created or touched by asking", () => {
    const home = initEnc("status-cold");
    const r = spawnCli(["lock", "--status", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("LOCKED (cold)");
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("warm: reports UNLOCKED with time remaining, and does NOT wipe (status ≠ lock)", () => {
    const home = initEnc("status-warm");
    expect(spawnCli(["unlock", "--home", home, "--passphrase", PASS]).status).toBe(0);
    const r = spawnCli(["lock", "--status", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNLOCKED (warm)");
    expect(r.stdout).toMatch(/expires in/);
    expect(existsSync(sessionCachePath(home))).toBe(true); // still warm — status never wipes
    // and a real `lock` afterwards DOES wipe
    expect(spawnCli(["lock", "--home", home]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });
});

describe("fimemory doctor (CLI)", () => {
  it("a LOCKED store exits 1 and prints the encrypted-LOCKED verdict with the unlock hint", () => {
    const home = initEnc("doctor-locked");
    const r = spawnCli(["doctor", "--home", home]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("encrypted (LOCKED)");
    expect(r.stdout).toContain("GESTALT_PASSPHRASE");
    expect(r.stdout).toContain("fimemory unlock");
  });

  it("--json emits the full report", () => {
    const home = freshHome("doctor-json");
    runInit({ home });
    const r = spawnCli(["doctor", "--home", home, "--json"]);
    const j = JSON.parse(r.stdout) as { mode: string; findings: unknown[]; healthy: boolean };
    expect(j.mode).toBe("plaintext");
    expect(Array.isArray(j.findings)).toBe(true);
    expect(r.status).toBe(j.healthy ? 0 : 1);
  });
});

describe("install-rules / uninstall-rules (CLI)", () => {
  it("installs with the written-vs-loaded caveat, then uninstalls cleanly", () => {
    const dir = freshHome("rules-cli");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "CLAUDE.md");
    writeFileSync(file, "# mine\n", "utf8");

    const inst = spawnCli(["install-rules", "--file", file]);
    expect(inst.status).toBe(0);
    expect(inst.stdout).toMatch(/next session/i); // the caveat is printed
    expect(readFileSync(file, "utf8")).toContain("<!-- fimemory:rules v1 -->");

    const un = spawnCli(["uninstall-rules", "--file", file]);
    expect(un.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# mine\n");
  });
});
