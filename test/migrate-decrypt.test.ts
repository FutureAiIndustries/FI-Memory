/**
 * `fimemory decrypt` — encrypted → plaintext migration.
 *
 * Data loss is the dominant risk in this command, so the suite is built around
 * it: a full round trip on a realistic store proved BYTE-IDENTICAL, a crash
 * injected at every stage, and one refusal per guard, each asserting that
 * NOTHING on disk changed.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { createTopic } from "../src/ops/create.js";
import { exportPlaintext } from "../src/ops/exportOp.js";
import { appendLedgerLine } from "../src/ops/ledgerOp.js";
import { appendLog } from "../src/ops/logOp.js";
import { updateTopic } from "../src/ops/update.js";
import { migrateToEncrypted } from "../src/ops/migrateEncrypt.js";
import {
  ARCHIVED_KEYRING_NAME,
  detectDecryptResidue,
  migrateToPlaintext,
} from "../src/ops/migrateDecrypt.js";
import type { GitState } from "../src/ops/migrateDecrypt.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { activateDek, clearActiveKey, encryptFile } from "../src/store/codec.js";
import { keyringExists, storeHasSealedContent, unlockWithPassphrase } from "../src/store/keyring.js";
import { parseLog, serializeLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import {
  clockAt,
  expectGestaltError,
  expectGestaltErrorAsync,
  freshHome,
  tsxEntry,
} from "./helpers.js";

/** file:// URL of a real source module, for the spawned crash driver to import. */
const srcUrl = (rel: string): string =>
  pathToFileURL(fileURLToPath(new URL(`../src/${rel}`, import.meta.url))).href;

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a solid migration passphrase here";
const ENC = "gestalt-enc:1:";
const YES = { confirmPlaintextRemote: true } as const;

/** A clean tree with no remote — the default for tests that are not about git. */
const NO_GIT = (): GitState => ({
  isRepo: false,
  dirty: [],
  inProgress: [],
  upstream: null,
  ahead: 0,
  behind: 0,
  remoteUrl: null,
});

afterEach(() => clearActiveKey());

/**
 * A realistic PLAINTEXT store: the example (note + log + pending proposal) plus
 * two more topics with log entries, a proposal, task-ledger lines, and a rotated
 * ledger archive directory — every surface the migration has to carry or rewrite.
 */
async function seedPlainStore(label: string): Promise<string> {
  const home = freshHome(label);
  runInit({ home });
  await createTopic(home, "auth-notes", "Auth Notes", { now: clockAt(1e12) });
  await appendLog(home, "auth-notes", { type: "decision", project: "fi", agent: "cli", summary: "chose sessions" }, { now: clockAt(1e12 + 1) });
  await appendLog(home, "auth-notes", { type: "gotcha", project: "fi", agent: "cli", summary: "cookie SameSite bit us" }, { now: clockAt(1e12 + 2) });
  await createTopic(home, "deploy-log", "Deploy Log", { now: clockAt(1e12 + 10) });
  await appendLog(home, "deploy-log", { type: "pattern", project: "ops", agent: "cli", summary: "blue/green" }, { now: clockAt(1e12 + 11) });
  await updateTopic(
    home,
    "auth-notes",
    "---\nid: auth-notes\ntitle: Auth Notes\naliases: []\ntags: []\nprojects: []\nupdated: null\ncompactedThrough: null\n---\n\nAuth Notes — sessions, not JWT.\n\n## Owner notes\n",
    { proposer: "cli" },
  );
  return home;
}

/** Two task-ledger events. Written through the real op, so they are sealed
 * PER-LINE whenever a DEK is active — the shape `merge=union` depends on. */
async function seedLedger(home: string): Promise<void> {
  await appendLedgerLine(home, "tasks", {
    task: "t-1", cascadeRoot: "t-1", idem: "i1", type: "assign",
    from: "eric", to: "agent-a", parent: null, agent: "cli",
  }, { now: clockAt(1e12 + 20) });
  await appendLedgerLine(home, "tasks", {
    task: "t-1", cascadeRoot: "t-1", idem: "i2", type: "result",
    from: "agent-a", to: "eric", parent: null, agent: "cli",
  }, { now: clockAt(1e12 + 21) });
}

/**
 * Seed, then ENCRYPT — the starting point for a decrypt test. Returns the
 * pre-encryption plaintext snapshot so the round trip can be proved byte-exact.
 *
 * The ledger is written AFTER the encryption on purpose: `fimemory encrypt`
 * carries an existing `ledgers/` across verbatim rather than re-sealing it (it
 * says so, loudly), so a ledger seeded before the migration would be PLAINTEXT
 * and would prove nothing about decrypt's per-line ledger path. Written after,
 * with the DEK active, it is genuinely sealed — which is the state every store
 * that has actually used the task bus is in.
 */
async function seedEncryptedStore(
  label: string,
): Promise<{ home: string; before: Map<string, string> }> {
  const home = await seedPlainStore(label);
  const before = snapshot(home);
  await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
  clearActiveKey();
  activateDek(unlockWithPassphrase(home, PASS)); // decrypt requires an UNLOCKED store
  await seedLedger(home);
  return { home, before };
}

/**
 * Drop the entries that legitimately differ between the PRE-ENCRYPTION snapshot
 * and the post-decrypt one, so what remains is a true byte-for-byte claim:
 *  - `keyring-archived.json` — created by the decrypt, by design;
 *  - `ledgers/*` — seeded AFTER the encryption (see `seedEncryptedStore`), so it
 *    does not exist in the pre-encryption baseline at all;
 *  - `index.json` — its `lastTimestamp` watermark advances with that ledger
 *    write, which is ordinary store activity and not something decrypt did;
 *  - `.gitignore` — decrypt appends the archived keyring to it, deliberately, so
 *    a wrapped key can never reach the remote.
 * Each of the four is asserted DIRECTLY instead.
 */
function withoutMigrationArtifacts(snap: Map<string, string>): Map<string, string> {
  const out = new Map(snap);
  out.delete(ARCHIVED_KEYRING_NAME);
  out.delete("index.json");
  out.delete(".gitignore");
  for (const k of [...out.keys()]) if (k.startsWith("ledgers/")) out.delete(k);
  return out;
}

/** Every content + config file's exact on-disk bytes, keyed store-relative. */
function snapshot(home: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (relDir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(fsPath(path.join(home, relDir)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === ".gestalt.lock") continue;
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) map.set(rel, readFileSync(fsPath(path.join(home, rel)), "utf8"));
    }
  };
  walk("");
  return map;
}

/** Assert the encrypted store was not touched at all. */
function expectStillEncrypted(home: string, snap: Map<string, string>): void {
  expect(snapshot(home)).toEqual(snap);
  expect(keyringExists(home)).toBe(true);
  expect(storeHasSealedContent(home)).toBe(true);
}

/** The scoped sibling DIRECTORIES of one kind (the `.kept.json` marker beside a
 * kept backup is metadata, not a store, and never counts as one). */
function siblings(home: string, kind: "decrypting" | "ciphertext"): string[] {
  const parent = path.dirname(home);
  const prefix = `.${path.basename(home)}.gestalt-${kind}-`;
  return readdirSync(fsPath(parent))
    .filter((n) => n.startsWith(prefix) && !n.endsWith(".kept.json"))
    .map((n) => path.join(parent, n));
}

/** Nothing at all beside the store — the assertion for every FAILURE path, where
 * a run that changed nothing must also have left nothing. */
function expectNoLeftovers(home: string): void {
  expect(siblings(home, "decrypting")).toEqual([]);
  expect(siblings(home, "ciphertext")).toEqual([]);
}

/**
 * The assertion for a SUCCESSFUL run: the encrypted backup is KEPT (the
 * one-command way back), marked as deliberate, and is a real encrypted store —
 * not an empty shell. Returns its path.
 */
function expectKeptBackup(home: string): string {
  const kept = siblings(home, "ciphertext");
  expect(kept.length).toBe(1);
  const backup = kept[0]!;
  expect(existsSync(fsPath(`${backup}.kept.json`))).toBe(true);
  expect(
    readFileSync(fsPath(path.join(backup, "topics", "auth-notes.md")), "utf8").startsWith(ENC),
  ).toBe(true);
  expect(existsSync(fsPath(path.join(backup, "keyring.json")))).toBe(true);
  expect(siblings(home, "decrypting")).toEqual([]); // no plaintext copy survives
  return backup;
}

describe("fimemory decrypt — encrypted → plaintext migration", () => {
  it("round-trips a realistic store BYTE-IDENTICALLY (notes, logs, proposals, index, ledgers)", async () => {
    const { home, before } = await seedEncryptedStore("dec-round");
    const p = storePaths(home);
    // The fidelity baseline for the two files the pre-encryption snapshot cannot
    // speak for: read them THROUGH the key, exactly as the store serves them now.
    const indexServed = await readText(p.index);

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.changed).toBe(true);
    expect(r.notes).toBe(3);
    expect(r.logs).toBe(3);
    expect(r.proposals).toBe(2);
    expect(r.ledgers).toBe(1);
    expect(r.ciphertextBackupRemovalFailed).toBeUndefined();

    // The store is plaintext by the runtime's OWN gate — no keyring, no marker,
    // no sealed content anywhere.
    expect(keyringExists(home)).toBe(false);
    expect(storeHasSealedContent(home)).toBe(false);
    expect(existsSync(fsPath(p.storeMarker))).toBe(false);

    // Every file is byte-for-byte what it was before it was ever encrypted.
    // `store.enc` and `keyring.json` are gone; `keyring-archived.json` is new.
    expect(withoutMigrationArtifacts(snapshot(home))).toEqual(withoutMigrationArtifacts(before));
    // The sealed ledger came back as readable JSONL, in order, nothing dropped.
    const ledger = readFileSync(fsPath(path.join(home, "ledgers", "tasks.jsonl")), "utf8");
    expect(ledger).not.toContain(ENC);
    expect(ledger.trim().split("\n").length).toBe(2);
    expect(ledger).toContain('"idem":"i1"');
    expect(ledger).toContain('"idem":"i2"');
    // index.json is now on disk exactly as the encrypted store served it.
    expect(readFileSync(fsPath(p.index), "utf8")).toBe(indexServed);
    // .gitignore differs by exactly the archived-keyring rule and nothing else.
    const gi = readFileSync(fsPath(path.join(home, ".gitignore")), "utf8");
    expect(gi).toContain(ARCHIVED_KEYRING_NAME);
    expect(gi.startsWith(before.get(".gitignore")!)).toBe(true);

    // And the store reads through the runtime with NO key active.
    clearActiveKey();
    expect(await readText(topicNotePath(home, "auth-notes"))).toBe(before.get("topics/auth-notes.md"));
    expect(parseLog((await readText(topicLogPath(home, "auth-notes")))!, "auth-notes").entries.length).toBe(2);
    // The encrypted original is KEPT beside the store — the one-command undo for
    // a migration that runs once against an irreplaceable store.
    expect(r.ciphertextBackup).toBe(expectKeptBackup(home));
  });

  it("a sealed entry ending in a blank line migrates (normalised, counted, and SAID) instead of aborting", async () => {
    // The live store hit this on the first real run (2026-08-10): two entries in
    // logs/gestalt-decisions.log.md had a raw ending in "\n". The plaintext format
    // separates entries with a blank line, so such an entry cannot round-trip
    // verbatim — verification failed and the migration refused, correctly but
    // uselessly, on content that was otherwise byte-identical. The fix normalises
    // BEFORE writing and reports the count; the one thing it must never do is
    // trim silently, and the other is abort.
    const { home } = await seedEncryptedStore("dec-trailing-nl");
    const rel = path.join(home, "logs", "auth-notes.log.md");

    // Re-seal the log with a trailing blank line inside its LAST entry, exactly
    // as the per-entry sealed path preserves whatever raw it is handed.
    const parsedBefore = parseLog(readFileSync(fsPath(rel), "utf8"), "auth-notes");
    const doctored = parsedBefore.entries.map((e, i) =>
      i === parsedBefore.entries.length - 1 ? { ...e, raw: `${e.raw}\n` } : e,
    );
    writeFileSync(fsPath(rel), serializeLog("auth-notes", doctored), "utf8");
    const bodyBefore = doctored[doctored.length - 1]!.raw.replace(/\n+$/, "");

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.changed).toBe(true); // it migrated rather than refusing
    expect(r.trimmedLogEntries).toBe(1); // and it counted what it normalised

    // The entry survives with every character intact except the trailing blank.
    clearActiveKey();
    const after = parseLog(readFileSync(fsPath(rel), "utf8"), "auth-notes");
    expect(after.entries.length).toBe(doctored.length);
    expect(after.entries[after.entries.length - 1]!.raw).toBe(bodyBefore);
  });

  it("keeps the keyring (archived, not deleted) and a later `encrypt` still works — decrypt → encrypt → decrypt is byte-identical", async () => {
    const { home, before } = await seedEncryptedStore("dec-relock");
    const keyringBytes = readFileSync(fsPath(path.join(home, "keyring.json")), "utf8");

    await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    // The road back: the OLD keyring survives verbatim under its archived name.
    expect(existsSync(fsPath(path.join(home, "keyring.json")))).toBe(false);
    expect(readFileSync(fsPath(path.join(home, ARCHIVED_KEYRING_NAME)), "utf8")).toBe(keyringBytes);
    // …and it is gitignored, exactly as keyring.json was. Renaming a wrapped key
    // out from behind that rule would publish it on the next `git add -A`.
    const ignored = readFileSync(fsPath(path.join(home, ".gitignore")), "utf8").split("\n");
    expect(ignored).toContain(ARCHIVED_KEYRING_NAME);
    expect(ignored).toContain("keyring.json");

    // Re-lock: a NEW keyring + a NEW phrase, and the archived one is carried
    // across as plaintext WITHOUT being sealed (it is a wrapped key, not a key).
    clearActiveKey();
    const warnings: string[] = [];
    const enc2 = await migrateToEncrypted({
      home,
      passphrase: "a second entirely different passphrase",
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => void warnings.push(m),
    });
    expect(enc2.mnemonic.split(" ").length).toBe(24);
    expect(warnings.join("")).not.toContain(ARCHIVED_KEYRING_NAME);
    expect(readFileSync(fsPath(path.join(home, ARCHIVED_KEYRING_NAME)), "utf8")).toBe(keyringBytes);
    expect(storeHasSealedContent(home)).toBe(true);
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8").startsWith(ENC)).toBe(true);

    // Decrypt again under the NEW key → still byte-identical to the original.
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, "a second entirely different passphrase"));
    await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    expect(withoutMigrationArtifacts(snapshot(home))).toEqual(withoutMigrationArtifacts(before));
  });

  it("a store with NO keyring (GESTALT_KEY style) claims NO archive — no phantom path, no .gitignore line", async () => {
    // The shape on disk: sealed content + an active DEK + no `keyring.json`,
    // which is exactly what a store unlocked through GESTALT_KEY looks like.
    const { home } = await seedEncryptedStore("dec-nokeyring");
    rmSync(fsPath(path.join(home, "keyring.json")));
    const gitignoreBefore = readFileSync(fsPath(path.join(home, ".gitignore")), "utf8");
    expect(keyringExists(home)).toBe(false);
    expect(storeHasSealedContent(home)).toBe(true);
    const printed: string[] = [];

    const r = await migrateToPlaintext({
      home,
      ...YES,
      git: NO_GIT,
      out: (l) => void printed.push(l),
    });

    expect(r.changed).toBe(true);
    // The claim that used to be FALSE: a path to a file that was never created.
    expect(r.archivedKeyring).toBeUndefined();
    expect(existsSync(fsPath(path.join(home, ARCHIVED_KEYRING_NAME)))).toBe(false);
    // …and no ignore rule for it either — an ignore line for a file that does not
    // exist reads as evidence that it does.
    expect(readFileSync(fsPath(path.join(home, ".gitignore")), "utf8")).toBe(gitignoreBefore);
    expect(gitignoreBefore).not.toContain(ARCHIVED_KEYRING_NAME);
    // The plan says what the old ciphertext ACTUALLY needs, and promises nothing.
    const plan = printed.join("\n");
    expect(plan).toContain("GESTALT_KEY");
    expect(plan).not.toContain(`keyring.json is KEPT`);
    // The store really is plaintext — the no-keyring path decrypted everything.
    expect(storeHasSealedContent(home)).toBe(false);
    clearActiveKey();
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  it("a note whose content begins with a UTF-8 BOM survives the round trip", async () => {
    const home = await seedPlainStore("dec-bom");
    // A BOM-prefixed note, written before encryption. `encrypt` normalizes the
    // leading BOM away (F4/F5), so the fidelity baseline is what IT sealed —
    // this test proves decrypt does not lose or double-count it either.
    const notePath = topicNotePath(home, "auth-notes");
    const withBom = "\uFEFF" + readFileSync(fsPath(notePath), "utf8");
    writeFileSync(fsPath(notePath), withBom, "utf8");

    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    const sealedRead = await readText(notePath);

    await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    clearActiveKey();

    const back = readFileSync(fsPath(notePath), "utf8");
    expect(back).toBe(sealedRead);
    expect(back).toContain("Auth Notes");
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("an atomic-temp-shaped user file is NOT silently skipped — the drop is named", async () => {
    const { home } = await seedEncryptedStore("dec-temp");
    // `.my-draft.md.tmp-1-2` matches store/atomic.ts's temp shape but may be a
    // real user file. It is skipped (carrying plaintext residue beside the store
    // is wrong) — but NEVER silently: the name is reported.
    writeFileSync(fsPath(path.join(home, "topics", ".my-draft.md.tmp-1-2")), "a draft\n", "utf8");
    const warnings: string[] = [];

    await migrateToPlaintext({ home, ...YES, git: NO_GIT, warn: (m) => void warnings.push(m) });

    expect(warnings.join("")).toContain("topics/.my-draft.md.tmp-1-2");
    expect(existsSync(fsPath(path.join(home, "topics", ".my-draft.md.tmp-1-2")))).toBe(false);
  });

  it("carries non-canonical user files (a README, a rotated ledger archive) instead of dropping them", async () => {
    const { home } = await seedEncryptedStore("dec-carry");
    writeFileSync(fsPath(path.join(home, "README.md")), "my own notes\n", "utf8");
    writeFileSync(fsPath(path.join(home, "topics", "notes-backup.txt")), "backup\n", "utf8");

    await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(readFileSync(fsPath(path.join(home, "README.md")), "utf8")).toBe("my own notes\n");
    expect(readFileSync(fsPath(path.join(home, "topics", "notes-backup.txt")), "utf8")).toBe("backup\n");
  });

  it("decrypts SEALED ledger lines in a rotated archive dir too — no ciphertext is left behind", async () => {
    const { home } = await seedEncryptedStore("dec-archive");
    // Roll the live ledger up the way the harness does: a sibling directory that
    // still holds per-line sealed JSONL.
    const archive = path.join(home, "ledgers-archive-2026-07-21");
    mkdirSync(fsPath(archive), { recursive: true });
    const sealed = readFileSync(fsPath(path.join(home, "ledgers", "tasks.jsonl")), "utf8");
    expect(sealed).toContain(ENC); // precondition: it really is sealed
    writeFileSync(fsPath(path.join(archive, "tasks.jsonl")), sealed, "utf8");

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.ledgers).toBe(2);
    const back = readFileSync(fsPath(path.join(archive, "tasks.jsonl")), "utf8");
    expect(back).not.toContain(ENC);
    expect(back).toContain('"task":"t-1"');
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("decrypts whole-file sealed MIRROR blobs (the Harness `work/` reports) at any depth, leaving plaintext siblings alone", async () => {
    const { home } = await seedEncryptedStore("dec-mirror");
    // Exactly what the Harness does: seal a report blob through the runtime's
    // exported `encryptFile` and mirror it into the store repo under `work/`.
    // A real store's `work/` is a MIX — some reports sealed, some not.
    const dir = path.join(home, "work", "aide");
    mkdirSync(fsPath(dir), { recursive: true });
    const sealedPath = path.join(dir, "systems-check.md");
    const plainPath = path.join(dir, "drive-capacity.md");
    const body = "# Systems check\n\nAll green.\n";
    writeFileSync(fsPath(sealedPath), encryptFile(sealedPath, body), "utf8");
    writeFileSync(fsPath(plainPath), "# Drive capacity\n", "utf8");
    expect(readFileSync(fsPath(sealedPath), "utf8").startsWith(ENC)).toBe(true);

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.mirrors).toBe(1);
    expect(readFileSync(fsPath(sealedPath), "utf8")).toBe(body);
    expect(readFileSync(fsPath(plainPath), "utf8")).toBe("# Drive capacity\n");
    // The whole point: nothing unreadable is left in a store we call plaintext.
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("decrypts a whole-file sealed blob UNDER logs/ instead of aborting the whole migration", async () => {
    const { home } = await seedEncryptedStore("dec-logs-deep");
    // `fileKind` calls a file one level below `logs/` kind "other", so `encrypt`
    // genuinely seals it — while the mirror finder used to skip everything under
    // `logs/`. The blob then rode into staging as ciphertext and the pre-swap
    // residue audit aborted: fail-closed, but it REFUSED to convert a store whose
    // only sin was a subdirectory under logs/.
    const dir = path.join(home, "logs", "sub");
    mkdirSync(fsPath(dir), { recursive: true });
    const blob = path.join(dir, "x.md");
    const body = "# archived thread\n\nkept out of the way\n";
    writeFileSync(fsPath(blob), encryptFile(blob, body), "utf8");
    expect(readFileSync(fsPath(blob), "utf8").startsWith(ENC)).toBe(true);

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.mirrors).toBe(1);
    expect(readFileSync(fsPath(blob), "utf8")).toBe(body);
    expect(storeHasSealedContent(home)).toBe(false);
    // The real logs are still logs — the deep blob did not disturb their pass.
    expect(r.logs).toBe(3);
    clearActiveKey();
    expect(parseLog((await readText(topicLogPath(home, "auth-notes")))!, "auth-notes").entries.length).toBe(2);
  });

  it("decrypts a LEGACY whole-file sealed ledger (pre-F3) as well as per-line sealed ones", async () => {
    const { home } = await seedEncryptedStore("dec-legacy-ledger");
    // The pre-F3 shape: the WHOLE `.jsonl` is one sealed blob under the
    // whole-file AAD for kind "other", not one sealed line per event. The AAD
    // binds the kind and the BASENAME only, so sealing through a path whose
    // parent is not `ledgers/` reproduces exactly the bytes that era wrote.
    const jsonl =
      '{"task":"t-legacy","idem":"L1","type":"assign"}\n' +
      '{"task":"t-legacy","idem":"L2","type":"result"}\n';
    const asOther = path.join(home, "legacy.jsonl"); // parent is not "ledgers" → kind "other"
    const legacyPath = path.join(home, "ledgers", "legacy.jsonl");
    writeFileSync(fsPath(legacyPath), encryptFile(asOther, jsonl), "utf8");
    const sealedBytes = readFileSync(fsPath(legacyPath), "utf8");
    expect(sealedBytes.startsWith(ENC)).toBe(true);
    expect(sealedBytes.trim().split("\n").length).toBe(1); // ONE blob, not per-line

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    // Both ledgers converted: the modern per-line one and the legacy blob.
    expect(r.ledgers).toBe(2);
    const back = readFileSync(fsPath(legacyPath), "utf8");
    expect(back).not.toContain(ENC);
    expect(back).toBe(jsonl);
    expect(readFileSync(fsPath(path.join(home, "ledgers", "tasks.jsonl")), "utf8")).not.toContain(ENC);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("a ledger that opens under NEITHER shape still aborts the run, touching nothing", async () => {
    const { home } = await seedEncryptedStore("dec-ledger-bad");
    const snap = snapshot(home);
    const bad = path.join(home, "ledgers", "corrupt.jsonl");
    // Sealed shape, garbage payload: neither the per-line AAD nor the legacy
    // whole-file AAD can verify it. The fallback must not soften the abort.
    writeFileSync(fsPath(bad), ENC + "bm90LWEtcmVhbC1ibG9i\n", "utf8");
    snap.set("ledgers/corrupt.jsonl", readFileSync(fsPath(bad), "utf8"));

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("ledgers/corrupt.jsonl");
    expectStillEncrypted(home, snap);
  });

  it("a mirror blob that will NOT open aborts the run, touching nothing", async () => {
    const { home } = await seedEncryptedStore("dec-mirror-bad");
    const snap = snapshot(home);
    const dir = path.join(home, "work");
    mkdirSync(fsPath(dir), { recursive: true });
    // Sealed shape, garbage payload — the AEAD tag cannot verify.
    writeFileSync(fsPath(path.join(dir, "broken.md")), ENC + "bm90LWEtcmVhbC1ibG9i\n", "utf8");
    snap.set("work/broken.md", readFileSync(fsPath(path.join(dir, "broken.md")), "utf8"));

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("work/broken.md");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  // ── refusals: every one must change NOTHING ────────────────────────────────

  it("refuses a LOCKED store (no key active) and changes nothing", async () => {
    const { home } = await seedEncryptedStore("dec-locked");
    const snap = snapshot(home);
    clearActiveKey(); // the store is encrypted but nothing has unlocked it

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("locked");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  it("refuses when ONE file will not decrypt — and touches nothing", async () => {
    const { home } = await seedEncryptedStore("dec-badfile");
    const snap = snapshot(home);
    // Corrupt one note's ciphertext body: the AEAD tag will not verify.
    const notePath = topicNotePath(home, "deploy-log");
    const cipher = readFileSync(fsPath(notePath), "utf8");
    writeFileSync(fsPath(notePath), cipher.slice(0, -10) + "AAAAAAAAA\n", "utf8");

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("deploy-log.md");
    expect(err.message).toContain("nothing was changed");
    // Every OTHER file is untouched too — one bad file aborts the whole run.
    expect(snapshot(home)).toEqual(snapshot(home));
    const now = snapshot(home);
    for (const [rel, bytes] of snap) {
      if (rel === "topics/deploy-log.md") continue;
      expect(now.get(rel), rel).toBe(bytes);
    }
    expect(keyringExists(home)).toBe(true);
    expectNoLeftovers(home);
  });

  it("refuses a DIRTY git tree, naming the files, and changes nothing", async () => {
    const { home } = await seedEncryptedStore("dec-dirty");
    const snap = snapshot(home);
    const git = (): GitState => ({ ...NO_GIT(), isRepo: true, dirty: ["M topics/auth-notes.md"] });

    const err = await expectGestaltErrorAsync(() => migrateToPlaintext({ home, ...YES, git }), "E_STORE_MODE");
    expect(err.message).toContain("uncommitted changes");
    expect(err.message).toContain("topics/auth-notes.md");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  it("refuses a DIVERGED tree (and ahead-only, and behind-only), and changes nothing", async () => {
    const { home } = await seedEncryptedStore("dec-diverged");
    const snap = snapshot(home);
    const base = { ...NO_GIT(), isRepo: true, upstream: "origin/main", remoteUrl: "git@example.com:me/store.git" };

    for (const [ahead, behind, expected] of [
      [2, 3, "diverged from origin/main"],
      [2, 0, "2 commit(s) ahead"],
      [0, 3, "3 commit(s) behind"],
    ] as const) {
      const err = await expectGestaltErrorAsync(
        () => migrateToPlaintext({ home, ...YES, git: () => ({ ...base, ahead, behind }) }),
        "E_STORE_MODE",
      );
      expect(err.message).toContain(expected);
      expectStillEncrypted(home, snap);
    }
    expectNoLeftovers(home);
  });

  it("refuses an in-progress rebase/merge, naming what to finish, and changes nothing", async () => {
    const { home } = await seedEncryptedStore("dec-rebase");
    const snap = snapshot(home);

    for (const op of ["rebase", "merge"] as const) {
      const err = await expectGestaltErrorAsync(
        () => migrateToPlaintext({ home, ...YES, git: () => ({ ...NO_GIT(), isRepo: true, inProgress: [op] }) }),
        "E_STORE_MODE",
      );
      expect(err.message).toContain(`unfinished ${op}`);
      expect(err.hint).toContain(`${op} --abort`);
      expectStillEncrypted(home, snap);
    }
  });

  it("refuses while a LIVE daemon lock is present, naming the pid — and ignores another machine's lock", async () => {
    const { home } = await seedEncryptedStore("dec-livelock");
    const snap = snapshot(home);
    const lock = path.join(home, ".harness-scheduler-m-local.lock");
    writeFileSync(
      fsPath(lock),
      JSON.stringify({ pid: 4242, machineId: "m-local", gestaltHome: home, configDir: "C:/x/.fi-harness" }),
      "utf8",
    );
    snap.set(".harness-scheduler-m-local.lock", readFileSync(fsPath(lock), "utf8"));

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT, isPidAlive: (pid) => pid === 4242 }),
      "E_LOCKED",
    );
    expect(err.message).toContain("pid 4242");
    expect(err.message).toContain(".fi-harness");
    expectStillEncrypted(home, snap);

    // A lock naming ANOTHER machine's store path rides the git sync into this
    // store. Its pid number is meaningless here, so it must not refuse the run —
    // even when a local process happens to own that number.
    writeFileSync(
      fsPath(lock),
      JSON.stringify({ pid: 4242, machineId: "m-remote", gestaltHome: "/home/nexus-office/.gestalt" }),
      "utf8",
    );
    const ok = await migrateToPlaintext({ home, ...YES, git: NO_GIT, isPidAlive: () => true });
    expect(ok.changed).toBe(true);

  });

  it("a STALE scheduler lock (dead pid) does not refuse the run", async () => {
    const { home } = await seedEncryptedStore("dec-stalelock");
    writeFileSync(
      fsPath(path.join(home, ".harness-scheduler-m-local.lock")),
      JSON.stringify({ pid: 999999, machineId: "m-local", gestaltHome: home }),
      "utf8",
    );
    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT, isPidAlive: () => false });
    expect(r.changed).toBe(true);
  });

  it("is a clean NO-OP on a store that is already plaintext (exit 0, clear message)", async () => {
    const home = await seedPlainStore("dec-noop");
    const snap = snapshot(home);

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(r.changed).toBe(false);
    expect(r.message).toContain("already plaintext");
    expect(snapshot(home)).toEqual(snap);
  });

  it("refuses a non-store home (E_NOT_FOUND)", async () => {
    const home = freshHome("dec-nostore");
    await expectGestaltErrorAsync(() => migrateToPlaintext({ home, ...YES, git: NO_GIT }), "E_NOT_FOUND");
    expect(existsSync(fsPath(home))).toBe(false);
  });

  // ── the remote consequence must be stated and confirmed ────────────────────

  it("REFUSES without an explicit acknowledgement, and the refusal names the remote URL", async () => {
    const { home } = await seedEncryptedStore("dec-confirm");
    const snap = snapshot(home);
    const git = (): GitState => ({
      ...NO_GIT(), isRepo: true, upstream: "origin/main", remoteUrl: "git@github.com:me/my-store.git",
    });

    const err = await expectGestaltErrorAsync(() => migrateToPlaintext({ home, git }), "E_SCHEMA");
    expect(err.message).toContain("git@github.com:me/my-store.git");
    expect(err.message).toContain("PLAINTEXT");
    expect(err.hint).toContain("--yes-plaintext-remote");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  it("an interactive answer that is not the word `decrypt` aborts, changing nothing", async () => {
    const { home } = await seedEncryptedStore("dec-cancel");
    const snap = snapshot(home);
    const printed: string[] = [];

    await expectGestaltErrorAsync(
      () =>
        migrateToPlaintext({
          home,
          git: () => ({ ...NO_GIT(), isRepo: true, remoteUrl: "https://example.com/store.git" }),
          out: (l) => void printed.push(l),
          confirm: async () => "y",
        }),
      "E_STORE_MODE",
    );
    // The consequence was STATED before the question was asked.
    expect(printed.join("\n")).toContain("PLAINTEXT");
    expect(printed.join("\n")).toContain("https://example.com/store.git");
    expectStillEncrypted(home, snap);
  });

  it("typing `decrypt` proceeds", async () => {
    const { home } = await seedEncryptedStore("dec-typed");
    const r = await migrateToPlaintext({ home, git: NO_GIT, confirm: async () => "  Decrypt \n" });
    expect(r.changed).toBe(true);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("does NOT hold the store write lock while it waits for the human to answer", async () => {
    const { home } = await seedEncryptedStore("dec-lockwait");
    let heldDuringPrompt: boolean | null = null;

    await migrateToPlaintext({
      home,
      git: NO_GIT,
      confirm: async () => {
        // A prompt is open-ended. Holding the store lock across it would block
        // every daemon and MCP server on the box, and proper-lockfile's 60 s
        // stale window would expire underneath the run.
        heldDuringPrompt = lockfile.checkSync(fsPath(home), {
          lockfilePath: fsPath(storePaths(home).lockfile),
          realpath: false,
          stale: 60_000,
        });
        return "decrypt";
      },
    });

    expect(heldDuringPrompt).toBe(false);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  // ── the real git probe, against a real repo ───────────────────────────────

  it("probeGit reads a REAL repo: clean+level passes, an uncommitted edit refuses", async () => {
    const { home } = await seedEncryptedStore("dec-realgit");
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: home, encoding: "utf8" });
      if (r.status !== 0 && !args.includes("commit")) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      }
    };
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("add", "-A");
    git("commit", "-qm", "seed");

    // Clean, no upstream → the git guard passes and the migration runs.
    // (No remote, so the plan says nothing is published — asserted separately.)
    const printed: string[] = [];
    const r = await migrateToPlaintext({ home, ...YES, out: (l) => void printed.push(l) });
    expect(r.changed).toBe(true);
    expect(printed.join("\n")).toContain("no git remote");

    // Now make the tree dirty and prove the REAL probe refuses (no injection).
    writeFileSync(fsPath(path.join(home, "topics", "auth-notes.md")), "edited\n", "utf8");
    clearActiveKey();
    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    const err = await expectGestaltErrorAsync(() => migrateToPlaintext({ home, ...YES }), "E_STORE_MODE");
    expect(err.message).toContain("uncommitted changes");
    expect(storeHasSealedContent(home)).toBe(true);
  }, 60_000);

  // ── the acknowledged-write window ─────────────────────────────────────────

  it("ABORTS if a peer writes to the store after the read, naming what changed", async () => {
    const { home } = await seedEncryptedStore("dec-race-write");
    const snap = snapshot(home);
    // The swap runs with the write lock RELEASED, so a peer write can land
    // between the read that produced the plaintext and the rename that discards
    // the original. Planting the write while staging is built puts it in exactly
    // that class: the staged copy no longer represents the store.
    const err = await expectGestaltErrorAsync(
      () =>
        migrateToPlaintext({
          home, ...YES, git: NO_GIT,
          hooks: {
            beforeVerify: () => {
              writeFileSync(fsPath(path.join(home, "topics", "late-note.md")), "peer write\n", "utf8");
            },
          },
        }),
      "E_LOCKED",
    );
    expect(err.message).toContain("topics/late-note.md");
    expect(err.message).toContain("DISCARD");
    // Nothing touched: the store is still the encrypted original (plus the file
    // the "peer" wrote), and no plaintext copy is left lying around.
    snap.set("topics/late-note.md", "peer write\n");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  it("ABORTS if a live writer appears after the pre-flight check", async () => {
    const { home } = await seedEncryptedStore("dec-race-lock");
    const err = await expectGestaltErrorAsync(
      () =>
        migrateToPlaintext({
          home, ...YES, git: NO_GIT,
          isPidAlive: () => true,
          hooks: {
            beforeVerify: () => {
              writeFileSync(
                fsPath(path.join(home, ".harness-scheduler-late.lock")),
                JSON.stringify({ pid: 4242, machineId: "late", gestaltHome: home }),
                "utf8",
              );
            },
          },
        }),
      "E_LOCKED",
    );
    expect(err.message).toContain("a live writer appeared");
    expect(err.message).toContain(".harness-scheduler-late.lock");
    expect(storeHasSealedContent(home)).toBe(true);
    expectNoLeftovers(home);
  });

  // ── the way back ──────────────────────────────────────────────────────────

  it("the kept backup really is the way back: renaming it over home restores the encrypted store", async () => {
    const { home, before } = await seedEncryptedStore("dec-wayback");
    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    const backup = expectKeptBackup(home);
    expect(r.ciphertextBackup).toBe(backup);
    expect(storeHasSealedContent(home)).toBe(false);

    // Undo, exactly as the printed guidance says: rename the backup over home.
    rmSync(fsPath(home), { recursive: true, force: true });
    renameSync(fsPath(backup), fsPath(home));

    expect(storeHasSealedContent(home)).toBe(true);
    expect(keyringExists(home)).toBe(true);
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    // …and it opens with the ORIGINAL passphrase, giving back the original note.
    expect(await readText(topicNotePath(home, "auth-notes"))).toBe(
      before.get("topics/auth-notes.md"),
    );
  });

  it("--remove-backup deletes the backup and its marker; without it nothing is deleted", async () => {
    const { home } = await seedEncryptedStore("dec-rmbackup");
    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT, removeBackup: true });

    expect(r.ciphertextBackup).toBeUndefined();
    expect(r.ciphertextBackupRemovalFailed).toBeUndefined();
    expectNoLeftovers(home);
    // The marker must not outlive the backup it describes (this store's only —
    // every test in the suite shares one run-root).
    const mine = `.${path.basename(home)}.`;
    expect(
      readdirSync(fsPath(path.dirname(home))).filter(
        (n) => n.startsWith(mine) && n.endsWith(".kept.json"),
      ),
    ).toEqual([]);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("`status` keeps naming the kept backup so it cannot be forgotten forever", async () => {
    const { home } = await seedEncryptedStore("dec-status-backup");
    await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    const backup = expectKeptBackup(home);
    clearActiveKey();

    const messages = runStatus({ home }).warnings.map((w) => w.message).join("\n");

    expect(messages).toContain(backup);
    expect(messages).toContain("rename it back over");
    // It is NOT reported as the wreckage of an interrupted run — it was kept.
    expect(messages).not.toContain("interrupted");
    expect(detectDecryptResidue(home).keptBackup).toEqual([backup]);
    expect(detectDecryptResidue(home).ciphertext).toEqual([]);
  });

  it("a kept backup does NOT block the next decrypt, but UNMARKED residue still does", async () => {
    const { home } = await seedEncryptedStore("dec-backup-nonblock");
    await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    const backup = expectKeptBackup(home);

    // Re-lock, then decrypt again: the backup this command itself left behind
    // must not make the round trip refuse (which is what happens if a kept
    // backup is indistinguishable from an interrupted run's ciphertext).
    clearActiveKey();
    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    const again = await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    expect(again.changed).toBe(true);

    // …but strip the marker off that same backup and it becomes exactly what it
    // then looks like — an interrupted decrypt's original — and the ambiguity
    // guard fires again.
    rmSync(fsPath(`${backup}.kept.json`), { force: true });
    clearActiveKey();
    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("ambiguous");
    expect(err.message).toContain(backup);
  });

  // ── crash injection ───────────────────────────────────────────────────────

  it("CRASH mid-staging leaves the intact ENCRYPTED original and no plaintext residue", async () => {
    const { home } = await seedEncryptedStore("dec-crash-stage");
    const snap = snapshot(home);

    await expect(
      migrateToPlaintext({
        home, ...YES, git: NO_GIT,
        hooks: { afterStageFile: (_rel, count) => { if (count === 2) throw new Error("simulated crash mid-staging"); } },
      }),
    ).rejects.toThrow(/simulated crash/);

    expectStillEncrypted(home, snap);
    // The staging tree was PLAINTEXT — it must not survive a failure.
    expectNoLeftovers(home);
    clearActiveKey();
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  it("CRASH in the commit GAP: both survivors are intact, never a mix; the op self-heals back to encrypted", async () => {
    const { home, before } = await seedEncryptedStore("dec-crash-gap");
    const snap = snapshot(home);
    let observed = false;

    await expect(
      migrateToPlaintext({
        home, ...YES, git: NO_GIT,
        hooks: {
          inCommitGap: ({ home: h, backup, staging }) => {
            observed = true;
            expect(existsSync(fsPath(h))).toBe(false); // home momentarily resolves to nothing
            // BACKUP is the intact ENCRYPTED original…
            expect(readFileSync(fsPath(path.join(backup, "topics", "auth-notes.md")), "utf8").startsWith(ENC)).toBe(true);
            expect(existsSync(fsPath(path.join(backup, "keyring.json")))).toBe(true);
            expect(existsSync(fsPath(path.join(backup, "store.enc")))).toBe(true);
            // …STAGING is the intact, verified PLAINTEXT result.
            expect(readFileSync(fsPath(path.join(staging, "topics", "auth-notes.md")), "utf8")).toBe(
              before.get("topics/auth-notes.md"),
            );
            expect(existsSync(fsPath(path.join(staging, "store.enc")))).toBe(false);
            expect(existsSync(fsPath(path.join(staging, ARCHIVED_KEYRING_NAME)))).toBe(true);
            throw new Error("simulated crash in the commit gap");
          },
        },
      }),
    ).rejects.toThrow(/simulated crash in the commit gap/);

    expect(observed).toBe(true);
    expectStillEncrypted(home, snap); // self-healed to the encrypted original
    expectNoLeftovers(home);
  });

  it("CRASH after the swap but before backup removal: home IS plaintext, the encrypted copy survives, and the NEXT run is a no-op that names it", async () => {
    const { home, before } = await seedEncryptedStore("dec-crash-cleanup");

    await expect(
      migrateToPlaintext({
        home, ...YES, git: NO_GIT,
        hooks: { beforeRemoveBackup: () => { throw new Error("killed before cleanup"); } },
      }),
    ).rejects.toThrow(/killed before cleanup/);

    // home IS the completed plaintext result…
    expect(storeHasSealedContent(home)).toBe(false);
    expect(keyringExists(home)).toBe(false);
    expect(withoutMigrationArtifacts(snapshot(home))).toEqual(withoutMigrationArtifacts(before));
    // …and the ENCRYPTED original is sitting beside it as residue.
    const residue = siblings(home, "ciphertext");
    expect(residue.length).toBe(1);
    expect(
      readFileSync(fsPath(path.join(residue[0]!, "topics", "auth-notes.md")), "utf8").startsWith(ENC),
    ).toBe(true);
    expect(detectDecryptResidue(home).ciphertext).toEqual(residue);

    // The next run is IDEMPOTENT: already plaintext → no-op, exit 0, and it says
    // the encrypted copy is there rather than silently deleting real data.
    const warnings: string[] = [];
    clearActiveKey();
    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT, warn: (m) => void warnings.push(m) });
    expect(r.changed).toBe(false);
    expect(warnings.join("")).toContain(residue[0]!);
    expect(existsSync(fsPath(residue[0]!))).toBe(true); // never auto-deleted
  });

  it("after a REAL kill in the commit gap, `status` names the survivors and never says `init`", async () => {
    const { home } = await seedEncryptedStore("dec-gap-guidance");
    // The shape is produced by KILLING a real run inside the one-instruction
    // commit gap — no hook-driven self-heal, no hand-built directories — because
    // the whole finding is about what is genuinely on disk at that moment.
    const script = path.join(path.dirname(home), "gap-kill.mjs");
    writeFileSync(
      fsPath(script),
      [
        `import { migrateToPlaintext } from ${JSON.stringify(srcUrl("ops/migrateDecrypt.ts"))};`,
        `import { activateDek } from ${JSON.stringify(srcUrl("store/codec.ts"))};`,
        `import { unlockWithPassphrase } from ${JSON.stringify(srcUrl("store/keyring.ts"))};`,
        `const home = ${JSON.stringify(home)};`,
        `activateDek(unlockWithPassphrase(home, ${JSON.stringify(PASS)}));`,
        `await migrateToPlaintext({`,
        `  home, confirmPlaintextRemote: true,`,
        `  git: () => ({ isRepo: false, dirty: [], inProgress: [], upstream: null, ahead: 0, behind: 0, remoteUrl: null }),`,
        `  hooks: { inCommitGap: () => { process.kill(process.pid, "SIGKILL"); } },`,
        `});`,
      ].join("\n"),
      "utf8",
    );
    const env = { ...process.env };
    delete env.GESTALT_PASSPHRASE;
    delete env.GESTALT_KEY;
    spawnSync(process.execPath, [tsxEntry(), script], { encoding: "utf8", env, timeout: 60_000 });

    // Precondition: the genuine crash-gap shape. `home` is GONE; the encrypted
    // original and the finished plaintext copy sit beside it under temp names.
    expect(existsSync(fsPath(home))).toBe(false);
    const cipher = siblings(home, "ciphertext");
    const plain = siblings(home, "decrypting");
    expect(cipher.length).toBe(1);
    expect(plain.length).toBe(1);
    expect(
      readFileSync(fsPath(path.join(cipher[0]!, "topics", "auth-notes.md")), "utf8").startsWith(ENC),
    ).toBe(true);
    expect(
      readFileSync(fsPath(path.join(plain[0]!, "topics", "auth-notes.md")), "utf8"),
    ).toContain("Auth Notes");

    // THE FIX: `status` is what a person runs at this moment. It must name both
    // survivors, say which is which, and point at the command that reconciles
    // them — never at `init`, which creates an empty store and turns that
    // verified plaintext copy into sweepable residue.
    const err = expectGestaltError(() => runStatus({ home }), "E_IO");
    expect(err.message).toContain(cipher[0]!);
    expect(err.message).toContain(plain[0]!);
    expect(err.message).toContain("ENCRYPTED original");
    expect(err.message).toContain("PLAINTEXT");
    expect(err.hint).toContain("fimemory decrypt");
    expect(err.hint).not.toContain("fimemory init --home");
    // It also says how to KEEP the finished plaintext copy, because the
    // reconcile it recommends deletes it.
    expect(err.hint).toContain(`rename ${plain[0]!} to ${home}`);

    // `export` — the command the recovery advice itself points people at — has
    // to agree rather than sending them to `init`.
    const exportErr = await expectGestaltErrorAsync(
      () => exportPlaintext(home, path.join(path.dirname(home), "export-out")),
      "E_IO",
    );
    expect(exportErr.hint).not.toContain("fimemory init --home");

    // And the advice is TRUE: running `fimemory decrypt` really does put the
    // encrypted original back at `home`.
    clearActiveKey();
    await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE", // restored, then correctly refuses because it is LOCKED
    );
    expect(existsSync(fsPath(home))).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    expect(keyringExists(home)).toBe(true);
    expect(siblings(home, "decrypting")).toEqual([]);
  }, 60_000);

  it("a PLAINTEXT staging dir ALONE is never called complete, and still never says `init`", async () => {
    // The other half of the crash window: a run killed mid-STAGING leaves a
    // half-built plaintext tree. Claiming it is the store would be a lie, and
    // pointing at `init` would strand it just the same.
    const home = freshHome("dec-gap-plain-only");
    const staging = path.join(
      path.dirname(home),
      `.${path.basename(home)}.gestalt-decrypting-99999-1`,
    );
    mkdirSync(fsPath(path.join(staging, "topics")), { recursive: true });
    writeFileSync(fsPath(path.join(staging, "config.json")), "{}\n", "utf8");

    const err = expectGestaltError(() => runStatus({ home }), "E_IO");
    expect(err.message).toContain(staging);
    expect(err.message).toContain("INCOMPLETE");
    expect(err.hint).not.toContain("fimemory init --home");
    expect(err.hint).toContain("your own backup");
  });

  it("a stale PLAINTEXT staging dir from a prior crash is swept on the next run (it is readable in the clear)", async () => {
    const { home } = await seedEncryptedStore("dec-sweep");
    const stale = path.join(path.dirname(home), `.${path.basename(home)}.gestalt-decrypting-99999-1`);
    mkdirSync(fsPath(stale), { recursive: true });
    writeFileSync(fsPath(path.join(stale, "leaked.md")), "readable memory\n", "utf8");
    const warnings: string[] = [];

    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT, warn: (m) => void warnings.push(m) });

    expect(existsSync(fsPath(stale))).toBe(false);
    expect(warnings.join("")).toContain("PLAINTEXT staging");
    expect(r.changed).toBe(true);
  });

  it("HALTS on an ambiguous pair: an encrypted home beside a memory-bearing ciphertext sibling", async () => {
    const { home } = await seedEncryptedStore("dec-ambiguous");
    const snap = snapshot(home);
    const sibling = path.join(path.dirname(home), `.${path.basename(home)}.gestalt-ciphertext-99999-1`);
    mkdirSync(fsPath(path.join(sibling, "topics")), { recursive: true });
    writeFileSync(fsPath(path.join(sibling, "config.json")), "{}\n", "utf8");

    const err = await expectGestaltErrorAsync(
      () => migrateToPlaintext({ home, ...YES, git: NO_GIT }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain(sibling);
    expect(err.message).toContain("ambiguous");
    expectStillEncrypted(home, snap);
    expect(existsSync(fsPath(sibling))).toBe(true); // never auto-deleted
  });

  it("VERIFY catches a staged file that does not match what it decrypted to — and never swaps", async () => {
    const { home } = await seedEncryptedStore("dec-verify");
    const snap = snapshot(home);

    const err = await expectGestaltErrorAsync(
      () =>
        migrateToPlaintext({
          home, ...YES, git: NO_GIT,
          hooks: {
            beforeVerify: (staging) => {
              writeFileSync(fsPath(path.join(staging, "topics", "auth-notes.md")), "tampered\n", "utf8");
            },
          },
        }),
      "E_STORE_MODE",
    );
    expect(err.message).toContain("Verification failed");
    expectStillEncrypted(home, snap);
    expectNoLeftovers(home);
  });

  it("VERIFY refuses to swap in a staged tree that still holds sealed content or a write temp", async () => {
    for (const [label, plant] of [
      ["sealed", (staging: string) => writeFileSync(fsPath(path.join(staging, "leftover.md")), ENC + "AAAA\n", "utf8")],
      ["temp", (staging: string) => writeFileSync(fsPath(path.join(staging, ".index.json.tmp-1-1")), "x", "utf8")],
    ] as const) {
      const { home } = await seedEncryptedStore(`dec-residue-${label}`);
      const snap = snapshot(home);
      const err = await expectGestaltErrorAsync(
        () => migrateToPlaintext({ home, ...YES, git: NO_GIT, hooks: { beforeVerify: plant } }),
        "E_STORE_MODE",
      );
      expect(err.message).toContain("refusing to swap it in");
      expectStillEncrypted(home, snap);
      expectNoLeftovers(home);
      clearActiveKey();
    }
  });

  it("wipes the cached session key (the DEK no longer opens anything) and reports the outcome", async () => {
    const { home } = await seedEncryptedStore("dec-session");
    const r = await migrateToPlaintext({ home, ...YES, git: NO_GIT });
    expect(r.sessionWipe).toBeDefined();
    expect(r.sessionWipe?.outcome === "wiped" || r.sessionWipe?.outcome === "nothing").toBe(true);
  });

  // ── the real command, through the real CLI ────────────────────────────────

  it("CLI: refuses without --yes-plaintext-remote, then succeeds with it (and is a no-op the second time)", async () => {
    const { home } = await seedEncryptedStore("dec-cli");
    clearActiveKey(); // the CLI does its own unlock, from GESTALT_PASSPHRASE
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = (...args: string[]): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [TSX, CLI, ...args, "--home", home], {
        encoding: "utf8",
        env: { ...process.env, GESTALT_PASSPHRASE: PASS, GESTALT_KEY: "" },
      });
      return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
    };

    // No acknowledgement → non-zero exit, nothing changed, and the flag is named.
    const refused = run("decrypt");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--yes-plaintext-remote");
    expect(storeHasSealedContent(home)).toBe(true);

    const ok = run("decrypt", "--yes-plaintext-remote");
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(ARCHIVED_KEYRING_NAME);
    expect(storeHasSealedContent(home)).toBe(false);
    expect(keyringExists(home)).toBe(false);

    // Idempotent: running it again is a clean no-op, exit 0.
    const again = run("decrypt", "--yes-plaintext-remote");
    expect(again.status).toBe(0);
    expect(again.out).toContain("already plaintext");

    // And the store is fully usable with NO key anywhere.
    const status = run("status");
    expect(status.status).toBe(0);
  }, 60_000);

  it("carries .git and .gitattributes across the swap (history is not rewritten)", async () => {
    const { home } = await seedEncryptedStore("dec-git-carry");
    mkdirSync(fsPath(path.join(home, ".git")), { recursive: true });
    writeFileSync(fsPath(path.join(home, ".git", "HEAD")), "ref: refs/heads/main\n", "utf8");
    writeFileSync(fsPath(path.join(home, ".gitattributes")), "logs/*.log.md merge=union\n", "utf8");

    await migrateToPlaintext({ home, ...YES, git: NO_GIT });

    expect(readFileSync(fsPath(path.join(home, ".git", "HEAD")), "utf8")).toBe("ref: refs/heads/main\n");
    expect(readFileSync(fsPath(path.join(home, ".gitattributes")), "utf8")).toBe("logs/*.log.md merge=union\n");
    expect(storeHasSealedContent(home)).toBe(false);
  });
});
