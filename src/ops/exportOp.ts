import { promises as fsp, realpathSync } from "node:fs";
import path from "node:path";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";
import { keyState } from "../store/codec.js";
import type { StoreMode } from "../store/codec.js";
import { storeHasSealedContent } from "../store/keyring.js";
import { decodeForExport } from "./exportDecode.js";
import { decryptResidueGuidance } from "./migrateDecrypt.js";
import type { ExportKind } from "./exportDecode.js";

/**
 * `export --plaintext <dir>` — the ownership escape hatch (ENCRYPTION-BUILD-PLAN
 * gate **G1**). Encryption at rest makes `~/.gestalt` opaque, which strains the
 * *letter* of frozen invariant §0.1 ("plain files are the source of truth; a
 * user with a text editor can read, edit, back up, or delete everything"). Its
 * *spirit* survives because this command is always one step away: it decrypts
 * every note, log and proposal and writes them as readable `.md` OUTSIDE the
 * store, in the store's own directory shape, so the export is greppable and
 * editable by a human with nothing but a text editor. **This op must exist
 * before §0.1 is reworded and before encrypted-default ships.**
 *
 * **CLI-only** (SPEC §5.1/§6): a bulk plaintext dump of the whole store is a
 * human act on the human's own machine — it is absent from MCP by construction
 * (no tool in `ALLOWED_MCP_TOOLS` reaches it) and is not part of the HS3 §4.4
 * harness register either. Agents `search`/`get` within a budget; they never
 * bulk-export.
 *
 * ## Containment here is a FOOTGUN GUARD, not a security boundary
 *
 * There is no adversary in this command. It runs on the user's own machine, as
 * the user, over the user's own files, at the user's own request. Its only
 * containment job is to stop the user *accidentally nuking their own store* —
 * `export --plaintext ~/.gestalt` must not re-encrypt its own output into the
 * store, and an export must never be mixed in with unrelated files. So the
 * guard is deliberately three plain rules, not a fortress:
 *
 *  1. **Not inside the store.** Resolve the destination (through links, via the
 *     nearest existing ancestor) and refuse if it lands on or under the home.
 *  2. **The destination is FRESH** — it does not exist, or it is an existing
 *     EMPTY directory. Nothing else. No `--force`.
 *  3. **Every file is created with `wx`** (exclusive) — export NEVER overwrites.
 *
 * Why (2)+(3) are the load-bearing pair, and why they beat a cleverer check:
 * together they make a stale or mixed-vintage export **impossible**. An export
 * directory is always exactly one export, whole, from one moment. That is what
 * makes the "it is NOT in this export" warning TRUE — with overwrite-in-place,
 * a failed item could leave LAST run's copy of that file sitting in the folder,
 * so the warning would name a file the user can plainly see, and the user would
 * trust the stale bytes. Given a verified-empty destination, a `wx` collision is
 * something we did not predict, so it fails loudly rather than clobbering.
 *
 * That link/junction/race tricks also fail against this is a free side effect of
 * the freshness rule — NOT its goal. Do not grow this into an attack-resistant
 * design: an attacker who can plant a reparse point in your export directory
 * already runs as you and can simply read the store.
 *
 * ## Export reports FACTS. It never reports a CAUSE. (Eric, 2026-07-15)
 *
 * **The tool must never be the CAUSE of a data loss.** If a user loses their key
 * or skips their backups, that is theirs to own — this command does not rescue
 * anyone from themselves. But if it tells someone their healthy note is
 * "damaged, restore it from a backup" and they do, then *we* destroyed their
 * work. That is the hazard, and the only reliable way to remove it is to stop
 * guessing: an item either made it into the export, or it did not and we say
 * exactly what the underlying error said. No diagnosis, no advice, no verdict on
 * the user's key — those are inferences, and every inference this op has ever
 * made about the CAUSE of a failure has eventually been wrong in the direction
 * that destroys data.
 *
 * Three adversarial audits (151 agents) found the same unsoundness three times,
 * so the machinery is DELETED rather than improved:
 *
 *  - A KEY / IO / CORRUPT classification whose fallback class was CORRUPT and
 *    whose CORRUPT sentence was "restore it from a backup". Anything the
 *    13-entry IO allowlist did not name — `EDQUOT`, `ESTALE`, `ELOOP`, libuv's
 *    `UNKNOWN` from an AV filter driver or a OneDrive placeholder, or a plain
 *    `TypeError` from a bug in our own decode path — landed on the destructive
 *    advice by DEFAULT. The safe default was inverted. (`ops/cat.ts` had the
 *    same choice to make and got it right: anything unrecognized is `E_IO`.)
 *  - Its KEY sentence ("if the rest of this export decrypted correctly, then the
 *    key is right and this file is damaged — restore it from a backup") fired on
 *    a codec `E_STORE_MODE`, which the codec raises for two OPPOSITE facts: a
 *    failed AEAD open (bytes unknown) and "found plaintext" (bytes demonstrably
 *    FINE). For the plaintext file the rest of the export always decrypts — so
 *    the sentence always resolved to "overwrite this healthy note with an old
 *    copy". The failure's own `reason` said "found plaintext"; the code knew the
 *    bytes were fine and said "damaged" anyway.
 *  - A fail-closed gate that re-derived "your key is wrong" from export's much
 *    worse evidence. That diagnosis ALREADY EXISTS UPSTREAM, is correct, and
 *    runs before export ever starts: the keyring unlock says "Wrong passphrase
 *    for this store" (`store/keyring.ts`), and `GESTALT_KEY` is bound to the
 *    store's own ciphertext by `assertEnvKeyMatchesStore` (`cli.ts`). The gate
 *    was a redundant re-derivation and it was wrong three times — v1 keyed on
 *    `pending.length === 0` (an empty log decodes vacuously under ANY key and
 *    defeated it); v2 on "all failures are KEY"; v3 on "all KEY and nothing
 *    proved the key" — which still fired on a PLAINTEXT store whenever
 *    `GESTALT_KEY` was set (a documented power-user path, `store/codec.ts`),
 *    bricking the escape hatch for a store that needs no key at all and claiming
 *    N "sealed file(s)" that did not exist. Deleted. Export's job is to report
 *    what it could and could not read; the key verdict belongs to the layer that
 *    can actually earn it.
 *
 * What remains is a fact and only a fact: `could not include <path> — <the
 * underlying error>. Not in this export.` — then a non-zero exit so no script
 * mistakes an incomplete export for a complete one.
 *
 * ## Plaintext is proved POSITIVELY. Absence of the magic proves nothing.
 *
 * The same unsoundness had one last hiding place, and it was the worst one:
 * "this file does not start with `gestalt-enc:1:`, therefore it is plaintext,
 * therefore copy it out as the user's note." That is absence-of-evidence as
 * proof — the exact mistake the classifier died for — and it fails on a ROUTINE
 * event, not an exotic one. Encrypted-yet-git-mergeable is this product's
 * headline feature and the store has a remote, but a NOTE is a whole-file blob,
 * so the same note edited on two machines does not merge: git writes
 * `<<<<<<< HEAD` at the TOP of `topics/my-secrets.md`, ahead of the sealed blob.
 * Offset 0 no longer carries the magic, so "no magic ⇒ plaintext" fired, and
 * export copied the conflict markers AND the raw base64 ciphertext out verbatim
 * **as the user's note** — green success, `failed: 0`, exit 0. The user believes
 * they are holding their memory. They are holding garbage, and the export they
 * were invited to trust is the reason they think otherwise.
 *
 * So a file is treated as exportable plaintext only on POSITIVE evidence that it
 * is the user's content: it must parse through the store's OWN parser for its
 * kind. If it neither seals nor parses, it is a factual failure like any other:
 * named, reason repeated verbatim, not exported, non-zero exit. Conflict markers
 * get named explicitly because a git-synced store WILL produce them and the user
 * needs to know WHICH file — and because that is a fact about the bytes, not a
 * diagnosis of them.
 *
 * ## ONE decode contract, for every kind — see `exportDecode.ts`
 *
 * That rule was written for notes. Proposals got it a round later. LOGS never
 * got it at all, and logs are exactly where the danger lives: per-entry encoding
 * + `merge=union` is this product's headline feature, so a log is the one file
 * git will hand back half-merged. Five rounds of audit each found the rule
 * missing from one more surface, so the rule no longer lives on the surfaces.
 * `decodeForExport` owns positive proof, the conflict-marker fact, and the
 * factual failure for notes, logs AND proposals; this op reads files and writes
 * files, and has no other way to decode one. There is no fourth surface to
 * forget.
 */
export interface ExportResult {
  /** Absolute destination directory. */
  dest: string;
  /** The store's mode at export time (what the escape hatch had to undo). */
  mode: StoreMode;
  /** Counts of what was **written** — never what was merely attempted. */
  notes: number;
  logs: number;
  /** Proposals (suggested edits) exported — they embed full note bodies. */
  proposals: number;
  /**
   * Items that are ABSENT from the export. Non-zero ⇒ the export is incomplete
   * ⇒ the CLI exits non-zero. Each one is itemized in `failures`/`warnings`.
   */
  failed: number;
  /** Store-relative paths actually written, in write order (`topics/foo.md`). */
  files: string[];
  /** Every failure, as facts — carried into `--json`. */
  failures: ExportFailure[];
  warnings: Warning[];
}

/**
 * One item that is not in the export. Facts only: WHAT is missing, WHERE we were
 * when it went wrong, and WHAT the failing layer said — never why, and never
 * what the user should do about their key or their backups.
 */
export interface ExportFailure {
  /** Store-relative path (`topics/foo.md`), or `topics/` for a whole directory. */
  rel: string;
  /** What export was doing. A fact about us, NOT a diagnosis of the item. */
  phase: "list" | "read" | "write";
  /** The underlying cause verbatim — an errno, or a GestaltError's message. */
  reason: string;
  /** The failing layer's own §5.10 code, or `E_IO` (see `codeOf`). */
  code: string;
  /** The user-facing sentence (see `sentence`). */
  message: string;
}

/** One decoded file, held in memory until every write target is known-good. */
interface Pending {
  rel: string;
  text: string;
}

/** The store's three content dirs — all of them, by construction. */
const CONTENT_DIRS = ["topics", "logs", "proposals"] as const;

export async function exportPlaintext(
  home: string,
  destDir: string,
): Promise<ExportResult> {
  const paths = storePaths(home);
  if (!(await isDir(paths.topicsDir))) {
    // Same rule as `isDir`'s below, for the other way a store goes missing: if
    // `fimemory decrypt` crashed in its commit gap, the real store is beside
    // this home under a scoped temp name and `init` would strand it. Export is
    // also the command the recovery advice itself points people at, so being
    // wrong here is being wrong at the worst moment.
    const guidance = decryptResidueGuidance(home);
    if (guidance) throw new GestaltError("E_IO", guidance.message, guidance.hint);
    throw new GestaltError(
      "E_NOT_FOUND",
      `No FIMemory store at ${home}.`,
      `fimemory init --home "${home}"`,
    );
  }

  const dest = path.resolve(destDir);
  // The footgun guard, in full: not into the store, and only into a fresh dir.
  // Whether the folder was already there decides how far the cleanup below can
  // unwind: we may remove what THIS run created, never what the user handed us.
  assertOutsideStore(dest, home);
  const destExisted = await assertFreshDest(dest);

  // Sealed content with NO key at all is the one refusal export still makes, and
  // it is a FACT, not an inference: `storeHasSealedContent` reads the store and
  // finds sealed bytes, and `keyState()` reports no key is active. There is
  // nothing to guess and no advice about damage — we simply cannot read those
  // bytes, and saying so up front beats emitting a file-by-file pile of the same
  // fact. (At the CLI this is unreachable — the unlock gate in cli.ts fires
  // first — so this is the library/API consumer's answer.)
  const mode = keyState().mode;
  if (mode === "plaintext" && storeHasSealedContent(home)) {
    throw new GestaltError(
      "E_STORE_MODE",
      "This store is encrypted and no key is active — refusing to export.",
      `Set GESTALT_PASSPHRASE (or pass --passphrase "...") and retry: fimemory export --plaintext "${dest}"`,
    );
  }

  // ── Phase 1: decode everything into memory ─────────────────────────────────
  // Per ITEM, not all-or-nothing: a single undecodable byte must not disable the
  // escape hatch for the entire store. What decodes gets exported; what does not
  // is recorded by name and surfaces as a loud non-zero exit.
  const pending: Pending[] = [];
  const failures: ExportFailure[] = [];

  // Every content dir, through the SAME contract. `proposals` is in this list
  // because proposals are content, not metadata: they are whole-file encrypted
  // and embed the full Old + New note bodies, so a PENDING proposal's proposed
  // text lives nowhere else in the store until someone approves it.
  const dirs: { dir: string; rel: string; suffix: string; kind: ExportKind }[] = [
    { dir: paths.topicsDir, rel: "topics", suffix: ".md", kind: "note" },
    { dir: paths.logsDir, rel: "logs", suffix: ".log.md", kind: "log" },
    { dir: paths.proposalsDir, rel: "proposals", suffix: ".md", kind: "proposal" },
  ];
  for (const d of dirs) {
    await collect(d.dir, d.rel, d.suffix, pending, failures, (src, raw) =>
      decodeForExport(d.kind, mode, src, raw),
    );
  }

  // ── Phase 2: write ─────────────────────────────────────────────────────────
  // The destination is verified fresh, so the tree below is created, not merged.
  //
  // A FAILED EXPORT MUST NOT BLOCK ITS OWN RE-RUN — and that invariant is keyed
  // on what was WRITTEN, not on what decoded. Keying it on decoding (which is
  // what this did) held for the store-side failures it was written for and broke
  // on the destination-side ones: Windows Controlled Folder Access, an AV
  // shield, or a full disk permits `mkdir` and denies file creation, so
  // everything decoded, every write failed, and the empty tree stayed behind.
  // The user fixes the folder permission, re-runs into the same folder, and the
  // freshness rule answers "That folder isn't empty" — the failed export is now
  // the thing standing between them and the retry. So: nothing written and
  // something failed ⇒ leave no tree, whichever side it failed on. An empty
  // STORE (nothing to write, nothing failed) still gets its tree: that export is
  // complete, and the folder is the truth.
  const files: string[] = [];
  if (pending.length > 0 || failures.length === 0) {
    for (const sub of CONTENT_DIRS) {
      try {
        await fsp.mkdir(fsPath(path.join(dest, sub)), { recursive: true });
      } catch (err) {
        // A hard stop — but not before unwinding: `topics/` may already exist
        // from this same loop, and leaving it would block the retry exactly as
        // above.
        await removeCreatedTree(dest, destExisted);
        throw new GestaltError(
          "E_IO",
          `Could not create ${path.join(dest, sub)} (${errnoOf(err) ?? "unknown error"}).`,
          `Pick a destination you can write to: fimemory export --plaintext "<empty dir>"`,
        );
      }
    }

    for (const p of pending) {
      const target = fsPath(path.join(dest, p.rel));
      try {
        // Plain write, NOT writeFileAtomic: that helper runs content through
        // `encryptFile`, and `fileKind` classifies by the immediate parent dir —
        // `<dest>/topics/x.md` would be classified a note and re-ENCRYPTED on the
        // way out, turning the escape hatch into a second ciphertext store. The
        // whole point is plaintext.
        //
        // `wx` = create exclusively, never overwrite. The destination was verified
        // empty, so a collision here is something we did not predict — fail that
        // item loudly rather than clobber a file we cannot explain.
        await fsp.writeFile(target, p.text, { flag: "wx" });
        files.push(p.rel);
      } catch (err) {
        // A write failure is a per-item failure like any other. Without this the
        // first EPERM threw a raw Node stack trace out of the CLI and left a
        // half-written tree with no warning and no accounting.
        failures.push(fail(p.rel, err, "write"));
        await discardPartial(target, err);
      }
    }

    // Every write failed ⇒ the tree we just made is all that is in there, and
    // leaving it is what turns "fix the permission and re-run" into "That folder
    // isn't empty".
    if (files.length === 0 && failures.length > 0) {
      await removeCreatedTree(dest, destExisted);
    }
  }

  // Counts are of what was WRITTEN. Reporting what we *decoded* would overstate
  // the export by exactly the files that failed in the write loop above.
  const count = (prefix: string): number =>
    files.filter((f) => f.startsWith(`${prefix}/`)).length;

  return {
    dest,
    mode,
    notes: count("topics"),
    logs: count("logs"),
    proposals: count("proposals"),
    failed: failures.length,
    files,
    failures,
    warnings: failures.map((f) => ({ id: f.rel, code: f.code, message: f.message })),
  };
}

/**
 * Read + decode one content dir into `pending`, recording per-item failures.
 *
 * A `readdir` failure is a failure OF THAT DIRECTORY, not an empty directory.
 * This used to be `catch { return [] }`, which meant an ACL, an EIO, or a lock
 * on `topics/` made the entire directory VANISH from the export with exit 0,
 * `failed: 0`, and `warnings: []` — silently reporting a store with 50 topics as
 * a store with none. That is the exact "silently incomplete" failure this whole
 * op exists to prevent. An empty directory and an unreadable directory must
 * never be indistinguishable. ENOENT alone means genuinely absent (a store with
 * no proposals yet), which IS empty and is not a failure.
 */
async function collect(
  dir: string,
  relDir: string,
  suffix: string,
  pending: Pending[],
  failures: ExportFailure[],
  decode: (src: string, raw: string) => string,
): Promise<void> {
  let names: string[];
  try {
    names = await listFiles(dir, suffix);
  } catch (err) {
    failures.push(fail(`${relDir}/`, err, "list"));
    return;
  }
  for (const name of names) {
    const rel = `${relDir}/${name}`;
    const src = path.join(dir, name);
    try {
      const raw = await fsp.readFile(fsPath(src), "utf8");
      pending.push({ rel, text: decode(src, raw) });
    } catch (err) {
      failures.push(fail(rel, err, "read"));
    }
  }
}

/**
 * Store files with the given suffix, sorted for a deterministic export. Dotfiles
 * are skipped: `writeFileAtomic` stages `.<name>.tmp-<pid>-<n>` beside its
 * target, and a concurrent write's temp file is not store content.
 *
 * Throws on an unreadable directory (see `collect`); only a genuinely absent one
 * is empty.
 */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(fsPath(dir));
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return []; // no proposals dir yet: empty, not broken
    throw err; // ACL / EIO / lock / not-a-directory — a real failure, never silence
  }
  return names.filter((n) => !n.startsWith(".") && n.endsWith(suffix)).sort();
}

/** Build a failure record for one item. */
function fail(rel: string, err: unknown, phase: ExportFailure["phase"]): ExportFailure {
  const reason = why(err);
  return { rel, phase, reason, message: sentence(rel, phase, reason), code: codeOf(err) };
}

/**
 * The user-facing sentence: WHAT is missing and WHAT the failing layer said.
 * Nothing else.
 *
 * It states one thing we know for certain and one thing someone else told us. It
 * does not name a cause, because export cannot know the cause — and a wrong
 * cause here is not a cosmetic error, it is an instruction. "Restore it from a
 * backup", handed to someone whose note is merely open in an editor or whose
 * file was never encrypted in the first place, means *overwrite the current
 * version with an older one*: the tool becomes the cause of the data loss it
 * claimed to be reporting. The words "damaged", "restore", "backup", and any
 * verdict on the user's key are therefore not permitted in this string — see the
 * header, and the test that greps the rendered output for them.
 *
 * "it is NOT in this export" is TRUE by construction, not by hope: the freshness
 * + never-overwrite rules mean there is no stale previous copy of this file
 * sitting in the destination to quietly contradict it.
 */
function sentence(rel: string, phase: ExportFailure["phase"], reason: string): string {
  const what = phase === "list" ? `the ${rel} directory` : rel;
  // A GestaltError's message is a sentence and already ends in "."; an errno
  // ("EISDIR") does not. Fold the two rather than emit "…tampered data.. Not in".
  const said = reason.replace(/\s*\.\s*$/, "");
  return `could not include ${what} — ${said}. Not in this export.`;
}

/**
 * The §5.8 warning code. Taken from the failing layer's OWN error when it has
 * one, so it stays a report rather than a guess; anything else reached us from
 * the filesystem, so it is `E_IO`.
 *
 * `E_IO` is also the right DEFAULT, which the deleted classifier had exactly
 * backwards: it defaulted to CORRUPT (with "restore from a backup" attached), so
 * every errno missing from a 13-entry allowlist — and every bug in our own code
 * that threw a `TypeError` — was reported as damaged data. `ops/cat.ts` had the
 * same choice and got it right: unrecognized means "we could not read it", not
 * "your file is destroyed".
 */
function codeOf(err: unknown): string {
  return err instanceof GestaltError ? err.code : "E_IO";
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function why(err: unknown): string {
  if (err instanceof GestaltError) return err.message;
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code ?? e?.message ?? String(err);
}

/**
 * Does this directory exist?
 *
 * ONLY `ENOENT` answers "no". This was `try { ...stat... } catch { return false }`,
 * and every other stat error means the OS would not TELL us — which is not the
 * same as "there is nothing here", and the difference is destructive. A store
 * merely LOCKED by an editor, an antivirus, or a backup agent (EBUSY/EACCES/EPERM,
 * or a libuv `UNKNOWN` from a filter driver) was reported as
 * `No FIMemory store at ~/.gestalt` — and the hint then invited the user to run
 * `fimemory init` ON TOP OF THE STORE THEY STILL HAVE. Answering "unknown" with
 * "absent" is how a recovery tool becomes the thing that destroys the data.
 */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(fsPath(p))).isDirectory();
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") return false; // genuinely absent — the only "no"
    throw new GestaltError(
      "E_IO",
      `Could not read ${p} (${code ?? "unknown error"}) — it may exist; refusing to guess.`,
      `Close whatever is holding ${p} (an editor, antivirus, or file indexer) and retry.`,
    );
  }
}

/**
 * Refuse a destination that is the store home or anything under it — an export
 * that landed in `~/.gestalt` would be re-encrypted by the write codec, i.e. the
 * escape hatch would quietly become a second ciphertext store.
 *
 * Path text on the link-resolved forms, and nothing more. `realish` collapses a
 * symlinked/junctioned destination onto its real location, which covers the
 * mistake people actually make (exporting into a folder that turns out to BE the
 * store). It is not trying to defeat an adversary — see the header.
 */
function assertOutsideStore(dest: string, home: string): void {
  const realDest = realish(dest);
  const realHome = realish(home);
  const rel = path.relative(realHome, realDest);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) return;
  throw new GestaltError(
    "E_SCHEMA",
    `Refusing to export inside the store itself (${dest} is in ${home}).`,
    `Pick a destination outside your store: fimemory export --plaintext "${path.join(
      path.dirname(home),
      "gestalt-export",
    )}"`,
  );
}

/**
 * Throw away the artifact of a write that FAILED — keyed on whether the bytes
 * landed, never on whether the open succeeded.
 *
 * `wx` does two things, and the cleanup used to assume they were one: it CREATES
 * the file, then it writes. A full disk (the case the comment above names), a
 * quota, or a USB stick pulled mid-export lets the create succeed and fails the
 * write — leaving a **zero-byte file wearing the user's real note filename**
 * while the CLI says "Nothing was exported". Two ways that hurts:
 *
 *  - The export contains `topics/deal-notes.md`, empty. The user is invited to
 *    trust this folder, and an empty file is the most convincing possible lie
 *    about a note that is in fact still safe in the store.
 *  - `removeCreatedTree` below is built out of `rmdir`, which refuses a
 *    non-empty directory — so the leftovers keep the tree alive and the retry
 *    hits "That folder isn't empty". The failed export becomes the obstacle to
 *    its own re-run, which is the exact thing that cleanup exists to prevent.
 *
 * **EEXIST is the one error that means the file is not ours**: the create itself
 * lost, so those bytes belong to whatever put them there and we do not touch
 * them (that is the whole promise of `wx`). Every other error means WE created
 * the path and the content never arrived, so what is sitting there is our own
 * debris — remove it. A cleanup that cannot run is not worth reporting: the
 * failure the user needs is already itemized.
 */
async function discardPartial(target: string, err: unknown): Promise<void> {
  if (errnoOf(err) === "EEXIST") return; // never ours; `wx` lost the race
  try {
    await fsp.rm(target, { force: true });
  } catch {
    /* not ours to force */
  }
}

/**
 * Undo the empty tree this run created, so a failed export never becomes the
 * obstacle to its own retry.
 *
 * Only ever called when NOTHING was written, and deliberately built out of
 * `rmdir` (which refuses a non-empty directory) rather than a recursive remove:
 * the destination is the user's folder, and the one thing worse than a blocked
 * retry is an export that deletes something on its way out. If a directory is
 * not empty, something we did not predict is in it — leave it exactly where it
 * is. A cleanup that cannot run is not worth reporting: the failures the user
 * actually needs are already itemized, and the freshness rule still protects the
 * next run.
 */
async function removeCreatedTree(dest: string, destExisted: boolean): Promise<void> {
  for (const sub of CONTENT_DIRS) {
    try {
      await fsp.rmdir(fsPath(path.join(dest, sub)));
    } catch {
      /* not ours to force */
    }
  }
  // The user's own pre-made empty folder stays; a folder we created does not.
  if (destExisted) return;
  try {
    await fsp.rmdir(fsPath(dest));
  } catch {
    /* not ours to force */
  }
}

/**
 * The destination must be FRESH: absent, or an existing EMPTY directory. Returns
 * whether it already existed (see `removeCreatedTree`).
 *
 * This is what makes an export a single, coherent, one-moment snapshot instead
 * of a pile of mixed vintages. Exporting into a directory that already holds
 * files — an older export, or the user's Documents folder — produces a tree
 * where some files are from today and some are from last month, with nothing on
 * disk to tell them apart. The user then backs it up believing it is one thing.
 * A `--force` flag would just be a supported way to ask for that, so there is
 * none: a fresh directory costs the user one `mkdir` and removes the failure
 * mode entirely.
 */
async function assertFreshDest(dest: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fsp.readdir(fsPath(dest));
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") return false; // does not exist yet — exactly what we want
    if (code === "ENOTDIR") {
      throw new GestaltError(
        "E_SCHEMA",
        `${dest} is a file, not a folder — export needs a fresh folder.`,
        `fimemory export --plaintext "${dest}-export"`,
      );
    }
    throw new GestaltError(
      "E_IO",
      `Could not check ${dest} (${code ?? "unknown error"}).`,
      `Pick a destination you can read: fimemory export --plaintext "<new dir>"`,
    );
  }
  if (entries.length === 0) return true; // the user's own empty folder — fine
  throw new GestaltError(
    "E_SCHEMA",
    `That folder isn't empty (${dest}) — export needs a fresh folder, so that everything in it is from this one export.`,
    `Export into a new folder, or delete that one first: fimemory export --plaintext "${dest}-new"`,
  );
}

/**
 * `realpath` of the nearest existing ancestor, with the not-yet-created tail
 * re-joined — the destination usually does not exist yet, so a plain `realpath`
 * would throw instead of answering the question we actually have (where *would*
 * this land?).
 */
function realish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(fsPath(cur)).replace(/^\\\\\?\\/, "");
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the root; nothing resolved
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
