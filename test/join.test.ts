import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";
import { runInit } from "../src/commands/init.js";
import { joinStore } from "../src/ops/joinOp.js";
import { freshHome } from "./helpers.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  temps.length = 0;
});

/** Build a bare git remote that contains a real store snapshot. */
function fixtureRemoteStore(): { remote: string; seedHome: string } {
  const seedHome = freshHome("join-seed");
  runInit({ home: seedHome });
  // Make it a git repo and commit.
  spawnSync("git", ["init"], { cwd: seedHome, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "join-test@example.com"], { cwd: seedHome });
  spawnSync("git", ["config", "user.name", "Join Test"], { cwd: seedHome });
  writeFileSync(path.join(seedHome, ".gitignore"), ".gestalt.lock/\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: seedHome });
  spawnSync("git", ["commit", "-m", "seed store"], { cwd: seedHome });

  const bare = mkdtempSync(path.join(tmpdir(), "join-remote-"));
  temps.push(bare);
  const remote = path.join(bare, "store.git");
  spawnSync("git", ["clone", "--bare", seedHome, remote], { encoding: "utf8" });
  return { remote, seedHome };
}

/**
 * A throwaway rules file for join's install-rules step.
 *
 * Without this, `joinStore` resolved the DEFAULT target — the developer's live
 * ~/.claude/CLAUDE.md — and every `npm test` run rewrote it with the shim body,
 * silently swapping the machine's measured retrieval behavior. `installHooks:
 * false` only ever guarded the other half of that write.
 */
function scratchRulesFile(label: string): string {
  const dir = freshHome(`join-rules-${label}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "CLAUDE.md");
}

describe("join <git-url> — team playbook join flow", () => {
  it("clones a fixture remote, verifies shape, guides passphrase, installs rules", async () => {
    const { remote } = fixtureRemoteStore();
    const dest = freshHome("join-dest");
    const rulesFile = scratchRulesFile("dest");
    // dest must not exist as non-empty; freshHome returns a path that may not exist yet
    const r = await joinStore({
      gitUrl: remote,
      home: dest,
      env: {} as NodeJS.ProcessEnv,
      installHooks: false, // avoid writing ~/.claude/settings.json in tests
      rulesFile, // ...and avoid writing ~/.claude/CLAUDE.md
    });
    expect(r.rulesPath).toBe(rulesFile);
    expect(existsSync(rulesFile)).toBe(true);
    expect(r.cloned).toBe(true);
    expect(r.storeShapeOk).toBe(true);
    expect(existsSync(path.join(dest, "config.json"))).toBe(true);
    expect(existsSync(path.join(dest, "topics"))).toBe(true);
    expect(r.passphraseGuide.length).toBeGreaterThan(0);
    // Must never contain a real passphrase value from the environment or store.
    const guideText = r.passphraseGuide.join("\n");
    expect(guideText).toMatch(/passphrase|plaintext/i);
    expect(guideText).not.toMatch(/GESTALT_PASSPHRASE=\S{8,}/);
    expect(r.successCheck).toMatch(/Ask your AI/);
    expect(r.steps.some((s) => s.includes("cloned"))).toBe(true);
    expect(r.steps.some((s) => s.includes("store shape ok"))).toBe(true);
  });

  it("skipClone works on an already-populated fixture tree", async () => {
    const seed = freshHome("join-skip");
    runInit({ home: seed });
    const r = await joinStore({
      gitUrl: "unused://remote",
      home: seed,
      skipClone: true,
      installHooks: false,
      rulesFile: scratchRulesFile("skip"),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.cloned).toBe(false);
    expect(r.storeShapeOk).toBe(true);
    expect(r.successCheck.length).toBeGreaterThan(10);
  });

  it("refuses to join over an existing store", async () => {
    const seed = freshHome("join-exists");
    runInit({ home: seed });
    await expect(
      joinStore({
        gitUrl: "unused://remote",
        home: seed,
        // Belt and braces: this rejects on E_EXISTS before the rules step, but
        // "cannot reach the live file" must hold even if that ordering changes.
        rulesFile: scratchRulesFile("exists"),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({ code: "E_EXISTS" });
  });

  it("injected gitClone failure surfaces E_IO", async () => {
    const dest = freshHome("join-fail");
    await expect(
      joinStore({
        gitUrl: "git@example.com:nope/nope.git",
        home: dest,
        gitClone: () => ({ ok: false, message: "auth failed" }),
        rulesFile: scratchRulesFile("fail"), // same belt-and-braces as above
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({ code: "E_IO" });
  });
});
