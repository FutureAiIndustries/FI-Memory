import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { HomeOpts } from "../paths.js";
import { fsPath, resolveHome, storePaths } from "../paths.js";
import { wipeSessionCache } from "../sessionKeyCache.js";
import type { WipeOutcome } from "../sessionKeyCache.js";
import {
  clearActiveKey,
  decodeLedgerLine,
  decodeLogEntry,
  decryptFile,
  decryptLegacyWholeFileLedger,
  encodeLedgerLine,
  encodeLogEntry,
  encryptFile,
  isWholeFileSealedPath,
  keyState,
  LEDGER_ENC_MAGIC,
} from "../store/codec.js";
import { keyringExists, storeHasSealedContent } from "../store/keyring.js";
import { looksLikeEncryptedLog, parseLog, serializeLogPlain } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { withLock } from "../store/lock.js";

/**
 * `fimemory decrypt` — convert an EXISTING encrypted store back to plaintext at
 * rest. The crash-safe INVERSE of `fimemory encrypt` (ops/migrateEncrypt.ts),
 * built to that command's staged-swap bar and reusing its proven shape.
 *
 * ## Why this exists — "lock when needed", not "locked forever"
 *
 * Encryption at rest stops being the mandatory posture and becomes a posture the
 * owner CHOOSES: work day to day on a plaintext store (frozen invariant §0.1 in
 * its plainest form — plain files a human can read with a text editor), and
 * `encrypt` it when the store has to travel (a backup, a flash drive, a laptop
 * that leaves the house). This verb is the other half of that switch. Encryption
 * remains fully supported and is one command away in both directions.
 *
 * It is NOT a bypass and cannot be used as one. It REQUIRES the store to be
 * UNLOCKED — an active DEK that actually opens this store's ciphertext — so it
 * can only ever decrypt data the caller could already read with `get`, `search`
 * or `export --plaintext`. It grants no access to anyone who did not have it.
 *
 * ## CRASH SAFETY — the same staged-swap model as `encrypt`
 *
 * The store's mode is derived from CONTENT (`storeHasSealedContent` scans for
 * sealed files, `keyringExists` for the keyring), so an in-place per-file
 * re-encode has no atomic flip point in EITHER direction: the instant the first
 * note is written back as plaintext, a store that still advertises itself as
 * encrypted is a fail-closed brick. So we STAGE, exactly as `encrypt` does:
 *
 *   A. Build the COMPLETE plaintext store in a sibling temp dir (`staging`),
 *      NEVER touching `home`. `home` stays intact ciphertext the entire time.
 *   B. VERIFY every staged file — read it BACK off disk and prove it is
 *      byte-identical to the AEAD-authenticated plaintext, and prove the codec
 *      can re-seal it to the same plaintext (so a later `encrypt` round-trips).
 *   C. COMMIT by two atomic renames: `home → backup`, then `staging → home`;
 *      then remove `backup` (the ciphertext original).
 *
 * A crash at ANY point leaves one of exactly these, every one a COMPLETE store:
 *
 *   - during A/B: `home` is the intact ENCRYPTED original; `staging` is a
 *     disposable temp dir. The next run sweeps the staging (which is PLAINTEXT
 *     residue, so sweeping it is required, not merely tidy).
 *   - in the commit GAP (after `home → backup`, before `staging → home`):
 *     `backup` is the intact encrypted original AND `staging` is the intact,
 *     verified plaintext result — two complete stores under discoverable names,
 *     never a mix. A caught failure self-heals by renaming `backup → home`; a
 *     power loss is reconciled on the next run (see `reconcileDecryptResidue`).
 *   - after `staging → home`: `home` is the plaintext result; `backup` is a
 *     leftover ciphertext copy we remove (and say so loudly if removal fails).
 *
 * ## What is NOT reversed: git history and old backups
 *
 * `.git` rides the swap verbatim. The history therefore still holds the
 * CIPHERTEXT commits, exactly as `encrypt` leaves the pre-migration PLAINTEXT in
 * history. From this commit forward the remote receives plaintext — which is the
 * consequence the caller must confirm explicitly (`confirmPlaintextRemote`); it
 * is never inferred, never defaulted, and stated with the remote's URL.
 *
 * ## The road back — keyring.json is ARCHIVED, never deleted
 *
 * `keyring.json` is renamed to `keyring-archived.json` (still plaintext, as it
 * always was — it holds the Argon2id-WRAPPED DEK, not the DEK). Two reasons:
 *  - the old ciphertext does not disappear from the world (git history, old
 *    backups, a flash drive), and the archived keyring + the old passphrase is
 *    what still opens it;
 *  - it is a durable, in-store reminder that this store WAS encrypted.
 * The 24-word recovery phrase remains the master secret for that old ciphertext.
 * A later `fimemory encrypt` mints a NEW keyring and a NEW phrase — it does not
 * and cannot reuse the archived one.
 */

/** The archived keyring's name after a decrypt. Deliberately NOT `keyring.json`
 * (which is what `keyringExists` — and therefore the whole CLI gate — keys on)
 * and deliberately NOT a `.bak`-style suffix that reads as junk. */
export const ARCHIVED_KEYRING_NAME = "keyring-archived.json";

export interface MigrateDecryptOptions extends HomeOpts {
  /**
   * REQUIRED acknowledgement (unless `confirm` is supplied and answered): after
   * this runs, the store's git remote receives PLAINTEXT. Never defaulted true.
   */
  confirmPlaintextRemote?: boolean;
  /**
   * Interactive confirmation seam. When `confirmPlaintextRemote` is not set and
   * this IS set, the op renders the plan through `out` and asks; the caller must
   * answer with the exact word `decrypt`. Anything else aborts, changing nothing.
   */
  confirm?: (question: string) => Promise<string>;
  /** Where the plan/confirmation prose is written (defaults to nothing). */
  out?: (line: string) => void;
  /** Sink for LOUD residue/recovery warnings (defaults to process.stderr). */
  warn?: (msg: string) => void;
  /**
   * Delete the ciphertext backup after a successful swap. Default FALSE: the
   * backup is the one-command way back from a migration that runs once against
   * an irreplaceable store, and a cheap always-available undo is worth more than
   * a tidy parent directory. Opt in only when you have checked the result.
   */
  removeBackup?: boolean;
  /** Injected git probe (tests). Defaults to a real `git` subprocess. */
  git?: GitProbe;
  /** Injected liveness probe for scheduler-lock pids (tests). */
  isPidAlive?: (pid: number) => boolean;
  /** TEST-ONLY crash-injection hooks — see the docstrings on each. */
  hooks?: DecryptHooks;
}

/** TEST-ONLY seams used to DRIVE the crash-safety proofs; never wired from the CLI. */
export interface DecryptHooks {
  /**
   * Called after each content file is written into `staging` (store-relative
   * path + 1-based count). THROW to simulate a crash mid-staging — `home` is
   * still the untouched encrypted original.
   */
  afterStageFile?: (rel: string, count: number) => void;
  /**
   * Called after staging is fully built, immediately BEFORE verifyStaged, so a
   * test can mutate `staging` (e.g. plant a leaked `.x.tmp-1-1`, or corrupt a
   * staged file) and drive the pre-swap audit.
   */
  beforeVerify?: (staging: string) => void;
  /**
   * Called in the commit GAP: after `home → backup`, before `staging → home`,
   * with the three temp paths so a test can assert BOTH survivors are intact.
   * THROW to simulate a crash there — the migration self-heals by renaming
   * `backup → home` (restoring the encrypted original).
   */
  inCommitGap?: (paths: { home: string; backup: string; staging: string }) => void;
  /**
   * Called right before the final ciphertext-backup removal, AFTER
   * `staging → home` has committed. THROW to simulate a kill in that window:
   * `home` is already the plaintext result and the ciphertext `backup` sibling
   * survives as residue a later run must detect + surface.
   */
  beforeRemoveBackup?: (backup: string) => void;
}

/** What the run WILL change — rendered before any confirmation, and returned. */
export interface DecryptPlan {
  home: string;
  notes: number;
  logs: number;
  proposals: number;
  ledgers: number;
  /** Whole-file sealed blobs outside the content dirs (the Harness `work/` mirror). */
  mirrors: number;
  /** True if index.json exists and will be rewritten as plaintext. */
  index: boolean;
  /** The git remote that will hold this content in the clear, if any. */
  remoteUrl: string | null;
  /** The upstream tracking ref compared against, if any. */
  upstream: string | null;
  /**
   * Where keyring.json is being moved to (absolute), or NULL when this store has
   * no keyring at all.
   *
   * A store unlocked through `GESTALT_KEY` has sealed content and an active DEK
   * but never had a `keyring.json` — `archiveKeyring` correctly returns early for
   * it. Reporting a path anyway (this used to be a non-optional string) was a
   * FALSE CLAIM ABOUT RECOVERABILITY: the CLI told the user "your keyring was
   * kept at <path> — it is what still opens the ciphertext in git history and in
   * your old backups. Keep both", naming a file that does not exist, and
   * `.gitignore` gained a line for it. Someone deleting an old backup on the
   * strength of that sentence loses the only copy. Null here means: say nothing
   * was archived, and say what the old ciphertext actually needs (GESTALT_KEY).
   */
  archivedKeyring: string | null;
  /**
   * Log entries whose raw text ends in blank line(s). The plaintext log format
   * separates entries with a blank line, so a trailing newline INSIDE an entry
   * cannot be represented — it parses back without it. Sealed per-entry storage
   * keeps whatever raw it was handed, so real stores accumulate a few. They are
   * normalised before anything is written, and counted here so the plan can say
   * so out loud: an unannounced trim is how a migration quietly edits content.
   */
  trimmedLogEntries: number;
}

export interface MigrateDecryptResult {
  home: string;
  /** False on the already-plaintext no-op path (exit 0, nothing changed). */
  changed: boolean;
  /** Human-readable statement of what happened (always present). */
  message: string;
  notes: number;
  logs: number;
  proposals: number;
  ledgers: number;
  mirrors: number;
  /** Absolute path of the preserved keyring — ABSENT when the store had none
   * (a `GESTALT_KEY` store). Never a path to a file that was not created. */
  archivedKeyring?: string;
  remoteUrl?: string | null;
  /** The session-key-cache wipe outcome — a FAILED wipe leaves a DEK on disk. */
  sessionWipe?: WipeOutcome;
  /**
   * The encrypted copy of the pre-decrypt store, KEPT beside the home (the
   * default). Rename it back over `home` to undo the decrypt. Absent when
   * `removeBackup` was requested.
   */
  ciphertextBackup?: string;
  /** Present ONLY when the ciphertext backup could not be removed after the
   * swap: the store IS plaintext, but an encrypted COPY still sits here. */
  ciphertextBackupRemovalFailed?: { path: string; error: string };
  /** Log entries whose trailing blank line the plaintext format cannot hold
   * (see DecryptPlan.trimmedLogEntries). 0 on a store with none. */
  trimmedLogEntries: number;
}

// ── The same anchored classifiers `encrypt` uses (see migrateEncrypt.ts) ──────

/** `store/atomic.ts`'s exact temp name: `.${basename}.tmp-${pid}-${ctr}`. */
const ATOMIC_TEMP_RE = /^\.([^\\/]+)\.tmp-\d+-\d+$/;
const isAtomicTemp = (name: string): boolean => ATOMIC_TEMP_RE.test(name);
function atomicTempBase(name: string): string | null {
  const m = ATOMIC_TEMP_RE.exec(name);
  return m ? m[1]! : null;
}

/** Root store files that are atomically (re)written — a `.<base>.tmp-*` for one
 * of these is unambiguously our own crashed-write residue, skipped SILENTLY. */
const KNOWN_ATOMIC_TEMP_BASES = new Set([
  "index.json",
  "store.enc",
  "keyring.json",
  "config.json",
]);

/** The transient write lock (a directory, created by proper-lockfile). */
const LOCKFILE_NAME = ".gestalt.lock";

/** The whole-file seal's magic prefix (store/codec.ts `encryptFile`). */
const ENC_MAGIC = "gestalt-enc:1:";

/** Strip a leading BOM/indent for a magic DETECTION test ONLY — never applied to
 * bytes we hand back. Same normalization `store/keyring.ts`'s finders use: a
 * restore/copy/editor round trip can prepend a BOM or indent the first line, and
 * a naked startsWith would then read sealed bytes as plaintext. */
const stripLeadingBomWs = (s: string): string => s.replace(/^[\uFEFF\s]+/, "");

/**
 * Names the decrypt REGENERATES into staging, so the generic carry must not also
 * copy them. `ledgers/` is deliberately ABSENT: only the sealed `*.jsonl` inside
 * it are rewritten, and those live in `ledgers/` AND in roll-up siblings a real
 * store keeps (`ledgers-archive-<date>/`). Copying every such directory verbatim
 * first and then OVERWRITING the rewritten files handles both shapes with one
 * rule and cannot drop a README, a subdirectory, or an already-plaintext ledger.
 */
const REGENERATED = new Set(["topics", "logs", "proposals", "index.json"]);

/**
 * Names DROPPED on purpose, each for a stated reason:
 *  - store.enc   — the sealed store-mode marker. A plaintext store has none, and
 *                  leaving it would make `storeHasSealedContent` read the result
 *                  as encrypted: a brick.
 *  - keyring.json — not dropped, MOVED to `keyring-archived.json` (handled
 *                  separately below; listed here so the generic carry skips it).
 */
const DROPPED_OR_MOVED = new Set(["store.enc", "keyring.json"]);

/** Content subdirs regenerated whole, with the suffix each one's files carry. */
const CONTENT_SUBDIRS: ReadonlyArray<{ sub: string; suffix: string }> = [
  { sub: "topics", suffix: ".md" },
  { sub: "proposals", suffix: ".md" },
  { sub: "logs", suffix: ".log.md" },
];

function isCanonicalContentFile(name: string, suffix: string): boolean {
  return !name.startsWith(".") && name.endsWith(suffix);
}

interface WholeFile {
  id: string;
  /** The AEAD-opened plaintext. */
  plain: string;
  /** The exact ciphertext bytes read off disk (the re-seal fixed-point input). */
  cipher: string;
}
interface Log {
  id: string;
  entries: LogEntry[];
  /**
   * How many entries carried trailing blank lines that the plaintext format
   * cannot represent (see readEncryptedLogs). Reported in the plan so the
   * normalisation is stated, never silent.
   */
  trimmedEntries?: number;
}
/** A ledger file: per-LINE sealed JSONL, kept line-for-line (never re-ordered,
 * never dropped — `parseLedger` skips bad lines, which a migration may not do). */
interface Ledger {
  /** Path relative to the store home, using "/" separators. */
  rel: string;
  lines: string[];
}

// ── git state ────────────────────────────────────────────────────────────────

export interface GitState {
  /** False when the store is not a git repo at all — every git guard is moot. */
  isRepo: boolean;
  /** Porcelain status lines (empty ⇒ clean). */
  dirty: string[];
  /** e.g. "rebase", "merge", "cherry-pick" — an operation git has half-finished. */
  inProgress: string[];
  upstream: string | null;
  ahead: number;
  behind: number;
  remoteUrl: string | null;
}

export type GitProbe = (home: string) => GitState;

function runGit(home: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: home, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return { ok: false, out: ((r.stderr ?? "") || (r.stdout ?? "")).trim() };
  }
  return { ok: true, out: (r.stdout ?? "").trim() };
}

/**
 * Read the store repo's state WITHOUT touching the network.
 *
 * Deliberately offline: `git fetch` would make this command's safety depend on
 * a network round trip, and a fetch that fails (offline laptop, expired token)
 * would either block the migration or — worse — be skipped and silently downgrade
 * the guard. So we compare against the LOCALLY KNOWN remote-tracking ref and the
 * refusal text says so, telling the user to `git fetch` first for a current
 * answer. An honest stale comparison the user is told about beats a fresh one
 * they cannot rely on.
 */
export function probeGit(home: string): GitState {
  const empty: GitState = {
    isRepo: false,
    dirty: [],
    inProgress: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    remoteUrl: null,
  };
  if (!existsSync(fsPath(path.join(home, ".git")))) return empty;
  const top = runGit(home, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return empty;

  const inProgress: string[] = [];
  const gitDirOut = runGit(home, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirOut.ok
    ? path.resolve(home, gitDirOut.out)
    : path.join(home, ".git");
  const marker = (rel: string, label: string): void => {
    if (existsSync(fsPath(path.join(gitDir, rel)))) inProgress.push(label);
  };
  marker("rebase-merge", "rebase");
  marker("rebase-apply", "rebase");
  marker("MERGE_HEAD", "merge");
  marker("CHERRY_PICK_HEAD", "cherry-pick");
  marker("REVERT_HEAD", "revert");
  marker("BISECT_LOG", "bisect");

  const status = runGit(home, ["status", "--porcelain"]);
  const dirty = status.ok
    ? status.out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
    : [];

  const up = runGit(home, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = up.ok && up.out.length > 0 ? up.out : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = runGit(home, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (counts.ok) {
      const [b, a] = counts.out.split(/\s+/);
      behind = Number.parseInt(b ?? "0", 10) || 0;
      ahead = Number.parseInt(a ?? "0", 10) || 0;
    }
  }
  const remoteName = upstream ? (upstream.split("/")[0] ?? "origin") : "origin";
  const url = runGit(home, ["remote", "get-url", remoteName]);
  return {
    isRepo: true,
    dirty: [...new Set(dirty)],
    inProgress: [...new Set(inProgress)],
    upstream,
    ahead,
    behind,
    remoteUrl: url.ok && url.out.length > 0 ? url.out : null,
  };
}

// ── live-writer detection ────────────────────────────────────────────────────

export interface LiveWriter {
  /** Absolute path of the lock file. */
  path: string;
  pid: number;
  /** Whatever the lock says about itself, for a message that names what to stop. */
  label: string;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid EXISTS but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Case-fold + separator-normalize a path for the "is this MY home?" test. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Find daemon/scheduler lock FILES in the store root that a LIVE process holds.
 *
 * The shape in the wild (`.harness-scheduler-<machineId>.lock`) is JSON with
 * `pid`, `machineId`, `gestaltHome`, `configDir`, `startedAt`. Two rules make
 * this both effective and safe:
 *
 *  1. A lock whose `gestaltHome` names a DIFFERENT path than the store we are
 *     migrating belongs to ANOTHER MACHINE — these files ride the git sync, so
 *     this store really does carry a Linux daemon's lock with a Linux pid. Its
 *     pid number means nothing here, and testing it would refuse the command
 *     because some unrelated local process happens to own that number. Skipped.
 *  2. Everything else is pid-probed, and a LIVE pid REFUSES the migration
 *     naming the lock file, the pid and the config dir — i.e. naming what to stop.
 *
 * `.gestalt.lock` (proper-lockfile's DIRECTORY) is not a match: `withLock` owns
 * that contention and would already have waited for it.
 */
export function detectLiveWriters(
  home: string,
  isAlive: (pid: number) => boolean = defaultIsPidAlive,
): LiveWriter[] {
  const out: LiveWriter[] = [];
  let entries: string[];
  try {
    entries = readdirSync(fsPath(home));
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".lock") || name === LOCKFILE_NAME) continue;
    const abs = path.join(home, name);
    try {
      if (!statSync(fsPath(abs)).isFile()) continue;
    } catch {
      continue;
    }
    let parsed: { pid?: unknown; gestaltHome?: unknown; configDir?: unknown; machineId?: unknown };
    try {
      parsed = JSON.parse(readFileSync(fsPath(abs), "utf8")) as typeof parsed;
    } catch {
      continue; // not one of ours / not machine-readable — never guess
    }
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
    if (!Number.isInteger(pid)) continue;
    // Rule 1: a lock that names another machine's store path is that machine's.
    if (typeof parsed.gestaltHome === "string" && !samePath(parsed.gestaltHome, home)) continue;
    if (!isAlive(pid)) continue; // stale leftover from a process that is gone
    const bits = [`pid ${pid}`];
    if (typeof parsed.machineId === "string") bits.push(`machine ${parsed.machineId}`);
    if (typeof parsed.configDir === "string") bits.push(`config ${parsed.configDir}`);
    out.push({ path: abs, pid, label: bits.join(", ") });
  }
  return out;
}

// ── the op ───────────────────────────────────────────────────────────────────

/**
 * Convert the encrypted store at `home` to plaintext, crash-safely. FAILS CLOSED
 * on every guard; VERIFIES before it commits; leaves either the intact encrypted
 * original or the intact plaintext result, never a mix.
 */
export async function migrateToPlaintext(
  opts: MigrateDecryptOptions = {},
): Promise<MigrateDecryptResult> {
  const home = resolveHome(opts);
  const paths = storePaths(home);
  const warn = opts.warn ?? ((m: string) => void process.stderr.write(m));
  const out = opts.out ?? ((): void => {});

  // ── Residue reconciliation — FIRST, before every guard (mirrors `encrypt`) ──
  reconcileDecryptResidue(home, paths, warn);

  // ── Store must exist ───────────────────────────────────────────────────────
  if (!existsSync(fsPath(paths.home)) || !homeHasStoreMaterial(home)) {
    // NEVER the `init` hint while this command's own residue sits beside the
    // home — that is the crash-gap trap (see `decryptResidueGuidance`).
    const guidance = decryptResidueGuidance(home);
    if (guidance) throw new GestaltError("E_IO", guidance.message, guidance.hint);
    throw new GestaltError(
      "E_NOT_FOUND",
      `No FIMemory store at ${home}.`,
      `fimemory init --home "${home}"`,
    );
  }

  // ── Already plaintext → NO-OP, exit 0, say so clearly ──────────────────────
  // Content-derived exactly like the CLI's own gate, so this answer can never
  // disagree with how the rest of the runtime reads the store.
  if (!keyringExists(home) && !storeHasSealedContent(home)) {
    const stray = findDecryptResidue(home);
    for (const p of stray.ciphertext) {
      warn(
        `fimemory decrypt: an ENCRYPTED copy from an interrupted decrypt is still on disk: ${p} — ` +
          `the runtime will not remove it for you; delete it once you are satisfied ${home} is complete.\n`,
      );
    }
    for (const p of stray.keptBackup) {
      warn(
        `fimemory decrypt: the ENCRYPTED backup from the decrypt that already ran is still here: ${p} — ` +
          `rename it back over ${home} to undo that decrypt, or delete it once you are satisfied ${home} is complete.\n`,
      );
    }
    return {
      home,
      changed: false,
      message: `${home} is already plaintext — nothing to decrypt.`,
      trimmedLogEntries: 0,
      notes: 0,
      logs: 0,
      proposals: 0,
      ledgers: 0,
      mirrors: 0,
    };
  }

  // ── HALT AND ASK on an ambiguous pair (mirrors `encrypt`'s FIX B) ──────────
  // `home` is encrypted AND a ciphertext sibling from an interrupted run also
  // holds memory: which one is the real store is ambiguous. Refuse, name both.
  {
    const bearing = findDecryptResidue(home).ciphertext.filter(homeHasStoreMaterial);
    if (bearing.length > 0) {
      throw new GestaltError(
        "E_STORE_MODE",
        `Cannot decrypt ${home}: an encrypted store from an interrupted decrypt also sits beside it at ${bearing.join(", ")} — which one holds your real data is ambiguous, so nothing was changed.`,
        `Recover the store you want at ${home} and remove the other, then run \`fimemory decrypt\`.`,
      );
    }
  }

  // ── The store must be UNLOCKED (this is what makes decrypt not a bypass) ───
  if (keyState().mode !== "encrypted") {
    throw new GestaltError(
      "E_STORE_MODE",
      "This store is encrypted and locked — `decrypt` can only convert data you can already read, so it needs the store unlocked first.",
      `Set GESTALT_PASSPHRASE (or pass --passphrase "..."), then run \`fimemory decrypt\`.`,
    );
  }

  // ── Live writers ───────────────────────────────────────────────────────────
  const live = detectLiveWriters(home, opts.isPidAlive ?? defaultIsPidAlive);
  if (live.length > 0) {
    const named = live.map((w) => `${path.basename(w.path)} (${w.label})`).join("; ");
    throw new GestaltError(
      "E_LOCKED",
      `Cannot decrypt ${home}: something is actively writing to this store — ${named}. Rewriting every file underneath a live writer would lose its writes, so nothing was changed.`,
      `Stop that process (its lock file names the pid and its config dir), then run \`fimemory decrypt\`. If the process is already gone, delete the stale lock file it left behind.`,
    );
  }

  // ── git: clean, no half-finished operation, in step with the remote ────────
  const git = (opts.git ?? probeGit)(home);
  assertGitSafe(home, git);

  // ── Read + decrypt EVERYTHING before anything is written ───────────────────
  // One unreadable file aborts the whole run with `home` untouched (the read
  // happens under the lock together with the staging build).
  const { config } = loadConfig(paths.config);

  // ── State the consequence and get consent BEFORE taking the write lock ─────
  // The interactive path waits on a human typing a word. Holding the store's
  // write lock across that would block every daemon and MCP server on this box
  // for as long as the person takes to read — and proper-lockfile's 60 s stale
  // window would then expire underneath us and fire `onCompromised` mid-run. So
  // the plan is built from a CHEAP census (a readdir, no key needed: it counts
  // the files that exist, which is exactly the number that will be rewritten),
  // consent is taken, and only then do we lock and do the real work.
  await confirmOrRefuse(census(home, paths, git), opts, out);

  const committer = await withLock(home, config.lockWaitMs, async () => {
    const src = readEncryptedStore(home, paths);
    // Taken RIGHT AFTER the read that produced the plaintext, so it describes
    // exactly the bytes being staged. Re-checked immediately before the first
    // rename (see `censusFiles` for why the swap cannot simply hold the lock).
    const census = censusFiles(home);
    const plan: DecryptPlan = {
      home,
      notes: src.notes.length,
      logs: src.logs.length,
      proposals: src.proposals.length,
      ledgers: src.ledgers.length,
      mirrors: src.mirrors.length,
      index: src.indexPlain !== null,
      remoteUrl: git.remoteUrl,
      upstream: git.upstream,
      archivedKeyring: archivedKeyringPath(home),
      trimmedLogEntries: src.logs.reduce((n, l) => n + (l.trimmedEntries ?? 0), 0),
    };
    return buildAndVerifyStaging(home, paths, src, plan, census, opts, warn);
  });

  // ── Commit (lock released) ────────────────────────────────────────────────
  return commitSwap(home, committer, opts, warn);
}

/** Everything the committer needs, produced under the lock. */
interface Committer {
  staging: string;
  backup: string;
  plan: DecryptPlan;
  /** The store's mutable surface as it was when we READ it — re-checked in
   * `commitSwap` immediately before the first rename (see `censusFiles`). */
  census: Map<string, string>;
}

// ── the acknowledged-write window ────────────────────────────────────────────

/**
 * A cheap fingerprint of everything in the store a writer could touch: one
 * `size:mtime` per file.
 *
 * WHY THIS EXISTS — the honest statement of the residual risk. The commit swap
 * runs OUTSIDE the store write lock: `withLock` returns the Committer, the lock
 * releases, and only then does `commitSwap` rename `home` away. A peer write
 * ACKed in that window lands in a directory that is immediately renamed and
 * (previously) deleted — a silently lost, already-acknowledged write. The same
 * shape as shipped `encrypt`, so not a regression, but THIS store is written by
 * two MCP hosts, an office daemon and an hourly scheduled task.
 *
 * Holding the lock across the swap is not the fix: `renameDirWithRetrySync` can
 * wait seconds on Windows, and proper-lockfile's 60 s stale window expiring
 * mid-rename would fire `onCompromised` in the middle of the one operation that
 * must not be interrupted. So instead the window is made LOUD: this census is
 * taken under the lock, right after the read that produced the plaintext, and
 * re-taken immediately before the first rename. Anything different — a new file,
 * a vanished file, a changed size or mtime, a moved git ref, a live daemon lock,
 * a peer holding the write lock — ABORTS before anything is touched, naming what
 * changed. It cannot make the window zero; it shrinks it to the rename itself
 * and converts a silent loss into a refusal.
 *
 * Cost is bounded on purpose: `.git` is NOT walked (a real store's object
 * database is tens of thousands of files). Only the refs a commit would move are
 * read — HEAD, packed-refs and everything under refs/ — which is what catches a
 * peer's `git commit` landing in the window. `.git/index` is deliberately NOT
 * included: a peer's read-only `git status` rewrites it, and aborting on someone
 * else LOOKING at the repo would be a false alarm.
 */
function censusFiles(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const record = (rel: string, abs: string): void => {
    try {
      const st = statSync(fsPath(abs));
      if (st.isFile()) out.set(rel, `${st.size}:${st.mtimeMs}`);
    } catch {
      /* vanished between readdir and stat — the next census disagrees, which is
         exactly the signal we want */
    }
  };
  const walk = (relDir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(fsPath(path.join(home, relDir)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      // Our OWN write lock is transient by construction — it exists while the
      // "before" census is taken and is gone by the "after" one. Comparing it
      // would abort every single run. A peer holding it is checked directly.
      if (relDir === "" && e.name === LOCKFILE_NAME) continue;
      if (relDir === "" && e.name === ".git") {
        for (const g of [".git/HEAD", ".git/packed-refs"]) record(g, path.join(home, g));
        walk(".git/refs");
        continue;
      }
      if (e.isDirectory()) walk(rel);
      else record(rel, path.join(home, rel));
    }
  };
  walk("");
  return out;
}

/** What moved between two censuses, as user-facing path lists. */
function censusDiff(
  before: Map<string, string>,
  after: Map<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [rel, sig] of after) {
    const was = before.get(rel);
    if (was === undefined) added.push(rel);
    else if (was !== sig) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/**
 * The last gate before the point of no return. Runs with the lock RELEASED,
 * immediately before `home → backup`, and throws with `home` and `staging` both
 * untouched — so a concurrent writer costs the operator a re-run, never a write.
 */
function assertNothingChangedSinceRead(
  home: string,
  c: Committer,
  isPidAlive: (pid: number) => boolean,
): void {
  const bail = (what: string, detail: string): never => {
    throw new GestaltError(
      "E_LOCKED",
      `Cannot decrypt ${home}: ${what} while this run was preparing, so the plaintext copy it built is already out of date. Swapping it in would DISCARD that change — nothing was touched. ${detail}`,
      `Stop everything that writes to this store (MCP servers, the office daemon, the hourly task, other terminals), then run \`fimemory decrypt\` again.`,
    );
  };

  // A daemon/scheduler lock that appeared (or came alive) since the pre-flight.
  const live = detectLiveWriters(home, isPidAlive);
  if (live.length > 0) {
    bail(
      "a live writer appeared",
      `Holding the store now: ${live.map((w) => `${path.basename(w.path)} (${w.label})`).join("; ")}.`,
    );
  }

  // A peer holding the store's own write lock — it acquired it in the instant
  // between our release and this check, and its write would land in a directory
  // about to be renamed away.
  try {
    const held = lockfile.checkSync(fsPath(home), {
      lockfilePath: fsPath(storePaths(home).lockfile),
      realpath: false,
      stale: 60_000,
    });
    if (held) bail("another process took the store's write lock", `Its write would be lost.`);
  } catch {
    /* checkSync throws when there is no lock at all — that is the normal case */
  }

  const diff = censusDiff(c.census, censusFiles(home));
  const changed = diff.added.length + diff.removed.length + diff.modified.length;
  if (changed === 0) return;
  const show = (label: string, list: string[]): string =>
    list.length === 0 ? "" : ` ${label}: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ` (and ${list.length - 5} more)` : ""}.`;
  bail(
    `${changed} file(s) in the store changed`,
    `${show("Added", diff.added)}${show("Modified", diff.modified)}${show("Removed", diff.removed)}`.trim(),
  );
}

// ── guards ───────────────────────────────────────────────────────────────────

/** Any canonical store material at `dir` — the mirror of `encrypt`'s shared
 * `homeHasMemory`, kept local so the two commands cannot deadlock on imports. */
function homeHasStoreMaterial(dir: string): boolean {
  return (
    existsSync(fsPath(path.join(dir, "config.json"))) ||
    existsSync(fsPath(path.join(dir, "keyring.json"))) ||
    existsSync(fsPath(path.join(dir, ARCHIVED_KEYRING_NAME))) ||
    existsSync(fsPath(path.join(dir, "topics"))) ||
    existsSync(fsPath(path.join(dir, "logs"))) ||
    existsSync(fsPath(path.join(dir, "proposals")))
  );
}

/**
 * Refuse on a git tree that is dirty, mid-operation, or out of step with its
 * remote. This is the guard the whole migration is gated on: `decrypt` rewrites
 * EVERY tracked file in one go, and a rewrite landing on top of uncommitted work
 * — or racing a divergence — is a conflict storm across every machine that syncs
 * this store, in files that are one blob each and therefore do not merge.
 *
 * "Out of step" is deliberately stricter than git's own word "diverged" (both
 * ahead AND behind). BEHIND alone is just as bad here: the next `pull` brings
 * the remote's CIPHERTEXT commits back onto a plaintext tree. AHEAD alone means
 * the remote has not seen the pre-decrypt state, so the plaintext rewrite lands
 * on a base nobody else has. Both are refused, and the message says which.
 */
function assertGitSafe(home: string, git: GitState): void {
  if (!git.isRepo) return;
  if (git.inProgress.length > 0) {
    throw new GestaltError(
      "E_STORE_MODE",
      `Cannot decrypt ${home}: git has an unfinished ${git.inProgress.join(" and ")} in this store. Rewriting every file mid-${git.inProgress[0]} would make the conflict unresolvable, so nothing was changed.`,
      `Finish or abort it (\`git -C "${home}" ${git.inProgress[0] === "merge" ? "merge" : git.inProgress[0]} --abort\`), then run \`fimemory decrypt\`.`,
    );
  }
  if (git.dirty.length > 0) {
    const shown = git.dirty.slice(0, 5).join(", ");
    const more = git.dirty.length > 5 ? ` (and ${git.dirty.length - 5} more)` : "";
    throw new GestaltError(
      "E_STORE_MODE",
      `Cannot decrypt ${home}: the store's git tree has uncommitted changes — ${shown}${more}. A whole-store rewrite on top of uncommitted work is unrecoverable, so nothing was changed.`,
      `Commit or stash them (\`git -C "${home}" status\`), then run \`fimemory decrypt\`.`,
    );
  }
  if (git.upstream && (git.ahead > 0 || git.behind > 0)) {
    const how =
      git.ahead > 0 && git.behind > 0
        ? `diverged from ${git.upstream} (${git.ahead} ahead, ${git.behind} behind)`
        : git.ahead > 0
          ? `${git.ahead} commit(s) ahead of ${git.upstream}`
          : `${git.behind} commit(s) behind ${git.upstream}`;
    throw new GestaltError(
      "E_STORE_MODE",
      `Cannot decrypt ${home}: this store is ${how}. Rewriting every file while the remote holds a different state is a conflict storm on every machine that syncs it, so nothing was changed. (Compared against the remote-tracking ref on this disk — no network fetch was made.)`,
      `Run \`git -C "${home}" fetch\` then \`git -C "${home}" pull --rebase\` and \`git -C "${home}" push\` until the store is level with ${git.upstream}, then run \`fimemory decrypt\`.`,
    );
  }
}

/**
 * Count what will be rewritten WITHOUT decrypting anything — a readdir per
 * content dir. Used only to render the plan before consent is taken, so the
 * store's write lock is not held across a human reading a warning. The real
 * numbers (which must and do agree) come from the read under the lock.
 */
function census(home: string, paths: ReturnType<typeof storePaths>, git: GitState): DecryptPlan {
  const count = (dir: string, suffix: string): number => {
    try {
      return readdirSync(fsPath(dir)).filter((n) => isCanonicalContentFile(n, suffix)).length;
    } catch {
      return 0;
    }
  };
  // The SAME predicate `readLedgers` uses, so the number the user consents to is
  // exactly the number that gets rewritten — never a head-only approximation
  // that quietly under-counts a file whose first sealed line sits further down.
  const ledgers = walkJsonl(home).filter((rel) => isSealedLedger(path.join(home, rel))).length;
  return {
    home,
    notes: count(paths.topicsDir, ".md"),
    logs: count(paths.logsDir, ".log.md"),
    proposals: count(paths.proposalsDir, ".md"),
    ledgers,
    mirrors: sealedMirrorPaths(home).length,
    index: existsSync(fsPath(paths.index)),
    remoteUrl: git.remoteUrl,
    upstream: git.upstream,
    archivedKeyring: archivedKeyringPath(home),
    // Keyless census: it counts files, it does not open them, so it cannot know
    // which entries carry trailing blank lines. The real plan (built under the
    // key) fills this in.
    trimmedLogEntries: 0,
  };
}

/** Where this store's keyring WILL be archived, or null if it has no keyring to
 * archive. The single source of truth for that question — the plan, the
 * `.gitignore` append and the CLI's "keep both" paragraph must all agree, and
 * the one thing none of them may do is name a file that will not exist. */
function archivedKeyringPath(home: string): string | null {
  return existsSync(fsPath(path.join(home, "keyring.json")))
    ? path.join(home, ARCHIVED_KEYRING_NAME)
    : null;
}

/** The unmissable remote-plaintext statement + the required confirmation. */
async function confirmOrRefuse(
  plan: DecryptPlan,
  opts: MigrateDecryptOptions,
  out: (line: string) => void,
): Promise<void> {
  const lines = planLines(plan);
  if (opts.confirmPlaintextRemote === true) {
    for (const l of lines) out(l);
    return;
  }
  if (opts.confirm) {
    for (const l of lines) out(l);
    const answer = await opts.confirm('Type "decrypt" to continue: ');
    if (answer.trim().toLowerCase() !== "decrypt") {
      throw new GestaltError(
        "E_STORE_MODE",
        "Decrypt cancelled — nothing was changed.",
        `Run \`fimemory decrypt\` again when you are ready.`,
      );
    }
    return;
  }
  throw new GestaltError(
    "E_SCHEMA",
    lines.join("\n") + "\n\nThis needs an explicit acknowledgement.",
    `fimemory decrypt --yes-plaintext-remote   (or run it in a terminal and type "decrypt" when asked)`,
  );
}

/** The "what will change" report — printed before the confirmation, always. */
export function planLines(plan: DecryptPlan): string[] {
  const lines = [
    `fimemory decrypt — ${plan.home}`,
    ``,
    `  This rewrites the store to PLAINTEXT on disk:`,
    `    ${plan.notes} note(s), ${plan.logs} log(s), ${plan.proposals} suggested edit(s), ${plan.ledgers} task ledger file(s)${plan.mirrors > 0 ? `, ${plan.mirrors} mirrored report(s)` : ""}${plan.index ? ", and index.json" : ""}`,
    `    store.enc (the encrypted-store marker) is removed`,
  ];
  if (plan.trimmedLogEntries > 0) {
    lines.push(
      `    ${plan.trimmedLogEntries} log entr${plan.trimmedLogEntries === 1 ? "y ends" : "ies end"} in a blank line; the plaintext`,
      `      format separates entries with one, so that trailing blank line is dropped.`,
      `      No other character of any entry changes.`,
    );
  }
  // Only claim the archive when there IS a keyring to archive. A GESTALT_KEY
  // store has none, and promising a file that will not exist is a false claim
  // about what can still open the old ciphertext (see DecryptPlan).
  if (plan.archivedKeyring) {
    lines.push(
      `    keyring.json is KEPT, renamed to ${ARCHIVED_KEYRING_NAME}`,
      `    .gitignore gains one line so that archived keyring never reaches the remote`,
    );
  } else {
    lines.push(
      `    this store has no keyring.json (it is unlocked with GESTALT_KEY), so nothing is archived`,
      `    — the ciphertext already in git history and in your old backups stays openable`,
      `      ONLY with that GESTALT_KEY value. Keep it.`,
    );
  }
  if (plan.remoteUrl) {
    lines.push(
      ``,
      `  THE REMOTE WILL HOLD YOUR MEMORY IN PLAINTEXT.`,
      `    ${plan.remoteUrl}`,
      `    Every note, log entry and suggested edit becomes readable to anyone who can`,
      `    read that repository — from the next push onward. Nothing un-publishes it.`,
      `    (The ciphertext already in git history stays ciphertext; this is not a rewrite`,
      `     of past commits, and it does not un-publish anything either.)`,
    );
  } else {
    lines.push(
      ``,
      `  This store has no git remote, so nothing is published by this change.`,
      `  If you ADD a remote later, it will hold your memory in plaintext.`,
    );
  }
  lines.push(
    ``,
    `  THE WAY BACK: your store is renamed aside as an ENCRYPTED copy and KEPT.`,
    `    Rename that copy back over ${plan.home} and this decrypt is undone.`,
    `    It is not deleted unless you ask (\`--remove-backup\`); \`fimemory status\``,
    `    keeps reminding you it is there.`,
    ``,
    `  ONE WINDOW REMAINS, honestly: the final swap happens with the store's write`,
    `    lock released, so a write ACKed by another process in that instant would be`,
    `    lost. Everything is re-checked immediately before the swap and the run`,
    `    ABORTS if anything moved — but the rename itself cannot be made atomic`,
    `    against other writers. Stop your MCP servers, daemons and scheduled tasks`,
    `    first.`,
    ``,
    `  To lock it again — for a backup, a flash drive, a laptop that leaves the house —`,
    `  run \`fimemory encrypt\`. That mints a NEW key and a NEW 24-word phrase.`,
  );
  if (plan.archivedKeyring) {
    lines.push(
      `  Keep the phrase you already wrote down: with ${ARCHIVED_KEYRING_NAME} it is what`,
      `  still opens the ciphertext already in git history and in your old backups.`,
    );
  }
  lines.push(``);
  return lines;
}

// ── read (decrypt) ───────────────────────────────────────────────────────────

/** A whole-file sealed blob living OUTSIDE the canonical content dirs — the
 * Harness `work/` report mirror is the real one (index.ts exports `encryptFile`
 * for exactly that). Keyed by its store-relative path, because the codec's AAD
 * binds to the file's own basename and kind. */
interface Mirror {
  rel: string;
  plain: string;
}

interface SourceStore {
  notes: WholeFile[];
  proposals: WholeFile[];
  logs: Log[];
  ledgers: Ledger[];
  mirrors: Mirror[];
  indexPlain: string | null;
  indexCipher: string | null;
}

/**
 * Read + AEAD-open EVERY encrypted file, holding the plaintext in memory. This
 * is the "one unreadable file = abort, touch nothing" guard: `decryptFile` and
 * `parseLog` both FAIL CLOSED (wrong key, tampered blob, or plaintext where
 * ciphertext was expected), and nothing has been written when they throw.
 */
function readEncryptedStore(home: string, paths: ReturnType<typeof storePaths>): SourceStore {
  const notes = readWholeFiles(paths.topicsDir, ".md");
  const proposals = readWholeFiles(paths.proposalsDir, ".md");
  const logs = readEncryptedLogs(paths.logsDir);
  const ledgers = readLedgers(home);
  const mirrors = readSealedMirrors(home);
  let indexPlain: string | null = null;
  let indexCipher: string | null = null;
  if (existsSync(fsPath(paths.index))) {
    indexCipher = readFileSync(fsPath(paths.index), "utf8");
    indexPlain = openOrFail(paths.index, indexCipher, "index.json");
  }
  return { notes, proposals, logs, ledgers, mirrors, indexPlain, indexCipher };
}

/**
 * Whole-file sealed blobs ANYWHERE else in the store.
 *
 * This is not hypothetical padding. The runtime exports `encryptFile` precisely
 * so the Harness can seal the report blobs it mirrors into the store repo under
 * `work/` (src/index.ts, "reports travel in plain text"), and a real store's
 * `work/` tree is a MIX — some reports sealed, some not, at arbitrary depth. If
 * decrypt ignored them, it would hand back a store it called plaintext with
 * unreadable files in it, and the key needed to read them would no longer be
 * active — the exact "a file they may never get back" failure the pre-swap audit
 * exists to prevent. So they are decrypted like everything else, and one that
 * will not open ABORTS the run like any other unreadable file.
 *
 * The codec's AAD binds to the file's KIND and BASENAME, so each blob is opened
 * at its own path and re-staged at the identical relative path — the re-seal
 * fixed point in `verifyStaged` then proves a later `encrypt` reproduces it.
 * `.git` is excluded (history is not rewritten) and the canonical surfaces are
 * excluded because they are handled, and better, above.
 */
function readSealedMirrors(home: string): Mirror[] {
  return sealedMirrorPaths(home).map((rel) => {
    const abs = path.join(home, rel);
    return { rel, plain: openOrFail(abs, readFileSync(fsPath(abs), "utf8"), rel) };
  });
}

/** The store-relative paths of those blobs — the finder, split out so the
 * pre-consent census counts EXACTLY what the read will rewrite, without a key. */
function sealedMirrorPaths(home: string): string[] {
  const handled = new Set(["index.json", "store.enc"]);
  const out: string[] = [];
  const walk = (relDir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(fsPath(path.join(home, relDir)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!e.isFile() || isAtomicTemp(e.name)) continue;
      if (handled.has(rel)) continue;
      // The canonical content files are read (and verified) by their own passes.
      if (/^topics\/[^/]+\.md$/.test(rel) && !e.name.startsWith(".")) continue;
      if (/^proposals\/[^/]+\.md$/.test(rel) && !e.name.startsWith(".")) continue;
      // Every `*.jsonl` in the tree belongs to `readLedgers` — including the
      // legacy WHOLE-FILE sealed ones, which it now opens with the historical
      // AAD. Claiming them here too would stage the same file twice.
      if (e.name.endsWith(".jsonl")) continue;
      const abs = path.join(home, rel);
      if (!stripLeadingBomWs(readHead(abs)).startsWith(ENC_MAGIC)) continue;
      // Ask the CODEC whether this path is a whole-file blob rather than
      // pattern-matching the tree. This used to skip everything under `logs/`,
      // which is wrong in both directions:
      //
      //  - a blob DEEPER than `logs/` (`logs/sub/x.md`) is kind "other", so
      //    `encrypt` really does seal it — and skipping it meant the pre-swap
      //    residue audit aborted the whole migration on a store that merely had
      //    a subdirectory under `logs/`. Fail-closed, but it refuses to convert a
      //    real store instead of converting it;
      //  - a file DIRECTLY in `logs/` is kind "log", which `decryptFile` passes
      //    through UNCHANGED. Handing one to `openOrFail` would "succeed" and
      //    stage its ciphertext verbatim, so those must still be skipped here —
      //    and the audit stays the backstop that refuses to swap them in.
      if (!isWholeFileSealedPath(abs)) continue;
      out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** `decryptFile`, but every failure becomes ONE canonical abort naming the file. */
function openOrFail(absPath: string, bytes: string, rel: string): string {
  try {
    return decryptFile(absPath, bytes);
  } catch (err) {
    throw new GestaltError(
      "E_STORE_MODE",
      `Cannot decrypt ${rel}: ${err instanceof Error ? err.message : String(err)} — nothing was changed.`,
      `Every file has to open before any of them is rewritten. Fix or remove that file (\`fimemory export --plaintext <dir>\` reports what does and does not read), then run \`fimemory decrypt\`.`,
    );
  }
}

function readWholeFiles(dir: string, suffix: string): WholeFile[] {
  let names: string[];
  try {
    names = readdirSync(fsPath(dir));
  } catch {
    return [];
  }
  const out: WholeFile[] = [];
  for (const name of names.filter((n) => isCanonicalContentFile(n, suffix)).sort()) {
    const abs = path.join(dir, name);
    const cipher = readFileSync(fsPath(abs), "utf8");
    const rel = `${path.basename(dir)}/${name}`;
    out.push({ id: name.slice(0, -suffix.length), plain: openOrFail(abs, cipher, rel), cipher });
  }
  return out;
}

/**
 * Parse every log with the DEK active — `parseLog` routes to the per-entry
 * decoder and FAILS CLOSED (never skips) on a line it cannot open, which is
 * exactly the contract a migration needs: a skipped line would be permanently
 * destroyed by the plaintext rewrite.
 */
function readEncryptedLogs(dir: string): Log[] {
  let names: string[];
  try {
    names = readdirSync(fsPath(dir));
  } catch {
    return [];
  }
  const out: Log[] = [];
  for (const name of names.filter((n) => isCanonicalContentFile(n, ".log.md")).sort()) {
    const id = name.slice(0, -".log.md".length);
    const raw = readFileSync(fsPath(path.join(dir, name)), "utf8");
    let parsed: { entries: LogEntry[]; warnings: { message: string }[] };
    try {
      parsed = parseLog(raw, id);
    } catch (err) {
      throw new GestaltError(
        "E_STORE_MODE",
        `Cannot decrypt logs/${name}: ${err instanceof Error ? err.message : String(err)} — nothing was changed.`,
        `Every log has to open before any file is rewritten. Fix or remove that log, then run \`fimemory decrypt\`.`,
      );
    }
    if (parsed.warnings.length > 0) {
      throw new GestaltError(
        "E_CORRUPT_SKIPPED",
        `logs/${name} has an unparsable entry that decrypting would drop — nothing was changed.`,
        `Fix the file (or copy it aside with \`fimemory export --plaintext <dir>\`), then run \`fimemory decrypt\`.`,
      );
    }
    // Trailing blank lines inside a SEALED entry cannot survive the plaintext
    // format: entries are joined with a blank line, so a raw ending in "\n" is
    // indistinguishable from the separator and parses back without it. The
    // per-entry sealed path preserves whatever raw it was handed, so real
    // stores carry a few of these (2 in the live store, 2026-08-10). Normalise
    // HERE, before anything is written or compared, so the staged bytes and the
    // verifier agree — and report the count rather than silently trimming.
    out.push({
      id,
      entries: parsed.entries.map((e) =>
        /\n+$/.test(e.raw) ? { ...e, raw: e.raw.replace(/\n+$/, "") } : e,
      ),
      trimmedEntries: parsed.entries.filter((e) => /\n+$/.test(e.raw)).length,
    });
  }
  return out;
}

/**
 * Task ledgers are PER-LINE sealed (`gestalt-enc:1:…`, store/ledger.ts) so
 * `merge=union` concatenates cross-machine appends without the key. They are
 * therefore decoded LINE BY LINE and kept in order — never through
 * `parseLedger`, which silently DROPS a line it cannot decode. In a migration a
 * dropped line is destroyed, so an undecodable sealed line aborts the run.
 *
 * Scanned RECURSIVELY from the store root for `*.jsonl`, not just `ledgers/`:
 * real stores keep rotated copies beside it (`ledgers-archive-<date>/`), and a
 * sealed file left behind in a store we just told the user is plaintext is both
 * unreadable to them and a lie about the store's posture. `.git` is excluded —
 * history is not rewritten (see the file header).
 */
/** Does this `.jsonl` hold ANY sealed line? (Whole-file, not head-only: a store
 * that started plaintext and was later encrypted has plaintext lines first.) */
function isSealedLedger(abs: string): boolean {
  try {
    return readFileSync(fsPath(abs), "utf8").includes(LEDGER_ENC_MAGIC);
  } catch {
    return false;
  }
}

function readLedgers(home: string): Ledger[] {
  const out: Ledger[] = [];
  for (const rel of walkJsonl(home)) {
    const abs = path.join(home, rel);
    if (!isSealedLedger(abs)) continue; // wholly plaintext already
    const raw = readFileSync(fsPath(abs), "utf8");
    let lines: string[];
    try {
      lines = decodeLedgerLines(raw);
    } catch (err) {
      // LEGACY SHAPE (pre-F3): the whole file is ONE sealed blob, from before
      // ledgers were line-sealed. Its AAD is the whole-file one for kind
      // "other", so the per-line decoder cannot open it and the run used to
      // abort — refusing to convert a store instead of converting it. Both
      // decoders are AEAD-authenticated under DIFFERENT AADs, so at most one can
      // ever succeed: trying the modern shape first and this second cannot
      // mis-attribute a file. If neither opens, the original abort stands.
      const legacy = decryptLegacyWholeFileLedger(abs, raw);
      if (legacy === null) {
        throw new GestaltError(
          "E_STORE_MODE",
          `Cannot decrypt ${rel}: a sealed ledger line would not open (${err instanceof Error ? err.message : String(err)}) — nothing was changed.`,
          `Every line has to open before any file is rewritten. Fix or remove that file, then run \`fimemory decrypt\`.`,
        );
      }
      lines = legacy.split("\n");
    }
    out.push({ rel, lines });
  }
  return out;
}

/** Decode a per-LINE sealed ledger, in order, keeping blank lines. Throws on the
 * first line that will not open — a migration may not drop one. */
function decodeLedgerLines(raw: string): string[] {
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    lines.push(t === "" ? "" : decodeLedgerLine(t));
  }
  return lines;
}

/** Every `*.jsonl` under `home`, store-relative with "/" separators, `.git` excluded. */
function walkJsonl(home: string): string[] {
  const found: string[] = [];
  const walk = (relDir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(fsPath(path.join(home, relDir)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && e.name.endsWith(".jsonl") && !isAtomicTemp(e.name)) found.push(rel);
    }
  };
  walk("");
  return found.sort();
}

// ── stage ────────────────────────────────────────────────────────────────────

/**
 * Build the COMPLETE plaintext store in a sibling `staging` dir and VERIFY it,
 * all WITHOUT touching `home`. Throws (and removes the partial staging — which
 * is PLAINTEXT, so removing it is required, not merely tidy) on any failure.
 */
async function buildAndVerifyStaging(
  home: string,
  paths: ReturnType<typeof storePaths>,
  src: SourceStore,
  plan: DecryptPlan,
  census: Map<string, string>,
  opts: MigrateDecryptOptions,
  warn: (msg: string) => void,
): Promise<Committer> {
  const parent = path.dirname(home);
  const base = path.basename(home);
  const uniq = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.${base}.gestalt-decrypting-${uniq}`);
  const backup = path.join(parent, `.${base}.gestalt-ciphertext-${uniq}`);

  try {
    // 0700 / 0600 throughout: the staged tree is RENAMED into place and BECOMES
    // the store, so its modes are the modes the user lives with. Unmoded under
    // umask 022 this would WIDEN every file the store had at 0600 — and this is
    // the command that makes the store readable, so widening it is the last
    // thing it should do. Inert on Windows; measured on the POSIX legs.
    mkdirSync(fsPath(staging), { recursive: true, mode: 0o700 });
    for (const sub of ["topics", "logs", "proposals"]) {
      mkdirSync(fsPath(path.join(staging, sub)), { recursive: true, mode: 0o700 });
    }

    // Carry everything we do NOT regenerate — config.json, schema.json,
    // machine-id, .git/.gitattributes/.gitignore, and any user file at the root
    // — byte for byte. Nothing is dropped except the sealed marker and the
    // keyring (archived, below).
    copyCarriedEntries(home, staging, warn);
    copyNonCanonicalContentEntries(home, staging, warn);
    // BOTH are gated on a keyring actually existing. A store with none (unlocked
    // by GESTALT_KEY) must not gain a `.gitignore` line for a file that was
    // never created — an ignore rule for a non-existent file reads as evidence
    // the file is there.
    if (archiveKeyring(home, staging)) ensureArchivedKeyringIgnored(staging);

    let staged = 0;
    const stage = (rel: string, absTarget: string, bytes: string): void => {
      mkdirSync(fsPath(path.dirname(absTarget)), { recursive: true, mode: 0o700 });
      writeFileSync(fsPath(absTarget), bytes, { encoding: "utf8", mode: 0o600 });
      staged += 1;
      opts.hooks?.afterStageFile?.(rel, staged);
    };

    for (const n of src.notes) {
      stage(`topics/${n.id}.md`, path.join(staging, "topics", `${n.id}.md`), n.plain);
    }
    for (const p of src.proposals) {
      stage(`proposals/${p.id}.md`, path.join(staging, "proposals", `${p.id}.md`), p.plain);
    }
    for (const l of src.logs) {
      // serializeLogPlain, NOT serializeLog: the DEK is still active here, and
      // serializeLog would faithfully re-encode every entry straight back to
      // ciphertext — writing the store we are trying to undo.
      stage(
        `logs/${l.id}.log.md`,
        path.join(staging, "logs", `${l.id}.log.md`),
        serializeLogPlain(l.id, l.entries),
      );
    }
    for (const led of src.ledgers) {
      stage(led.rel, path.join(staging, ...led.rel.split("/")), led.lines.join("\n"));
    }
    for (const m of src.mirrors) {
      stage(m.rel, path.join(staging, ...m.rel.split("/")), m.plain);
    }
    if (src.indexPlain !== null) {
      stage("index.json", path.join(staging, "index.json"), src.indexPlain);
    }

    opts.hooks?.beforeVerify?.(staging);
    verifyStaged(staging, src, warn);

    return { staging, backup, plan, census };
  } catch (err) {
    // `home` is untouched. The partial staging is PLAINTEXT — remove it.
    safeRemove(staging);
    throw err;
  }
}

/**
 * Move keyring.json into staging under {@link ARCHIVED_KEYRING_NAME}.
 *
 * A COPY, not a move: `home` must stay byte-for-byte intact until the swap. It
 * is never deleted, because the ciphertext this key opens does not stop existing
 * — it is in git history, in old backups, on whatever drive the store travelled
 * on — and the archived keyring plus the old passphrase is what still opens it.
 *
 * Returns whether anything was archived, so no caller can report or gitignore an
 * archive that did not happen (a `GESTALT_KEY` store has no keyring at all).
 */
function archiveKeyring(home: string, staging: string): boolean {
  const src = path.join(home, "keyring.json");
  if (!existsSync(fsPath(src))) return false;
  cpSync(fsPath(src), fsPath(path.join(staging, ARCHIVED_KEYRING_NAME)));
  return true;
}

/**
 * Add `keyring-archived.json` to the store's `.gitignore`.
 *
 * THE ONE FILE THIS COMMAND CHANGES THAT IS NOT MEMORY, and it is not optional.
 * `init` gitignores `keyring.json` because it is per-machine and must travel out
 * of band (Decision 3) — it holds the Argon2id-WRAPPED DEK, so committing it to
 * a shared remote reduces the old ciphertext's protection to the passphrase
 * alone against anyone who can read the repo. Renaming that same file to
 * `keyring-archived.json` walks it straight out from behind that rule: git sees
 * a brand-new untracked file and the very next `git add -A` publishes it.
 *
 * Idempotent, and it never touches a store that has no git rules at all (no
 * `.gitignore` and no `.git`) — there is nothing to protect there, and inventing
 * a file the user never had is not this command's business.
 */
function ensureArchivedKeyringIgnored(staging: string): void {
  const gitignore = path.join(staging, ".gitignore");
  const hasRules = existsSync(fsPath(gitignore)) || existsSync(fsPath(path.join(staging, ".git")));
  if (!hasRules) return;
  let current = "";
  try {
    current = readFileSync(fsPath(gitignore), "utf8");
  } catch {
    /* no .gitignore yet, but this IS a git repo — create one */
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === ARCHIVED_KEYRING_NAME)) return;
  const body =
    (current.length > 0 && !current.endsWith("\n") ? current + "\n" : current) +
    `# Kept by \`fimemory decrypt\`: the wrapped key for this store's OLD ciphertext.\n` +
    `# Same rule as keyring.json — it must never reach the remote.\n` +
    `${ARCHIVED_KEYRING_NAME}\n`;
  writeFileSync(fsPath(gitignore), body, { encoding: "utf8", mode: 0o600 });
}

/**
 * Carry every top-level entry we are NOT regenerating, byte for byte:
 *  - regenerated names (topics/, logs/, proposals/, ledgers/, index.json) skipped;
 *  - store.enc dropped (the sealed marker; a plaintext store has none) and
 *    keyring.json handled by `archiveKeyring`;
 *  - process residue skipped (atomic-write temps, the lockfile, scoped siblings);
 *  - EVERYTHING ELSE carried — a README, a `state/` dir, `ledgers-archive-*`.
 *    A user file is never silently dropped by a format migration.
 */
function copyCarriedEntries(home: string, staging: string, warn: (msg: string) => void): void {
  const sibRe = siblingTempRe(path.basename(home));
  for (const entry of readdirSync(fsPath(home), { withFileTypes: true })) {
    const name = entry.name;
    if (REGENERATED.has(name) || DROPPED_OR_MOVED.has(name)) continue;
    if (name === LOCKFILE_NAME || sibRe.test(name) || encryptSiblingTempRe(path.basename(home)).test(name)) {
      continue;
    }
    const tempBase = atomicTempBase(name);
    if (tempBase !== null) {
      if (!KNOWN_ATOMIC_TEMP_BASES.has(tempBase)) {
        warn(
          `fimemory decrypt: left behind a leftover from an interrupted write, which is not one of your notes and was not copied: ${name}\n`,
        );
      }
      continue;
    }
    cpSync(fsPath(path.join(home, name)), fsPath(path.join(staging, name)), { recursive: true });
  }
}

/**
 * The never-drop policy INSIDE the regenerated content dirs, and inside every
 * directory that holds a regenerated `*.jsonl`. A non-canonical entry there
 * (`topics/notes-backup.txt`, `ledgers/README.md`) was not created by us and is
 * carried verbatim; only true process residue is skipped, and an atomic-temp
 * skip is always WARNED naming the path — the base of a content-dir write-temp
 * is indistinguishable from a real user file that ends the same way, so a silent
 * drop there is not acceptable.
 */
function copyNonCanonicalContentEntries(
  home: string,
  staging: string,
  warn: (msg: string) => void,
): void {
  const sibRe = siblingTempRe(path.basename(home));
  const carryDir = (relDir: string, isRegenerated: (name: string) => boolean): void => {
    const srcDir = path.join(home, relDir);
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(fsPath(srcDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (isRegenerated(name)) continue;
      if (name === LOCKFILE_NAME || sibRe.test(name)) continue;
      if (atomicTempBase(name) !== null) {
        warn(
          `fimemory decrypt: left behind a leftover from an interrupted write, which is not one of your notes and was not copied: ${relDir}/${name}\n`,
        );
        continue;
      }
      mkdirSync(fsPath(path.join(staging, relDir)), { recursive: true, mode: 0o700 });
      cpSync(fsPath(path.join(srcDir, name)), fsPath(path.join(staging, relDir, name)), {
        recursive: true,
      });
    }
  };
  for (const { sub, suffix } of CONTENT_SUBDIRS) {
    carryDir(sub, (n) => isCanonicalContentFile(n, suffix));
  }
}

// ── verify ───────────────────────────────────────────────────────────────────

/**
 * Prove the staged PLAINTEXT is exactly what the ciphertext held, before any
 * swap. Three independent checks, each closing a different failure:
 *
 *  V1 — BYTE IDENTITY. Read every staged file BACK off disk and compare to the
 *       AEAD-opened plaintext held in memory. Catches a short write, an encoding
 *       mangle, a filesystem that "succeeded" and stored something else.
 *  V2 — RE-SEAL FIXED POINT. Seal the staged plaintext with the still-active DEK
 *       and open it again: it must yield the same plaintext. This proves the
 *       staged bytes are a valid pre-image the codec round-trips, i.e. that a
 *       later `fimemory encrypt` will not mangle them. (Deliberately NOT a
 *       ciphertext-equality check against the original blob: `bytesToUtf8` drops
 *       one leading BOM on the way out, so a BOM-prefixed original re-seals to
 *       different bytes while holding identical content — the exact trap that
 *       once bricked `encrypt`'s verify. Comparing PLAINTEXT is BOM-stable.)
 *  V3 — NOTHING SEALED SURVIVES, and no residue rides in. The staged tree is
 *       walked and any leftover ciphertext (a `gestalt-enc:1:` blob, a sealed
 *       log) or atomic-write temp ABORTS. A store we call plaintext must have
 *       no unreadable files left in it.
 *
 * Any failure throws, `home` untouched. There is no unverified swap.
 */
function verifyStaged(staging: string, src: SourceStore, warn: (msg: string) => void): void {
  const fail = (rel: string, why: string): never => {
    throw new GestaltError(
      "E_STORE_MODE",
      `Verification failed: ${rel} ${why}. Nothing was changed.`,
      "Re-run `fimemory decrypt`.",
    );
  };
  const readBack = (rel: string): string => readFileSync(fsPath(path.join(staging, rel)), "utf8");

  const checkWhole = (rel: string, plain: string): void => {
    if (readBack(rel) !== plain) fail(rel, "did not read back as the content it decrypted to");
    // V2 — re-seal fixed point (BOM-stable; see the docstring).
    const abs = path.join(staging, rel);
    let round: string;
    try {
      round = decryptFile(abs, encryptFile(abs, plain));
    } catch (err) {
      return fail(rel, `could not be re-sealed by the codec (${err instanceof Error ? err.message : String(err)})`);
    }
    if (round !== plain) fail(rel, "does not survive a re-encrypt round trip");
  };

  for (const n of src.notes) checkWhole(`topics/${n.id}.md`, n.plain);
  for (const p of src.proposals) checkWhole(`proposals/${p.id}.md`, p.plain);
  for (const m of src.mirrors) checkWhole(m.rel, m.plain);
  if (src.indexPlain !== null) checkWhole("index.json", src.indexPlain);

  for (const l of src.logs) {
    const rel = `logs/${l.id}.log.md`;
    const bytes = readBack(rel);
    if (bytes !== serializeLogPlain(l.id, l.entries)) fail(rel, "did not read back as written");
    // Entry-for-entry: the plaintext file must yield the SAME raw blocks, in the
    // same order. Parsed with an explicit plaintext parse (the DEK is active, so
    // `parseLog` would refuse a plaintext log outright) — the same comparison
    // `encrypt` makes, in the other direction.
    const back = parsePlainLogBlocks(bytes);
    if (back.length !== l.entries.length) fail(rel, "lost or gained entries");
    for (let i = 0; i < back.length; i++) {
      if (back[i] !== l.entries[i]!.raw) fail(rel, `entry ${i + 1} did not round-trip`);
    }
    // V2 for logs: each entry must re-encode under the DEK and decode back.
    for (const e of l.entries) {
      let round: string;
      try {
        round = resealLogEntry(l.id, e.raw);
      } catch (err) {
        return fail(rel, `an entry could not be re-sealed (${err instanceof Error ? err.message : String(err)})`);
      }
      if (round !== e.raw) fail(rel, "an entry does not survive a re-encrypt round trip");
    }
  }

  for (const led of src.ledgers) {
    const bytes = readBack(led.rel);
    if (bytes !== led.lines.join("\n")) fail(led.rel, "did not read back as written");
    for (const line of led.lines) {
      const t = line.trim();
      if (t === "") continue;
      let round: string;
      try {
        round = decodeLedgerLine(encodeLedgerLine(t));
      } catch (err) {
        return fail(led.rel, `a line could not be re-sealed (${err instanceof Error ? err.message : String(err)})`);
      }
      if (round !== t) fail(led.rel, "a line does not survive a re-encrypt round trip");
    }
  }

  assertNoSealedResidue(staging, warn);
}

/** encode→decode one log entry with the active DEK (the V2 fixed point for logs).
 * `encodeLogEntry` emits `<ts> <token>`; the decoder takes exactly that line. */
function resealLogEntry(id: string, block: string): string {
  return decodeLogEntry(id, encodeLogEntry(id, block));
}

/** Split a PLAINTEXT log into its `### <ts> | …` blocks, without `parseLog`
 * (which refuses a plaintext log while a key is active — and a key IS active
 * here, by construction: we are mid-decrypt). */
function parsePlainLogBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (!current) return;
    blocks.push(current.join("\n").replace(/\n+$/, ""));
    current = null;
  };
  for (const line of text.split("\n")) {
    if (/^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| /.test(line)) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * V3 — the pre-swap audit. Two outcomes, never a third (silent drop):
 *
 *  - ABORT on an atomic-write temp (process residue must never ride the swap)
 *    and on ANY file that still carries sealed content: the `gestalt-enc:1:`
 *    magic at the head, or a `*.log.md` whose head reads as a sealed log. A
 *    store we are about to call plaintext may not contain a file its owner
 *    cannot open — and after this run the key is no longer active, so an
 *    unnoticed sealed file is a file they may never get back.
 *  - Everything else passes. `.git` is skipped: history is not rewritten, which
 *    is stated in the file header and in the plan the user confirmed.
 */
function assertNoSealedResidue(staging: string, warn: (msg: string) => void): void {
  const ENC = "gestalt-enc:1:";
  const abort = (rel: string, what: string): never => {
    throw new GestaltError(
      "E_STORE_MODE",
      `Staged store still holds ${what} (${rel}) — refusing to swap it in. Nothing was changed.`,
      "Re-run `fimemory decrypt`. If it persists, that file is not one this command knows how to read — copy it aside and remove it from the store first.",
    );
  };
  const walk = (relDir: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(fsPath(path.join(staging, relDir)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (isAtomicTemp(e.name)) abort(rel, "a leftover write temp");
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name === ARCHIVED_KEYRING_NAME) continue; // plaintext by design (a WRAPPED key)
      const head = readHead(path.join(staging, rel));
      // BOM/indent-tolerant, exactly like the keyring's own sealed-content
      // finders: a restore/copy/editor round trip can prepend a BOM or indent
      // the first line, and a naked startsWith would then read sealed bytes as
      // plaintext and let them ride the swap.
      if (head.replace(/^[\uFEFF\s]+/, "").startsWith(ENC)) {
        abort(rel, "encrypted content this command did not decrypt");
      }
      if (e.name.endsWith(".log.md") && looksLikeEncryptedLog(head)) {
        abort(rel, "an encrypted log this command did not decrypt");
      }
    }
  };
  // The sealed store-mode marker must be gone BEFORE the walk, or the walk's own
  // magic check would abort on it — it is the one sealed file we DROP rather than
  // decrypt (a plaintext store has none, and leaving it would make
  // `storeHasSealedContent` read the result as encrypted: a brick). It is never
  // copied in (`DROPPED_OR_MOVED`), so this is belt-and-braces for a store whose
  // marker somehow rode in inside a carried directory.
  const marker = path.join(staging, "store.enc");
  if (existsSync(fsPath(marker))) {
    warn(`fimemory decrypt: removing the encrypted-store marker (store.enc) from the result.\n`);
    safeRemove(marker);
  }
  walk("");
}

/** Read up to `n` bytes from a file's HEAD — bounded, so a huge carried file (or
 * a planted blob) can never force a whole-file read just to test a 14-char magic.
 * Same primitive `store/keyring.ts`'s sealed-content finders use. */
function readHead(p: string, n = 512): string {
  let fd: number | undefined;
  try {
    fd = openSync(fsPath(p), "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── commit ───────────────────────────────────────────────────────────────────

/**
 * Two atomic renames with self-healing rollback, then removal of the ciphertext
 * backup. Runs AFTER the lock is released. See the file header.
 */
function commitSwap(
  home: string,
  c: Committer,
  opts: MigrateDecryptOptions,
  warn: (msg: string) => void,
): MigrateDecryptResult {
  const hooks = opts.hooks;
  const finish = (
    extra?: Pick<MigrateDecryptResult, "ciphertextBackup" | "ciphertextBackupRemovalFailed">,
  ): MigrateDecryptResult => {
    // The DEK must not survive this command: the store no longer has anything
    // for it to open, and leaving it active would make the very next write in
    // this process re-seal a file into the store we just made plaintext.
    clearActiveKey();
    // The cached session DEK is now a plaintext key on disk for a store that
    // does not use it. Wipe it, and REPORT the outcome — a failed wipe means a
    // usable key is still sitting there, which the caller must hear about.
    const sessionWipe = wipeSessionCache(home);
    return {
      home,
      changed: true,
      message: `Decrypted your store at ${home} — it is plaintext on disk now.`,
      notes: c.plan.notes,
      logs: c.plan.logs,
      proposals: c.plan.proposals,
      ledgers: c.plan.ledgers,
      mirrors: c.plan.mirrors,
      // OMITTED entirely when the store had no keyring — never a path to a file
      // this command did not create (see DecryptPlan.archivedKeyring).
      ...(c.plan.archivedKeyring ? { archivedKeyring: c.plan.archivedKeyring } : {}),
      trimmedLogEntries: c.plan.trimmedLogEntries,
      remoteUrl: c.plan.remoteUrl,
      sessionWipe,
      ...(extra ?? {}),
    };
  };

  // THE LAST GATE. The lock is released; this proves nothing has moved since the
  // read that produced the staged plaintext, and throws with everything still
  // untouched if it has. It must run BEFORE the signal handlers below, because
  // it is allowed to fail and change nothing.
  try {
    assertNothingChangedSinceRead(home, c, opts.isPidAlive ?? defaultIsPidAlive);
  } catch (err) {
    clearActiveKey();
    safeRemove(c.staging); // PLAINTEXT staging — never left behind on failure
    throw err;
  }

  // Shrink the commit-window exposure: a SIGINT/SIGTERM in the swap would leave
  // the store under a temp name. Handle the signals for the duration, then
  // re-raise so exit semantics are unchanged. (The ciphertext backup is KEPT on
  // success now, so there is nothing to clean up here — see `removeBackup`.)
  const onSignal = (sig: NodeJS.Signals): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.kill(process.pid, sig);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    try {
      renameDirWithRetrySync(home, c.backup, "set your store aside to swap in the plaintext copy");
    } catch (err) {
      clearActiveKey();
      safeRemove(c.staging); // PLAINTEXT staging — never left behind on failure
      throw err;
    }
    try {
      hooks?.inCommitGap?.({ home, backup: c.backup, staging: c.staging });
      renameDirWithRetrySync(c.staging, home, "move the plaintext copy into place");
    } catch (err) {
      // Self-heal: restore the encrypted original and destroy the plaintext copy.
      clearActiveKey();
      try {
        renameDirWithRetrySync(c.backup, home, "put your original store back");
        safeRemove(c.staging);
      } catch {
        throw new GestaltError(
          "E_IO",
          `Decrypt could not complete the swap. Your data is intact but under a temp name: encrypted at ${c.backup}, plaintext at ${c.staging}.`,
          `Rename either one back to ${home} (the encrypted one to undo, the plaintext one to keep). The plaintext copy is readable in the clear — delete whichever you do not keep.`,
        );
      }
      throw err;
    }

    // `home` is now the plaintext result, and the ciphertext backup beside it is
    // the ONE-COMMAND WAY BACK: rename it over `home` and the decrypt is undone.
    //
    // It is KEPT by default. It used to be deleted here on success, which made
    // the command tidy and the mistake unrecoverable — the swap window's
    // residual risk (see `censusFiles`) has no cheap undo once the only other
    // copy of the pre-decrypt store is gone. Deleting it is now an explicit
    // opt-in, and `status` names the leftover so it cannot be forgotten forever.
    hooks?.beforeRemoveBackup?.(c.backup);
    if (opts.removeBackup !== true) {
      // Marked so a LATER run can tell "kept on purpose" from "the original of a
      // decrypt that died mid-swap" — the latter is ambiguous and must halt.
      markBackupKept(c.backup, home);
      return finish({ ciphertextBackup: c.backup });
    }
    try {
      rmSync(fsPath(keptMarkerPath(c.backup)), { force: true });
      rmSync(fsPath(c.backup), { recursive: true, force: true });
    } catch (err) {
      warn(
        `fimemory decrypt: the store is plaintext, but the ENCRYPTED copy at ${c.backup} could not be removed (${(err as Error).message ?? String(err)}). Delete it yourself.\n`,
      );
      return finish({
        ciphertextBackupRemovalFailed: {
          path: c.backup,
          error: (err as Error).message ?? String(err),
        },
      });
    }
    return finish();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// ── residue ──────────────────────────────────────────────────────────────────

/** This store's scoped decrypt sibling names, anchored so they can NEVER match a
 * real user directory: `.<base>.gestalt-(decrypting|ciphertext)-<pid>-<ts>`. */
function siblingTempRe(base: string): RegExp {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${esc}\\.gestalt-(decrypting|ciphertext)-\\d+-\\d+$`);
}

/** `encrypt`'s sibling names — skipped when carrying, so an interrupted encrypt's
 * residue never rides INTO a decrypted store. */
function encryptSiblingTempRe(base: string): RegExp {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${esc}\\.gestalt-(encrypting|plaintext)-\\d+-\\d+$`);
}

export interface DecryptResidue {
  /** `.gestalt-decrypting-*` — a PLAINTEXT staging tree (possibly incomplete). */
  plaintext: string[];
  /**
   * `.gestalt-ciphertext-*` with NO completion marker: the encrypted original of
   * a decrypt that did not finish. Which store is real is genuinely ambiguous
   * here, which is why this set — and only this set — blocks a fresh run.
   */
  ciphertext: string[];
  /**
   * `.gestalt-ciphertext-*` that a COMPLETED decrypt deliberately kept, proved by
   * its `.kept.json` marker. Not ambiguous and not residue: it is the one-command
   * way back, and it must never block the next `decrypt` (without this
   * distinction, decrypt → encrypt → decrypt refuses on the backup decrypt
   * itself left behind).
   */
  keptBackup: string[];
}

/**
 * The marker that separates "the backup a finished decrypt kept" from "the
 * original of a decrypt that died mid-swap". Written BESIDE the backup, never
 * inside it, so the backup stays a byte-identical copy of the old store —
 * renaming it back to `home` must give you exactly what you had, not a store
 * with an extra file in it.
 */
const KEPT_MARKER_SUFFIX = ".kept.json";

/** Marker path for a backup dir. `siblingTempRe` is anchored with `$`, so a
 * marker can never be mistaken for the backup itself. */
function keptMarkerPath(backup: string): string {
  return backup + KEPT_MARKER_SUFFIX;
}

function isKeptBackup(backup: string): boolean {
  return existsSync(fsPath(keptMarkerPath(backup)));
}

/**
 * Record that this backup was kept on purpose. Best effort: if the marker cannot
 * be written the backup simply reads as unmarked residue, which is the
 * CONSERVATIVE failure (loud warnings, and the next run halts and asks rather
 * than proceeding beside an encrypted store it cannot account for).
 */
function markBackupKept(backup: string, home: string): void {
  try {
    writeFileSync(
      fsPath(keptMarkerPath(backup)),
      JSON.stringify(
        {
          kind: "fimemory-decrypt-ciphertext-backup",
          home,
          backup,
          completedAt: new Date().toISOString(),
          note: "The encrypted store as it was before `fimemory decrypt` ran. Rename it back over `home` to undo the decrypt. Delete it when you are satisfied the plaintext store is complete.",
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* conservative: an unmarked backup is treated as interrupted residue */
  }
}

/**
 * Detect this store's interrupted-decrypt residue. Exported so a routinely-run
 * command (`fimemory status`) surfaces it LOUDLY without re-running `decrypt` —
 * the `.gestalt-decrypting-*` copy is the store's memory readable in the clear,
 * which is exactly the thing a user must be told is lying around.
 */
export function detectDecryptResidue(home: string, entries?: readonly string[]): DecryptResidue {
  return findDecryptResidue(home, entries);
}

/**
 * The recovery guidance for a home that has no store but has decrypt residue
 * beside it — or `null` when there is no such residue and the ordinary
 * "no store here" answer is the honest one.
 *
 * THIS IS THE SCARIEST MOMENT THIS COMMAND CAN PRODUCE. After a crash in the
 * commit gap, `home` does not exist and every command except `decrypt` reported
 * `No FIMemory store at <home>` with the hint `fimemory init --home "<home>"`.
 * Following the product's own hint creates an empty store — and a later
 * `decrypt` then takes the `homeIsComplete` branch of `reconcileDecryptResidue`
 * and SWEEPS the verified plaintext copy. The guidance pointed away from the
 * user's data at the one moment it was hardest to find.
 *
 * What can be said with certainty, and what cannot:
 *  - a `.gestalt-ciphertext-*` sibling exists ONLY because `home → backup`
 *    already ran, and that rename happens AFTER the staged copy is built and
 *    verified. So when one is present, the `.gestalt-decrypting-*` beside it IS
 *    the finished, verified plaintext result — that is a sound inference, not a
 *    hopeful one, and it is stated plainly.
 *  - a `.gestalt-decrypting-*` ALONE proves nothing of the sort: a run killed
 *    mid-staging leaves exactly that, half-built. It is called possibly
 *    incomplete, and nothing is suggested that would overwrite a good store
 *    with it.
 */
export function decryptResidueGuidance(
  home: string,
  entries?: readonly string[],
): { message: string; hint: string } | null {
  const sib = findDecryptResidue(home, entries);
  if (sib.plaintext.length === 0 && sib.ciphertext.length === 0 && sib.keptBackup.length === 0) {
    return null;
  }
  const plain = sib.plaintext.join(", ");
  const cipher = sib.ciphertext.join(", ");

  // Nothing from an INTERRUPTED run — only the backup a completed decrypt kept.
  // That backup is an OLDER store, so it is offered as a recovery candidate and
  // never described as "the store that belongs here".
  if (sib.ciphertext.length === 0 && sib.plaintext.length === 0) {
    const kept = sib.keptBackup.join(", ");
    return {
      message: `${home} is missing, but the ENCRYPTED backup kept by an earlier "fimemory decrypt" is still here: ${kept}. It is the store as it was BEFORE that decrypt — anything written since is not in it.`,
      hint: `If you have no newer copy, rename ${kept} back to ${home} and unlock it as it was then. Do NOT run \`fimemory init\`: an empty store here would leave that backup looking like junk.`,
    };
  }

  if (sib.ciphertext.length > 0) {
    const parts = [
      `An earlier "fimemory decrypt" was interrupted while swapping the store into place, so ${home} is missing — but nothing is lost.`,
      `Your ENCRYPTED original is intact at ${cipher}.`,
    ];
    if (sib.plaintext.length > 0) {
      parts.push(
        `The decrypted PLAINTEXT copy it had finished and verified is at ${plain} — readable in the clear.`,
      );
    }
    return {
      message: parts.join(" "),
      hint:
        `Run \`fimemory decrypt\` — it reconciles this: it puts the encrypted original back at ${home}` +
        (sib.plaintext.length > 0
          ? `, removes the plaintext copy, and you can then decrypt again. If you would rather KEEP the finished plaintext copy, rename ${plain} to ${home} yourself FIRST — running decrypt deletes it. Do NOT run \`fimemory init\`: it would create an empty store and that plaintext copy would then be swept away.`
          : `. Do NOT run \`fimemory init\`: it would create an empty store here and strand the real one.`),
    };
  }

  // Plaintext staging only: it may be a half-built tree, so it is never claimed
  // to be complete and never blessed as the store to keep.
  return {
    message: `An earlier "fimemory decrypt" was interrupted and ${home} is missing. The only copy here is the PLAINTEXT one it was building, readable in the clear at ${plain} — it may be INCOMPLETE, so nothing was renamed for you.`,
    hint: `Check ${plain} against your own backup. Rename it to ${home} only if it is complete; otherwise restore ${home} from backup and delete it. Do NOT run \`fimemory init\` — an empty store here is what makes that copy look like sweepable residue.`,
  };
}

/** `entries` lets a caller that already listed the parent pass it in — see the
 * same parameter on `detectMigrationResidue` for why that matters on the
 * `fimemory status` path (it is the reason this parameter exists at all). */
function findDecryptResidue(home: string, entries?: readonly string[]): DecryptResidue {
  const parent = path.dirname(home);
  const re = siblingTempRe(path.basename(home));
  const out: DecryptResidue = { plaintext: [], ciphertext: [], keptBackup: [] };
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
    if (m[1] === "decrypting") out.plaintext.push(abs);
    else if (isKeptBackup(abs)) out.keptBackup.push(abs);
    else out.ciphertext.push(abs);
  }
  return out;
}

/**
 * Reconcile leftovers from a prior interrupted decrypt, LOUDLY. Mirrors
 * `encrypt`'s `reconcileMigrationResidue`, with the roles swapped — and one
 * asymmetry that is deliberate:
 *
 *  - `home` is a complete store → home is authoritative. The `.gestalt-decrypting-*`
 *    staging is disposable AND is PLAINTEXT sitting outside the store, so it is
 *    SWEPT (encrypt leaves its ciphertext staging in place for the same reason
 *    inverted: leaving ciphertext lying around exposes nothing). A
 *    `.gestalt-ciphertext-*` sibling is NEVER auto-deleted — it may be the only
 *    intact copy of something — it is surfaced and left alone, and the
 *    halt-and-ask guard then refuses a fresh run while it exists.
 *
 *  - `home` is ABSENT → a power loss in the one-instruction commit gap. If
 *    exactly one ciphertext sibling holds store material, self-heal by renaming
 *    it back to `home` (the ORIGINAL, never the staging: a staging killed
 *    mid-build also "has memory" and is incomplete, so restoring one would
 *    install a partial store). The plaintext staging is then removed. The run
 *    continues and fails the unlocked-store guard with a message that says to
 *    re-run — which is correct: `home` is encrypted again.
 */
function reconcileDecryptResidue(
  home: string,
  paths: ReturnType<typeof storePaths>,
  warn: (msg: string) => void,
): void {
  const sib = findDecryptResidue(home);
  if (sib.plaintext.length === 0 && sib.ciphertext.length === 0 && sib.keptBackup.length === 0) {
    return;
  }

  // A backup a COMPLETED decrypt kept is not residue and is never in the way: it
  // is reported wherever it is found, and reconciliation ignores it entirely.
  for (const p of sib.keptBackup) {
    warn(
      `fimemory decrypt: the ENCRYPTED backup kept by an earlier decrypt is still here: ${p} — rename it back over ${home} to undo that decrypt, or delete it when you no longer want the way back.\n`,
    );
  }

  const homeIsComplete = existsSync(fsPath(paths.config));
  if (homeIsComplete) {
    for (const p of sib.plaintext) {
      safeRemove(p);
      warn(
        `fimemory decrypt: removed a leftover PLAINTEXT staging dir from an interrupted run: ${p}\n`,
      );
    }
    for (const p of sib.ciphertext) {
      warn(
        `fimemory decrypt: an ENCRYPTED store from an interrupted decrypt is here and may hold real data — NOT removing it: ${p} — recover it or remove it yourself.\n`,
      );
    }
    return;
  }

  if (existsSync(fsPath(home))) {
    // home exists but is not a complete store — never auto-restore over it.
    for (const p of sib.ciphertext) {
      warn(
        `fimemory decrypt: an ENCRYPTED store from an interrupted decrypt is here and may hold real data — NOT removing it: ${p} — recover it or remove it yourself.\n`,
      );
    }
    for (const p of sib.plaintext) {
      warn(
        `fimemory decrypt: a PLAINTEXT copy from an interrupted decrypt is here, readable in the clear: ${p} — recover it or remove it yourself.\n`,
      );
    }
    return;
  }

  const restorable = sib.ciphertext.filter(homeHasStoreMaterial);
  if (restorable.length === 1) {
    renameSync(fsPath(restorable[0]!), fsPath(home));
    warn(
      `fimemory decrypt: an earlier decrypt was interrupted in the commit window; ` +
        `restored the intact ENCRYPTED store from ${restorable[0]} to ${home}.\n`,
    );
    for (const p of sib.plaintext) {
      safeRemove(p);
      warn(`fimemory decrypt: removed the interrupted decrypt's plaintext copy: ${p}\n`);
    }
    return;
  }

  const found = [...sib.ciphertext, ...sib.plaintext].join(", ");
  const plaintexts = sib.plaintext.filter(homeHasStoreMaterial);
  if (restorable.length > 1) {
    throw new GestaltError(
      "E_IO",
      `An earlier "fimemory decrypt" was interrupted and ${home} is missing. Intact data survives under temp names: ${found}.` +
        (plaintexts.length > 0
          ? ` A PLAINTEXT copy of your store is readable in the clear at ${plaintexts.join(", ")}.`
          : ""),
      `Decide which store to keep and rename it back to ${home} (remove the other copies), then re-run.`,
    );
  }
  if (plaintexts.length > 0) {
    throw new GestaltError(
      "E_IO",
      `An earlier "fimemory decrypt" was interrupted and ${home} is missing. The only copy holding data is the PLAINTEXT one it was building, readable in the clear at ${plaintexts.join(", ")} — it may be INCOMPLETE, so nothing was renamed for you.`,
      `Check it against your own backup, then rename it to ${home} if it is complete (or restore ${home} from backup and delete it).`,
    );
  }
  throw new GestaltError(
    "E_IO",
    `An earlier "fimemory decrypt" was interrupted and ${home} is missing. Only empty leftover temp dirs remain (no data in them): ${found}.`,
    `No recoverable store data was found under those temp names; remove them, then restore ${home} from your own backup.`,
  );
}

// ── shared low-level helpers (same contracts as `encrypt`) ───────────────────

/**
 * Rename a DIRECTORY, retrying briefly while Windows says EPERM — a directory
 * rename fails if ANY file beneath it is open, and one peer agent's 1 ms read is
 * enough. Deliberately NOT `store/atomic.ts`'s renameWithRetry, which unlinks
 * `from` when it decides the target is read-only: here `from` is THE USER'S
 * STORE. Synchronous so the signal handler's `committed` reasoning stays valid.
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
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      if (Date.now() >= deadline) {
        throw new GestaltError(
          "E_LOCKED",
          `Could not ${what} (${code}) after waiting ${DIR_RENAME_BUDGET_MS} ms. ` +
            `On Windows a folder cannot be renamed while any file inside it is open, and something is holding one. ` +
            `Your store was NOT changed and nothing was lost.`,
          "Close other AI tools and editors that have this store open (and pause any virus scanner watching it), then run the command again.",
        );
      }
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
