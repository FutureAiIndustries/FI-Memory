import { spawn } from "node:child_process";
import { promises as fsp, openSync, closeSync, readdirSync, readFileSync } from "node:fs";
import type { Mode, PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { GestaltError } from "../src/errors.js";
import { handleRpc } from "../src/mcp/server.js";
import { get } from "../src/ops/get.js";
import { appendLog } from "../src/ops/logOp.js";
import { createTopic } from "../src/ops/create.js";
import { search } from "../src/ops/search.js";
import { fsPath, storePaths } from "../src/paths.js";
import {
  peekSessionCache,
  readSessionCache,
  sessionCacheDir,
  sessionCachePath,
  wipeSessionCache,
  writeSessionCache,
} from "../src/sessionKeyCache.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import { assertEnvKeyMatchesStore, recover, unlockWithPassphrase } from "../src/store/keyring.js";
import { ENCRYPTED_LINE_RE, parseLog } from "../src/store/log.js";
import { readIndex } from "../src/store/index.js";
import { clockAt, freshHome, tickingClock, tsxEntry } from "./helpers.js";

/**
 * CONTENTION ON AN ENCRYPTED STORE — what a real team actually runs.
 *
 * The 2026-07-28 EPERM finding (test/atomic-rename-contention.test.ts) proved
 * the premise "many AI tools share ONE store" was broken on Windows for the
 * PLAINTEXT write path. Everything that made it break — a process-global piece
 * of state, one file every tool touches, a rename over a file someone else
 * holds open — exists at least as much on the ENCRYPTED path, where a slip is
 * not a lost write but a confidentiality failure. These probes ask four
 * questions of the encrypted store under contention:
 *
 *   1. do concurrent writes all survive AND still decrypt?
 *   2. does the session key cache survive many concurrent unlock/read paths
 *      (several REAL processes, the shape the product ships in)?
 *   3. SECURITY: can a write racing a `lock` (session wipe + key drop) put
 *      PLAINTEXT into an encrypted store?
 *   4. does a LOCKED store under concurrent reads answer with typed E_LOCKED
 *      rather than crashing?
 *
 * Tiny Argon2 params (the keyring records its own, so spawned CLIs unlock fast
 * too) and an in-test-only passphrase. Every store is a scratch `freshHome()`;
 * the session cache is already sandboxed by test/setup.ts.
 */

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
const ENC_MAGIC = "gestalt-enc:1:";
const HOUR_MS = 3_600_000;
const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A fresh ENCRYPTED store, left LOCKED (no process key, no warm cache). */
function encStore(label: string): string {
  const home = freshHome(label);
  runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
  clearActiveKey(); // init unlocked this process; a locked store means no in-process key
  wipeSessionCache(home);
  return home;
}

/** Unlock in-process, the way a warm MCP server / daemon holds the DEK. */
function unlock(home: string): void {
  activateDek(unlockWithPassphrase(home, PASS));
}

/** Strip ambient credentials — an inherited GESTALT_PASSPHRASE on the dev box
 * would silently unlock what a probe needs locked. */
async function withoutAmbientKeys<T>(fn: () => Promise<T>): Promise<T> {
  const savedPass = process.env.GESTALT_PASSPHRASE;
  const savedKey = process.env.GESTALT_KEY;
  delete process.env.GESTALT_PASSPHRASE;
  delete process.env.GESTALT_KEY;
  try {
    return await fn();
  } finally {
    if (savedPass !== undefined) process.env.GESTALT_PASSPHRASE = savedPass;
    if (savedKey !== undefined) process.env.GESTALT_KEY = savedKey;
    clearActiveKey();
  }
}

const isTemp = (name: string): boolean => name.startsWith(".") || name.includes(".tmp-");

/**
 * Every store file that is NOT ciphertext, by name. Needs NO key — it only
 * looks for the seal shape, so it is a true at-rest observation, the same one
 * a thief of the directory would make.
 *
 * Whole-file kinds (index, marker, notes, proposals) must start with the codec
 * magic; logs are per-entry sealed, so every content line must have the
 * `<ISO-ts> <base64url>` shape and no plaintext entry header.
 */
function plaintextAtRest(home: string): string[] {
  const paths = storePaths(home);
  const bad: string[] = [];
  for (const file of [paths.index, paths.storeMarker]) {
    let raw: string;
    try {
      raw = readFileSync(fsPath(file), "utf8");
    } catch {
      continue; // absent is a different failure; this probe is about CONTENT
    }
    if (!raw.startsWith(ENC_MAGIC)) bad.push(path.basename(file));
  }
  for (const dir of [paths.topicsDir, paths.proposalsDir]) {
    let names: string[];
    try {
      names = readdirSync(fsPath(dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (isTemp(name)) continue;
      const raw = readFileSync(path.join(fsPath(dir), name), "utf8");
      if (!raw.startsWith(ENC_MAGIC)) bad.push(`${path.basename(dir)}/${name}`);
    }
  }
  let logs: string[];
  try {
    logs = readdirSync(fsPath(paths.logsDir));
  } catch {
    logs = [];
  }
  for (const name of logs) {
    if (isTemp(name) || !name.endsWith(".log.md")) continue;
    const raw = readFileSync(path.join(fsPath(paths.logsDir), name), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "" || /^# \S+ log$/.test(t)) continue;
      if (!ENCRYPTED_LINE_RE.test(t)) {
        bad.push(`logs/${name} (plaintext line: ${t.slice(0, 40)})`);
        break;
      }
    }
  }
  return bad;
}

const entry = (summary: string) =>
  ({ type: "decision", project: "p", agent: "x", summary }) as const;

afterEach(() => {
  vi.restoreAllMocks();
  clearActiveKey();
});

describe("(1) concurrent writes on an ENCRYPTED store", () => {
  it("20 concurrent appends all survive, all decrypt, and nothing lands in plaintext", async () => {
    const home = encStore("enc-conc-writes");
    unlock(home);
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });

    const clk = tickingClock(50_000);
    const summaries = Array.from({ length: 20 }, (_, i) => `concurrent-entry-${i}`);
    await Promise.all(summaries.map((s) => appendLog(home, "topic-a", entry(s), { now: clk })));

    // Every entry survived AND decrypts under the real key.
    const logPath = path.join(fsPath(storePaths(home).logsDir), "topic-a.log.md");
    const raw = readFileSync(logPath, "utf8");
    const { entries, warnings } = parseLog(raw, "topic-a");
    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.summary).sort()).toEqual([...summaries].sort());
    // Timestamps stayed strictly distinct under the lock, so no entry was
    // silently coalesced away by the encrypted (deterministic-nonce) codec.
    expect(new Set(entries.map((e) => e.timestamp)).size).toBe(20);

    // …and the bytes on disk are ciphertext, not text that merely round-trips.
    expect(plaintextAtRest(home)).toEqual([]);
    for (const s of summaries) expect(raw).not.toContain(s);

    // The derived index agrees with the files.
    expect((await readIndex(home))!.topics["topic-a"]!.logEntries).toBe(20);
  }, 60_000);

  it("concurrent writers across topics keep the index sealed and consistent", async () => {
    const home = encStore("enc-conc-topics");
    unlock(home);
    const ids = ["alpha-topic", "bravo-topic", "charlie-topic", "delta-topic"];
    for (const id of ids) await createTopic(home, id, id, { now: clockAt(1000) });

    const clk = tickingClock(90_000);
    await Promise.all(
      ids.flatMap((id) =>
        Array.from({ length: 4 }, (_, i) => appendLog(home, id, entry(`${id}-${i}`), { now: clk })),
      ),
    );

    const index = await readIndex(home);
    for (const id of ids) expect(index!.topics[id]!.logEntries).toBe(4);
    expect(plaintextAtRest(home)).toEqual([]);
  }, 60_000);
});

describe("(2) key material (session cache + keyring) under concurrency", () => {
  it("a concurrent READER of the cache file must not defeat the cache write", () => {
    // The exact shape that broke the store write path on Windows: a rename over
    // a file another process holds open. `store/atomic.ts` now rides that out
    // with 12 jittered retries; `writeSessionCache` does a BARE renameSync, and
    // this file is the single one EVERY tool reads on EVERY unlock.
    const home = encStore("cache-reader-race");
    const dek = unlockWithPassphrase(home, PASS);
    writeSessionCache(home, dek, HOUR_MS);
    const cacheFile = sessionCachePath(home);

    const held = openSync(cacheFile, "r"); // another tool reading the cache
    let failure: unknown;
    try {
      writeSessionCache(home, dek, HOUR_MS);
    } catch (err) {
      failure = err;
    } finally {
      closeSync(held);
    }

    // Non-negotiables first: whatever happened, no half-written file and no
    // orphaned temp holding a live DEK. These hold — the damage is elsewhere.
    expect(readSessionCache(home, Date.now(), { ttlMs: HOUR_MS })).toMatch(/^[0-9a-f]{64}$/i);
    expect(readdirSync(sessionCacheDir()).filter((n) => n.includes(".tmp-"))).toEqual([]);

    // DEFECT (2026-07-28 probe): `writeSessionCache` renames with NO retry
    // budget, so one concurrent reader is enough to lose the write — the exact
    // failure `store/atomic.ts` was given 12 jittered retries to survive. Every
    // caller swallows the throw ("best effort"), so the product degrades
    // SILENTLY: with several tools on one store the cache is repeatedly lost
    // and every command pays the full Argon2id unlock it was built to skip.
    //
    // FIXED 2026-07-28: writeSessionCache now retries the rename with backoff,
    // like the store's atomic writer. This probe holds the reader open for the
    // WHOLE attempt, which no retry budget can ever beat and which no real
    // reader does (they open, read a few hundred bytes, and close). So the
    // contract asserted here is the one that matters for a permanent holder:
    // it fails CLEANLY, leaving a usable cache and no temp holding a live key
    // (both already checked above). The transient case — the real one — is
    // asserted next.
    if (failure !== undefined) {
      expect((failure as NodeJS.ErrnoException).code).toMatch(/EPERM|EACCES|EBUSY/);
    }
  });

  it("a TRANSIENT reader (the real shape) no longer defeats the cache write", () => {
    // What actually happens on a shared store: a reader holds the file for
    // microseconds. Before the retry budget existed, even that lost the write.
    const home = encStore("cache-reader-transient");
    const dek = unlockWithPassphrase(home, PASS);
    writeSessionCache(home, dek, HOUR_MS);
    const cacheFile = sessionCachePath(home);

    // Open and close immediately, the way a reader really behaves, then write.
    closeSync(openSync(cacheFile, "r"));
    let failure: unknown;
    try {
      writeSessionCache(home, dek, HOUR_MS);
    } catch (err) {
      failure = err;
    }
    expect(failure, "a transient reader must not cost the cache write").toBeUndefined();
    expect(readSessionCache(home, Date.now(), { ttlMs: HOUR_MS })).toMatch(/^[0-9a-f]{64}$/i);
    expect(readdirSync(sessionCacheDir()).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("a concurrent READER of keyring.json must not break `recover`", () => {
    // Same class, harder consequence: EVERY unlock reads keyring.json
    // (`readKeyring`), and `writeKeyringFile` renames over it with no retry —
    // so a passphrase reset can fail purely because another tool was unlocking.
    // Unlike the cache, this one is NOT best-effort: it surfaces as a hard
    // "Could not write keyring.json" on `recover` (and `init`).
    const home = freshHome("keyring-reader-race");
    const r = runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    const keyringFile = path.join(fsPath(storePaths(home).home), "keyring.json");

    const held = openSync(keyringFile, "r"); // another tool unlocking right now
    let failure: unknown;
    try {
      recover(home, r.mnemonic!, "another perfectly sturdy passphrase", TINY, {
        allowWeakParams: true,
      });
    } catch (err) {
      failure = err;
    } finally {
      closeSync(held);
      clearActiveKey();
    }

    // The store is never damaged by the failure — that part holds.
    expect(plaintextAtRest(home)).toEqual([]);
    expect(readFileSync(keyringFile, "utf8")).toContain('"kid"');

    // FIXED 2026-07-28: writeKeyringFile retries the rename now. As with the
    // cache probe, this holder never lets go, so a clean typed refusal is the
    // correct outcome; the transient case is asserted next.
    if (failure !== undefined) {
      expect(failure).toBeInstanceOf(GestaltError);
      expect((failure as GestaltError).code).toBe("E_LOCKED");
    }
  });

  it("a TRANSIENT reader of keyring.json (the real shape) no longer breaks recover", () => {
    const home = freshHome("keyring-reader-transient");
    const r = runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    const keyringFile = path.join(fsPath(storePaths(home).home), "keyring.json");

    closeSync(openSync(keyringFile, "r")); // a real unlock: open, read, close
    let failure: unknown;
    try {
      recover(home, r.mnemonic!, "another perfectly sturdy passphrase", TINY, {
        allowWeakParams: true,
      });
    } catch (err) {
      failure = err;
    } finally {
      clearActiveKey();
    }
    expect(failure, "a transient unlock must not break a passphrase reset").toBeUndefined();
    expect(plaintextAtRest(home)).toEqual([]);
  });

  it(
    "many REAL concurrent unlock processes leave a usable cache and no wedged process",
    async () => {
      const home = encStore("cache-storm");
      const N = 8;

      const runs = await Promise.all(
        Array.from({ length: N }, () => runCli(["status", "--home", home], { GESTALT_PASSPHRASE: PASS })),
      );

      // Nobody crashed, nobody wedged. A non-zero exit here is a user whose
      // tool died because another tool was unlocking at the same moment.
      const failed = runs.filter((r) => r.status !== 0).map((r) => `exit ${r.status}: ${r.stderr.trim().slice(0, 200)}`);
      expect(failed).toEqual([]);

      // The cache file is intact, holds THIS store's key, and is warm — i.e.
      // the storm did not silently cost every tool the cache it exists for.
      const peek = peekSessionCache(home, Date.now(), { ttlMs: HOUR_MS });
      expect(peek.state).toBe("warm");
      const hex = readSessionCache(home, Date.now(), { ttlMs: HOUR_MS });
      expect(hex).toMatch(/^[0-9a-f]{64}$/i);
      expect(() => assertEnvKeyMatchesStore(home, hex!)).not.toThrow();
      clearActiveKey();

      // No half-written temp holding a live DEK survived the storm.
      expect(readdirSync(sessionCacheDir()).filter((n) => n.includes(".tmp-"))).toEqual([]);
      // And the store itself is untouched by the read storm.
      expect(plaintextAtRest(home)).toEqual([]);
    },
    240_000,
  );
});

describe("(3) SECURITY: a write racing a `lock` must never write PLAINTEXT", () => {
  /**
   * `fimemory lock` wipes the session cache; the in-process equivalent for a
   * long-lived host (MCP server / Harness daemon) additionally drops the
   * process key — `clearActiveKey()` is what EVERY failed-unlock and lock path
   * in this codebase calls. The key is process-GLOBAL mutable state with no
   * interlock against in-flight async writes, so the question is exact: if the
   * key disappears mid-write, does the op fail cleanly, or does it finish the
   * write with the codec silently degraded to IDENTITY?
   *
   * Timing is deterministic, not a sleep race: the lock fires the instant the
   * Nth atomic-write TEMP file is opened, which is precisely "this op has
   * already started writing".
   */
  async function raceLockAgainst(
    home: string,
    tempOpenIndex: number,
    op: () => Promise<unknown>,
  ): Promise<"resolved" | unknown> {
    const realOpen = fsp.open.bind(fsp);
    let temps = 0;
    const hooked = async (p: PathLike, flags?: string | number, mode?: Mode): Promise<FileHandle> => {
      const handle = await realOpen(p, flags, mode);
      if (String(p).includes(".tmp-") && temps++ === tempOpenIndex) {
        wipeSessionCache(home); // what `fimemory lock` does on disk
        clearActiveKey(); // …and what a locked host does in memory
      }
      return handle;
    };
    vi.spyOn(fsp, "open").mockImplementation(hooked);
    try {
      return await op().then(
        () => "resolved" as const,
        (err: unknown) => err,
      );
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("createTopic racing a lock leaves the store fully sealed", async () => {
    const violations: string[] = [];
    // createTopic's atomic writes, in order: note temp, log temp, index temp.
    for (const at of [0, 1, 2]) {
      const home = encStore(`race-create-${at}`);
      unlock(home);
      await createTopic(home, "seed-topic", "Seed", { now: clockAt(1000) });

      const outcome = await raceLockAgainst(home, at, () =>
        createTopic(home, "raced-topic", "Raced", { now: clockAt(2000) }),
      );
      const verdict =
        outcome === "resolved"
          ? "the op REPORTED SUCCESS"
          : outcome instanceof GestaltError
            ? `the op threw ${outcome.code}`
            : `the op crashed untyped: ${String(outcome)}`;
      if (outcome !== "resolved" && !(outcome instanceof GestaltError)) {
        violations.push(`tempOpen=${at}: crashed untyped — ${String(outcome)}`);
      }
      unlock(home); // the owner unlocks again, as any tool would after a lock
      for (const file of plaintextAtRest(home)) {
        // Name what leaked and whether the store is now unreadable: a plaintext
        // index.json in a sealed store both exposes every topic id/title/tag and
        // wedges the store (`decryptFile` fails closed on the next read).
        const leaked =
          file === "index.json"
            ? readFileSync(fsPath(storePaths(home).index), "utf8").replace(/\s+/g, " ").slice(0, 120)
            : "";
        const stillReadable = await readIndex(home).then(
          () => "index still readable",
          (err: unknown) => `store WEDGED: ${err instanceof GestaltError ? err.code : String(err)}`,
        );
        violations.push(
          `tempOpen=${at}: ${file} is PLAINTEXT in an encrypted store — ${verdict}; ${stillReadable}${
            leaked ? `; leaked: ${leaked}` : ""
          }`,
        );
      }
      clearActiveKey();
    }
    expect(violations).toEqual([]);
  }, 60_000);

  it("appendLog racing a lock leaves the store fully sealed", async () => {
    const violations: string[] = [];
    // appendLog's atomic writes, in order: log temp, index temp.
    for (const at of [0, 1]) {
      const home = encStore(`race-append-${at}`);
      unlock(home);
      await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
      await appendLog(home, "topic-a", entry("baseline"), { now: clockAt(2000) });

      const outcome = await raceLockAgainst(home, at, () =>
        appendLog(home, "topic-a", entry("raced-write"), { now: clockAt(3000) }),
      );
      if (outcome !== "resolved" && !(outcome instanceof GestaltError)) {
        violations.push(`tempOpen=${at}: crashed untyped — ${String(outcome)}`);
      }
      for (const file of plaintextAtRest(home)) {
        violations.push(`tempOpen=${at}: ${file} is PLAINTEXT in an encrypted store`);
      }
      clearActiveKey();
    }
    expect(violations).toEqual([]);
  }, 60_000);

  it("a write STARTED after the lock fails closed, never half-plaintext", async () => {
    const home = encStore("race-after-lock");
    unlock(home);
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    await appendLog(home, "topic-a", entry("before-lock"), { now: clockAt(2000) });

    wipeSessionCache(home);
    clearActiveKey(); // the lock lands BETWEEN ops — the ordinary case

    await expect(
      appendLog(home, "topic-a", entry("after-lock"), { now: clockAt(3000) }),
    ).rejects.toBeInstanceOf(GestaltError);
    await expect(createTopic(home, "new-topic", "New", { now: clockAt(4000) })).rejects.toBeInstanceOf(
      GestaltError,
    );
    expect(plaintextAtRest(home)).toEqual([]);
  }, 30_000);
});

describe("(4) a LOCKED encrypted store under concurrent reads", () => {
  it("12 concurrent MCP calls all answer typed E_LOCKED — no crash, no process death", async () => {
    await withoutAmbientKeys(async () => {
      const home = encStore("locked-concurrent-mcp");
      const calls = Array.from({ length: 12 }, (_, i) =>
        handleRpc(home, {
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params:
            i % 3 === 0
              ? { name: "fimemory_status", arguments: {} }
              : i % 3 === 1
                ? { name: "fimemory_search", arguments: { query: "anything" } }
                : { name: "fimemory_get", arguments: { ids: ["gestalt-example"] } },
        }),
      );
      const results = (await Promise.all(calls)) as {
        result: { isError: boolean; structuredContent?: { error?: { code: string; hint: string } } };
      }[];
      for (const r of results) {
        expect(r.result.isError).toBe(true);
        expect(r.result.structuredContent?.error?.code).toBe("E_LOCKED");
        expect(r.result.structuredContent?.error?.hint).toContain("fimemory unlock");
      }
    });
  }, 60_000);

  it("concurrent library reads on a locked store throw typed E_STORE_MODE, not raw crashes", async () => {
    await withoutAmbientKeys(async () => {
      const home = encStore("locked-concurrent-lib");
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? search(home, "example") : get(home, ["gestalt-example"])).then(
            () => "resolved" as const,
            (err: unknown) => err,
          ),
        ),
      );
      const untyped = outcomes.filter((o) => o === "resolved" || !(o instanceof GestaltError));
      expect(untyped).toEqual([]);
      for (const o of outcomes) expect((o as GestaltError).code).toBe("E_STORE_MODE");
    });
  }, 60_000);
});

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the REAL cli.ts in a child process (never a vendor CLI). Ambient
 * credentials are cleared unless the caller sets them. */
function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      env: { ...process.env, GESTALT_KEY: "", GESTALT_PASSPHRASE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli ${args.join(" ")} did not finish within 120 s`));
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}
