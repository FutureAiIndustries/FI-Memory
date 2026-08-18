import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import { activateDek, clearActiveKey, encryptFile } from "../src/store/codec.js";
import { storeHasSealedContent, unlockWithPassphrase } from "../src/store/keyring.js";
import { expectGestaltErrorAsync, freshHome, tsxEntry } from "./helpers.js";

/**
 * B1 — a keyring-less clone of an encrypted store accepted plaintext writes.
 *
 * `assertNotSealedStore` decided a store was encrypted by testing one thing:
 * `existsSync(<home>/keyring.json)`. But `fimemory init` GITIGNORES keyring.json
 * on purpose — it is the per-machine wrapped key and must travel out of band —
 * so the single file the guard keyed on is missing from every clone of an
 * encrypted store BY DESIGN. The guard returned early there, and `create`,
 * `log`, `review approve` and the index writer all landed CLEARTEXT in a tree of
 * ciphertext. Restoring keyring.json afterwards wedges the store: the reader
 * fails closed on exactly the files the writer had just added, and no doctor
 * finding named the real problem.
 *
 * The fix is structural, at the choke point: the guard now keys on keyring.json
 * OR the store's actual sealed CONTENT, using the same `storeHasSealedContent`
 * gate the CLI, doctor, export and the migrations already share. Patching the
 * one caller that surfaced the bug would have left the next write path with the
 * identical hole, which is why every test below drives the REAL write path
 * (`store/atomic.ts` → `encryptFile`) rather than the guard directly.
 *
 * Half of these tests exist for the OPPOSITE risk. A guard that refuses a
 * genuinely plaintext store is worse than the bug it replaces — it breaks every
 * write the user makes — so the plaintext cases here are not filler.
 */

// Tiny Argon2 params so the suite stays fast (real default is 64 MiB / t=3).
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASSPHRASE = "a solid sealed-store guard passphrase";

/** An encrypted store, LOCKED — the state every one of these tests starts from. */
function lockedEncryptedStore(label: string): string {
  const home = freshHome(label);
  runInit({ home, encrypted: true, passphrase: PASSPHRASE, argon2: TINY, allowWeakParams: true });
  clearActiveKey();
  return home;
}

/** Delete keyring.json, exactly as `git clone` of a store template does. */
function dropKeyring(home: string): void {
  rmSync(fsPath(path.join(home, "keyring.json")));
}

const NOTE_BODY = "---\nid: arrived-by-clone\ntitle: arrived by clone\n---\n\nbody\n";

afterEach(() => clearActiveKey());

describe("the sealed-store guard keys on CONTENT, not on the gitignored keyring", () => {
  it("still accepts note, log and index writes into a genuinely plaintext store", async () => {
    const home = freshHome("guard-plain");
    runInit({ home });

    const note = topicNotePath(home, "hand-written");
    await writeFileAtomic(note, NOTE_BODY);
    await writeFileAtomic(topicLogPath(home, "hand-written"), "# hand-written log\n");
    await writeFileAtomic(storePaths(home).index, '{"topics":[]}\n');

    // Identity codec, byte for byte — the whole point of the plaintext mode.
    expect(readFileSync(fsPath(note), "utf8")).toBe(NOTE_BODY);
    expect(readFileSync(fsPath(storePaths(home).index), "utf8")).toBe('{"topics":[]}\n');
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("does not lock a plaintext store out of its own writes because a note QUOTES the sealed magic", async () => {
    // The store gate requires git conflict-marker evidence before a mid-file
    // magic string counts, precisely so a note DOCUMENTING the format is not
    // read as ciphertext. The guard must inherit that conservatism unchanged —
    // it adds no heuristic of its own.
    const home = freshHome("guard-quotes-magic");
    runInit({ home });
    writeFileSync(
      fsPath(topicNotePath(home, "format-notes")),
      "---\nid: format-notes\n---\n\nA sealed blob looks like:\n\ngestalt-enc:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
      "utf8",
    );
    clearActiveKey(); // retire any verdict taken while `init` was writing

    expect(storeHasSealedContent(home)).toBe(false);
    await writeFileAtomic(topicNotePath(home, "hand-written"), NOTE_BODY);
    expect(readFileSync(fsPath(topicNotePath(home, "hand-written")), "utf8")).toBe(NOTE_BODY);
  });

  it("an unlocked encrypted store writes ciphertext exactly as before", async () => {
    const home = lockedEncryptedStore("guard-unlocked");
    activateDek(unlockWithPassphrase(home, PASSPHRASE));

    const note = topicNotePath(home, "sealed-write");
    await writeFileAtomic(note, NOTE_BODY);
    const raw = readFileSync(fsPath(note), "utf8");
    expect(raw.startsWith("gestalt-enc:1:")).toBe(true);
    expect(raw).not.toContain("arrived by clone");
  });

  it("a LOCKED encrypted store that still has its keyring refuses, and blames the in-flight key loss", async () => {
    const home = lockedEncryptedStore("guard-locked");
    const note = topicNotePath(home, "arrived-by-clone");

    const err = await expectGestaltErrorAsync(
      () => writeFileAtomic(note, NOTE_BODY),
      "E_STORE_MODE",
    );
    expect(err.message).toMatch(/Refusing to write arrived-by-clone\.md as plaintext/);
    expect(err.hint).toMatch(/cleared while this write was in flight/);
    expect(existsSync(fsPath(note))).toBe(false); // nothing written, as promised
  });

  it("REFUSES the plaintext note write a keyring-less clone of a sealed store used to accept", async () => {
    const home = lockedEncryptedStore("guard-clone");
    dropKeyring(home); // the gitignored file never made it into the clone
    expect(existsSync(fsPath(path.join(home, "keyring.json")))).toBe(false);
    expect(storeHasSealedContent(home)).toBe(true);

    const note = topicNotePath(home, "arrived-by-clone");
    const err = await expectGestaltErrorAsync(
      () => writeFileAtomic(note, NOTE_BODY),
      "E_STORE_MODE",
    );
    // The hint has to fit the clone, not a lock: there was never a key here.
    expect(err.hint).toMatch(/gitignored and travels out of band/);
    expect(err.hint).toMatch(/fimemory recover/);
    expect(existsSync(fsPath(note))).toBe(false);
  });

  it("refuses the index write too — the one whose leak exposed every topic id and title", async () => {
    const home = lockedEncryptedStore("guard-clone-index");
    dropKeyring(home);

    await expectGestaltErrorAsync(
      () => writeFileAtomic(storePaths(home).index, '{"topics":[{"id":"secret-project"}]}\n'),
      "E_STORE_MODE",
    );
    // The sealed catalog `init` wrote is untouched — the refusal did not
    // overwrite it with a cleartext one listing every topic id and title.
    expect(readFileSync(fsPath(storePaths(home).index), "utf8").startsWith("gestalt-enc:1:")).toBe(true);
  });

  it("refuses when the store-mode marker is gone too and only per-entry sealed LOGS survive", async () => {
    // The `store.enc` marker is an O(1) shortcut, not the answer. A pre-marker
    // store, or a partial restore, can arrive with neither keyring nor marker —
    // then only `storeHasSealedContent`'s log-shape finder stands between the
    // user and cleartext in a sealed tree.
    const home = lockedEncryptedStore("guard-logs-only");
    dropKeyring(home);
    rmSync(fsPath(storePaths(home).storeMarker));
    rmSync(fsPath(storePaths(home).index));
    rmSync(fsPath(topicNotePath(home, "gestalt-example")));
    rmSync(fsPath(path.join(home, "proposals")), { recursive: true, force: true });
    expect(storeHasSealedContent(home)).toBe(true); // via the sealed log lines alone

    await expectGestaltErrorAsync(
      () => writeFileAtomic(topicNotePath(home, "arrived-by-clone"), NOTE_BODY),
      "E_STORE_MODE",
    );
  });

  it("refuses with a TYPED error the CLI can render, never a bare throw", async () => {
    const home = lockedEncryptedStore("guard-typed");
    dropKeyring(home);

    // expectGestaltErrorAsync asserts `instanceof GestaltError` and the code; a
    // raw `throw new Error(...)` fails it. The hint is user-facing recovery
    // text and is asserted because a refusal with no way out is its own defect.
    const err = await expectGestaltErrorAsync(
      () => writeFileAtomic(topicNotePath(home, "arrived-by-clone"), NOTE_BODY),
      "E_STORE_MODE",
    );
    expect(err.code).toBe("E_STORE_MODE");
    expect(err.hint.length).toBeGreaterThan(0);
  });
});

describe("the memoised scan cannot outlive the key change that made the store sealed", () => {
  it("refuses on the very next write after THIS process seals a store it just called plaintext", async () => {
    const home = freshHome("guard-epoch-dek");
    runInit({ home });

    // 1. A plaintext write: the guard scans and memoises "nothing sealed here".
    await writeFileAtomic(topicNotePath(home, "before"), NOTE_BODY);
    expect(readFileSync(fsPath(topicNotePath(home, "before")), "utf8")).toBe(NOTE_BODY);

    // 2. Seal a note in place. Sealed bytes cannot appear without a key, and
    //    every door to a key bumps the epoch that retires the memo.
    activateDek(new Uint8Array(32).fill(7));
    await writeFileAtomic(topicNotePath(home, "before"), NOTE_BODY);
    expect(readFileSync(fsPath(topicNotePath(home, "before")), "utf8").startsWith("gestalt-enc:1:")).toBe(true);

    // 3. Lock, and try to write plaintext into what is now a sealed store.
    clearActiveKey();
    await expectGestaltErrorAsync(
      () => writeFileAtomic(topicNotePath(home, "after"), NOTE_BODY),
      "E_STORE_MODE",
    );
    expect(existsSync(fsPath(topicNotePath(home, "after")))).toBe(false);
  });

  it("retires the memo when GESTALT_KEY appears and vanishes, not only on an explicit unlock", async () => {
    // The env-key path never calls activateDek/clearActiveKey, so `keyState()`
    // has to bump the epoch itself. It is the route the suite and CI take, so a
    // memo that survived it would be a hole opened by the fix, not closed.
    const home = freshHome("guard-epoch-env");
    runInit({ home });
    const saved = process.env.GESTALT_KEY;
    try {
      await writeFileAtomic(topicNotePath(home, "before"), NOTE_BODY); // memoise "plaintext"

      process.env.GESTALT_KEY = "a".repeat(64);
      await writeFileAtomic(topicNotePath(home, "before"), NOTE_BODY);
      expect(readFileSync(fsPath(topicNotePath(home, "before")), "utf8").startsWith("gestalt-enc:1:")).toBe(true);

      delete process.env.GESTALT_KEY;
      await expectGestaltErrorAsync(
        () => writeFileAtomic(topicNotePath(home, "after"), NOTE_BODY),
        "E_STORE_MODE",
      );
    } finally {
      if (saved === undefined) delete process.env.GESTALT_KEY;
      else process.env.GESTALT_KEY = saved;
    }
  });
});

describe("the guard stays off the hot path", () => {
  it("pays for ONE tree scan per home, not one per write", () => {
    // Measured before the memo existed (Windows 11, Defender live, warm cache):
    // `storeHasSealedContent` costs ~0.34 ms per file head it reads — 111 ms at
    // 50 notes, 424 ms at 200, 1048 ms at 500 — and one `create` performs three
    // guarded writes. Scanning per write would have put seconds on a single
    // command, and a guard that slow is a guard someone turns off.
    //
    // A RATIO, not a wall-clock budget: both halves scale together under suite
    // load, so this stays honest on a slow box. Un-memoised, the warm burst
    // would cost ~25x the cold call; memoised it is a Map lookup.
    const home = freshHome("guard-hot-path");
    runInit({ home });
    for (let i = 0; i < 60; i++) {
      writeFileSync(fsPath(topicNotePath(home, `t-${i}`)), `---\nid: t-${i}\n---\n\nbody\n`, "utf8");
      writeFileSync(fsPath(topicLogPath(home, `t-${i}`)), `# t-${i} log\n`, "utf8");
    }
    const target = storePaths(home).index;

    clearActiveKey(); // retire the verdict `init` left behind, so the next call scans
    const t0 = performance.now();
    encryptFile(target, "{}");
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < 25; i++) encryptFile(target, "{}");
    const warmMs = performance.now() - t1;

    expect(coldMs).toBeGreaterThan(0); // the scan really happened
    expect(warmMs).toBeLessThan(coldMs * 3);
  });
});

/**
 * The guard imports `storeHasSealedContent`, and `store/keyring.ts` already
 * imports this codec — so the two modules form an ESM cycle, and store/log.ts
 * (which keyring pulls in) is a third leg of it. That is safe ONLY while
 * neither side reads the other's bindings during module EVALUATION; the day
 * someone writes a top-level `const X = SEALED_TOKEN_FLOOR + 1` in keyring.ts
 * or log.ts, the cycle becomes a TDZ ReferenceError and every command dies at
 * import time.
 *
 * Vitest cannot catch that. Vite-node rewrites ESM into async import calls with
 * their own ordering, so a cycle that breaks under Node's real loader can pass
 * here. These cases therefore spawn REAL node processes — one per plausible
 * entry order — and only assert that the modules load.
 */
describe("the codec ↔ keyring import cycle survives Node's real ESM loader", () => {
  const src = (rel: string): string => new URL(`../src/${rel}`, import.meta.url).href;
  const ORDERS: Array<[label: string, modules: string[]]> = [
    ["codec first", ["store/codec.ts", "store/keyring.ts"]],
    ["keyring first", ["store/keyring.ts", "store/codec.ts"]],
    ["log first — the deepest leg, keyring → log → codec", ["store/log.ts", "store/keyring.ts"]],
    ["the real write path first", ["store/atomic.ts"]],
    ["the CLI's own entry", ["index.ts"]],
  ];

  for (const [label, modules] of ORDERS) {
    it(`loads clean when the process reaches it via ${label}`, () => {
      const root = process.env.GESTALT_TEST_ROOT!;
      const script = path.join(root, `load-order-${label.replace(/\W+/g, "-")}.mjs`);
      writeFileSync(
        script,
        modules.map((m, i) => `import * as m${i} from ${JSON.stringify(src(m))};`).join("\n") +
          `\nif (${modules.map((_, i) => `typeof m${i} !== "object"`).join(" || ")}) process.exit(2);\n` +
          `console.log("LOADED");\n`,
        "utf8",
      );
      const r = spawnSync(process.execPath, [tsxEntry(), script], { encoding: "utf8" });
      expect(`${r.status} ${r.stderr}`.trim()).toBe("0");
      expect(r.stdout).toContain("LOADED");
    });
  }
});
