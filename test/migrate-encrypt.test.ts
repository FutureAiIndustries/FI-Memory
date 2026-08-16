import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { updateTopic } from "../src/ops/update.js";
import { migrateToEncrypted } from "../src/ops/migrateEncrypt.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import {
  deriveDekFromMnemonic,
  keyringExists,
  storeHasSealedContent,
  unlockWithMnemonic,
  unlockWithPassphrase,
} from "../src/store/keyring.js";
import { looksLikeEncryptedLog, parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { clockAt, expectGestaltErrorAsync, freshHome } from "./helpers.js";

// Tiny Argon2 params + weak-params allowance so the suite stays fast.
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a solid migration passphrase here";
const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");
const ENC = "gestalt-enc:1:";

afterEach(() => clearActiveKey());

/** A realistic PLAINTEXT store: the example (note + 5-entry log + pending
 * proposal) plus two more topics with their own log entries and a proposal. */
async function seedStore(label = "mig"): Promise<string> {
  const home = freshHome(label);
  runInit({ home });
  await createTopic(home, "auth-notes", "Auth Notes", { now: clockAt(1e12) });
  await appendLog(home, "auth-notes", { type: "decision", project: "fi", agent: "cli", summary: "chose sessions" }, { now: clockAt(1e12 + 1) });
  await appendLog(home, "auth-notes", { type: "gotcha", project: "fi", agent: "cli", summary: "cookie SameSite bit us" }, { now: clockAt(1e12 + 2) });
  await createTopic(home, "deploy-log", "Deploy Log", { now: clockAt(1e12 + 10) });
  await appendLog(home, "deploy-log", { type: "pattern", project: "ops", agent: "cli", summary: "blue/green" }, { now: clockAt(1e12 + 11) });
  await updateTopic(home, "auth-notes", "---\nid: auth-notes\ntitle: Auth Notes\naliases: []\ntags: []\nprojects: []\nupdated: null\ncompactedThrough: null\n---\n\nAuth Notes — sessions, not JWT.\n\n## Owner notes\n", { proposer: "cli" });
  return home;
}

/** Snapshot every content + config file's exact on-disk bytes (for "unchanged" proofs). */
function snapshot(home: string): Map<string, string> {
  const p = storePaths(home);
  const map = new Map<string, string>();
  const add = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(fsPath(dir));
    } catch {
      return;
    }
    for (const n of names.filter((x) => x.endsWith(".md"))) {
      map.set(`${rel}/${n}`, readFileSync(fsPath(path.join(dir, n)), "utf8"));
    }
  };
  add(p.topicsDir, "topics");
  add(p.logsDir, "logs");
  add(p.proposalsDir, "proposals");
  map.set("index.json", readFileSync(fsPath(p.index), "utf8"));
  map.set("config.json", readFileSync(fsPath(p.config), "utf8"));
  return map;
}

function expectUnchanged(home: string, snap: Map<string, string>): void {
  const now = snapshot(home);
  expect(now).toEqual(snap);
  // A plaintext store has NO keyring and NO marker.
  expect(keyringExists(home)).toBe(false);
  expect(existsSync(fsPath(storePaths(home).storeMarker))).toBe(false);
  expect(storeHasSealedContent(home)).toBe(false);
}

/** No leftover staging dir beside the store after an aborted run. */
function expectNoStagingLeftover(home: string): void {
  const parent = path.dirname(home);
  const prefix = `.${path.basename(home)}.gestalt-encrypting-`;
  const leftovers = readdirSync(fsPath(parent)).filter((n) => n.startsWith(prefix));
  expect(leftovers).toEqual([]);
}

describe("fimemory encrypt — plaintext → encrypted migration", () => {
  it("every on-disk content file becomes ciphertext, and reads back byte-identical with the new key", async () => {
    const home = await seedStore();
    const p = storePaths(home);
    // Capture the plaintext content BEFORE migrating (the fidelity baseline).
    const notesBefore = new Map<string, string>();
    for (const id of ["gestalt-example", "auth-notes", "deploy-log"]) {
      notesBefore.set(id, readFileSync(fsPath(topicNotePath(home, id)), "utf8"));
    }
    const logEntriesBefore = new Map<string, string[]>();
    for (const id of ["gestalt-example", "auth-notes", "deploy-log"]) {
      logEntriesBefore.set(id, parseLog(readFileSync(fsPath(topicLogPath(home, id)), "utf8"), id).entries.map((e) => e.raw));
    }
    const indexBefore = readFileSync(fsPath(p.index), "utf8");
    const configBefore = readFileSync(fsPath(p.config), "utf8");

    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });

    expect(r.mnemonic.split(" ").length).toBe(24);
    expect(r.notes).toBe(3);
    expect(r.logs).toBe(3);
    expect(r.proposals).toBe(2); // the example's + auth-notes'
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // On disk: keyring + marker present; notes/proposals/index sealed; config plaintext.
    expect(keyringExists(home)).toBe(true);
    expect(readFileSync(fsPath(p.storeMarker), "utf8").startsWith(ENC)).toBe(true);
    for (const id of ["gestalt-example", "auth-notes", "deploy-log"]) {
      expect(readFileSync(fsPath(topicNotePath(home, id)), "utf8").startsWith(ENC), `topics/${id}.md`).toBe(true);
      expect(looksLikeEncryptedLog(readFileSync(fsPath(topicLogPath(home, id)), "utf8")), `logs/${id}.log.md`).toBe(true);
    }
    for (const f of readdirSync(fsPath(p.proposalsDir))) {
      expect(readFileSync(fsPath(path.join(p.proposalsDir, f)), "utf8").startsWith(ENC), f).toBe(true);
    }
    expect(readFileSync(fsPath(p.index), "utf8").startsWith(ENC)).toBe(true);
    expect(readFileSync(fsPath(p.config), "utf8")).toBe(configBefore); // config untouched, plaintext
    expect(storeHasSealedContent(home)).toBe(true);

    // Read back through the runtime with the new key → byte-identical.
    activateDek(unlockWithPassphrase(home, PASS));
    for (const id of ["gestalt-example", "auth-notes", "deploy-log"]) {
      expect(await readText(topicNotePath(home, id))).toBe(notesBefore.get(id));
      const back = parseLog((await readText(topicLogPath(home, id)))!, id).entries.map((e) => e.raw);
      expect(back).toEqual(logEntriesBefore.get(id));
    }
    expect(await readText(p.index)).toBe(indexBefore);
  });

  it("the recovery phrase round-trips — the 24 words alone open the migrated store", async () => {
    const home = await seedStore("mig-recover");
    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });

    const dekPass = unlockWithPassphrase(home, PASS);
    // Same DEK from the phrase, and it binds to the migrated ciphertext (H1).
    expect(hex(deriveDekFromMnemonic(r.mnemonic))).toBe(hex(dekPass));
    expect(hex(unlockWithMnemonic(home, r.mnemonic))).toBe(hex(dekPass));
  });

  it("re-running on an already-encrypted store is a clean refusal — never double-encryption", async () => {
    const home = await seedStore("mig-twice");
    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    const sealedNote = readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8");

    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: "another good passphrase here", argon2: TINY, allowWeakParams: true }),
      "E_STORE_MODE",
    );
    // Not double-sealed: the note is byte-identical to its single-sealed form, and
    // still opens with the ORIGINAL passphrase.
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8")).toBe(sealedNote);
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  it("an absent or weak passphrase changes NOTHING", async () => {
    const home = await seedStore("mig-nopass");
    const snap = snapshot(home);

    // Explicit empty env: `encrypt` deliberately falls back to
    // GESTALT_PASSPHRASE, and on a real operator's machine that variable is set
    // USER-WIDE — so "absent passphrase" is only absent if the test says so.
    // Without this the case silently tested the opposite of its name, and passed
    // or failed depending on which test happened to run first in the worker
    // (caught 2026-08-10 on the box that actually has it set).
    const NO_ENV = {} as NodeJS.ProcessEnv;
    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, argon2: TINY, allowWeakParams: true, env: NO_ENV }),
      "E_SCHEMA",
    );
    expectUnchanged(home, snap);
    expectNoStagingLeftover(home);

    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: "short", argon2: TINY, allowWeakParams: true, env: NO_ENV }),
      "E_SCHEMA",
    );
    expectUnchanged(home, snap);
    expectNoStagingLeftover(home);
  });

  it("GESTALT_KEY set is refused (it would shadow the keyring), changing nothing", async () => {
    const home = await seedStore("mig-envkey");
    const snap = snapshot(home);
    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true, env: { GESTALT_KEY: "ab".repeat(32) } as NodeJS.ProcessEnv }),
      "E_SCHEMA",
    );
    expectUnchanged(home, snap);
  });

  it("CRASH mid-staging (killed after N files, before the swap) leaves the intact plaintext original", async () => {
    const home = await seedStore("mig-crash-stage");
    const snap = snapshot(home);

    // Throw after the 2nd staged file — home is never touched during staging.
    await expect(
      migrateToEncrypted({
        home,
        passphrase: PASS,
        argon2: TINY,
        allowWeakParams: true,
        hooks: { afterStageFile: (_rel, count) => { if (count === 2) throw new Error("simulated crash mid-staging"); } },
      }),
    ).rejects.toThrow(/simulated crash/);

    // Fully usable: the original. Byte-identical, no keyring/marker, no sealed
    // content, no leftover staging — and every note still parses/reads.
    expectUnchanged(home, snap);
    expectNoStagingLeftover(home);
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
    expect(parseLog((await readText(topicLogPath(home, "auth-notes")))!, "auth-notes").entries.length).toBe(2);
  });

  it("CRASH in the commit GAP (after home→backup, before staging→home): both survivors are intact, never a mix; the op self-heals", async () => {
    const home = await seedStore("mig-crash-gap");
    const snap = snapshot(home);
    let observed = false;

    await expect(
      migrateToEncrypted({
        home,
        passphrase: PASS,
        argon2: TINY,
        allowWeakParams: true,
        hooks: {
          inCommitGap: ({ home: h, backup, staging }) => {
            observed = true;
            // home momentarily resolves to nothing…
            expect(existsSync(fsPath(h))).toBe(false);
            // …but the BACKUP is the intact plaintext original…
            expect(readFileSync(fsPath(path.join(backup, "topics", "auth-notes.md")), "utf8")).toBe(
              snap.get("topics/auth-notes.md"),
            );
            expect(existsSync(fsPath(path.join(backup, "keyring.json")))).toBe(false);
            // …and the STAGING is the intact, verified ENCRYPTED result.
            expect(readFileSync(fsPath(path.join(staging, "topics", "auth-notes.md")), "utf8").startsWith(ENC)).toBe(true);
            expect(existsSync(fsPath(path.join(staging, "keyring.json")))).toBe(true);
            expect(existsSync(fsPath(path.join(staging, "store.enc")))).toBe(true);
            throw new Error("simulated crash in the commit gap");
          },
        },
      }),
    ).rejects.toThrow(/simulated crash in the commit gap/);

    expect(observed).toBe(true);
    // Self-healed: home is the intact plaintext original again (never a mix).
    expectUnchanged(home, snap);
    expectNoStagingLeftover(home);
  });

  it("preserves a git-synced store's .git and .gitattributes across the swap (history stays plaintext)", async () => {
    const home = await seedStore("mig-git");
    // Fake a git repo: a .git dir with a sentinel + the merge=union attribute.
    mkdirSync(fsPath(path.join(home, ".git")), { recursive: true });
    writeFileSync(fsPath(path.join(home, ".git", "HEAD")), "ref: refs/heads/main\n", "utf8");
    writeFileSync(fsPath(path.join(home, ".gitattributes")), "logs/*.log.md merge=union\n", "utf8");

    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });

    // .git and .gitattributes carried across verbatim; store is now encrypted.
    expect(readFileSync(fsPath(path.join(home, ".git", "HEAD")), "utf8")).toBe("ref: refs/heads/main\n");
    expect(readFileSync(fsPath(path.join(home, ".gitattributes")), "utf8")).toBe("logs/*.log.md merge=union\n");
    expect(keyringExists(home)).toBe(true);
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8").startsWith(ENC)).toBe(true);
  });

  it("a sweep removes a stale staging dir from a prior crash, then migrates cleanly", async () => {
    const home = await seedStore("mig-sweep");
    const stale = path.join(path.dirname(home), `.${path.basename(home)}.gestalt-encrypting-99999-1`);
    mkdirSync(fsPath(stale), { recursive: true });
    writeFileSync(fsPath(path.join(stale, "junk")), "leftover", "utf8");

    await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });

    expect(existsSync(fsPath(stale))).toBe(false); // swept
    expect(keyringExists(home)).toBe(true);
  });

  it("refuses a non-store home (E_NOT_FOUND), changing nothing", async () => {
    const home = freshHome("mig-nostore");
    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_NOT_FOUND",
    );
    expect(existsSync(fsPath(home))).toBe(false);
  });

  // ── REDESIGN / FIX B (regression 3): kill in the rmSync(backup) window leaves a
  // COMPLETE plaintext copy at `.<base>.gestalt-plaintext-*`. The tool can NEVER
  // prove that copy is redundant, so a subsequent `fimemory encrypt` must NOT delete
  // it — it must REFUSE with a recovery error naming BOTH paths, and the plaintext
  // copy (real data) must SURVIVE. (The prior heuristic auto-swept it, destroying
  // real memory whenever home was not actually the completed encrypted result.) ────
  it("kill in the plaintext-backup-removal window: the NEXT run REFUSES naming both paths and PRESERVES the plaintext copy (never auto-deletes it)", async () => {
    const home = await seedStore("mig-residue");
    const parent = path.dirname(home);
    const plainPrefix = `.${path.basename(home)}.gestalt-plaintext-`;

    // Simulate Ctrl-C/power-loss in the exact window AFTER staging→home committed
    // but BEFORE rmSync(backup): the throw propagates, leaving `home` encrypted and
    // the plaintext `backup` sibling on disk.
    await expect(
      migrateToEncrypted({
        home,
        passphrase: PASS,
        argon2: TINY,
        allowWeakParams: true,
        hooks: { beforeRemoveBackup: () => { throw new Error("killed before cleanup"); } },
      }),
    ).rejects.toThrow(/killed before cleanup/);

    // home IS the encrypted result now…
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    // …and a COMPLETE plaintext copy is sitting beside it as residue.
    const residue = readdirSync(fsPath(parent)).filter((n) => n.startsWith(plainPrefix));
    expect(residue.length).toBe(1);
    const residuePath = path.join(parent, residue[0]!);
    const residueNote = readFileSync(
      fsPath(path.join(residuePath, "topics", "auth-notes.md")),
      "utf8",
    );
    expect(residueNote.startsWith(ENC)).toBe(false); // plaintext in the clear
    expect(residueNote).toContain("Auth Notes");

    // A subsequent `fimemory encrypt`: home is a complete store AND a complete-store
    // plaintext sibling exists → REFUSE (recovery error naming BOTH paths), never
    // delete the sibling.
    const err = await expectGestaltErrorAsync(
      () =>
        migrateToEncrypted({
          home,
          passphrase: "another good passphrase here",
          argon2: TINY,
          allowWeakParams: true,
        }),
      "E_STORE_MODE",
    );
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain(home); // names home…
    expect(text).toContain(residuePath); // …and the plaintext sibling
    expect(text).not.toMatch(/removed a leftover PLAINTEXT copy/);

    // The plaintext copy — real data — SURVIVES byte-identical; nothing was deleted.
    expect(existsSync(fsPath(residuePath))).toBe(true);
    expect(
      readFileSync(fsPath(path.join(residuePath, "topics", "auth-notes.md")), "utf8"),
    ).toBe(residueNote);
  });

  // ── FINDING 3 (primary): a pre-existing orphaned atomic-write temp in `home`
  // (`.index.json.tmp-*`) must NOT be copied into the encrypted store. Reachable
  // with NO crash of the migration itself. ───────────────────────────────────────
  it("a pre-existing orphaned atomic-write temp is NOT carried into the encrypted store (allowlist copy)", async () => {
    const home = await seedStore("mig-orphan-temp");
    // An earlier crashed index write left this plaintext temp (index catalog copy).
    const orphan = `.index.json.tmp-4242-7`;
    writeFileSync(fsPath(path.join(home, orphan)), "PLAINTEXT CATALOG: titles + summaries", "utf8");

    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // The orphan temp did NOT ride the swap: no plaintext temp survives in `home`.
    expect(existsSync(fsPath(path.join(home, orphan)))).toBe(false);
    expect(readdirSync(fsPath(home)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    // And the store IS encrypted (the happy path still completed).
    expect(keyringExists(home)).toBe(true);
    expect(readFileSync(fsPath(storePaths(home).index), "utf8").startsWith(ENC)).toBe(true);
  });

  // ── FINDING 3 (defense in depth): even if a temp somehow lands in staging,
  // verifyStaged must FAIL CLOSED before the swap, leaving `home` untouched. ───────
  it("a temp leaked into the staged store aborts the swap (verifyStaged defense in depth), changing nothing", async () => {
    const home = await seedStore("mig-leak-verify");
    const snap = snapshot(home);
    await expectGestaltErrorAsync(
      () =>
        migrateToEncrypted({
          home,
          passphrase: PASS,
          argon2: TINY,
          allowWeakParams: true,
          hooks: {
            beforeVerify: (staging) => {
              writeFileSync(fsPath(path.join(staging, ".index.json.tmp-1-1")), "leaked plaintext", "utf8");
            },
          },
        }),
      "E_STORE_MODE",
    );
    expectUnchanged(home, snap);
    expectNoStagingLeftover(home);
  });

  // ── FINDING 4: a true power loss in the one-instruction commit gap (home absent;
  // intact plaintext at `.gestalt-plaintext-*`, intact ciphertext at
  // `.gestalt-encrypting-*`) must self-heal from the plaintext backup, NOT throw the
  // misleading `fimemory init` E_NOT_FOUND. ────────────────────────────────────────
  it("a commit-gap power loss (home gone) self-heals from the plaintext backup instead of the misleading init hint", async () => {
    const home = await seedStore("mig-powerloss-gap");
    const snap = snapshot(home);
    const parent = path.dirname(home);
    const base = path.basename(home);
    const backup = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    const staging = path.join(parent, `.${base}.gestalt-encrypting-1234-5678`);

    // Reconstruct the on-disk state left by a power loss in the commit gap: `home`
    // renamed aside to the plaintext backup, the (interrupted) ciphertext result at
    // staging, and `home` itself absent.
    renameSync(fsPath(home), fsPath(backup));
    mkdirSync(fsPath(staging), { recursive: true });
    writeFileSync(fsPath(path.join(staging, "config.json")), "{}", "utf8");
    expect(existsSync(fsPath(home))).toBe(false);

    const captured: string[] = [];
    const r = await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });

    // Self-healed: the plaintext original was restored to `home`, the interrupted
    // ciphertext was dropped, and the migration then completed cleanly.
    expect(captured.join("")).toMatch(/restored the intact plaintext store/);
    expect(existsSync(fsPath(backup))).toBe(false);
    expect(existsSync(fsPath(staging))).toBe(false);
    expect(r.mnemonic.split(" ").length).toBe(24);
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    // Content preserved through the heal + migration: reads back to the original.
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toBe(snap.get("topics/auth-notes.md"));
  });

  // ── RESIDUAL 1 (data-loss regression): a legitimate user file kept at the store
  // root (a README, a notes backup) must SURVIVE the migration — never silently
  // dropped — while a crashed-write temp is still skipped, and the carried file is
  // surfaced LOUDLY as PLAINTEXT (it is not sealed). ──────────────────────────────
  it("a legitimate user file at the store root SURVIVES migration (not dropped) and is warned as PLAINTEXT; a .tmp-* is still skipped", async () => {
    const home = await seedStore("mig-userfile");
    // A user's own file kept beside the store — real data, must not vanish.
    writeFileSync(fsPath(path.join(home, "README.md")), "my personal notes backup\n", "utf8");
    // A crashed index-write's leftover — PLAINTEXT process residue, must be skipped.
    writeFileSync(fsPath(path.join(home, ".index.json.tmp-9-9")), "PLAINTEXT CATALOG", "utf8");

    const captured: string[] = [];
    const r = await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // The README rode the swap into the (now encrypted) home, byte-identical…
    expect(existsSync(fsPath(path.join(home, "README.md")))).toBe(true);
    const readme = readFileSync(fsPath(path.join(home, "README.md")), "utf8");
    expect(readme).toBe("my personal notes backup\n");
    expect(readme.startsWith(ENC)).toBe(false); // …carried in as PLAINTEXT (unsealed)
    // …and the carry was surfaced LOUDLY, naming the file.
    expect(captured.join("")).toMatch(/AS PLAINTEXT/);
    expect(captured.join("")).toContain("README.md");

    // The atomic-write temp was SKIPPED — not carried into home, not warned about.
    expect(existsSync(fsPath(path.join(home, ".index.json.tmp-9-9")))).toBe(false);
    expect(readdirSync(fsPath(home)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(captured.join("")).not.toContain(".index.json.tmp-9-9");

    // The store IS encrypted and every note still reads back with the new key.
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  // ── FINDING 1 (silent DATA-LOSS): a legitimate user file whose name merely
  // CONTAINS ".tmp-" as a substring (e.g. `quarterly.tmp-notes.md`) must NOT be
  // misclassified as atomic-write residue. The classifier is ANCHORED to the exact
  // `.<basename>.tmp-<pid>-<ctr>` format, so such a file SURVIVES + is warned as
  // plaintext, while a real `.index.json.tmp-9-9` orphan is still skipped. ─────────
  it("a user file that merely CONTAINS \".tmp-\" survives + is warned as PLAINTEXT, while a real atomic temp is still skipped", async () => {
    const home = await seedStore("mig-tmp-substring");
    // Real user files whose names happen to contain ".tmp-" — NOT process residue:
    // no leading dot / trailing `.tmp-<int>-<int>` shape. Must never be dropped.
    const userFiles: Record<string, string> = {
      "quarterly.tmp-notes.md": "Q3 planning notes — do not lose\n",
      "draft.tmp-2.md": "second draft\n",
      "export.tmp-old": "old export blob\n",
    };
    for (const [name, body] of Object.entries(userFiles)) {
      writeFileSync(fsPath(path.join(home, name)), body, "utf8");
    }
    // A genuine crashed-write atomic temp — PLAINTEXT process residue, must be skipped.
    writeFileSync(fsPath(path.join(home, ".index.json.tmp-9-9")), "PLAINTEXT CATALOG", "utf8");

    const captured: string[] = [];
    const r = await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // Every substring-".tmp-" user file SURVIVED byte-identical (carried as plaintext)
    // and was warned about by name — never silently dropped.
    for (const [name, body] of Object.entries(userFiles)) {
      const p = path.join(home, name);
      expect(existsSync(fsPath(p)), name).toBe(true);
      const on = readFileSync(fsPath(p), "utf8");
      expect(on, name).toBe(body);
      expect(on.startsWith(ENC), name).toBe(false); // carried in as PLAINTEXT
      expect(captured.join(""), name).toContain(name);
    }
    expect(captured.join("")).toMatch(/AS PLAINTEXT/);

    // The real atomic-write temp WAS skipped — not carried, not warned about.
    expect(existsSync(fsPath(path.join(home, ".index.json.tmp-9-9")))).toBe(false);
    expect(captured.join("")).not.toContain(".index.json.tmp-9-9");

    // The store IS encrypted and reads back cleanly.
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  // ── REDESIGN (regression 2): after an accidental `fimemory init` following a
  // commit-gap crash, `home` is a FRESH plaintext store while the user's ONLY real
  // memory sits under a `.gestalt-plaintext-*` sibling. `fimemory encrypt` must
  // REFUSE (never auto-sweep the sibling, never encrypt over the ambiguous pair),
  // and the sibling must SURVIVE across REPEATED encrypt attempts. ────────────────
  it("plaintext init over a stranded plaintext sibling: TWO `fimemory encrypt` runs both REFUSE and the sibling holding real data SURVIVES both", async () => {
    const home = await seedStore("mig-init-then-encrypt");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const plaintext = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);

    // Reconstruct the dangerous state: the real store is stranded under the plaintext
    // sibling (commit-gap crash), and the user then ran `fimemory init`, planting a
    // fresh EMPTY store at home.
    renameSync(fsPath(home), fsPath(plaintext));
    const realNote = readFileSync(
      fsPath(path.join(plaintext, "topics", "auth-notes.md")),
      "utf8",
    );
    expect(realNote).toContain("Auth Notes");
    runInit({ home }); // accidental fresh store at home

    const runEncrypt = (): Promise<unknown> =>
      expectGestaltErrorAsync(
        () =>
          migrateToEncrypted({
            home,
            passphrase: PASS,
            argon2: TINY,
            allowWeakParams: true,
          }),
        "E_STORE_MODE",
      );

    // Run it TWICE — both refuse (halt-and-ask), the sibling is never touched.
    for (let i = 0; i < 2; i++) {
      const err = (await runEncrypt()) as { message: string; hint?: string };
      const text = `${err.message} ${err.hint ?? ""}`;
      expect(text).toContain(home);
      expect(text).toContain(plaintext);
      // The plaintext sibling — the user's ONLY real data — SURVIVES byte-identical.
      expect(existsSync(fsPath(plaintext)), `run ${i + 1}`).toBe(true);
      expect(
        readFileSync(fsPath(path.join(plaintext, "topics", "auth-notes.md")), "utf8"),
        `run ${i + 1}`,
      ).toBe(realNote);
    }
    // home stayed plaintext (encrypt refused, never touched it).
    expect(keyringExists(home)).toBe(false);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  // ── REDESIGN (regression 1): commit-gap crash (home absent, plaintext + encrypting
  // siblings) followed by an accidental `fimemory init --encrypted` — home is now a
  // fresh ENCRYPTED store while the user's real memory is under the plaintext
  // sibling. `fimemory encrypt` must REFUSE (naming both paths) and the plaintext
  // sibling must SURVIVE. The old heuristic auto-swept it (home was "encrypted"),
  // destroying the real data. ─────────────────────────────────────────────────────
  it("init --encrypted after a commit-gap crash: `fimemory encrypt` REFUSES and the stranded plaintext sibling SURVIVES", async () => {
    const home = await seedStore("mig-encinit-then-encrypt");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const plaintext = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    const encrypting = path.join(parent, `.${base}.gestalt-encrypting-1234-5678`);

    // Commit-gap crash on-disk state: home renamed aside to the plaintext backup +
    // an interrupted ciphertext staging dir; home itself gone.
    renameSync(fsPath(home), fsPath(plaintext));
    const realNote = readFileSync(
      fsPath(path.join(plaintext, "topics", "auth-notes.md")),
      "utf8",
    );
    mkdirSync(fsPath(encrypting), { recursive: true });
    writeFileSync(fsPath(path.join(encrypting, "config.json")), "{}", "utf8");
    expect(existsSync(fsPath(home))).toBe(false);

    // User runs `fimemory init --encrypted` instead of recovering → fresh encrypted
    // store at home, real data still stranded under the plaintext sibling.
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(keyringExists(home)).toBe(true);

    const err = await expectGestaltErrorAsync(
      () =>
        migrateToEncrypted({
          home,
          passphrase: "another good passphrase here",
          argon2: TINY,
          allowWeakParams: true,
        }),
      "E_STORE_MODE",
    );
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain(home);
    expect(text).toContain(plaintext);

    // The stranded plaintext sibling — real data — SURVIVES byte-identical.
    expect(existsSync(fsPath(plaintext))).toBe(true);
    expect(
      readFileSync(fsPath(path.join(plaintext, "topics", "auth-notes.md")), "utf8"),
    ).toBe(realNote);
  });

  // ── REDESIGN (regression 7): on the HAPPY path (no sibling at entry) the genuine
  // within-run backup created + verified inside commitSwap is still deleted — no
  // plaintext copy is left behind. The redesign removed the residue auto-sweep, but
  // must NOT touch commitSwap's provably-redundant within-run cleanup. ─────────────
  it("a legit fresh migration still deletes its within-run plaintext backup (no plaintext left behind on the happy path)", async () => {
    const home = await seedStore("mig-happy-nobackup");
    const parent = path.dirname(home);
    const plainPrefix = `.${path.basename(home)}.gestalt-plaintext-`;

    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // Store is encrypted and NO plaintext backup sibling survives.
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    expect(readdirSync(fsPath(parent)).filter((n) => n.startsWith(plainPrefix))).toEqual([]);
  });

  // ── REDESIGN (this round, regression 1): a LOGS-ONLY `.gestalt-plaintext-*`
  // sibling holds REAL memory (migration re-encodes logs), so it must NEVER be
  // auto-swept — it is SURFACED loudly and left on disk, and because it has memory
  // the halt-and-ask guard REFUSES the run. The prior code classified a logs-only
  // dir as "incomplete residue" and DELETED it (then let the migration proceed). ──
  it("a LOGS-ONLY plaintext sibling SURVIVES reconcile (never swept) and is surfaced; the run REFUSES", async () => {
    const home = await seedStore("mig-logs-only-sibling");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const sibling = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    // A logs-only sibling: real memory (a log entry), but NO config.json / topics.
    mkdirSync(fsPath(path.join(sibling, "logs")), { recursive: true });
    const logBody = "# auth-notes log\n\n<!--entry--> real decision kept in the clear\n";
    writeFileSync(fsPath(path.join(sibling, "logs", "auth-notes.log.md")), logBody, "utf8");

    const captured: string[] = [];
    await expectGestaltErrorAsync(
      () =>
        migrateToEncrypted({
          home,
          passphrase: PASS,
          argon2: TINY,
          allowWeakParams: true,
          warn: (m) => captured.push(m),
        }),
      "E_STORE_MODE",
    );

    // Never swept — the logs-only sibling (real data) survives byte-identical…
    expect(existsSync(fsPath(sibling))).toBe(true);
    expect(readFileSync(fsPath(path.join(sibling, "logs", "auth-notes.log.md")), "utf8")).toBe(logBody);
    // …and it was surfaced LOUDLY (NOT removing it), naming the path.
    expect(captured.join("")).toContain(sibling);
    expect(captured.join("")).toMatch(/NOT removing it/);
    // home stayed plaintext (refused, never encrypted over the ambiguous pair).
    expect(keyringExists(home)).toBe(false);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  // ── REDESIGN (this round, regression 2): a PROPOSALS-ONLY sibling likewise holds
  // real memory (migration re-encodes proposals) → never swept, surfaced, refused. ─
  it("a PROPOSALS-ONLY plaintext sibling SURVIVES reconcile (never swept)", async () => {
    const home = await seedStore("mig-proposals-only-sibling");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const sibling = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    mkdirSync(fsPath(path.join(sibling, "proposals")), { recursive: true });
    const propBody = "---\nseq: 1\nid: auth-notes\nstatus: pending\n---\n\n## Old\n\n## New\n";
    writeFileSync(fsPath(path.join(sibling, "proposals", "1-auth-notes.md")), propBody, "utf8");

    await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_STORE_MODE",
    );

    // The proposals-only sibling (real data) survives byte-identical, never swept.
    expect(existsSync(fsPath(sibling))).toBe(true);
    expect(readFileSync(fsPath(path.join(sibling, "proposals", "1-auth-notes.md")), "utf8")).toBe(propBody);
    expect(keyringExists(home)).toBe(false);
  });

  // ── REDESIGN (this round, regression 3): home present (complete store) + a
  // logs-only stranded sibling → the halt-and-ask guard uses the broadened
  // memory predicate, so it REFUSES naming BOTH paths (a logs-only sibling now
  // blocks a destructive encrypt just like a complete-store one). ─────────────────
  it("home present + a logs-only stranded sibling: `fimemory encrypt` REFUSES (halt-and-ask) naming BOTH paths", async () => {
    const home = await seedStore("mig-logs-only-halt");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const sibling = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    mkdirSync(fsPath(path.join(sibling, "logs")), { recursive: true });
    writeFileSync(fsPath(path.join(sibling, "logs", "auth-notes.log.md")), "# auth-notes log\n\n<!--entry--> data\n", "utf8");

    const err = await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_STORE_MODE",
    );
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain(home); // names home…
    expect(text).toContain(sibling); // …and the logs-only sibling
    // The sibling — real data — survives; nothing was deleted.
    expect(existsSync(fsPath(sibling))).toBe(true);
  });

  it("a commit-gap power loss with NO restorable plaintext backup reports the temp paths (never the misleading init hint)", async () => {
    const home = await seedStore("mig-powerloss-ambiguous");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const staging = path.join(parent, `.${base}.gestalt-encrypting-1-2`);

    // Only the (complete) ciphertext result survived under a temp name; `home` is
    // gone and there is NO plaintext backup to restore from.
    renameSync(fsPath(home), fsPath(staging));
    expect(existsSync(fsPath(home))).toBe(false);

    const err = await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_IO",
    );
    // Names the temp path so the user can recover by hand; NOT the init hint.
    expect(`${err.message} ${err.hint ?? ""}`).toContain(staging);
    expect(`${err.message} ${err.hint ?? ""}`).not.toMatch(/fimemory init/);
  });

  // ── H1 (silent DATA-LOSS INSIDE content dirs): the never-drop policy must apply
  // INSIDE topics/ logs/ proposals/, not only at the store ROOT. readWholeFiles/
  // readLogs regenerate ONLY canonical `<id>` files, so a non-canonical entry there
  // (topics/my-notes-backup.txt, topics/.secret-draft.md, logs/extra-notes.txt) would
  // be silently dropped when the plaintext backup is removed. It must be CARRIED
  // verbatim + warned as plaintext. ───────────────────────────────────────────────
  it("non-canonical files INSIDE content dirs SURVIVE migration (carried as PLAINTEXT + warned), never silently dropped", async () => {
    const home = await seedStore("mig-content-nonstd");
    const survivors: Record<string, string> = {
      "topics/my-notes-backup.txt": "topic backup — keep\n",
      "topics/.secret-draft.md": "hidden draft — keep\n",
      "logs/extra-notes.txt": "loose log note — keep\n",
    };
    for (const [rel, body] of Object.entries(survivors)) {
      writeFileSync(fsPath(path.join(home, ...rel.split("/"))), body, "utf8");
    }

    const captured: string[] = [];
    const r = await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // Each carried into the (now encrypted) home byte-identical, as PLAINTEXT, and warned.
    for (const [rel, body] of Object.entries(survivors)) {
      const p = path.join(home, ...rel.split("/"));
      expect(existsSync(fsPath(p)), rel).toBe(true);
      const on = readFileSync(fsPath(p), "utf8");
      expect(on, rel).toBe(body);
      expect(on.startsWith(ENC), rel).toBe(false); // carried in as PLAINTEXT (unsealed)
      expect(captured.join(""), rel).toContain(rel); // warned by name
    }
    expect(captured.join("")).toMatch(/AS PLAINTEXT/);

    // The canonical notes/logs are still SEALED and read back with the new key.
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
    activateDek(unlockWithPassphrase(home, PASS));
    expect(await readText(topicNotePath(home, "auth-notes"))).toContain("Auth Notes");
  });

  // ── H2 (partial home bypasses halt-and-ask): a PARTIAL home (topics/ but no
  // config.json) beside a memory-bearing plaintext sibling let encrypt seal the junk
  // tree while the real memory sat unsounded. It must REFUSE naming BOTH paths, and
  // the stranded sibling must SURVIVE. ────────────────────────────────────────────
  it("a PARTIAL home (topics/, no config.json) beside a memory-bearing plaintext sibling → encrypt REFUSES naming both; sibling preserved", async () => {
    const home = await seedStore("mig-partial-home");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const sibling = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);

    // Strand the real store under the plaintext sibling…
    renameSync(fsPath(home), fsPath(sibling));
    const realNote = readFileSync(fsPath(path.join(sibling, "topics", "auth-notes.md")), "utf8");
    // …and leave a PARTIAL home: topics/ present but NO config.json.
    mkdirSync(fsPath(path.join(home, "topics")), { recursive: true });
    writeFileSync(fsPath(path.join(home, "topics", "junk.md")), "partial-home junk\n", "utf8");
    expect(existsSync(fsPath(storePaths(home).config))).toBe(false);

    const err = await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_STORE_MODE",
    );
    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toContain(home); // names the partial home…
    expect(text).toContain(sibling); // …and the stranded sibling

    // The stranded sibling — real data — SURVIVES byte-identical; home stayed plaintext.
    expect(existsSync(fsPath(sibling))).toBe(true);
    expect(readFileSync(fsPath(path.join(sibling, "topics", "auth-notes.md")), "utf8")).toBe(realNote);
    expect(keyringExists(home)).toBe(false);
    expect(storeHasSealedContent(home)).toBe(false);
  });

  // ── L1 (exact-temp-shape user file drop is silent): a root file matching the exact
  // atomic-temp shape whose base is NOT a known store file (`.mydata.tmp-1-2`) is
  // still skipped, but the drop must be WARNED naming it — a real user-file collision
  // is then surfaced. A genuine store-file temp (`.index.json.tmp-*`) stays silent. ─
  it("a `.mydata.tmp-1-2` root file is skipped but WARNED by name (never silent); a `.index.json.tmp-*` stays silent", async () => {
    const home = await seedStore("mig-tmp-warn");
    writeFileSync(fsPath(path.join(home, ".mydata.tmp-1-2")), "user data that looks like a temp\n", "utf8");
    writeFileSync(fsPath(path.join(home, ".index.json.tmp-9-9")), "PLAINTEXT CATALOG", "utf8");

    const captured: string[] = [];
    await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });

    // Both skipped (not carried into the encrypted home)…
    expect(existsSync(fsPath(path.join(home, ".mydata.tmp-1-2")))).toBe(false);
    expect(existsSync(fsPath(path.join(home, ".index.json.tmp-9-9")))).toBe(false);
    // …but the unknown-base one is WARNED by name; the store-file temp stays silent.
    expect(captured.join("")).toContain(".mydata.tmp-1-2");
    expect(captured.join("")).not.toContain(".index.json.tmp-9-9");
    expect(keyringExists(home)).toBe(true);
  });

  // ── F3 (content-dir temp-skip silently DROPPED a possible user file): the root L1
  // policy WARNS when it skips an atomic-temp-shaped file whose base is not a known
  // store write-temp. INSIDE topics/ logs/ proposals/ a temp whose captured base ENDS
  // WITH the dir's canonical suffix (`.my-draft.md.tmp-1-2`, base `.my-draft.md`) was
  // treated as our own residue and dropped SILENTLY — but a `.md`-ending base cannot
  // be told apart from a real user collision. So EVERY content-dir atomic-temp skip
  // must now be WARNED by name (a warning on a genuine `.<id>.md.tmp-*` note write-temp
  // is acceptable noise); never a silent drop of a possible user file. ───────────────
  it("EVERY atomic-temp-shaped file under a content dir is skipped but WARNED by name (never silently dropped), incl. a `.md`-ending base", async () => {
    const home = await seedStore("mig-content-temp-warn");
    // A no-suffix-base temp (may be a user-collision file).
    writeFileSync(fsPath(path.join(home, "topics", ".foo.tmp-1-2")), "looks like a temp\n", "utf8");
    // A `.md`-ending base — INDISTINGUISHABLE from a genuine note write-temp, so it
    // must NOT be silently dropped (the F3 bug: it was). Must be WARNED by name.
    writeFileSync(fsPath(path.join(home, "topics", ".my-draft.md.tmp-1-2")), "hidden user draft — keep visible\n", "utf8");
    // A genuine note write-temp (base ends with the dir's `.md` suffix) — our own
    // residue, but now warned too (acceptable noise, better than a silent drop).
    writeFileSync(fsPath(path.join(home, "topics", ".auth-notes.md.tmp-9-9")), "PLAINTEXT NOTE", "utf8");

    const captured: string[] = [];
    const r = await migrateToEncrypted({
      home,
      passphrase: PASS,
      argon2: TINY,
      allowWeakParams: true,
      warn: (m) => captured.push(m),
    });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();

    // All skipped — none carried into the encrypted home…
    for (const n of [".foo.tmp-1-2", ".my-draft.md.tmp-1-2", ".auth-notes.md.tmp-9-9"]) {
      expect(existsSync(fsPath(path.join(home, "topics", n))), n).toBe(false);
    }
    // …and EVERY one was WARNED by name — no silent drop of a possible user file.
    expect(captured.join("")).toContain("topics/.foo.tmp-1-2");
    expect(captured.join("")).toContain("topics/.my-draft.md.tmp-1-2");
    expect(captured.join("")).toContain("topics/.auth-notes.md.tmp-9-9");

    // The store IS encrypted and canonical notes still read back with the new key.
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);
  });

  // ── F1 (encrypt entry guard footgunned logs/proposals-only homes to `fimemory init`):
  // a config-less LOGS-ONLY home, a config-less PROPOSALS-ONLY home, and a
  // config+logs-but-no-topics home all HAVE real memory (status/siblingHasMemory
  // recognize it via homeHasMemory). `fimemory encrypt` must NOT throw E_NOT_FOUND and
  // must NOT emit a `fimemory init` hint — it refuses with a non-init recovery message,
  // never writing a fresh store over the real memory. A truly-empty home still inits. ─
  it("F1: memory-present-but-no-topics homes do NOT get the `fimemory init` footgun (refuse, non-init); a truly empty home still inits", async () => {
    const mkHome = (label: string, build: (h: string) => void): string => {
      const h = freshHome(label);
      mkdirSync(fsPath(h), { recursive: true });
      build(h);
      return h;
    };
    // (a) config-less LOGS-ONLY home.
    const logsOnly = mkHome("mig-f1-logs-only", (h) => {
      mkdirSync(fsPath(path.join(h, "logs")), { recursive: true });
      writeFileSync(fsPath(path.join(h, "logs", "auth-notes.log.md")), "# auth-notes log\n\n<!--e--> data\n", "utf8");
    });
    // (b) config-less PROPOSALS-ONLY home.
    const propsOnly = mkHome("mig-f1-props-only", (h) => {
      mkdirSync(fsPath(path.join(h, "proposals")), { recursive: true });
      writeFileSync(fsPath(path.join(h, "proposals", "1-auth-notes.md")), "---\nseq: 1\n---\n\n## New\n", "utf8");
    });
    // (c) config.json + logs/ but NO topics/.
    const configLogs = mkHome("mig-f1-config-logs", (h) => {
      writeFileSync(fsPath(path.join(h, "config.json")), "{}", "utf8");
      mkdirSync(fsPath(path.join(h, "logs")), { recursive: true });
      writeFileSync(fsPath(path.join(h, "logs", "auth-notes.log.md")), "# auth-notes log\n\n<!--e--> data\n", "utf8");
    });

    for (const h of [logsOnly, propsOnly, configLogs]) {
      const err = await expectGestaltErrorAsync(
        () => migrateToEncrypted({ home: h, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
        "E_STORE_MODE",
      );
      const text = `${err.message} ${err.hint ?? ""}`;
      expect(text, h).not.toMatch(/fimemory init/); // NEVER the init footgun
      expect(text, h).toContain(h);
      // Nothing was created over the real memory: no keyring, no marker.
      expect(keyringExists(h), h).toBe(false);
      expect(storeHasSealedContent(h), h).toBe(false);
    }

    // A truly-empty home (no memory at all) still gets the normal not-found → init.
    const empty = freshHome("mig-f1-empty");
    mkdirSync(fsPath(empty), { recursive: true });
    const initErr = await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home: empty, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_NOT_FOUND",
    );
    expect(`${initErr.message} ${initErr.hint ?? ""}`).toMatch(/fimemory init/);
  });

  // ── F2 (empty-sibling overclaim): home absent + an EMPTY plaintext sibling (no
  // memory). `fimemory encrypt` must word this exactly like `fimemory status` — an
  // empty leftover with NO data, no "intact data survives", no rename advice. ────────
  it("F2: home-absent + an EMPTY plaintext sibling → encrypt says 'empty leftover' (no intact-data claim, no rename advice)", async () => {
    const home = await seedStore("mig-f2-empty-sib");
    const parent = path.dirname(home);
    const base = path.basename(home);
    const emptySib = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);

    // home gone; an EMPTY plaintext sibling (a dir with no memory) is all that remains.
    renameSync(fsPath(home), fsPath(path.join(parent, `.${base}.gestalt-encrypting-1234-5678`)));
    mkdirSync(fsPath(emptySib), { recursive: true });
    expect(existsSync(fsPath(home))).toBe(false);

    const err = await expectGestaltErrorAsync(
      () => migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true }),
      "E_IO",
    );
    const text = `${err.message} ${err.hint ?? ""}`;
    // Matches status: describes an empty leftover, claims NO intact/readable data,
    // and gives NO rename-the-plaintext-copy-back advice.
    expect(text).toMatch(/empty leftover temp dirs remain/);
    expect(text).toContain(emptySib);
    expect(text).not.toMatch(/intact data survives/);
    expect(text).not.toMatch(/readable in the clear/);
    expect(text).not.toMatch(/[Rr]ename the plaintext copy/);
  });

  // ── F4 (UTF-8 BOM notes bricked migration): a note whose bytes begin with a UTF-8
  // BOM (EF BB BF — PowerShell `Set-Content -Encoding utf8`, many Windows editors)
  // failed verifyStaged's byte-identical check (the codec's decrypt strips the BOM),
  // aborting the whole migration. The leading BOM must be normalized on staging so the
  // round-trip is consistent and the note migrates SUCCESSFULLY (BOM-less, matching
  // every codec-decoded read). ──────────────────────────────────────────────────────
  it("F4: a note with a leading UTF-8 BOM migrates SUCCESSFULLY and round-trips (BOM normalized away)", async () => {
    const home = await seedStore("mig-bom");
    // Overwrite a note on disk with a leading UTF-8 BOM.
    const BOM = String.fromCharCode(0xfeff); // U+FEFF → EF BB BF on utf8 write
    const bomNote =
      BOM +
      "---\nid: auth-notes\ntitle: Auth Notes\naliases: []\ntags: []\nprojects: []\nupdated: null\ncompactedThrough: null\n---\n\nBOM-prefixed body.\n";
    writeFileSync(fsPath(topicNotePath(home, "auth-notes")), bomNote, "utf8");
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8").charCodeAt(0)).toBe(0xfeff);

    // Without the fix this ABORTS (E_STORE_MODE verification failure); with it, success.
    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();
    expect(r.notes).toBe(3);
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);

    // Reads back BOM-less (consistent with every encrypted-mode codec read) — the
    // single leading BOM was the ONLY change; the rest of the note is byte-identical.
    activateDek(unlockWithPassphrase(home, PASS));
    const back = await readText(topicNotePath(home, "auth-notes"));
    expect(back).toBe(bomNote.slice(1));
    expect(back!.charCodeAt(0)).not.toBe(0xfeff);
  });

  // ── F5 (MULTIPLE leading BOMs): a whole file beginning with TWO+ UTF-8 BOMs
  // (tool composition / concatenation / Windows editor round-trips) still left a
  // leading BOM after a SINGLE strip — the codec drops only one on decrypt, so the
  // once-stripped staged copy was still short by a BOM and verifyStaged bricked the
  // WHOLE migration. Stripping ALL leading BOMs normalizes any count to zero so the
  // round-trip always matches. ──────────────────────────────────────────────────────
  it("F5: a note with TWO leading UTF-8 BOMs migrates SUCCESSFULLY and round-trips (all BOMs normalized away)", async () => {
    const home = await seedStore("mig-bom2");
    const BOM = String.fromCharCode(0xfeff);
    const body =
      "---\nid: auth-notes\ntitle: Auth Notes\naliases: []\ntags: []\nprojects: []\nupdated: null\ncompactedThrough: null\n---\n\nDouble-BOM body.\n";
    // TWO leading BOMs — one strip would leave one behind and brick verify.
    writeFileSync(fsPath(topicNotePath(home, "auth-notes")), BOM + BOM + body, "utf8");
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8").charCodeAt(0)).toBe(0xfeff);
    expect(readFileSync(fsPath(topicNotePath(home, "auth-notes")), "utf8").charCodeAt(1)).toBe(0xfeff);

    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();
    expect(r.notes).toBe(3);
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);

    // ALL leading BOMs gone; the body is otherwise byte-identical.
    activateDek(unlockWithPassphrase(home, PASS));
    const back = await readText(topicNotePath(home, "auth-notes"));
    expect(back).toBe(body);
    expect(back!.charCodeAt(0)).not.toBe(0xfeff);
  });

  // ── F5 (index.json not normalized): the BOM strip was applied to notes/proposals
  // but NOT to index.json, so a BOM-prefixed index.json still bricked verifyStaged
  // (short by a BOM on the codec round-trip) while the notes migrated fine. The
  // shared normalizer now runs at EVERY codec-verified whole-file staging site,
  // index.json included. ──────────────────────────────────────────────────────────
  it("F5: a BOM-prefixed index.json migrates and verifies (index normalized like notes)", async () => {
    const home = await seedStore("mig-bom-idx");
    const idxPath = storePaths(home).index;
    const BOM = String.fromCharCode(0xfeff);
    const idxBody = readFileSync(fsPath(idxPath), "utf8");
    // Prefix index.json with a UTF-8 BOM (a Windows editor round-trip could do this).
    writeFileSync(fsPath(idxPath), BOM + idxBody, "utf8");
    expect(readFileSync(fsPath(idxPath), "utf8").charCodeAt(0)).toBe(0xfeff);

    // Without index normalization this ABORTS (E_STORE_MODE verify failure).
    const r = await migrateToEncrypted({ home, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    expect(r.plaintextBackupRemovalFailed).toBeUndefined();
    expect(keyringExists(home)).toBe(true);
    expect(storeHasSealedContent(home)).toBe(true);

    // index.json sealed on disk, decrypts BOM-less to the original body.
    expect(readFileSync(fsPath(idxPath), "utf8").startsWith(ENC)).toBe(true);
    activateDek(unlockWithPassphrase(home, PASS));
    const back = await readText(idxPath);
    expect(back).toBe(idxBody);
    expect(back!.charCodeAt(0)).not.toBe(0xfeff);
  });
});
