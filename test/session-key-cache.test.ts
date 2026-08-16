import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { exportPlaintext } from "../src/ops/exportOp.js";
import { fsPath, storePaths } from "../src/paths.js";
import {
  readSessionCache,
  sessionCachePath,
  wipeSessionCache,
  writeSessionCache,
} from "../src/sessionKeyCache.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import { recover, unlockWithPassphrase } from "../src/store/keyring.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * E2c — the session key cache. The contract under test:
 *
 *   after ONE passphrase unlock, one-shot CLI commands skip Argon2id for a
 *   bounded window — and the cache NEVER widens the stolen-artifact surface
 *   (never under the store home), NEVER poisons an unlock (ciphertext-bound
 *   like every other key path), and every failure mode falls back to the
 *   ordinary friendly "This store is encrypted." passphrase path.
 *
 * Store fixtures use tiny Argon2 params (the keyring records its own params,
 * so the spawned real CLI unlocks fast too). The timing claim itself — warm
 * unlock within ~10 ms of plaintext — is measured by scripts/bench-encryption.mjs,
 * not asserted here (wall-clock asserts flake); these tests pin the BEHAVIOR.
 */

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the REAL cli.ts in a child. GESTALT_KEY/GESTALT_PASSPHRASE are cleared
 * unless a test sets them — an inherited ambient credential would fake a pass. */
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

function initEnc(label: string): { home: string; mnemonic: string } {
  const home = freshHome(label);
  const r = runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
  return { home, mnemonic: r.mnemonic! };
}

/** Doctor the on-disk cache entry (e.g. force expiry) — hand-editing the file
 * is exactly what a hostile/broken environment does, so tests do it raw. */
function doctorCache(home: string, patch: Record<string, unknown>): void {
  const file = sessionCachePath(home);
  const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...entry, ...patch }), "utf8");
}

const FRIENDLY = /This store is encrypted\./;

/** Rewrite a store's config with a specific session-cache TTL. */
function setTtl(home: string, hours: number): void {
  writeFileSync(
    fsPath(storePaths(home).config),
    JSON.stringify({ ...DEFAULT_CONFIG, sessionKeyCacheTtlHours: hours }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Run `fn` with the session cache routed into a PRIVATE directory. The
 * suite-wide `_session_cache` sandbox is shared with concurrently-running
 * test FILES, and every CLI invocation now SWEEPS whatever dir it sees — so a
 * test that stages an expired/orphaned file and asserts on its presence would
 * race a bystander's sweep. `process.env` is per test-worker and tests within
 * a file run sequentially, so the swap is safe; spawned CLIs inherit it.
 */
function withPrivateSessionDir<T>(label: string, fn: (dir: string) => T): T {
  const dir = path.join(freshHome(`${label}-sess`), "session-keys");
  const saved = process.env.GESTALT_SESSION_DIR;
  process.env.GESTALT_SESSION_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (saved === undefined) delete process.env.GESTALT_SESSION_DIR;
    else process.env.GESTALT_SESSION_DIR = saved;
  }
}

describe("session key cache — placement (the stolen-artifact exclusions)", () => {
  it("lives OUTSIDE the store home, per-store keyed, distinct across stores", () => {
    const a = freshHome("sess-place-a");
    const b = freshHome("sess-place-b");
    const pa = sessionCachePath(a);
    const pb = sessionCachePath(b);
    expect(pa).not.toBe(pb); // per-store, not global
    for (const [home, p] of [[a, pa], [b, pb]] as const) {
      expect(p.startsWith(path.resolve(home) + path.sep)).toBe(false);
      expect(p.startsWith(path.resolve(home))).toBe(false);
    }
  });

  /**
   * The case-folding contract, MEASURED against the filesystem this test is
   * running on rather than gated to one platform.
   *
   * It used to be three lines inside the test above, wrapped in
   * `if (process.platform === "win32")`, which is the same mistake the code
   * itself made: it reads "case-insensitive filesystem" as "Windows". A default
   * macOS volume folds case exactly like NTFS, so on a Mac `~/.gestalt` and
   * `~/.Gestalt` are ONE directory that produced TWO cache entries — and per
   * this module's own comment, `lock` would then wipe the entry for the
   * spelling you typed while a warm session survived under the alias.
   *
   * Both directions matter and both are asserted here. On a case-SENSITIVE
   * filesystem (ext4, and case-sensitive APFS) two spellings are two different
   * stores, and folding them together would be the worse bug: one cache entry
   * shared by two stores.
   */
  it("a case-variant spelling follows the FILESYSTEM, not the platform", () => {
    /** Independent measurement: make a directory, look for the other spelling.
     * Deliberately NOT src/fsCase.ts — a test that asks the code under test
     * what the answer is cannot fail. */
    function filesystemFoldsCase(under: string): boolean {
      mkdirSync(path.join(under, "CaseProbe"), { recursive: true });
      return existsSync(path.join(under, "caseprobe"));
    }
    /** Flip the case of the last segment only, so the parent still resolves. */
    const flipLeaf = (p: string): string =>
      path.join(path.dirname(p), path.basename(p).toUpperCase());

    const home = freshHome("sess-case");
    mkdirSync(home, { recursive: true }); // freshHome only names a path
    const parent = path.dirname(home);
    const folds = filesystemFoldsCase(parent);
    console.log(
      `  [measured] ${process.platform} ${parent}: filesystem is ` +
        `${folds ? "CASE-INSENSITIVE" : "case-sensitive"}`,
    );

    // An EXISTING store, spelled two ways.
    expect(sessionCachePath(flipLeaf(home)) === sessionCachePath(home)).toBe(folds);

    // And a store that does not exist yet, which is the case the fold is
    // actually load-bearing for: `init` digests the home to wipe a stale cache
    // BEFORE creating the directory, so realpath cannot canonicalize the
    // spelling and only the fold can make the two agree.
    const ghost = path.join(parent, "ghost-store-not-created");
    expect(sessionCachePath(flipLeaf(ghost)) === sessionCachePath(ghost)).toBe(folds);
  });

  it("a git repo at the store home never sees the cache (unlock writes nothing new into the store)", () => {
    const { home } = initEnc("sess-git");
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", home, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
    expect(git("init").status).toBe(0);
    expect(git("add", "-A").status).toBe(0);
    expect(git("commit", "-m", "store").status).toBe(0);

    // A real CLI unlock (writes the cache) + a warm read.
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(true);
    expect(spawnCli(["get", "gestalt-example", "--home", home]).status).toBe(0);

    const status = git("status", "--porcelain");
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe(""); // nothing new, tracked or untracked
  });

  it("export --plaintext carries no cache/key material", async () => {
    const { home } = initEnc("sess-export");
    const dek = unlockWithPassphrase(home, PASS);
    const dekHex = Buffer.from(dek).toString("hex");
    writeSessionCache(home, dek, 3_600_000);
    try {
      activateDek(dek);
      const dest = path.join(freshHome("sess-export-out"), "export");
      const r = await exportPlaintext(home, dest);
      expect(r.failed).toBe(0);
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(dest);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        expect(content, f).not.toContain(dekHex);
        expect(content, f).not.toContain('"dek"');
      }
      // The cache file itself is nowhere under the export destination.
      expect(sessionCachePath(home).startsWith(path.resolve(dest))).toBe(false);
    } finally {
      clearActiveKey();
    }
  });

  it.skipIf(process.platform === "win32")("cache file is 0600, its dir 0700 (POSIX)", () => {
    const home = freshHome("sess-perms");
    writeSessionCache(home, new Uint8Array(32), 3_600_000);
    const file = sessionCachePath(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe("session key cache — lifecycle through the real CLI", () => {
  it("one passphrase unlock caches; the next command unlocks WITHOUT a passphrase", () => {
    const { home } = initEnc("sess-warm");
    // Cold, no credentials at all → the friendly gate, not a crash.
    const cold = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(cold.status).toBe(1);
    expect(cold.stderr).toMatch(FRIENDLY);

    // One unlock with the passphrase…
    expect(spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", PASS]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(true);

    // …and the SAME command now works with no passphrase anywhere.
    const warm = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(warm.status).toBe(0);
    expect(warm.stdout).toContain("gestalt-example");
  });

  it("TTL expiry → the passphrase is required again (friendly, and the dead entry is removed)", () => {
    const { home } = initEnc("sess-ttl");
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
    doctorCache(home, { expires: Date.now() - 1000 });

    const r = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(FRIENDLY); // the normal ask — not a scary key error
    expect(r.stderr).not.toMatch(/does not open|does not match|wrong/i);
    expect(existsSync(sessionCachePath(home))).toBe(false); // expired entry wiped

    // With the passphrase it unlocks — and re-caches for a fresh window.
    expect(spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", PASS]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(true);
  });

  it("fimemory lock wipes immediately, needs no passphrase, and is honest when there is nothing to wipe", () => {
    const { home } = initEnc("sess-lock");
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(true);

    const locked = spawnCli(["lock", "--home", home]); // NO passphrase
    expect(locked.status).toBe(0);
    expect(locked.stdout).toContain("Locked");
    expect(existsSync(sessionCachePath(home))).toBe(false);

    const after = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(after.status).toBe(1);
    expect(after.stderr).toMatch(FRIENDLY);

    const again = spawnCli(["lock", "--home", home, "--json"]);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ locked: true, wiped: false });
  });

  it("a WRONG passphrase fails loudly and never seeds a cache", () => {
    const { home } = initEnc("sess-wrongpass");
    const r = spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", "not the passphrase, no"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Wrong passphrase/);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("explicit --passphrase ALWAYS derives (a wrong flag is reported, never masked by a warm cache); ambient env defers to the cache", () => {
    const { home } = initEnc("sess-precedence");
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0); // warm

    // Warm cache + wrong ambient GESTALT_PASSPHRASE → the cache serves (the env
    // var is a standing convenience; the cache exists to make it unnecessary).
    expect(
      spawnCli(["get", "gestalt-example", "--home", home], { GESTALT_PASSPHRASE: "wrong ambient phrase" }).status,
    ).toBe(0);

    // Warm cache + wrong EXPLICIT flag → the explicit act wins and is reported.
    const explicit = spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", "wrong explicit phrase"]);
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toMatch(/Wrong passphrase/);
    // …and the failed explicit attempt did not destroy the (still valid) cache.
    expect(existsSync(sessionCachePath(home))).toBe(true);
  });

  it("two stores never cross-unlock: a foreign/planted cache falls back to the friendly ask and is wiped", () => {
    const a = initEnc("sess-cross-a");
    const b = initEnc("sess-cross-b");
    expect(spawnCli(["status", "--home", a.home, "--passphrase", PASS]).status).toBe(0); // warm A only

    // B is cold: A's warmth must not leak.
    const coldB = spawnCli(["get", "gestalt-example", "--home", b.home]);
    expect(coldB.status).toBe(1);
    expect(coldB.stderr).toMatch(FRIENDLY);

    // Plant A's DEK at B's cache slot (shape-valid, home-field correct). The
    // ciphertext binding must reject it QUIETLY — friendly ask, entry removed.
    const dekA = unlockWithPassphrase(a.home, PASS);
    clearActiveKey();
    writeSessionCache(b.home, dekA, 3_600_000);
    const planted = spawnCli(["get", "gestalt-example", "--home", b.home]);
    expect(planted.status).toBe(1);
    expect(planted.stderr).toMatch(FRIENDLY);
    expect(planted.stderr).not.toMatch(/does not open|does not match/i);
    expect(existsSync(sessionCachePath(b.home))).toBe(false);

    // Raw file copy (home field says A) is rejected by the read layer the same way.
    expect(spawnCli(["status", "--home", a.home, "--passphrase", PASS]).status).toBe(0);
    mkdirSync(path.dirname(sessionCachePath(b.home)), { recursive: true });
    writeFileSync(sessionCachePath(b.home), readFileSync(sessionCachePath(a.home), "utf8"), "utf8");
    const copied = spawnCli(["get", "gestalt-example", "--home", b.home]);
    expect(copied.status).toBe(1);
    expect(copied.stderr).toMatch(FRIENDLY);
    expect(existsSync(sessionCachePath(b.home))).toBe(false);

    // A itself is untouched and still warm.
    expect(spawnCli(["get", "gestalt-example", "--home", a.home]).status).toBe(0);
  });

  it("a corrupt cache file reads as 'please unlock', never as a crash — and is cleaned up", () => {
    const { home } = initEnc("sess-corrupt");
    mkdirSync(path.dirname(sessionCachePath(home)), { recursive: true });
    writeFileSync(sessionCachePath(home), "not json {{{{", "utf8");
    const r = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(FRIENDLY);
    expect(r.stderr).not.toMatch(/SyntaxError|JSON/);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("sessionKeyCacheTtlHours: 0 is a real opt-out — nothing written, and an existing entry is ignored", () => {
    const { home } = initEnc("sess-optout");
    // Seed a valid cache FIRST (proves 0 disables reads, not just writes).
    const dek = unlockWithPassphrase(home, PASS);
    clearActiveKey();
    writeSessionCache(home, dek, 3_600_000);
    writeFileSync(
      fsPath(storePaths(home).config),
      JSON.stringify({ ...DEFAULT_CONFIG, sessionKeyCacheTtlHours: 0 }, null, 2) + "\n",
      "utf8",
    );

    const noPass = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(noPass.status).toBe(1); // valid cache on disk, but the paranoid said no
    expect(noPass.stderr).toMatch(FRIENDLY);

    wipeSessionCache(home);
    expect(spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", PASS]).status).toBe(0);
    expect(existsSync(sessionCachePath(home))).toBe(false); // and no new one was written
  });
});

describe("session key cache — invalidation at the keyring layer", () => {
  it("recover (passphrase change) wipes the cached session key", () => {
    const { home, mnemonic } = initEnc("sess-recover");
    const dek = unlockWithPassphrase(home, PASS);
    clearActiveKey();
    writeSessionCache(home, dek, 3_600_000);
    expect(existsSync(sessionCachePath(home))).toBe(true);

    recover(home, mnemonic, "a brand new passphrase now", TINY, { allowWeakParams: true });
    clearActiveKey();
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("re-init at the same path wipes a stale cache (a new keyring can never warm-unlock under the old DEK)", () => {
    const home = freshHome("sess-reinit");
    writeSessionCache(home, new Uint8Array(32).fill(7), 3_600_000); // stale leftovers
    expect(existsSync(sessionCachePath(home))).toBe(true);
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("readSessionCache proves freshness and shape only — and never returns a foreign home's entry", () => {
    const home = freshHome("sess-read");
    writeSessionCache(home, new Uint8Array(32).fill(1), 3_600_000);
    expect(readSessionCache(home)).toBe("01".repeat(32));
    // Expired by the reader's own clock → null AND removed.
    expect(readSessionCache(home, Date.now() + 4_000_000)).toBeNull();
    expect(existsSync(sessionCachePath(home))).toBe(false);
    // ttl <= 0 never writes.
    writeSessionCache(home, new Uint8Array(32), 0);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });
});

describe("session key cache — the TTL has teeth: EVERY invocation sweeps (root cause 1/5)", () => {
  it("an EXPIRED entry is deleted by ANY invocation — a plaintext store's status, no key, no warm read in sight", () => {
    withPrivateSessionDir("sweep-any", () => {
      const plain = freshHome("sweep-bystander");
      expect(spawnCli(["init", "--home", plain]).status).toBe(0);
      // A leftover entry for some OTHER store, past its own expiry — the
      // pre-fix world deleted this only when a warm READ of that store ran.
      const x = freshHome("sweep-x");
      writeSessionCache(x, new Uint8Array(32).fill(3), 3_600_000);
      doctorCache(x, { expires: Date.now() - 1000 });
      expect(existsSync(sessionCachePath(x))).toBe(true);

      expect(spawnCli(["status", "--home", plain]).status).toBe(0);
      expect(existsSync(sessionCachePath(x))).toBe(false);
    });
  });

  it("…including an invocation that unlocks via GESTALT_KEY (the cache read path never runs)", () => {
    withPrivateSessionDir("sweep-key", () => {
      const { home } = initEnc("sweep-key-store");
      const dekHex = Buffer.from(unlockWithPassphrase(home, PASS)).toString("hex");
      clearActiveKey();
      const x = freshHome("sweep-key-x");
      writeSessionCache(x, new Uint8Array(32).fill(9), 3_600_000);
      doctorCache(x, { expires: Date.now() - 1000 });
      expect(existsSync(sessionCachePath(x))).toBe(true);

      expect(spawnCli(["status", "--home", home], { GESTALT_KEY: dekHex }).status).toBe(0);
      expect(existsSync(sessionCachePath(x))).toBe(false);
    });
  });

  it("sessionKeyCacheTtlHours: 0 WIPES a pre-existing entry on sight — the opt-out deletes, it does not merely ignore", () => {
    withPrivateSessionDir("sweep-optout", () => {
      const { home } = initEnc("sweep-optout-store");
      const dek = unlockWithPassphrase(home, PASS);
      clearActiveKey();
      writeSessionCache(home, dek, 3_600_000); // a VALID, unexpired entry…
      setTtl(home, 0); // …then the paranoid turn the cache off
      expect(existsSync(sessionCachePath(home))).toBe(true);

      const r = spawnCli(["get", "gestalt-example", "--home", home]);
      expect(r.status).toBe(1); // cold, as the opt-out promises…
      expect(r.stderr).toMatch(FRIENDLY);
      expect(existsSync(sessionCachePath(home))).toBe(false); // …and the key file is GONE, not lying in wait
    });
  });

  it("LOWERING the TTL is retroactive: an entry older than the new TTL dies even inside its embedded expiry", () => {
    const { home } = initEnc("sweep-clamp");
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0); // warm under the 8h default
    // Age the entry to 2h old (its embedded expiry is still ~6h away)…
    doctorCache(home, { created: Date.now() - 2 * 3_600_000 });
    setTtl(home, 1); // …then tighten the window to 1h.

    const r = spawnCli(["get", "gestalt-example", "--home", home]);
    expect(r.status).toBe(1); // the CURRENT config wins, not the stale embedded window
    expect(r.stderr).toMatch(FRIENDLY);
    expect(existsSync(sessionCachePath(home))).toBe(false);
  });

  it("an orphaned atomic-write temp (crash leftover holding the key) is swept once old; a fresh one (write in flight) is not", () => {
    withPrivateSessionDir("sweep-tmp", () => {
      const { home } = initEnc("sweep-tmp-store");
      const entryPath = sessionCachePath(home);
      mkdirSync(path.dirname(entryPath), { recursive: true });
      const oldTmp = `${entryPath}.tmp-4242`;
      const freshTmp = `${entryPath}.tmp-4343`;
      writeFileSync(oldTmp, JSON.stringify({ dek: "ab".repeat(32) }), "utf8");
      const past = new Date(Date.now() - 10 * 60_000);
      utimesSync(oldTmp, past, past);
      writeFileSync(freshTmp, "write in flight", "utf8");

      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      expect(existsSync(oldTmp)).toBe(false); // invisible-to-expiry key bytes: swept
      expect(existsSync(freshTmp)).toBe(true); // an in-flight write is not a crash leftover
    });
  });
});

describe("session key cache — one store, ONE digest; lock means LOCKED (root causes 2/3)", () => {
  it("a junction/symlink spelling of the same store shares one cache entry — warm serves via either, lock via either kills it", () => {
    const { home } = initEnc("sess-alias");
    const alias = `${home}-alias`;
    symlinkSync(home, alias, "junction"); // dir junction on Windows (no admin needed); plain symlink elsewhere
    expect(sessionCachePath(alias)).toBe(sessionCachePath(home)); // one identity, not two

    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0); // warm via the REAL spelling
    expect(spawnCli(["get", "gestalt-example", "--home", alias]).status).toBe(0); // the alias IS the same warm store

    expect(spawnCli(["lock", "--home", alias]).status).toBe(0); // lock via the ALIAS…
    expect(existsSync(sessionCachePath(home))).toBe(false);
    const cold = spawnCli(["get", "gestalt-example", "--home", home]); // …and the real spelling is COLD
    expect(cold.status).toBe(1);
    expect(cold.stderr).toMatch(FRIENDLY);
  });

  it("fimemory lock with NO --home wipes EVERY store's cached key (and temp leftovers) — the safe reading of 'lock'", () => {
    withPrivateSessionDir("lock-all", () => {
      const a = initEnc("lock-all-a");
      const b = initEnc("lock-all-b");
      expect(spawnCli(["status", "--home", a.home, "--passphrase", PASS]).status).toBe(0);
      expect(spawnCli(["status", "--home", b.home, "--passphrase", PASS]).status).toBe(0);
      const tmp = `${sessionCachePath(a.home)}.tmp-31337`; // a crashed writer's leftover — age must NOT matter to lock
      writeFileSync(tmp, JSON.stringify({ dek: "ff".repeat(32) }), "utf8");

      const r = spawnCli(["lock"]); // no --home
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Locked");
      expect(existsSync(sessionCachePath(a.home))).toBe(false);
      expect(existsSync(sessionCachePath(b.home))).toBe(false);
      expect(existsSync(tmp)).toBe(false);

      const cold = spawnCli(["get", "gestalt-example", "--home", a.home]);
      expect(cold.status).toBe(1);
      expect(cold.stderr).toMatch(FRIENDLY);

      const again = spawnCli(["lock", "--json"]);
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ locked: true, scope: "all-stores", wiped: 0 });
    });
  });

  it("fimemory lock with NO --home leaves FOREIGN files byte-identical while wiping every entry AND temp of OURS — a shared session dir never loses unrelated files (round 3, B1)", () => {
    withPrivateSessionDir("lock-foreign", (dir) => {
      mkdirSync(dir, { recursive: true });
      // Another tool's content-addressed files, wearing our 32-hex `.json`
      // entry pattern — one valid JSON of a DIFFERENT shape, one not JSON at
      // all. Name alone would doom them; only a CONTENT shape-check spares
      // them. Pre-fix `lock` (wipe-all) zeroized + deleted BOTH — in a
      // user-pointed shared GESTALT_SESSION_DIR that is data destruction.
      const foreignJson = path.join(dir, "ab".repeat(16) + ".json");
      const foreignJsonBytes = JSON.stringify({ someOtherTool: true, blobs: ["precious user data"] });
      writeFileSync(foreignJson, foreignJsonBytes, "utf8");
      const foreignRaw = path.join(dir, "cd".repeat(16) + ".json");
      const foreignRawBytes = "not json - some other app's content-addressed bytes";
      writeFileSync(foreignRaw, foreignRawBytes, "utf8");

      // Two real stores, warmed → two of OUR entries beside the foreign files.
      const a = initEnc("lock-foreign-a");
      const b = initEnc("lock-foreign-b");
      expect(spawnCli(["status", "--home", a.home, "--passphrase", PASS]).status).toBe(0);
      expect(spawnCli(["status", "--home", b.home, "--passphrase", PASS]).status).toBe(0);
      expect(existsSync(sessionCachePath(a.home))).toBe(true);
      expect(existsSync(sessionCachePath(b.home))).toBe(true);
      // …plus one of OUR crashed-writer temps, in our EXACT `.tmp-<pid digits>`
      // naming — lock ends it regardless of age (ownership is the pinned name).
      const ourTmp = `${sessionCachePath(a.home)}.tmp-31337`;
      writeFileSync(ourTmp, JSON.stringify({ dek: "ff".repeat(32) }), "utf8");

      const r = spawnCli(["lock", "--json"]); // no --home → wipe EVERY store
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout) as { locked: boolean; scope: string; wiped: number };
      expect(parsed).toMatchObject({ locked: true, scope: "all-stores" });

      // OURS — both entries AND the temp — is gone.
      expect(existsSync(sessionCachePath(a.home))).toBe(false);
      expect(existsSync(sessionCachePath(b.home))).toBe(false);
      expect(existsSync(ourTmp)).toBe(false);
      // …and the count reflects ONLY ours: 2 entries + 1 temp, never the foreign pair.
      expect(parsed.wiped).toBe(3);

      // FOREIGN — still present AND byte-identical (a zeroize would have
      // blanked them even where the delete was correctly skipped).
      expect(readFileSync(foreignJson, "utf8")).toBe(foreignJsonBytes);
      expect(readFileSync(foreignRaw, "utf8")).toBe(foreignRawBytes);

      // A SECOND lock, now that only foreign files remain, is still honest:
      // wiped 0, all-stores — and the foreign files survive that pass too.
      const second = spawnCli(["lock", "--json"]);
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ locked: true, scope: "all-stores", wiped: 0 });
      expect(readFileSync(foreignJson, "utf8")).toBe(foreignJsonBytes);
      expect(readFileSync(foreignRaw, "utf8")).toBe(foreignRawBytes);
    });
  });

  it("a wipe that FAILS is loud, non-zero, and names the path — never 'nothing was cached'", () => {
    withPrivateSessionDir("lock-fail", () => {
      const { home } = initEnc("lock-fail-store");
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      const file = sessionCachePath(home);
      expect(existsSync(file)).toBe(true);
      // Make the entry undeletable the way an AV scanner does: a second
      // process holds an open handle WITHOUT FILE_SHARE_DELETE but WITH
      // read/write sharing — the AV-scanner story: delete blocked, the
      // zeroize write still lands (share None also blocked the zeroize and
      // broke the wipe-all contract on Windows — found 7/26). (Node's own
      // opens always share delete, and modern libuv unlinks read-only files,
      // so an in-test handle or attribute cannot simulate this). POSIX: a
      // dir without write permission refuses the unlink instead.
      let holder: ReturnType<typeof spawn> | undefined;
      const sleep = (ms: number) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try {
        if (process.platform === "win32") {
          const flag = `${file}.held-flag`;
          holder = spawn("powershell", [
            "-NoProfile",
            "-Command",
            `$f=[System.IO.File]::Open('${file}','Open','Read','ReadWrite'); New-Item -ItemType File -Path '${flag}' | Out-Null; Start-Sleep -Seconds 60`,
          ], { stdio: "ignore" });
          const deadline = Date.now() + 20_000;
          while (!existsSync(flag) && Date.now() < deadline) sleep(50);
          expect(existsSync(flag)).toBe(true); // the handle is provably held
        } else {
          chmodSync(path.dirname(file), 0o500);
        }

        const r = spawnCli(["lock", "--home", home]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/LOCK FAILED/);
        expect(r.stderr).toContain(file); // names the path it could not remove
        expect(r.stdout).not.toMatch(/nothing was cached/i);
        expect(existsSync(file)).toBe(true); // unlink failed — residue remains

        // wipeSessionCache zeroizes BEFORE unlink (limits key exposure even when
        // the OS refuses the delete). wipe-all only acts on entries that still
        // prove as ours by shape — a zeroized file no longer does, so the
        // machine-wide lock honestly reports nothing usable cached (exit 0),
        // not LOCK FAILED. The DEK is already gone; only blank residue remains.
        const all = spawnCli(["lock"]);
        expect(all.status).toBe(0);
        expect(all.stderr).not.toMatch(/LOCK FAILED/);
      } finally {
        if (process.platform === "win32") holder?.kill();
        else chmodSync(path.dirname(file), 0o700);
      }
      if (process.platform === "win32") sleep(200); // let the OS release the held handle
      expect(spawnCli(["lock", "--home", home]).status).toBe(0); // deletable again → a clean wipe
      expect(existsSync(file)).toBe(false);
    });
  });
});

describe("session key cache — 'never under any store home' is enforced, and an explicit flag is explicit (root causes 4/6)", () => {
  it("REFUSES to cache when the store home contains the cache dir — the DEK never enters the store's own surface", () => {
    const { home } = initEnc("sess-contain");
    const innerDir = path.join(home, "nested", "session-keys");
    const saved = process.env.GESTALT_SESSION_DIR;
    process.env.GESTALT_SESSION_DIR = innerDir;
    try {
      // Library level: the write is refused outright — no dir, no file, no key
      // inside anything a store backup/git/export would carry.
      const dek = unlockWithPassphrase(home, PASS);
      clearActiveKey();
      writeSessionCache(home, dek, 3_600_000);
      expect(existsSync(innerDir)).toBe(false);

      // End-to-end: the command still WORKS — it just stays cold, every run.
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      expect(existsSync(innerDir)).toBe(false);
      const cold = spawnCli(["get", "gestalt-example", "--home", home]);
      expect(cold.status).toBe(1);
      expect(cold.stderr).toMatch(FRIENDLY);
    } finally {
      if (saved === undefined) delete process.env.GESTALT_SESSION_DIR;
      else process.env.GESTALT_SESSION_DIR = saved;
    }
  });

  it("a store homed at a filesystem ROOT refuses to cache — the containment guard's degenerate prefix (round 3, fix 3)", () => {
    withPrivateSessionDir("root-home", (dir) => {
      // The root that CONTAINS the (sandboxed) cache dir: `C:\` here, `/` on
      // POSIX. A root home keeps its trailing separator, which the old prefix
      // math turned into an impossible `C:\\`-style prefix — so the one home
      // that contains EVERYTHING slipped past "never under any store home".
      const root = path.parse(path.resolve(dir)).root;
      writeSessionCache(root, new Uint8Array(32).fill(5), 3_600_000);
      expect(existsSync(dir)).toBe(false); // refused outright: no dir, no file, no DEK on disk
    });
  });

  it('--passphrase "" (explicitly supplied, empty) ALWAYS derives and fails — a warm cache must not vouch for broken credential plumbing', () => {
    const { home } = initEnc("sess-emptyflag");
    expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0); // warm

    // A CI script whose $PASSPHRASE var silently unset: the flag is PRESENT
    // but empty. Pre-fix, the warm cache served and the script believed its
    // credential plumbing worked.
    const r = spawnCli(["get", "gestalt-example", "--home", home, "--passphrase", ""]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Wrong passphrase/);
    expect(r.stderr).not.toMatch(FRIENDLY);

    // Parity with the wrong-flag rule: the failed explicit attempt leaves the
    // (still valid) cache alone.
    expect(existsSync(sessionCachePath(home))).toBe(true);
    expect(spawnCli(["get", "gestalt-example", "--home", home]).status).toBe(0); // still warm
  });
});

describe("session key cache — round-3 audit: only ENOENT means nothing; foreign files are not ours (fixes 1/2/4/5)", () => {
  it("an UNLISTABLE session dir makes `fimemory lock` fail LOUD and non-zero, naming the dir — never 'nothing was cached' (fix 1)", () => {
    withPrivateSessionDir("lock-unlistable", (dir) => {
      const { home } = initEnc("lock-unlistable-store");
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      const file = sessionCachePath(home);
      expect(existsSync(file)).toBe(true); // a LIVE key sits in the dir

      // Make the dir unlistable with a REAL ACL: Windows denies ReadData/
      // ListDirectory to ourselves (a deny ACE beats every allow); POSIX
      // clears the permission bits. Pre-fix, readdir's EPERM was conflated
      // with ENOENT and lock printed "nothing was cached" + exit 0 — RC3's
      // lie one level up — while the live key kept serving.
      const user = process.env.USERNAME ?? "";
      try {
        if (process.platform === "win32") {
          const deny = spawnSync("icacls", [dir, "/deny", `${user}:(RD,X)`], { encoding: "utf8" });
          expect(deny.status).toBe(0);
        } else {
          chmodSync(dir, 0o000);
        }
        // Precondition: the dir is provably unlistable with a NON-ENOENT error.
        let code: string | undefined;
        try {
          readdirSync(dir);
        } catch (err) {
          code = (err as NodeJS.ErrnoException).code;
        }
        expect(code).toBeDefined();
        expect(code).not.toBe("ENOENT");

        const r = spawnCli(["lock"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/LOCK FAILED/);
        expect(r.stderr).toContain(dir); // names the dir it could not list
        expect(r.stdout).not.toMatch(/nothing was cached/i);
        if (process.platform === "win32") {
          // Windows' bypass-traverse lets us stat through the deny: honest —
          // the key file really is still there behind the unlistable dir.
          expect(existsSync(file)).toBe(true);
        }
      } finally {
        if (process.platform === "win32") spawnSync("icacls", [dir, "/remove:d", user], { encoding: "utf8" });
        else chmodSync(dir, 0o700);
      }
      // Listable again → the SAME lock now wipes clean and says so.
      expect(spawnCli(["lock"]).status).toBe(0);
      expect(existsSync(file)).toBe(false);
    });
  });

  // Deliberately slow: the CLI `recover` re-wraps the keyring at the SHIPPED
  // Argon2id params (twice), plus a passphrase unlock to prove the reset took.
  it("recover that cannot wipe the old session key WARNS loudly, names the path — and the reset itself proceeds (fix 2)", { timeout: 60_000 }, () => {
    withPrivateSessionDir("recover-wipefail", () => {
      const { home, mnemonic } = initEnc("recover-wipefail-store");
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      const file = sessionCachePath(home);
      expect(existsSync(file)).toBe(true);

      // Same undeletable-entry rig as the lock-failure test: a second process
      // holds the file open WITHOUT FILE_SHARE_DELETE (AV-scanner style);
      // POSIX refuses the unlink via a write-protected dir instead.
      let holder: ReturnType<typeof spawn> | undefined;
      const sleep = (ms: number) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try {
        if (process.platform === "win32") {
          const flag = `${file}.held-flag`;
          holder = spawn("powershell", [
            "-NoProfile",
            "-Command",
            `$f=[System.IO.File]::Open('${file}','Open','Read','None'); New-Item -ItemType File -Path '${flag}' | Out-Null; Start-Sleep -Seconds 60`,
          ], { stdio: "ignore" });
          const deadline = Date.now() + 20_000;
          while (!existsSync(flag) && Date.now() < deadline) sleep(50);
          expect(existsSync(flag)).toBe(true); // the handle is provably held
        } else {
          chmodSync(path.dirname(file), 0o500);
        }

        // Pre-fix: recover() discarded the WipeOutcome — exit 0, "Recovered",
        // not a word about the old session key still serving.
        const r = spawnCli(["recover", "--home", home, "--mnemonic", mnemonic, "--passphrase", "a completely new passphrase"]);
        expect(r.status).toBe(0); // the reset succeeded and may proceed…
        expect(r.stdout).toContain("Recovered");
        expect(r.stderr).toMatch(/could not remove the cached session key/i); // …but LOUDLY
        expect(r.stderr).toContain(file); // names the path
        expect(r.stderr).toMatch(/fimemory lock/); // and the remedy
        if (process.platform === "win32") expect(existsSync(file)).toBe(true); // honest: old key still on disk

        // --json carries the same fact for scripts.
        const rj = spawnCli(["recover", "--home", home, "--mnemonic", mnemonic, "--passphrase", "another brand new passphrase", "--json"]);
        expect(rj.status).toBe(0);
        const parsed = JSON.parse(rj.stdout) as { recovered: boolean; sessionKeyWipeFailed?: { path: string } };
        expect(parsed.recovered).toBe(true);
        expect(parsed.sessionKeyWipeFailed?.path).toBe(file);
      } finally {
        if (process.platform === "win32") holder?.kill();
        else chmodSync(path.dirname(file), 0o700);
      }
      if (process.platform === "win32") sleep(200); // let the OS release the held handle
      expect(spawnCli(["lock", "--home", home]).status).toBe(0); // the remedy works once the hold is gone
      expect(existsSync(file)).toBe(false);
      // And the passphrase really was reset to the LAST recover's choice.
      expect(spawnCli(["status", "--home", home, "--passphrase", "another brand new passphrase"]).status).toBe(0);
    });
  });

  it("gestalt --version and bare gestalt sweep an expired entry — the cheap early returns keep the EVERY-invocation promise (fix 4)", () => {
    withPrivateSessionDir("sweep-version", () => {
      const x = freshHome("sweep-version-x");
      const stageExpired = (): void => {
        writeSessionCache(x, new Uint8Array(32).fill(4), 3_600_000);
        doctorCache(x, { expires: Date.now() - 1000 });
        expect(existsSync(sessionCachePath(x))).toBe(true);
      };

      stageExpired();
      const v = spawnCli(["--version"]);
      expect(v.status).toBe(0);
      // --version prints "<name> <version>" from the package's OWN package.json
      // (Phase D.4) — so this suite passes unchanged inside the staged export
      // tree, where the name is the public one, not gestalt-runtime.
      const pkg = JSON.parse(
        readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
      ) as { name: string; version: string };
      expect(v.stdout).toContain(`${pkg.name} ${pkg.version}`);
      expect(existsSync(sessionCachePath(x))).toBe(false); // swept before the early return

      stageExpired();
      const bare = spawnCli([]); // usage text, exit 1 — still an invocation
      expect(bare.status).toBe(1);
      expect(existsSync(sessionCachePath(x))).toBe(false);
    });
  });

  it("a FOREIGN 32-hex .json in a user-pointed shared session dir survives the sweep byte-for-byte; our expired entry beside it dies (fix 5)", () => {
    withPrivateSessionDir("sweep-foreign", (dir) => {
      mkdirSync(dir, { recursive: true });
      // Another tool's content-addressed files, wearing our filename pattern —
      // one valid JSON of a different shape, one not JSON at all, one temp-ish
      // name outside our exact `.tmp-<pid digits>` scheme, aged past the gate.
      const foreignJson = path.join(dir, "ab".repeat(16) + ".json");
      const foreignJsonBytes = JSON.stringify({ someOtherTool: true, blobs: ["precious user data"] });
      writeFileSync(foreignJson, foreignJsonBytes, "utf8");
      const foreignRaw = path.join(dir, "cd".repeat(16) + ".json");
      const foreignRawBytes = "not json - some other app's content-addressed bytes";
      writeFileSync(foreignRaw, foreignRawBytes, "utf8");
      const foreignTmp = path.join(dir, "ef".repeat(16) + ".json.tmp-backup");
      writeFileSync(foreignTmp, "foreign temp-suffixed file", "utf8");
      const past = new Date(Date.now() - 10 * 60_000);
      utimesSync(foreignTmp, past, past);

      // Our own EXPIRED entry beside them — proves the sweep RAN and kept its teeth.
      const x = freshHome("sweep-foreign-x");
      writeSessionCache(x, new Uint8Array(32).fill(6), 3_600_000);
      doctorCache(x, { expires: Date.now() - 1000 });

      const plain = freshHome("sweep-foreign-store");
      expect(spawnCli(["init", "--home", plain]).status).toBe(0);
      expect(spawnCli(["status", "--home", plain]).status).toBe(0);

      expect(existsSync(sessionCachePath(x))).toBe(false); // ours by shape: swept
      // Foreign files: still present AND byte-identical (zeroize would have
      // blanked them even where the delete failed) — pre-fix both were
      // zeroized + deleted, which in a shared dir is data destruction.
      expect(readFileSync(foreignJson, "utf8")).toBe(foreignJsonBytes);
      expect(readFileSync(foreignRaw, "utf8")).toBe(foreignRawBytes);
      expect(existsSync(foreignTmp)).toBe(true); // not our temp naming: left alone even past the age gate
    });
  });
});

describe("session key cache — re-init surfaces a failed stale-cache wipe (the recover fix, one call site over)", () => {
  // Deliberately slow: the CLI `init --encrypted` wraps the keyring at the
  // SHIPPED Argon2id params — twice (text + --json variants).
  it("re-init over a store whose OLD cache entry cannot be deleted WARNS loudly, names the path — and the init itself proceeds", { timeout: 120_000 }, () => {
    withPrivateSessionDir("init-wipefail", () => {
      const { home } = initEnc("init-wipefail-store");
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      const file = sessionCachePath(home);
      expect(existsSync(file)).toBe(true); // the OLD store's DEK, cached and warm

      // The store is deleted out from under its cache entry, then re-inited at
      // the same home — the exact stale-cache scenario initKeyring's wipe
      // exists for (a re-inited store must never warm-unlock under the old
      // store's DEK).
      rmSync(fsPath(home), { recursive: true, force: true });

      // Same undeletable-entry rig as the recover-failure test: a second
      // process holds the file open WITHOUT FILE_SHARE_DELETE (AV-scanner
      // style); POSIX refuses the unlink via a write-protected dir instead.
      let holder: ReturnType<typeof spawn> | undefined;
      const sleep = (ms: number) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try {
        if (process.platform === "win32") {
          const flag = `${file}.held-flag`;
          holder = spawn("powershell", [
            "-NoProfile",
            "-Command",
            `$f=[System.IO.File]::Open('${file}','Open','Read','None'); New-Item -ItemType File -Path '${flag}' | Out-Null; Start-Sleep -Seconds 60`,
          ], { stdio: "ignore" });
          const deadline = Date.now() + 20_000;
          while (!existsSync(flag) && Date.now() < deadline) sleep(50);
          expect(existsSync(flag)).toBe(true); // the handle is provably held
        } else {
          chmodSync(path.dirname(file), 0o500);
        }

        // Pre-fix: initKeyring() discarded the WipeOutcome — exit 0, "Created",
        // not a word about the OLD store's DEK staying cached for its TTL.
        const r = spawnCli(["init", "--encrypted", "--home", home, "--passphrase", PASS]);
        expect(r.status).toBe(0); // the init succeeded and may proceed…
        expect(r.stdout).toContain("Created");
        expect(r.stderr).toMatch(/could not remove the cached session key/i); // …but LOUDLY
        expect(r.stderr).toContain(file); // names the path
        expect(r.stderr).toMatch(/fimemory lock/); // and the remedy
        if (process.platform === "win32") expect(existsSync(file)).toBe(true); // honest: old key still on disk

        // --json carries the same fact for scripts.
        rmSync(fsPath(home), { recursive: true, force: true });
        const rj = spawnCli(["init", "--encrypted", "--home", home, "--passphrase", PASS, "--json"]);
        expect(rj.status).toBe(0);
        const parsed = JSON.parse(rj.stdout) as { encrypted: boolean; sessionKeyWipeFailed?: { path: string } };
        expect(parsed.encrypted).toBe(true);
        expect(parsed.sessionKeyWipeFailed?.path).toBe(file);
      } finally {
        if (process.platform === "win32") holder?.kill();
        else chmodSync(path.dirname(file), 0o700);
      }
      if (process.platform === "win32") sleep(200); // let the OS release the held handle
      expect(spawnCli(["lock", "--home", home]).status).toBe(0); // the remedy works once the hold is gone
      expect(existsSync(file)).toBe(false);
    });
  });
});

describe("session key cache — re-init invalidates the entry whatever the NEW store's mode (the SPEC promise, unconditional)", () => {
  it("PLAINTEXT re-init over a deleted encrypted store wipes the stale entry — and surfaces a FAILED wipe with the same warning", { timeout: 120_000 }, () => {
    withPrivateSessionDir("init-plain-wipe", () => {
      // ---- the clean path: the stale entry is GONE, and no warning fires ----
      const { home } = initEnc("init-plain-wipe-store");
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      const file = sessionCachePath(home);
      expect(existsSync(file)).toBe(true); // the OLD store's DEK, cached and warm

      // Delete the encrypted store, then re-init the same home PLAINTEXT.
      // Pre-fix the only wipe lived inside initKeyring — reached ONLY under
      // `--encrypted` — so this path left the old store's DEK warm-usable for
      // its TTL, and the loud re-init warning could never fire here.
      rmSync(fsPath(home), { recursive: true, force: true });
      const clean = spawnCli(["init", "--home", home]);
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain("Created");
      expect(clean.stderr).not.toMatch(/could not remove the cached session key/i);
      expect(existsSync(file)).toBe(false); // invalidated with no keyring involved at all

      // ---- the failed-wipe path: the SAME loud warning as an encrypted re-init ----
      rmSync(fsPath(home), { recursive: true, force: true });
      runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
      expect(spawnCli(["status", "--home", home, "--passphrase", PASS]).status).toBe(0);
      expect(existsSync(file)).toBe(true); // warm again
      rmSync(fsPath(home), { recursive: true, force: true });

      // Same undeletable-entry rig as the encrypted re-init test above: a
      // second process holds the file open WITHOUT FILE_SHARE_DELETE
      // (AV-scanner style); POSIX refuses the unlink via a write-protected dir.
      let holder: ReturnType<typeof spawn> | undefined;
      const sleep = (ms: number) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try {
        if (process.platform === "win32") {
          const flag = `${file}.held-flag`;
          holder = spawn("powershell", [
            "-NoProfile",
            "-Command",
            `$f=[System.IO.File]::Open('${file}','Open','Read','None'); New-Item -ItemType File -Path '${flag}' | Out-Null; Start-Sleep -Seconds 60`,
          ], { stdio: "ignore" });
          const deadline = Date.now() + 20_000;
          while (!existsSync(flag) && Date.now() < deadline) sleep(50);
          expect(existsSync(flag)).toBe(true); // the handle is provably held
        } else {
          chmodSync(path.dirname(file), 0o500);
        }

        const r = spawnCli(["init", "--home", home]); // PLAINTEXT — no keyring on this path
        expect(r.status).toBe(0); // the init succeeded and may proceed…
        expect(r.stdout).toContain("Created");
        expect(r.stderr).toMatch(/could not remove the cached session key/i); // …but LOUDLY
        expect(r.stderr).toContain(file); // names the path
        expect(r.stderr).toMatch(/fimemory lock/); // and the remedy
        if (process.platform === "win32") expect(existsSync(file)).toBe(true); // honest: old key still on disk

        // --json carries the same fact for scripts — on the plaintext path too.
        rmSync(fsPath(home), { recursive: true, force: true });
        const rj = spawnCli(["init", "--home", home, "--json"]);
        expect(rj.status).toBe(0);
        const parsed = JSON.parse(rj.stdout) as { encrypted: boolean; sessionKeyWipeFailed?: { path: string } };
        expect(parsed.encrypted).toBe(false);
        expect(parsed.sessionKeyWipeFailed?.path).toBe(file);
      } finally {
        if (process.platform === "win32") holder?.kill();
        else chmodSync(path.dirname(file), 0o700);
      }
      if (process.platform === "win32") sleep(200); // let the OS release the held handle
      expect(spawnCli(["lock", "--home", home]).status).toBe(0); // the remedy works once the hold is gone
      expect(existsSync(file)).toBe(false);
    });
  });
});
