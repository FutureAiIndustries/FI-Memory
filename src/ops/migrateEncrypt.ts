import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readEnv } from "../brand.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { HomeOpts } from "../paths.js";
import { atomicTempBase, isAtomicTemp } from "../store/tmpResidue.js";
import { fsPath, resolveHome, storePaths, topicLogPath } from "../paths.js";
import { activateDek, clearActiveKey, decryptFile, encryptFile } from "../store/codec.js";
import {
  initKeyring,
  keyringExists,
  STORE_MARKER_CONTENT,
  storeHasSealedContent,
} from "../store/keyring.js";
import type { Argon2Params } from "../store/keyring.js";
// One-way: `decrypt` deliberately imports NOTHING from this file (it keeps its
// own `homeHasStoreMaterial`), so this direction cannot form a cycle.
import { decryptResidueGuidance } from "./migrateDecrypt.js";
import { parseLog, serializeLog } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { withLock } from "../store/lock.js";

/**
 * `fimemory encrypt` — convert an EXISTING plaintext store to an encrypted one,
 * so a real user (with a store created before encryption existed) can ADOPT
 * encryption without re-creating the store. CLI-only and human-driven: it is
 * absent from the MCP surface by construction (no tool in `ALLOWED_MCP_TOOLS`
 * reaches it), the mirror of `init --encrypted` for a store that already holds
 * the user's memory. Threat model is the rest of the encryption work's — a
 * PASSIVE stolen artifact (a stolen disk/backup), not a live local process.
 *
 * It does exactly what `init --encrypted` does, one store later:
 *  1. build a keyring (passphrase → Argon2id KEK wrapping a fresh BIP39-derived
 *     DEK) and return the 24-word recovery phrase the user MUST record — the
 *     SAME ownership contract as `init --encrypted`, no weaker flow;
 *  2. re-write every note, log, proposal and the index through the codec so the
 *     on-disk store becomes ciphertext;
 *  3. leave NO plaintext content behind.
 *
 * ## CRASH SAFETY — the staged-swap model (the hard requirement)
 *
 * A migration that dies half-way must NEVER leave a silently-corrupt store —
 * some files encrypted, some plaintext, presenting as one mode. The store's
 * mode is derived from CONTENT (`storeHasSealedContent` scans for sealed files),
 * so an in-place per-file re-encode has no single atomic flip point: the instant
 * the first note is sealed the gate reads the whole store as encrypted, while
 * the not-yet-touched files are still plaintext — a fail-closed brick, not a
 * usable store. There is no safe in-place ordering. So we STAGE:
 *
 *   A. Build the COMPLETE encrypted store in a sibling temp dir (`staging`),
 *      NEVER touching `home`. `home` stays intact plaintext the entire time.
 *   B. VERIFY the staged copy decrypts to byte-identical content for every file
 *      with the NEW DEK (whole files byte-for-byte; logs entry-for-entry). No
 *      unverified swap — if anything fails to round-trip, we abort and `home`
 *      is untouched.
 *   C. COMMIT by two atomic renames: `home → backup`, then `staging → home`;
 *      then remove `backup` (the plaintext original).
 *
 * Every directory is built WHOLE before it is moved — `staging` is complete and
 * verified before the first rename, and `home` is never edited in place — so no
 * directory is ever internally a MIX. A crash leaves one of exactly these, and
 * every one contains at least one COMPLETE, intact store, never a half-encoded
 * one:
 *
 *   - during A/B (the long phase, incl. "kill after N files"): `home` is intact
 *     plaintext; `staging` is a disposable temp dir (a partial mix confined to a
 *     dir that is NEVER the store). Fully usable: the original. Stale staging is
 *     swept on the next run.
 *   - in the commit GAP (after `home → backup`, before `staging → home` — the
 *     one non-atomic window, two synchronous renames apart): `home` momentarily
 *     resolves to nothing, but `backup` is the intact plaintext original AND
 *     `staging` is the intact, verified encrypted result — two complete stores
 *     side by side under discoverable names, never a mix. Recover by renaming
 *     EITHER back to `home`. (A caught failure here also self-heals: we rename
 *     `backup → home`, restoring the plaintext original.)
 *   - after `staging → home`: `home` is the intact encrypted result; `backup` is
 *     a leftover plaintext copy to remove (we remove it, and if that FAILS we
 *     say so loudly and name the path — the "no plaintext behind" promise is not
 *     silently broken).
 *
 * Because the mode is read from whatever ends up AT `home`, the result is always
 * unambiguously one mode — plaintext original or encrypted result — and never a
 * silently half-done store. Facts-not-causes on every abort: we say what failed,
 * never "restore from a backup".
 *
 * ## git-synced stores (E1 `merge=union`)
 *
 * The store may be a git repo. `staging` is built as a byte copy of everything
 * in `home` EXCEPT the content we regenerate (topics/logs/proposals/index +
 * marker + keyring) and the lockfile — so `.git`, `.gitattributes` and
 * `.gitignore` are carried across verbatim. The git HISTORY therefore stays
 * PLAINTEXT: this is an OPT-IN fresh-encrypted-state from this commit forward,
 * NOT a rewrite of past commits (we never touch git history). Future commits
 * record ciphertext; anyone with the repo's history can still read the
 * pre-migration plaintext there, exactly as they could from any old backup —
 * migration cannot and does not un-publish what git already holds.
 */

export interface MigrateEncryptOptions extends HomeOpts {
  /** Passphrase for the new keyring (else falls back to GESTALT_PASSPHRASE). */
  passphrase?: string;
  /** Argon2id params override (tests use tiny params for speed). */
  argon2?: Omit<Argon2Params, "salt">;
  /** Allow below-floor Argon2 params (tests only). */
  allowWeakParams?: boolean;
  /** Sink for LOUD residue/recovery warnings (defaults to process.stderr). The
   * residue reconciliation reports what interrupted-migration temp copies it
   * found + removed (or restored) here, even on the already-encrypted refusal
   * path. Injectable so tests can assert the surfacing. */
  warn?: (msg: string) => void;
  /** TEST-ONLY crash-injection hooks — see the docstrings on each. */
  hooks?: MigrateHooks;
}

/** TEST-ONLY seams used to DRIVE the crash-safety proofs; never wired from the CLI. */
export interface MigrateHooks {
  /**
   * Called after each content file is written into `staging` (store-relative
   * path + 1-based count). THROW to simulate a crash mid-staging — `home` is
   * still untouched plaintext, so the migration aborts leaving the intact
   * original ("kill after N files").
   */
  afterStageFile?: (rel: string, count: number) => void;
  /**
   * Called in the commit GAP: after `home → backup`, before `staging → home`,
   * with the three temp paths so a test can assert BOTH survivors are intact.
   * THROW to simulate a crash there — the migration then self-heals by renaming
   * `backup → home` (restoring the plaintext original).
   */
  inCommitGap?: (paths: { home: string; backup: string; staging: string }) => void;
  /**
   * Called after staging is fully built + sealed, immediately BEFORE verifyStaged.
   * A test can mutate `staging` here (e.g. plant a leaked `.x.tmp-1-1`) to drive
   * the staged-store leak check (FINDING 3 defense in depth).
   */
  beforeVerify?: (staging: string) => void;
  /**
   * Called right before the final plaintext-backup removal (`rmSync(backup)`),
   * AFTER `staging → home` has committed. THROW to simulate a Ctrl-C/power-loss
   * in that exact window: `home` is already the encrypted result, and the
   * plaintext `backup` sibling survives as residue (FINDING 1/2). The throw
   * PROPAGATES (unlike a real rmSync error, which is reported) so the test sees
   * the "killed before cleanup" state — a subsequent `fimemory encrypt` must then
   * detect + remove that residue.
   */
  beforeRemoveBackup?: (backup: string) => void;
}

export interface MigrateEncryptResult {
  home: string;
  /** The 24-word recovery phrase — show ONCE, same contract as init --encrypted. */
  mnemonic: string;
  kid: string;
  notes: number;
  logs: number;
  proposals: number;
  /** Present ONLY when the plaintext backup could not be removed after the swap:
   * the store IS encrypted, but a plaintext COPY still sits at this path until
   * it is deleted. Surfaced loudly; never swallowed. */
  plaintextBackupRemovalFailed?: { path: string; error: string };
}

/**
 * Top-level home entries that are KNOWN plaintext store files, carried across the
 * swap verbatim and SILENTLY (they are expected, so no warning). Audited against
 * the store layout (SPEC §1 + init.ts):
 *   - config.json          — operator knobs; stays plaintext
 *   - schema.json          — store-format version (Phase B); must stay plaintext
 *                            so a cold client can refuse writes without a key
 *   - .git / .gitattributes / .gitignore — git-synced store history + attributes
 * (index.json, store.enc, keyring.json, topics/, logs/, proposals/ are all
 * REGENERATED; .gestalt.lock is transient; the session key cache lives outside
 * the home entirely.)
 *
 * NOTE (M3 revised): entries NOT in this set are no longer DROPPED. A user may
 * legitimately keep files at the store root (a README, a notes backup); silently
 * deleting them during migration is unrecoverable data loss on a non-git store.
 * So `copyPreservedEntries` now CARRIES unknown top-level entries too — skipping
 * only true process residue (atomic-write temps, the lockfile, scoped migration
 * siblings) — and every carried non-standard file is surfaced LOUDLY as PLAINTEXT
 * (it rides in unsealed) by the pre-swap `assertNoLeakedEntries` audit.
 */
const PRESERVED = new Set([
  "config.json",
  "schema.json",
  // Per-clone replica id (store/machineId.ts), 8 hex chars, written by us and
  // gitignored by `init` so it never reaches a remote. It carries no user
  // content — it exists only to make proposal filenames collision-free across
  // clones — so it rides across unsealed on purpose. Without this line, every
  // encrypted store that has ever minted a proposal prints "carried a
  // non-standard file … AS PLAINTEXT" about a file the runtime created itself,
  // next to the 24-word recovery phrase. Same false alarm, same place, as the
  // empty `ledgers/` directory handled below.
  "machine-id",
  // The keyring `fimemory decrypt` archived (ops/migrateDecrypt.ts). It has
  // always been plaintext — it holds the Argon2id-WRAPPED DEK, never the DEK —
  // so it rides across unsealed on purpose, exactly like `keyring.json` itself
  // does in a store that was encrypted from the start. Without this line the one
  // command that re-locks a store prints "carried a non-standard file … AS
  // PLAINTEXT" about a file the runtime created itself, next to the 24-word
  // recovery phrase. Same false alarm, same place, as `ledgers/` below.
  "keyring-archived.json",
  ".git",
  ".gitattributes",
  ".gitignore",
]);

/** The transient write lock (a directory, created by proper-lockfile). Never carried. */
const LOCKFILE_NAME = ".gestalt.lock";
/** The lock plus its D7 owner-record sibling (0.4) — machinery, never content. */
const isLockMachinery = (name: string): boolean =>
  name === LOCKFILE_NAME || name === `${LOCKFILE_NAME}.owner`;

/**
 * The EXACT atomic-write temp name that `store/atomic.ts` produces:
 * `.${basename}.tmp-${pid}-${ctr}` — a leading dot, the target basename (any run
 * of non-separator chars), then `.tmp-<pid>-<ctr>` where both are integers.
 *
 * ANCHORED (^…$) so it can NEVER match a real user file that merely CONTAINS
 * ".tmp-" as a substring — e.g. `quarterly.tmp-notes.md`, `draft.tmp-2.md`,
 * `export.tmp-old`, or a hidden `.notes.tmp-x`. Those are NOT process residue:
 * they are carried into staging like any other user file and WARNED as plaintext
 * by `assertNoLeakedEntries`, never silently dropped. Only a byte-exact atomic
 * temp (`.index.json.tmp-9-9`, `.auth-notes.md.tmp-4242-7`) classifies as residue
 * and is skipped. This is the single classifier for the whole file-drop class —
 * both `copyPreservedEntries` (the carry) and `assertNoLeakedEntries` (the audit)
 * route through it, so fixing it here closes the class in every path at once.
 */
// The classifier itself moved to store/tmpResidue.ts, shared with the D5
// janitor — one definition for the whole file-drop class, imported at the top.

/**
 * The root store files that are atomically (re)written — a `.<base>.tmp-*` for one
 * of these is unambiguously our OWN crashed-write residue, skipped SILENTLY. A temp
 * whose base is anything ELSE may be a real user file that merely matches the atomic
 * temp shape (`.mydata.tmp-1-2`), so skipping it is WARNED naming it (L1): the drop
 * is surfaced, never silent, and a real user-file collision is at least visible.
 */
const KNOWN_ATOMIC_TEMP_BASES = new Set([
  "index.json",
  "store.enc",
  "keyring.json",
  "config.json",
]);

/** The store's own regenerated top-level names — the set legitimately (re)created
 * INTO staging. Used by the staged-store leak check (defense in depth). */
const REGENERATED_STAGED = new Set([
  "topics",
  "logs",
  "proposals",
  "index.json",
  "store.enc",
  "keyring.json",
]);

/** The content subdirs and the canonical suffix each regenerates. readWholeFiles /
 * readLogs pick up exactly the non-dotfiles ending in the suffix; ANYTHING else in
 * these dirs is non-canonical user data that must be carried, never dropped (H1). */
const CONTENT_SUBDIRS: ReadonlyArray<{ sub: string; suffix: string }> = [
  { sub: "topics", suffix: ".md" },
  { sub: "proposals", suffix: ".md" },
  { sub: "logs", suffix: ".log.md" },
];

/** A content-dir entry the migration regenerates + re-seals (a non-dotfile ending in
 * the dir's canonical suffix). Everything else in the dir is a non-canonical user
 * file (`topics/.secret-draft.md`, `topics/notes-backup.txt`, `logs/extra.txt`) the
 * migration did NOT create, which must be CARRIED verbatim and warned as plaintext. */
function isCanonicalContentFile(name: string, suffix: string): boolean {
  return !name.startsWith(".") && name.endsWith(suffix);
}

/** One whole-file content blob (a note or a proposal), held until verified. */
interface WholeFile {
  id: string;
  raw: string;
}
interface Log {
  id: string;
  entries: LogEntry[];
}

/**
 * Convert the plaintext store at `home` to encrypted, in place, crash-safely.
 * FAILS CLOSED on every guard; VERIFIES before it commits; leaves either the
 * intact plaintext original or the intact encrypted result, never a mix.
 */
export async function migrateToEncrypted(
  opts: MigrateEncryptOptions,
): Promise<MigrateEncryptResult> {
  const home = resolveHome(opts);
  const paths = storePaths(home);
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => void process.stderr.write(m));

  // ── Residue reconciliation — runs FIRST, before EVERY guard ─────────────────
  // A prior migration that was interrupted in its commit window can leave scoped
  // sibling temp dirs beside `home` (`.<base>.gestalt-plaintext-*` — a COMPLETE
  // plaintext copy — and/or `.<base>.gestalt-encrypting-*` — the ciphertext).
  // This pass detects them and either self-heals (home gone → restore the
  // plaintext original) or, if home is intact, SURFACES them loudly — it NEVER
  // auto-deletes a `.gestalt-plaintext-*` copy (only the disposable ciphertext
  // `.gestalt-encrypting-*` staging is swept). It MUST precede the not-found guard
  // (so a commit-gap crash self-heals instead of hitting the misleading
  // `fimemory init` hint — FINDING 4) AND the already-encrypted refusal (so a
  // plaintext copy left after a completed swap is SURFACED, not hidden).
  reconcileMigrationResidue(home, paths, warn);

  // ── FIX B — HALT AND ASK on an ambiguous pair (before ANY encryption) ───────
  // If home is a complete store AND a `.gestalt-plaintext-*` sibling that HAS MEMORY
  // (config.json OR topics/ OR logs/ OR proposals/) ALSO exists, which one holds the
  // real data is ambiguous (init-then-encrypt, a double-encrypt, or a
  // killed-before-cleanup backup). A logs-only or proposals-only sibling is REAL
  // memory too (migration re-encodes logs + proposals), so it counts. Encrypting
  // home here would shadow — and could later strand — the sibling. REFUSE, naming
  // BOTH paths, and change nothing. This runs BEFORE the already-encrypted refusal so
  // the recovery error (not the generic "already encrypted") is what surfaces. A
  // LEGIT fresh migration has NO such sibling at entry; a genuine within-run backup is
  // created only later, inside commitSwap, so it can never be misdetected here.
  // Applies REGARDLESS of home completeness (H2). Gating this on homeIsCompleteStore
  // let a PARTIAL home (topics/ but no config.json) beside a memory-bearing plaintext
  // sibling slip through — encrypt would seal the junk tree while the real memory sat
  // unsounded in the sibling. So refuse whenever ANY plaintext sibling HAS MEMORY.
  {
    const memoryBearingSiblings = findSiblingTemps(home).plaintext.filter(siblingHasMemory);
    if (memoryBearingSiblings.length > 0) {
      const both = memoryBearingSiblings.join(", ");
      throw new GestaltError(
        "E_STORE_MODE",
        homeIsCompleteStore(paths)
          ? `Cannot encrypt ${home}: a plaintext store from an interrupted migration also sits beside it at ${both} — which one holds your real data is ambiguous, so nothing was changed.`
          : `Cannot encrypt ${home}: the home is incomplete (no config.json) while a plaintext store holding real data sits beside it at ${both} — refusing to encrypt a partial home while real memory is stranded in a plaintext sibling. Nothing was changed.`,
        `Recover the store you want at ${home} and remove the other, then run \`fimemory encrypt\`.`,
      );
    }
  }

  // ── Guards (fail closed; NOTHING is changed if any of these throw) ──────────
  // Entry presence check routed through the SHARED `homeHasMemory` predicate — the
  // SAME one `status.storeIsPresent` and `siblingHasMemory` use — so all THREE call
  // sites agree and can never drift (F1). A config-less LOGS-ONLY or PROPOSALS-ONLY
  // home (or config.json + logs/ with no topics/) IS real memory to that predicate,
  // so it must NEVER be steered to `fimemory init` (which only checks config.json,
  // would happily write a fresh example store OVER it, and STRAND the real logs).
  if (!existsSync(fsPath(paths.topicsDir))) {
    if (!homeHasMemory(home)) {
      // …unless `fimemory decrypt` crashed in its commit gap and the real store
      // is sitting beside this home under a scoped temp name. Same rule as the
      // logs-only case below, for the other command's residue: never steer to
      // `init` while real memory is stranded next door.
      const guidance = decryptResidueGuidance(home);
      if (guidance) throw new GestaltError("E_IO", guidance.message, guidance.hint);
      // Truly empty home (no memory at all) → the normal not-found → init path.
      throw new GestaltError(
        "E_NOT_FOUND",
        `No FIMemory store at ${home}.`,
        `fimemory init --home "${home}"`,
      );
    }
    // Memory IS present, but there is no canonical topics/ layout to migrate (a
    // logs-only, proposals-only, or config-but-no-topics home). REFUSE with a
    // recovery message that is explicitly NOT `fimemory init` — creating a fresh
    // store here would strand the real memory that is already on disk.
    throw new GestaltError(
      "E_STORE_MODE",
      `Cannot encrypt ${home}: memory is present but the store layout is incomplete (no topics/ directory to migrate) — refusing to encrypt a partial store, and NOT creating a new one over your existing data.`,
      `Restore the complete store layout at ${home} (it should have topics/, logs/, and proposals/), then run \`fimemory encrypt\`.`,
    );
  }
  // Already encrypted → clear refusal, never double-encrypt. Content-derived, so
  // a deleted keyring can't sneak a sealed store past this (M4).
  if (keyringExists(home) || storeHasSealedContent(home)) {
    throw new GestaltError(
      "E_STORE_MODE",
      "This store is already encrypted — nothing to migrate.",
      `Unlock it with your passphrase: GESTALT_PASSPHRASE=... fimemory status --home "${home}"`,
    );
  }
  // GESTALT_KEY would make the codec read this plaintext store as encrypted and
  // shadow the passphrase keyring we are about to build — refuse, like init.
  if (env.GESTALT_KEY) {
    throw new GestaltError(
      "E_SCHEMA",
      "GESTALT_KEY is set — it would shadow the passphrase keyring.",
      "Unset GESTALT_KEY, then run `fimemory encrypt`.",
    );
  }
  const passphrase = opts.passphrase ?? readEnv("PASSPHRASE", env);
  if (!passphrase) {
    throw new GestaltError(
      "E_SCHEMA",
      "Encrypting a store needs a passphrase.",
      `fimemory encrypt --passphrase "<a memorable sentence>"`,
    );
  }

  const { config } = loadConfig(paths.config);

  // (Stale sibling temps were already reconciled at command entry above.)

  // Read + build + verify the staged store while holding the write lock (a
  // consistent snapshot; no concurrent writer during the slow Argon2 + encrypt
  // phase). The lock is RELEASED before the commit swap so `home/.gestalt.lock`
  // is gone by the time we rename `home` aside — the committer returned here runs
  // AFTER release. A concurrent write in the sub-second post-release swap window
  // is outside the single-local-user v1 threat model (SPEC §1).
  const committer = await withLock(home, config.lockWaitMs, async () =>
    buildAndVerifyStaging(home, paths, passphrase, opts, warn),
  );

  // ── Commit (lock released) — see the crash-safety model in the file header ──
  return commitSwap(home, committer, opts.hooks);
}

/** Everything the committer needs, produced under the lock. */
interface Committer {
  staging: string;
  backup: string;
  mnemonic: string;
  kid: string;
  notes: number;
  logs: number;
  proposals: number;
}

/**
 * Build the COMPLETE encrypted store in a sibling `staging` dir and VERIFY it
 * decrypts byte-identical, all WITHOUT touching `home`. Throws (and removes the
 * partial staging) on any failure — `home` stays intact plaintext.
 */
async function buildAndVerifyStaging(
  home: string,
  paths: ReturnType<typeof storePaths>,
  passphrase: string,
  opts: MigrateEncryptOptions,
  warn: (msg: string) => void,
): Promise<Committer> {
  const parent = path.dirname(home);
  const base = path.basename(home);
  const uniq = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.${base}.gestalt-encrypting-${uniq}`);
  const backup = path.join(parent, `.${base}.gestalt-plaintext-${uniq}`);

  // (1) READ every content file in PLAINTEXT mode (no DEK active yet). Capture
  // exact bytes for whole-file kinds and parsed entries for logs — the fidelity
  // baseline the verify step checks the ciphertext against.
  const notes = readWholeFiles(home, paths.topicsDir, ".md");
  const proposals = readWholeFiles(home, paths.proposalsDir, ".md");
  // index.json is a whole file staged through the codec and byte-compared by
  // verifyStaged, so it MUST get the SAME strip-all-leading-BOMs normalization as
  // notes/proposals — otherwise a BOM-prefixed index.json still bricks verify while
  // the notes succeed (F5). Same shared helper, applied at every codec-verified
  // whole-file staging site.
  const indexRaw = existsSync(fsPath(paths.index))
    ? stripLeadingBoms(readFileSync(fsPath(paths.index), "utf8"))
    : null;
  const logs = readLogs(home, paths.logsDir);

  try {
    // (2) KEYRING — generated INTO staging (not home), so home is untouched and
    // the keyring rides the swap into place. Same primitive init --encrypted
    // uses: passphrase → Argon2id KEK wrapping a fresh BIP39-derived DEK; returns
    // the 24-word recovery phrase. Validates the passphrase + params, so a weak
    // passphrase aborts here having created nothing but the empty staging dir.
    // mode 0700 / 0600 throughout this function: the staged tree is RENAMED into
    // place and becomes the store, so whatever mode it is built with is the mode
    // the user lives with afterwards. Unmoded, under umask 022, `migrate-encrypt`
    // — the command whose entire purpose is to make an existing store safer —
    // hands back 0755 directories and 0644 files, WIDENING every store file that
    // init or writeFileAtomicPlain had created 0600. Inert on Windows; measured
    // on the POSIX legs by .github/scripts/posix-modes.mjs.
    mkdirSync(fsPath(staging), { recursive: true, mode: 0o700 });
    const kr = initKeyring(staging, passphrase, opts.argon2, {
      allowWeakParams: opts.allowWeakParams,
    });

    // (3) BUILD the staged store, DEK active so the codec seals on write.
    activateDek(kr.dek);
    mkdirSync(fsPath(path.join(staging, "topics")), { recursive: true, mode: 0o700 });
    mkdirSync(fsPath(path.join(staging, "logs")), { recursive: true, mode: 0o700 });
    mkdirSync(fsPath(path.join(staging, "proposals")), { recursive: true, mode: 0o700 });

    // Carry across everything we do NOT regenerate — config.json (stays
    // plaintext), .git / .gitattributes / .gitignore (history stays plaintext by
    // design), and any other user file — byte-for-byte. The never-drop policy also
    // applies INSIDE the content dirs (H1): non-canonical entries under
    // topics/ logs/ proposals/ (a `.secret-draft.md`, a `notes-backup.txt`) are
    // carried too, so nothing is silently dropped when the plaintext backup is removed.
    copyPreservedEntries(home, staging, warn);
    copyNonCanonicalContentEntries(home, staging, warn);

    let staged = 0;
    const stage = (rel: string, absTarget: string, bytes: string): void => {
      writeFileSync(fsPath(absTarget), bytes, { encoding: "utf8", mode: 0o600 });
      staged += 1;
      opts.hooks?.afterStageFile?.(rel, staged);
    };

    // The always-present sealed marker — the canonical DEK↔ciphertext oracle.
    stage("store.enc", path.join(staging, "store.enc"), encryptFile(paths.storeMarker, STORE_MARKER_CONTENT));
    for (const n of notes) {
      const target = path.join(staging, "topics", `${n.id}.md`);
      stage(`topics/${n.id}.md`, target, encryptFile(target, n.raw));
    }
    for (const p of proposals) {
      const target = path.join(staging, "proposals", `${p.id}.md`);
      stage(`proposals/${p.id}.md`, target, encryptFile(target, p.raw));
    }
    for (const l of logs) {
      // Logs are PER-ENTRY sealed (so git merge=union concatenates cross-machine
      // appends without the key) — serializeLog encodes each entry under the DEK.
      const target = path.join(staging, "logs", `${l.id}.log.md`);
      stage(`logs/${l.id}.log.md`, target, serializeLog(l.id, l.entries));
    }
    if (indexRaw !== null) {
      const target = path.join(staging, "index.json");
      stage("index.json", target, encryptFile(target, indexRaw));
    }

    // (4) VERIFY — decrypt the STAGED copy with the new DEK and prove it matches
    // the plaintext original for EVERY file. No unverified swap.
    opts.hooks?.beforeVerify?.(staging);
    verifyStaged(staging, { notes, proposals, indexRaw, logs }, warn);

    return {
      staging,
      backup,
      mnemonic: kr.mnemonic,
      kid: kr.kid,
      notes: notes.length,
      logs: logs.length,
      proposals: proposals.length,
    };
  } catch (err) {
    // home is untouched; discard the partial staging and re-throw the FACT.
    clearActiveKey();
    safeRemove(staging);
    throw err;
  }
}

/**
 * The commit: two atomic renames with self-healing rollback, then removal of the
 * plaintext backup. Runs AFTER the lock is released. See the file header.
 */
function commitSwap(
  home: string,
  c: Committer,
  hooks?: MigrateHooks,
): MigrateEncryptResult {
  const result = (
    extra?: Pick<MigrateEncryptResult, "plaintextBackupRemovalFailed">,
  ): MigrateEncryptResult => {
    clearActiveKey(); // no lingering process key — the user unlocks explicitly
    return {
      home,
      mnemonic: c.mnemonic,
      kid: c.kid,
      notes: c.notes,
      logs: c.logs,
      proposals: c.proposals,
      ...(extra ?? {}),
    };
  };

  // ── Shrink the commit-window exposure (RESIDUAL 2a) ─────────────────────────
  // A SIGINT/SIGTERM landing between `staging → home` and `rmSync(backup)` would
  // otherwise strand the plaintext `backup` sibling as residue readable in the
  // clear. Handle those signals for the duration of the swap to finish the
  // least-bad cleanup, then re-raise so the process still exits with signal
  // semantics. (SIGKILL / power loss cannot be caught — the `fimemory status` and
  // `fimemory encrypt` residue surfacing is the durable backstop for that.)
  let committed = false; // true once `home` IS the encrypted result
  const onSignal = (sig: NodeJS.Signals): void => {
    // If the swap already put the encrypted result at `home`, the plaintext
    // backup is pure residue → remove it. If not, leave BOTH intact copies for
    // the next run's reconcile pass — never guess mid-signal.
    if (committed) safeRemove(c.backup);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.kill(process.pid, sig); // re-raise: default terminate
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // home → backup (atomic). If THIS fails, nothing is committed: home is the
    // intact plaintext original — discard the (complete, verified) staging.
    try {
      renameDirWithRetrySync(home, c.backup, "set your store aside to swap in the encrypted copy");
    } catch (err) {
      clearActiveKey();
      safeRemove(c.staging);
      throw err;
    }
    // After the rename, home resolves to nothing; backup is the intact plaintext
    // original, staging the intact verified encrypted result.
    try {
      hooks?.inCommitGap?.({ home, backup: c.backup, staging: c.staging });
      renameDirWithRetrySync(c.staging, home, "move the encrypted copy into place"); // atomic
      committed = true;
    } catch (err) {
      // Self-heal: restore the plaintext original. A crash (power loss) here
      // instead leaves backup + staging both intact — recoverable by hand, never a
      // mix (see the file header).
      clearActiveKey();
      try {
        renameDirWithRetrySync(c.backup, home, "put your original store back");
        safeRemove(c.staging);
      } catch {
        // Could not restore: home is absent, but `backup` IS the intact plaintext
        // original and `staging` the intact verified ciphertext — name them so the
        // user recovers by hand (never a mix, just displaced).
        throw new GestaltError(
          "E_IO",
          `Migration could not complete the swap. Your data is intact but under a temp name: plaintext at ${c.backup}, encrypted at ${c.staging}.`,
          `Rename either one back to ${home} (the plaintext to undo, the encrypted to keep).`,
        );
      }
      throw err;
    }

    // home is now the encrypted result. Remove the plaintext backup — REQUIRED to
    // leave no plaintext behind; a failure is surfaced loudly (never swallowed),
    // exactly like the session-key wipe-failed path.
    // TEST seam: a throw here PROPAGATES — it simulates a kill in this exact window,
    // leaving `home` encrypted and the plaintext `backup` sibling as residue that a
    // subsequent `fimemory encrypt` (or `fimemory status`) must detect + surface (FINDING 1/2).
    hooks?.beforeRemoveBackup?.(c.backup);
    try {
      rmSync(fsPath(c.backup), { recursive: true, force: true });
    } catch (err) {
      return result({
        plaintextBackupRemovalFailed: {
          path: c.backup,
          error: (err as Error).message ?? String(err),
        },
      });
    }
    return result();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * Strip ALL leading UTF-8 BOMs (U+FEFF — the EF BB BF bytes produced by PowerShell
 * `Set-Content -Encoding utf8` and many Windows editors), leaving every other byte
 * untouched (a BOM mid-content is content and is NEVER removed). The codec's decrypt
 * (`bytesToUtf8`, in codec.ts) drops exactly ONE leading BOM on the way back out, so
 * a whole file staged WITH its BOM(s) would fail verifyStaged's byte-identical check
 * and BRICK the entire migration (F4). A SINGLE strip is not enough: a file beginning
 * with TWO+ BOMs (EF BB BF EF BB BF … — from tool composition / concatenation /
 * Windows editor round-trips) would still leave a leading BOM after one strip, so the
 * once-stripped codec round-trip is still short by one BOM and verify still bricks.
 * Looping until the string no longer begins with U+FEFF normalizes ANY count of
 * leading BOMs to zero, so the encrypt→decrypt round-trip always matches — and it
 * matches how the runtime already reads every codec-decoded whole file (BOM-less), so
 * the migrated file is BOM-less and consistent, not a meaningful content loss.
 *
 * This is the SINGLE shared normalizer applied at EVERY whole-file staging site that
 * is codec-sealed and byte-compared by verifyStaged — notes, proposals, AND
 * index.json — so the BOM-brick class is closed uniformly for all codec-verified
 * whole files, not just notes (F5). (The store marker is fixed known content, never
 * read from disk, so it needs no normalization; logs are per-ENTRY sealed and
 * compared entry-for-entry, not whole-file byte-identical, so they are unaffected.)
 */
function stripLeadingBoms(content: string): string {
  let out = content;
  while (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out;
}

/** Read every `<dir>/*<suffix>` as exact bytes (plaintext mode → raw == plaintext),
 * normalizing away ALL leading UTF-8 BOMs so the codec round-trip verifies (F4/F5). */
function readWholeFiles(home: string, dir: string, suffix: string): WholeFile[] {
  let names: string[];
  try {
    names = readdirSync(fsPath(dir));
  } catch {
    return [];
  }
  const out: WholeFile[] = [];
  for (const name of names.filter((n) => !n.startsWith(".") && n.endsWith(suffix)).sort()) {
    const id = name.slice(0, -suffix.length);
    out.push({ id, raw: stripLeadingBoms(readFileSync(fsPath(path.join(dir, name)), "utf8")) });
  }
  return out;
}

/**
 * Read every log, parse to entries in PLAINTEXT mode. A log that parses with
 * WARNINGS (an unparsable block parseLog would SKIP) is refused: re-encoding it
 * would silently DROP that block, and a migration must never lose content.
 */
function readLogs(home: string, dir: string): Log[] {
  let names: string[];
  try {
    names = readdirSync(fsPath(dir));
  } catch {
    return [];
  }
  const out: Log[] = [];
  for (const name of names.filter((n) => !n.startsWith(".") && n.endsWith(".log.md")).sort()) {
    const id = name.slice(0, -".log.md".length);
    const raw = readFileSync(fsPath(topicLogPath(home, id)), "utf8");
    const { entries, warnings } = parseLog(raw, id);
    if (warnings.length > 0) {
      throw new GestaltError(
        "E_CORRUPT_SKIPPED",
        `logs/${id}.log.md has an unparsable entry that migration would drop.`,
        `Fix the file (or export it with fimemory export --plaintext) and re-run.`,
      );
    }
    out.push({ id, entries });
  }
  return out;
}

/**
 * Prove the staged ciphertext decrypts to byte-identical content with the new
 * DEK — whole files byte-for-byte, logs entry-for-entry. Any mismatch throws
 * (routed to the caller's abort, `home` untouched). This is the "no unverified
 * swap" gate.
 */
function verifyStaged(
  staging: string,
  src: { notes: WholeFile[]; proposals: WholeFile[]; indexRaw: string | null; logs: Log[] },
  warn: (msg: string) => void,
): void {
  const fail = (rel: string): never => {
    throw new GestaltError(
      "E_STORE_MODE",
      `Verification failed: ${rel} did not decrypt back to its original content.`,
      "Nothing was changed. Re-run `fimemory encrypt`.",
    );
  };

  // Pre-swap audit of what is about to ride into `home` (FINDING 3 + RESIDUAL 1):
  //  - FAIL CLOSED on any atomic-write temp — plaintext residue must NEVER swap in.
  //  - WARN (never abort, never drop) on a legitimate non-standard file carried in:
  //    it rides as PLAINTEXT, so the user is told loudly it is not sealed.
  assertNoLeakedEntries(staging, warn);

  // The marker must AEAD-open to its fixed known plaintext.
  const markerPath = path.join(staging, "store.enc");
  if (readWholeBack(markerPath) !== STORE_MARKER_CONTENT) fail("store.enc");

  for (const n of src.notes) {
    const p = path.join(staging, "topics", `${n.id}.md`);
    if (readWholeBack(p) !== n.raw) fail(`topics/${n.id}.md`);
  }
  for (const pr of src.proposals) {
    const p = path.join(staging, "proposals", `${pr.id}.md`);
    if (readWholeBack(p) !== pr.raw) fail(`proposals/${pr.id}.md`);
  }
  if (src.indexRaw !== null) {
    const p = path.join(staging, "index.json");
    if (readWholeBack(p) !== src.indexRaw) fail("index.json");
  }
  for (const l of src.logs) {
    const p = path.join(staging, "logs", `${l.id}.log.md`);
    const back = parseLog(readFileSync(fsPath(p), "utf8"), l.id).entries;
    if (!sameEntries(back, l.entries)) fail(`logs/${l.id}.log.md`);
  }
}

/**
 * The pre-swap audit of the staged store (FINDING 3 + RESIDUAL 1). Two outcomes,
 * never a THIRD (silent drop):
 *
 *  - ABORT (fail closed) on an atomic-write temp (`.<name>.tmp-*`, at the top level
 *    or inside a regenerated content dir). A temp is PLAINTEXT process residue that
 *    must never ride the swap into `home` — the "no stray plaintext behind" promise.
 *
 *  - WARN (never abort, never drop) on a legitimate non-standard top-level entry —
 *    a user file kept at the store root that `copyPreservedEntries` carried across.
 *    It is real user data, so we do NOT delete it; but foreign files are not sealed,
 *    so it rides into the encrypted store as PLAINTEXT — say so LOUDLY, naming it,
 *    so the user knows it is readable in the clear.
 *
 * The regenerated names and the known PRESERVED store files pass silently.
 */
function assertNoLeakedEntries(staging: string, warn: (msg: string) => void): void {
  const abort = (name: string): never => {
    throw new GestaltError(
      "E_STORE_MODE",
      `Staged store has an unexpected temp file (${name}) — refusing to swap it in.`,
      "Nothing was changed. Re-run `fimemory encrypt`.",
    );
  };
  for (const entry of readdirSync(fsPath(staging), { withFileTypes: true })) {
    if (isAtomicTemp(entry.name)) abort(entry.name);
    // `ledgers/` is a directory `init` itself creates, so on a store that has
    // never used the task-ledger bus it is EMPTY — and warning "carried a
    // non-standard file … AS PLAINTEXT (it is NOT sealed): ledgers" about an
    // empty directory we created ourselves is a false alarm, printed next to
    // the 24-word recovery phrase, on the one command that touches all of
    // someone's memory. That is the worst possible place to cry wolf.
    //
    // It is NOT unconditionally false, which is why this narrows the warning
    // instead of silencing it. Ledger lines are sealed per-line on an encrypted
    // store, but this migration does not re-seal EXISTING ones: it carries the
    // directory across verbatim. So a store with real ledger content genuinely
    // does end up with plaintext lines inside an encrypted store, and the user
    // must be told — in words that say what to do about it, which the generic
    // "non-standard file" text did not.
    if (entry.name === "ledgers") {
      let ledgerFiles: string[] = [];
      try {
        ledgerFiles = readdirSync(fsPath(path.join(staging, "ledgers")));
      } catch {
        /* unreadable — fall through to the generic warning below */
      }
      if (ledgerFiles.length === 0) continue; // empty: nothing carried, nothing to say
      warn(
        `fimemory encrypt: task-ledger entries were carried across WITHOUT being sealed (${ledgerFiles.length} file(s) in ledgers/). ` +
          `New ledger entries written after this migration ARE sealed; these existing ones are not, ` +
          `so they stay readable inside the encrypted store.\n`,
      );
      continue;
    }
    if (!REGENERATED_STAGED.has(entry.name) && !PRESERVED.has(entry.name)) {
      // A carried-in user file: preserved, but PLAINTEXT — surface it loudly.
      warn(
        `fimemory encrypt: carried a non-standard file into the encrypted store AS PLAINTEXT (it is NOT sealed): ${entry.name}\n`,
      );
    }
  }
  // The regenerated content dirs: ABORT on any atomic-write temp (plaintext residue
  // must never ride the swap), and WARN on a carried non-canonical file (H1) — a user
  // entry that is not one of the re-sealed `<id>` files rides in as PLAINTEXT.
  for (const { sub, suffix } of CONTENT_SUBDIRS) {
    let names: string[];
    try {
      names = readdirSync(fsPath(path.join(staging, sub)));
    } catch {
      continue;
    }
    for (const n of names) {
      if (isAtomicTemp(n)) abort(`${sub}/${n}`);
      else if (!isCanonicalContentFile(n, suffix)) {
        warn(
          `fimemory encrypt: carried a non-standard file into the encrypted store AS PLAINTEXT (it is NOT sealed): ${sub}/${n}\n`,
        );
      }
    }
  }
}

/** Decrypt one whole-file staged blob with the active DEK (throws on any AEAD failure). */
function readWholeBack(absPath: string): string {
  return decryptFile(absPath, readFileSync(fsPath(absPath), "utf8"));
}

/** Entry-for-entry byte comparison: same count, same raw block, same order. */
function sameEntries(a: LogEntry[], b: LogEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.raw !== b[i]!.raw) return false;
  }
  return true;
}

/**
 * Copy every top-level `home` entry we are NOT regenerating into `staging`,
 * byte-for-byte — WITHOUT silently losing user data (M3 revised / RESIDUAL 1):
 *
 *  - PRESERVED store files (config.json, schema.json, .git / .gitattributes /
 *    .gitignore) ride across as before.
 *  - REGENERATED names (topics/, logs/, proposals/, index.json, store.enc,
 *    keyring.json) are skipped — the migration (re)creates their sealed forms.
 *  - True process residue is skipped: atomic-write temps (`.<name>.tmp-*`, a
 *    crashed write's leftover — carrying one would plant stray PLAINTEXT beside
 *    the sealed copy), the transient lockfile, and any scoped migration sibling
 *    that somehow nested inside `home`.
 *  - EVERYTHING ELSE — a legitimate user file kept at the store root (a README, a
 *    notes backup) — is CARRIED, never dropped. It rides in as PLAINTEXT (foreign
 *    files are not sealed); the pre-swap `assertNoLeakedEntries` audit surfaces
 *    each one LOUDLY so the user knows it is not encrypted.
 */
function copyPreservedEntries(home: string, staging: string, warn: (msg: string) => void): void {
  const sibRe = siblingTempRe(path.basename(home));
  for (const entry of readdirSync(fsPath(home), { withFileTypes: true })) {
    const name = entry.name;
    if (REGENERATED_STAGED.has(name)) continue; // regenerated sealed into staging
    if (isLockMachinery(name) || sibRe.test(name)) continue; // transient / scoped residue
    const tempBase = atomicTempBase(name);
    if (tempBase !== null) {
      // An atomic-write temp: skip it (carrying one would plant stray PLAINTEXT beside
      // the sealed copy). If its base is NOT a known store file, it may be a real user
      // file that merely matches the temp shape — WARN naming it so the drop is never
      // silent (L1). A `.index.json.tmp-*` etc. is our own residue → skip silently.
      if (!KNOWN_ATOMIC_TEMP_BASES.has(tempBase)) {
        warn(
          `fimemory encrypt: left behind a leftover from an interrupted write, which is not one of your notes and was not copied: ${name}
`,
        );
      }
      continue;
    }
    // PRESERVED (expected) and unknown-but-legitimate files both ride across —
    // never DROP user data. The loud "carried as plaintext" warning for the
    // non-standard ones is emitted by assertNoLeakedEntries before the swap.
    cpSync(fsPath(path.join(home, name)), fsPath(path.join(staging, name)), {
      recursive: true,
    });
  }
}

/**
 * The never-drop policy applied INSIDE the content dirs (H1). readWholeFiles/readLogs
 * regenerate ONLY the canonical `<id>` store files under topics/ logs/ proposals/, so
 * a NON-canonical entry there (topics/my-notes-backup.txt, topics/.secret-draft.md,
 * logs/extra-notes.txt) would be silently dropped when the plaintext backup is removed.
 * Mirror the root policy: carry every non-canonical content-dir entry into staging
 * verbatim; true process residue (atomic-write temps, the lockfile, a nested scoped
 * sibling) is still skipped. assertNoLeakedEntries then WARNS each carried entry as
 * plaintext before the swap, so the drop is never silent.
 *
 * L1 mirrored INSIDE content dirs (F3): the root `copyPreservedEntries` WARNS when
 * it skips an atomic-temp-shaped file whose base is not a known store write-temp.
 * Content dirs must WARN even more aggressively — on EVERY atomic-temp-shaped skip.
 * A genuine note write-temp here is `.<id><suffix>.tmp-*` (captured base ENDS WITH
 * the dir's canonical suffix, e.g. `.auth-notes.md.tmp-9-9`), but a real user file
 * can end the same way (`.my-draft.md.tmp-1-2`, base `.my-draft.md`), so a
 * suffix-ending base is INDISTINGUISHABLE from a user collision and can NOT be
 * silently dropped. So every content-dir atomic-temp skip is WARNED naming the
 * path; a warning on a real note write-temp is acceptable noise, a silent drop is not.
 */
function copyNonCanonicalContentEntries(
  home: string,
  staging: string,
  warn: (msg: string) => void,
): void {
  const sibRe = siblingTempRe(path.basename(home));
  for (const { sub, suffix } of CONTENT_SUBDIRS) {
    const srcDir = path.join(home, sub);
    let names: string[];
    try {
      names = readdirSync(fsPath(srcDir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (isCanonicalContentFile(name, suffix)) continue; // regenerated + sealed separately
      if (isLockMachinery(name) || sibRe.test(name)) continue; // transient / scoped residue
      if (atomicTempBase(name) !== null) {
        // An atomic-write temp: skip it (carrying one would plant stray PLAINTEXT
        // beside the sealed copy). Unlike the root, a content-dir write-temp base
        // ENDS WITH the dir's canonical suffix (`.auth-notes.md.tmp-9-9`), and a
        // real user collision can end the same way (`.my-draft.md.tmp-1-2`) — the
        // two are INDISTINGUISHABLE, so a suffix-ending base can NOT be silently
        // treated as our own residue (that silently drops a possible user file — F3).
        // Mirror the root L1 policy INSIDE content dirs: WARN on EVERY atomic-temp
        // skip here, naming `<sub>/<name>`. A warning on a genuine note write-temp is
        // acceptable noise; a silent user-file drop is not.
        warn(
          `fimemory encrypt: left behind a leftover from an interrupted write, which is not one of your notes and was not copied: ${sub}/${name}
`,
        );
        continue;
      }
      cpSync(fsPath(path.join(srcDir, name)), fsPath(path.join(staging, sub, name)), {
        recursive: true,
      });
    }
  }
}

/** The exact scoped sibling-temp name pattern for THIS store — anchored so it can
 * NEVER match a real user directory: `.<base>.gestalt-(encrypting|plaintext)-<pid>-<ts>`. */
function siblingTempRe(base: string): RegExp {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${esc}\\.gestalt-(encrypting|plaintext)-\\d+-\\d+$`);
}

export interface Siblings {
  encrypting: string[];
  plaintext: string[];
}

/**
 * Detect this store's interrupted-migration residue (RESIDUAL 2b) — the scoped
 * sibling temp dirs beside `home`, classified by kind, absolute paths. Exported so
 * a routinely-run command (`fimemory status`) can surface leftover residue LOUDLY
 * even without re-running `fimemory encrypt` (which is what would otherwise sweep
 * it). Reuses the SAME anchored pattern, so it can NEVER match a real user dir.
 */
export function detectMigrationResidue(home: string, entries?: readonly string[]): Siblings {
  return findSiblingTemps(home, entries);
}

/**
 * Find this store's scoped sibling temp dirs (absolute paths), classified by kind.
 *
 * `entries` lets a caller that already listed the parent directory pass that
 * listing in rather than forcing another one. This is not micro-optimisation.
 * It runs on EVERY `fimemory status`; the parent of a store is the user's HOME
 * directory (and, in the suite, a root holding every test store); and status is
 * called in a hot loop by the retrieval hook and the MCP server. Adding a third
 * listing of that directory per call measurably starved the store's own writer
 * under peer read pressure — caught by test/contention-processes.test.ts, which
 * failed on exactly that regression.
 */
function findSiblingTemps(home: string, entries?: readonly string[]): Siblings {
  const parent = path.dirname(home);
  const re = siblingTempRe(path.basename(home));
  const out: Siblings = { encrypting: [], plaintext: [] };
  let names: readonly string[];
  try {
    names = entries ?? readdirSync(fsPath(parent));
  } catch {
    return out;
  }
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const abs = path.join(parent, name);
    if (m[1] === "encrypting") out.encrypting.push(abs);
    else out.plaintext.push(abs);
  }
  return out;
}

/** True once `home` looks like a COMPLETE store (config.json is written by init
 * before any content and survives both modes) — the discriminator between "home
 * is authoritative, siblings are residue" and "home is gone, a sibling may be the
 * only intact copy". */
function homeIsCompleteStore(paths: ReturnType<typeof storePaths>): boolean {
  return existsSync(fsPath(paths.config));
}

/**
 * The SINGLE shared "is there a store / memory on disk at `dir`?" predicate.
 *
 * This question used to be answered by TWO predicates that could DISAGREE —
 * `status.storeIsPresent` (config OR keyring OR sealed OR topics/) and
 * `siblingHasMemory` (config OR topics OR logs OR proposals) — so a config-less
 * home holding ONLY logs/ or ONLY proposals/ was reported "not a FIMemory store"
 * and steered to `fimemory init` OVER real memory. Both callers now route through
 * THIS one function, so the two can NEVER drift apart again.
 *
 * A store/memory is PRESENT when ANY canonical material exists:
 *   - config.json                       — the store's config file
 *   - the passphrase keyring (keyring.json)  — a config-less SEALED store
 *   - AEAD-sealed content               — a config-less SEALED store
 *   - topics/ OR logs/ OR proposals/    — plaintext memory. Migration re-encodes
 *     logs AND proposals as well as notes (readLogs/readWholeFiles), so a
 *     logs-only or proposals-only home is REAL memory, not "no store".
 */
export function homeHasMemory(dir: string): boolean {
  return (
    existsSync(fsPath(path.join(dir, "config.json"))) ||
    keyringExists(dir) ||
    storeHasSealedContent(dir) ||
    existsSync(fsPath(path.join(dir, "topics"))) ||
    existsSync(fsPath(path.join(dir, "logs"))) ||
    existsSync(fsPath(path.join(dir, "proposals")))
  );
}

/**
 * True when a `.gestalt-plaintext-*` sibling `dir` HOLDS MEMORY. This is the
 * redesign's single load-bearing predicate (the last classification carve-out —
 * "complete store" vs "incomplete residue" — is gone). The tool must NEVER
 * auto-delete a sibling that satisfies this, because it cannot prove the sibling
 * is redundant (it may be the user's only real memory: an accidental `gestalt
 * init` after a commit-gap crash, or a double-encrypt).
 *
 * It is now a thin alias of the shared {@link homeHasMemory}: sibling-presence and
 * store-presence are the SAME question, so `fimemory status` (store-presence) and
 * `fimemory encrypt` (sibling PRESERVE / REFUSE / SELF-HEAL) decide it with ONE
 * predicate — keeping the two in lockstep by construction.
 */
export function siblingHasMemory(dir: string): boolean {
  return homeHasMemory(dir);
}

/**
 * Reconcile leftover sibling temp dirs from a prior interrupted migration, LOUDLY.
 * Two crash states, both scoped to this store's exact sibling names:
 *
 *  - `home` is a complete store  → home is authoritative. A `.gestalt-encrypting-*`
 *    dir is disposable ciphertext staging and IS swept. But NO `.gestalt-plaintext-*`
 *    sibling is EVER auto-deleted (the redesign's FINAL safe rule) — complete,
 *    logs-only, proposals-only, or empty alike: the tool cannot prove any of them is
 *    redundant, and a logs-only/proposals-only sibling is REAL memory (migration
 *    re-encodes logs + proposals). Every one is SURFACED loudly and left in place;
 *    the halt-and-ask guard (FIX B) in `migrateToEncrypted` then refuses the run
 *    when any sibling has memory, so home is never encrypted over an ambiguous pair.
 *
 *  - `home` is ABSENT             → a true power loss in the one-instruction commit
 *    gap (after `home → backup`, before `staging → home`; FINDING 4). If exactly
 *    one plaintext backup HAS MEMORY (config/topics/logs/proposals), self-heal by
 *    renaming it back to `home` (never clobbering an existing home — home is absent
 *    here) and drop the encrypting dir; the migration then proceeds on the restored
 *    plaintext. If it is ambiguous/unsafe, throw a recovery error NAMING the temp
 *    paths instead of the misleading `fimemory init` hint.
 */
function reconcileMigrationResidue(
  home: string,
  paths: ReturnType<typeof storePaths>,
  warn: (msg: string) => void,
): void {
  const sib = findSiblingTemps(home);
  if (sib.encrypting.length === 0 && sib.plaintext.length === 0) return;

  if (homeIsCompleteStore(paths)) {
    // home is present & a complete store → home is authoritative. The REDESIGN's
    // FINAL safe rule: NO `.gestalt-plaintext-*` sibling is EVER auto-deleted —
    // complete, logs-only, proposals-only, or empty. Any such dir can hold REAL
    // memory (migration re-encodes logs + proposals as well as notes, so a logs-only
    // or proposals-only sibling is real data), and the tool cannot prove it is
    // redundant. The last classification carve-out is gone: we surface EVERY
    // plaintext sibling loudly and leave it in place. The halt-and-ask guard (FIX B)
    // then refuses the run whenever any sibling has memory, so home is never
    // encrypted over an ambiguous pair. Only the disposable `.gestalt-encrypting-*`
    // ciphertext staging is swept.
    for (const p of sib.plaintext) {
      warn(
        `fimemory encrypt: a plaintext store from an interrupted migration is here and may hold real data — NOT removing it: ${p} — recover it or remove it yourself.\n`,
      );
    }
    for (const p of sib.encrypting) {
      safeRemove(p);
      warn(`fimemory encrypt: removed a stale encryption staging dir: ${p}\n`);
    }
    return;
  }

  // home is absent — a commit-gap power loss. Prefer to self-heal from an intact
  // plaintext backup; never clobber an existing home (there is none here).
  if (existsSync(fsPath(home))) {
    // home exists but is NOT a complete store (partial/foreign). Do NOT touch it or
    // auto-restore over it. But SURFACE any memory-bearing plaintext sibling (H2) —
    // the halt-and-ask guard then REFUSES the run — so real memory beside a partial
    // home is never left unsounded. (The complete-store branch above already surfaces.)
    for (const p of sib.plaintext.filter(siblingHasMemory)) {
      warn(
        `fimemory encrypt: a plaintext store from an interrupted migration is here and may hold real data — NOT removing it: ${p} — recover it or remove it yourself.\n`,
      );
    }
    return;
  }
  const restorable = sib.plaintext.filter(siblingHasMemory);
  if (restorable.length === 1) {
    renameSync(fsPath(restorable[0]!), fsPath(home));
    warn(
      `fimemory encrypt: an earlier migration was interrupted in the commit window; ` +
        `restored the intact plaintext store from ${restorable[0]} to ${home}.\n`,
    );
    for (const p of sib.encrypting) {
      safeRemove(p);
      warn(`fimemory encrypt: removed the interrupted encryption result: ${p}\n`);
    }
    return;
  }

  // Ambiguous or no verified-intact backup — never guess. Name the temp paths so
  // the user recovers by hand, instead of the misleading `fimemory init` hint. The
  // wording MUST match `fimemory status` for the same on-disk state (F2): only CLAIM
  // "intact data" / "readable in the clear" for a sibling that actually HAS MEMORY,
  // and NEVER advise a rename for an EMPTY leftover — describe it as empty, no data.
  const found = [...sib.plaintext, ...sib.encrypting].join(", ");
  const memoryBearing = sib.plaintext.filter(siblingHasMemory);
  if (memoryBearing.length > 0) {
    // 2+ memory-bearing plaintext copies (the ==1 self-heal case returned above) —
    // ambiguous which one to keep. Name the copies that actually hold real data.
    const plaintexts = memoryBearing.join(", ");
    throw new GestaltError(
      "E_IO",
      `An earlier "fimemory encrypt" was interrupted and ${home} is missing. Intact data survives under temp names: ${found}. A PLAINTEXT copy of your store is readable in the clear at ${plaintexts}.`,
      `Decide which store to keep and rename it back to ${home} (remove the other copies), then re-run.`,
    );
  }
  if (sib.plaintext.length > 0) {
    // Every plaintext sibling is EMPTY (no memory) — do NOT claim intact data or
    // advise a rename; word it as an empty leftover, exactly like `fimemory status`.
    throw new GestaltError(
      "E_IO",
      `An earlier "fimemory encrypt" was interrupted and ${home} is missing. Only empty leftover temp dirs remain (no data in them): ${found}.`,
      `No recoverable store data was found under those temp names; remove them, then restore ${home} from your own backup.`,
    );
  }
  // Only a `.gestalt-encrypting-*` ciphertext staging dir — no plaintext backup to
  // restore. (`fimemory status` says the same for this exact state.)
  throw new GestaltError(
    "E_IO",
    `An earlier "fimemory encrypt" was interrupted and ${home} is missing. It left an encryption staging (ciphertext) dir at ${found}; there is no plaintext backup to restore.`,
    `If you have your recovery phrase, rename ${found} back to ${home} to keep the encrypted result; otherwise restore ${home} from your own backup.`,
  );
}

/**
 * Rename a DIRECTORY, retrying briefly while Windows says EPERM.
 *
 * WHY THIS EXISTS. `commitSwap` renames the store directory itself, and on
 * Windows a directory rename fails EPERM if ANY file anywhere beneath it is
 * open. One peer agent's 1 ms read is enough. Reproduced 2026-08-01: holding a
 * single topic file open made `fimemory encrypt` exit 1 with a raw
 * `node:fs:1013` stack dump, during the one command that touches every note a
 * person owns — and the store was completely intact, which nothing on screen
 * said.
 *
 * WHY NOT `store/atomic.ts`'s renameWithRetry. That one unlinks `from` when it
 * decides the target is read-only. Here `from` is THE USER'S STORE. Reusing it
 * would turn a contended rename into deleting the thing we are protecting.
 * Never call it with a directory you cannot afford to lose.
 *
 * WHY SYNCHRONOUS. The SIGINT/SIGTERM handler installed around the swap decides
 * what to keep based on `committed`, and that reasoning only holds while the
 * swap is a straight-line sync sequence. Sleeping via `Atomics.wait` on a
 * throwaway SharedArrayBuffer keeps it that way — an async sleep would let a
 * signal land mid-await with `committed` half-true.
 *
 * The budget is deliberately short. A holder is either transient (a peer's read,
 * gone in milliseconds) or persistent (an editor, a scanner), and waiting 30 s
 * for the second kind just moves a crash later. Exhaustion raises E_LOCKED,
 * which is a GestaltError, so the CLI prints one red line naming the cause
 * instead of a stack trace.
 */
const DIR_RENAME_BUDGET_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameDirWithRetrySync(from: string, to: string, what: string): void {
  const deadline = Date.now() + DIR_RENAME_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    try {
      renameSync(fsPath(from), fsPath(to));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // ENOTEMPTY/EEXIST mean the destination is genuinely occupied — waiting
      // cannot help and retrying would hide a real bug. Only the "someone is
      // holding a handle" family is worth a second attempt.
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      if (Date.now() >= deadline) {
        throw new GestaltError(
          "E_LOCKED",
          // `code` directly rather than a carried `lastCode`: the only read is
          // right here, in the same catch that produced it, so the variable was
          // a dead initializer plus an assignment nobody else could observe.
          `Could not ${what} (${code}) after waiting ${DIR_RENAME_BUDGET_MS} ms. ` +
            `On Windows a folder cannot be renamed while any file inside it is open, and something is holding one. ` +
            `Your store was NOT changed and nothing was lost.`,
          "Close other AI tools and editors that have this store open (and pause any virus scanner watching it), then run the command again.",
        );
      }
      // Poll fast: a peer's read is measured in single-digit milliseconds, so a
      // long backoff spends the whole budget asleep through the gap it is
      // waiting for.
      sleepSync(Math.min(2 * 2 ** Math.min(attempt, 2), 10));
      attempt += 1;
    }
  }
}

function safeRemove(target: string): void {
  try {
    rmSync(fsPath(target), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
