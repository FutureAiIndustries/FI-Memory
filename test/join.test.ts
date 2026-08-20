import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  it("joining a SECOND store does not steal the first machine's wiring", async () => {
    const { remote } = fixtureRemoteStore();
    const dest = freshHome("join-guard-dest");
    const rulesFile = scratchRulesFile("guard");

    // A machine already wired to some OTHER store.
    const otherStore = freshHome("join-guard-existing-store");
    const settingsPath = path.join(freshHome("join-guard-settings"), "settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: ["/somewhere/cli.js", "hook-retrieve", "--shim-id", "fimemory-v1", "--home", otherStore],
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const r = await joinStore({
      gitUrl: remote,
      home: dest,
      env: {} as NodeJS.ProcessEnv,
      rulesFile,
      settingsPath,
    });

    // The store still arrives — refusing to rewire is not refusing to join.
    expect(r.cloned).toBe(true);
    expect(r.storeShapeOk).toBe(true);
    // But nothing about this machine's existing setup was touched.
    expect(r.rulesPath).toBe(null);
    expect(existsSync(rulesFile)).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(
      JSON.parse(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "node",
                    args: ["/somewhere/cli.js", "hook-retrieve", "--shim-id", "fimemory-v1", "--home", otherStore],
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    // And the user is told, with the way to opt in.
    const warned = r.warnings.join(" ");
    expect(warned).toMatch(/did NOT repoint/i);
    expect(warned).toMatch(/--force-rewire/);
  });

  it("--force-rewire switches the machine over deliberately", async () => {
    const { remote } = fixtureRemoteStore();
    const dest = freshHome("join-force-dest");
    const rulesFile = scratchRulesFile("force");
    const otherStore = freshHome("join-force-existing-store");
    const settingsPath = path.join(freshHome("join-force-settings"), "settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: ["/somewhere/cli.js", "hook-retrieve", "--home", otherStore],
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const r = await joinStore({
      gitUrl: remote,
      home: dest,
      env: {} as NodeJS.ProcessEnv,
      installHooks: false,
      rulesFile,
      settingsPath,
      forceRewire: true,
    });

    expect(r.rulesPath).toBe(rulesFile);
    expect(existsSync(rulesFile)).toBe(true);
  });

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
      // ...and pin the machine state the rewire guard reads. Without this the
      // guard inherits the DEVELOPER'S live wiring, sees it pointing at their
      // real store, correctly concludes "this box already belongs to another
      // store", and skips the rules write — so this test would pass or fail
      // depending on whose laptop ran it. An absent file means "no wiring yet",
      // which is the fresh-machine case this test is actually about.
      settingsPath: path.join(freshHome("join-settings-dest"), "settings.json"),
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
