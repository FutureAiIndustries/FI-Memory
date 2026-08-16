import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { fsPath, proposalPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { activateDek, clearActiveKey, SEALED_TOKEN_FLOOR } from "../src/store/codec.js";
import {
  assertEnvKeyMatchesStore,
  deriveDekFromMnemonic,
  keyringExists,
  recover,
  storeHasSealedContent,
  unlockWithMnemonic,
  unlockWithPassphrase,
} from "../src/store/keyring.js";
import { parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { freshHome } from "./helpers.js";

// Tiny Argon2 params so the suite stays fast (real default is 64 MiB / t=3).
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");
const initEnc = (label: string, passphrase: string) =>
  runInit({ home: freshHome(label), encrypted: true, passphrase, argon2: TINY, allowWeakParams: true });

afterEach(() => clearActiveKey());

describe("keyring — E2 passphrase + recovery key management", () => {
  it("encrypted init creates a plaintext keyring + an encrypted store, unlockable by passphrase", async () => {
    const home = freshHome("kr");
    const r = runInit({ home, encrypted: true, passphrase: "a solid test passphrase here", argon2: TINY, allowWeakParams: true });

    expect(r.encrypted).toBe(true);
    expect(r.mnemonic?.split(" ").length).toBe(24);
    expect(keyringExists(home)).toBe(true);

    const kr = JSON.parse(readFileSync(fsPath(path.join(home, "keyring.json")), "utf8"));
    expect(kr.v).toBe(1);
    expect(kr.kdf.name).toBe("argon2id");
    expect(kr.wrap.passphrase.ct).toBeTruthy();

    // Note AND proposal are ciphertext on disk (M1); config stays plaintext.
    expect(readFileSync(fsPath(topicNotePath(home, "gestalt-example")), "utf8").startsWith("gestalt-enc:1:")).toBe(true);
    expect(readFileSync(fsPath(proposalPath(home, 1, "gestalt-example")), "utf8").startsWith("gestalt-enc:1:")).toBe(true);
    expect(readFileSync(fsPath(storePaths(home).config), "utf8")).toContain("noteTokenCap");

    expect(() => unlockWithPassphrase(home, "not the passphrase")).toThrow(/wrong passphrase|E_STORE_MODE/i);

    activateDek(unlockWithPassphrase(home, "a solid test passphrase here"));
    expect(await readText(topicNotePath(home, "gestalt-example"))).toContain("gestalt-example");
    expect(parseLog((await readText(topicLogPath(home, "gestalt-example")))!, "gestalt-example").entries.length).toBeGreaterThan(0);
  });

  it("the DEK is DETERMINISTIC in the recovery phrase — the 24 words alone restore the key with NO keyring.json (M3)", () => {
    const r = initEnc("kr-m3", "first passphrase here");
    const home = r.home;
    const dekP = unlockWithPassphrase(home, "first passphrase here");
    expect(hex(deriveDekFromMnemonic(r.mnemonic!))).toBe(hex(dekP)); // phrase derives the same DEK

    // Simulate a fresh machine / lost keyring: delete keyring.json, phrase still works.
    rmSync(fsPath(path.join(home, "keyring.json")));
    expect(keyringExists(home)).toBe(false);
    expect(hex(unlockWithMnemonic(home, r.mnemonic!))).toBe(hex(dekP)); // recovered from the phrase alone
  });

  it("recover resets a forgotten passphrase from the phrase (and rebuilds a missing keyring)", () => {
    const r = initEnc("kr-rec", "the original passphrase");
    const home = r.home;
    const dek0 = unlockWithPassphrase(home, "the original passphrase");

    rmSync(fsPath(path.join(home, "keyring.json"))); // forgot passphrase AND lost keyring
    const dek1 = recover(home, r.mnemonic!, "a brand new passphrase", TINY, { allowWeakParams: true }).dek;
    expect(hex(dek1)).toBe(hex(dek0)); // same DEK
    expect(keyringExists(home)).toBe(true); // keyring rebuilt
    expect(hex(unlockWithPassphrase(home, "a brand new passphrase"))).toBe(hex(dek0));
    expect(() => unlockWithPassphrase(home, "the original passphrase")).toThrow();
  });

  it("rejects a weak passphrase and a bogus recovery phrase (S1)", () => {
    const home = freshHome("kr-weak");
    expect(() => runInit({ home, encrypted: true, passphrase: "short", argon2: TINY, allowWeakParams: true })).toThrow(/weak|E_SCHEMA/i);
    const r = initEnc("kr-bogus", "a perfectly fine passphrase");
    expect(() => unlockWithMnemonic(r.home, "not even a mnemonic")).toThrow(/recovery phrase|E_SCHEMA/i);
  });

  it("recovery is bound to the store's ciphertext — a wrong (valid) phrase is rejected (Grok H1)", () => {
    const r = initEnc("kr-h1", "the real passphrase here");
    const home = r.home;
    // A different, checksum-valid 24-word phrase (all-zeros entropy).
    const WRONG = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
    rmSync(fsPath(path.join(home, "keyring.json"))); // the exact H1 scenario: no keyring to kid-check

    expect(() => unlockWithMnemonic(home, WRONG)).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(() => recover(home, WRONG, "a new real passphrase", TINY, { allowWeakParams: true })).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    // The RIGHT phrase still recovers.
    expect(hex(recover(home, r.mnemonic!, "a new real passphrase", TINY, { allowWeakParams: true }).dek)).toBe(hex(deriveDekFromMnemonic(r.mnemonic!)));
  });

  it("rejects a non-24-word phrase (L1) and a repeated-pattern passphrase (M2)", () => {
    expect(() => deriveDekFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")).toThrow(/24-word|E_SCHEMA/i);
    const home = freshHome("kr-m2");
    expect(() => runInit({ home, encrypted: true, passphrase: "aaaaaaaaaaaaaaaa", argon2: TINY, allowWeakParams: true })).toThrow(/repeated|weak|common|E_SCHEMA/i);
  });

  it("plaintext init is unchanged (no keyring, no mnemonic, no marker)", () => {
    const home = freshHome("kr-plain");
    const r = runInit({ home });
    expect(r.encrypted).toBe(false);
    expect(r.mnemonic).toBeUndefined();
    expect(keyringExists(home)).toBe(false);
    expect(existsSync(fsPath(storePaths(home).storeMarker))).toBe(false); // R3 marker
    expect(readFileSync(fsPath(topicNotePath(home, "gestalt-example")), "utf8")).toContain("id: gestalt-example");
  });

  // A different, checksum-valid 24-word phrase (all-zeros entropy) — opens no store.
  const WRONG_PHRASE =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

  it("encrypted init writes a sealed store-mode marker (R3)", () => {
    const r = initEnc("kr-marker", "a marker test passphrase");
    expect(readFileSync(fsPath(storePaths(r.home).storeMarker), "utf8").startsWith("gestalt-enc:1:")).toBe(true);
  });

  it("everyday passphrase unlock is bound to the ciphertext — a swapped keyring is rejected (R3 H)", () => {
    const a = initEnc("kr-swapA", "passphrase for store A here");
    const b = initEnc("kr-swapB", "passphrase for store B here");
    const aKeyring = readFileSync(fsPath(path.join(a.home, "keyring.json")), "utf8");

    // B's keyring is internally consistent (its kid matches its own DEK) but its
    // DEK does not open A's store. The old kid-only check would let it "unlock".
    writeFileSync(fsPath(path.join(a.home, "keyring.json")), readFileSync(fsPath(path.join(b.home, "keyring.json")), "utf8"));
    expect(() => unlockWithPassphrase(a.home, "passphrase for store B here")).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();

    // Restore A's real keyring — A's own passphrase opens A again.
    writeFileSync(fsPath(path.join(a.home, "keyring.json")), aKeyring);
    expect(() => unlockWithPassphrase(a.home, "passphrase for store A here")).not.toThrow();
  });

  it("a store whose only sealed survivor is a proposal is still encrypted + binds recovery (R3 M)", () => {
    const r = initEnc("kr-prop", "a good enough passphrase");
    const home = r.home;
    const p = storePaths(home);
    // Strip the keyring, the marker, the index, and the note — leave the sealed
    // proposal (and the sealed log). The old scan saw none of these.
    rmSync(fsPath(path.join(home, "keyring.json")));
    rmSync(fsPath(p.storeMarker));
    rmSync(fsPath(p.index));
    rmSync(fsPath(topicNotePath(home, "gestalt-example")));

    expect(storeHasSealedContent(home)).toBe(true);
    expect(() => recover(home, WRONG_PHRASE, "a new good passphrase", TINY, { allowWeakParams: true })).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(hex(recover(home, r.mnemonic!, "a new good passphrase", TINY, { allowWeakParams: true }).dek)).toBe(hex(deriveDekFromMnemonic(r.mnemonic!)));
  });

  it("a store whose only sealed survivor is a log is still encrypted + binds recovery (R3 M)", () => {
    const r = initEnc("kr-logonly", "yet another fine passphrase");
    const home = r.home;
    const p = storePaths(home);
    rmSync(fsPath(path.join(home, "keyring.json")));
    rmSync(fsPath(p.storeMarker));
    rmSync(fsPath(p.index));
    rmSync(fsPath(topicNotePath(home, "gestalt-example")));
    rmSync(fsPath(proposalPath(home, 1, "gestalt-example")));

    expect(storeHasSealedContent(home)).toBe(true); // detected via the per-entry log shape
    expect(() => unlockWithMnemonic(home, WRONG_PHRASE)).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(hex(unlockWithMnemonic(home, r.mnemonic!))).toBe(hex(deriveDekFromMnemonic(r.mnemonic!)));
  });

  it("rejects trivial multi-token passphrases the old AND-gate let through (R3 M)", () => {
    for (const weak of ["the the the the", "1 2 3 4", "a a a a"]) {
      const home = freshHome("kr-weak-" + weak.replace(/\s/g, "_"));
      expect(
        () => runInit({ home, encrypted: true, passphrase: weak, argon2: TINY, allowWeakParams: true }),
        weak,
      ).toThrow(/weak|repeated|E_SCHEMA/i);
    }
    // A genuine diceware phrase of DISTINCT words is still accepted.
    const ok = freshHome("kr-diceware");
    expect(() => runInit({ home: ok, encrypted: true, passphrase: "correct stapler mountain velvet", argon2: TINY, allowWeakParams: true })).not.toThrow();
  });

  /**
   * THE REGRESSION (R3-H1) — a wrong phrase must NEVER re-key a store it cannot
   * open. c913ff3 added `logsDir` to `findWholeFileSealed`, which is BOTH the
   * gate's evidence AND `verifyDekOpensStore`'s AEAD oracle. `decryptFile`
   * identity-passes any log-kind path (`isWholeFileEncrypted("log")` is false),
   * so verifying a candidate DEK against a whole-file blob MISPLACED at a log
   * path consults no AEAD and ALWAYS "succeeds" — a WRONG valid phrase re-keyed
   * the store, exit 0, "Recovered".
   *
   * The fix separates the two concerns: `findWholeFileSealed` (the oracle) no
   * longer scans `logsDir`; a gate-only `findWholeFileSealedAtLogPath` keeps the
   * gate seeing the blob; and when the gate sees sealed content the oracle
   * cannot open, verify FAILS CLOSED. This guards both shapes — (a) a marker-less
   * store whose only sealed artifact is a misplaced log-path blob (fail closed
   * for EVERY key, right or wrong — nothing here is AEAD-openable), and (b) a
   * real sealed log (wrong refuses, RIGHT recovers) — for `recover` and for the
   * `GESTALT_KEY` verify gate the CLI runs before `status`/any op.
   */
  it("R3-H1 regression: a misplaced log-path blob is no oracle — wrong AND right fail closed, neither re-keys; a real sealed log still binds; the GESTALT_KEY gate refuses in both shapes", () => {
    // ── shape (a): the ONLY sealed artifact is a whole-file blob at a log path ──
    const a = initEnc("kr-blob-log", "the real passphrase here");
    const home = a.home;
    const pa = storePaths(home);
    // This store's OWN sealed note blob — genuinely a's ciphertext under a's key.
    const blob = readFileSync(fsPath(topicNotePath(home, "gestalt-example")), "utf8");
    expect(blob.startsWith("gestalt-enc:1:")).toBe(true);
    // Strip every artifact the codec can AEAD-open BY PATH, then MISPLACE the
    // blob at the log path — where decryptFile identity-passes it, so it can
    // prove NO key even though it IS a's ciphertext under a's key.
    rmSync(fsPath(path.join(home, "keyring.json")));
    rmSync(fsPath(pa.storeMarker));
    rmSync(fsPath(pa.index));
    rmSync(fsPath(topicNotePath(home, "gestalt-example")));
    rmSync(fsPath(proposalPath(home, 1, "gestalt-example")));
    writeFileSync(fsPath(topicLogPath(home, "gestalt-example")), blob, "utf8");
    clearActiveKey();

    // The gate still SEES it — the store is not silently downgraded to plaintext.
    expect(storeHasSealedContent(home)).toBe(true);

    // WRONG phrase: pre-fix the identity-pass "verified" it and re-keyed; now it
    // fails closed and does NOT write a keyring.
    expect(() => recover(home, WRONG_PHRASE, "a new good passphrase", TINY, { allowWeakParams: true })).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(keyringExists(home)).toBe(false);

    // RIGHT phrase: still fails closed — R3-H1, never re-key over a store whose
    // one artifact the codec cannot AEAD-verify — and also writes no keyring.
    expect(() => recover(home, a.mnemonic!, "a new good passphrase", TINY, { allowWeakParams: true })).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(keyringExists(home)).toBe(false);

    // The GESTALT_KEY verify gate (what the CLI runs before status/any op) also
    // refuses in shape (a) — a wrong raw key, AND, fail-closed, the real key.
    expect(() => assertEnvKeyMatchesStore(home, "00".repeat(32))).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(() => assertEnvKeyMatchesStore(home, hex(deriveDekFromMnemonic(a.mnemonic!)))).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();

    // ── shape (b): a REAL sealed log is present — wrong refuses, RIGHT recovers ──
    const b = initEnc("kr-sealedlog", "another real passphrase");
    const hb = b.home;
    const pb = storePaths(hb);
    rmSync(fsPath(path.join(hb, "keyring.json")));
    rmSync(fsPath(pb.storeMarker));
    rmSync(fsPath(pb.index));
    rmSync(fsPath(topicNotePath(hb, "gestalt-example")));
    rmSync(fsPath(proposalPath(hb, 1, "gestalt-example")));
    clearActiveKey();
    expect(storeHasSealedContent(hb)).toBe(true); // via the per-entry sealed log

    expect(() => recover(hb, WRONG_PHRASE, "a new good passphrase", TINY, { allowWeakParams: true })).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(keyringExists(hb)).toBe(false);
    expect(() => assertEnvKeyMatchesStore(hb, "11".repeat(32))).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();

    // The RIGHT phrase recovers where a real AEAD-openable artifact survives.
    expect(hex(recover(hb, b.mnemonic!, "a new good passphrase", TINY, { allowWeakParams: true }).dek)).toBe(hex(deriveDekFromMnemonic(b.mnemonic!)));
    clearActiveKey();
    expect(keyringExists(hb)).toBe(true);
  });

  /**
   * A1 (Grok round 2) — the GATE had no `SEALED_TOKEN_FLOOR`, so a wholly
   * PLAINTEXT store whose first log line is the canonized hand edit
   * `2026-07-14T09:30:00.000Z deployed` (an 8-char token) was read as encrypted.
   * `verifyDekOpensStore` then found that log (`findEncryptedLog`) and handed the
   * sub-floor token to `decodeLogEntry`, which threw — so recover reported
   * "does not open this store" about a store that has NOTHING sealed at all: a
   * false failure of the R3-H1 shape. With the floor shared from the codec the
   * gate excludes the sub-floor line, so there is no phantom AEAD oracle.
   */
  it("A1: a plaintext store with a SUB-FLOOR first log line does not falsely fail recover (no phantom oracle)", () => {
    const home = freshHome("a1-subfloor-recover");
    runInit({ home }); // a wholly plaintext store — no keyring, no ciphertext
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      "# deploys log\n\n2026-07-14T09:30:00.000Z deployed\n",
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(false);
    // No phantom oracle over the sub-floor line ⇒ recover binds a fresh keyring
    // (nothing sealed to be "wrong" against) instead of falsely refusing.
    expect(() =>
      recover(home, WRONG_PHRASE, "a new good passphrase", TINY, { allowWeakParams: true }),
    ).not.toThrow();
    clearActiveKey();
  });

  it("A1: a REAL >=FLOOR sealed log is still detected AND still binds recovery — the floor removes only false positives (R3-H1 unchanged)", () => {
    const r = initEnc("a1-real-sealed", "a perfectly good passphrase");
    const home = r.home;
    const p = storePaths(home);
    // Leave ONLY the sealed log — strip every artifact the codec opens by path.
    rmSync(fsPath(path.join(home, "keyring.json")));
    rmSync(fsPath(p.storeMarker));
    rmSync(fsPath(p.index));
    rmSync(fsPath(topicNotePath(home, "gestalt-example")));
    rmSync(fsPath(proposalPath(home, 1, "gestalt-example")));
    clearActiveKey();

    // Its first sealed line's token clears the floor — which is WHY the gate
    // still sees it: the floor changed nothing for a genuine sealed line.
    const sealedLine = readFileSync(fsPath(topicLogPath(home, "gestalt-example")), "utf8")
      .split("\n")
      .find((l) => /^\d{4}-/.test(l))!;
    expect(sealedLine.slice(sealedLine.indexOf(" ") + 1).length).toBeGreaterThanOrEqual(
      SEALED_TOKEN_FLOOR,
    );

    expect(storeHasSealedContent(home)).toBe(true);
    expect(() =>
      recover(home, WRONG_PHRASE, "a new good passphrase", TINY, { allowWeakParams: true }),
    ).toThrow(/does not open|E_STORE_MODE/i);
    clearActiveKey();
    expect(
      hex(recover(home, r.mnemonic!, "a new good passphrase", TINY, { allowWeakParams: true }).dek),
    ).toBe(hex(deriveDekFromMnemonic(r.mnemonic!)));
    clearActiveKey();
  });
});
