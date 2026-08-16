import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { fsPath, resolveHome, storePaths } from "../paths.js";
import type { HomeOpts, StorePaths } from "../paths.js";
import { detectMigrationResidue, homeHasMemory, siblingHasMemory } from "../ops/migrateEncrypt.js";
import { decryptResidueGuidance, detectDecryptResidue } from "../ops/migrateDecrypt.js";
import { sessionMeter } from "../session.js";
import { decryptFile } from "../store/codec.js";
import { countPendingSync } from "../store/proposals.js";

export interface StatusResult {
  home: string;
  topicCount: number;
  pendingProposals: number;
  /** Per-process read meter, fed by `get`/`search` this session (SPEC §5.1). */
  session: { topicsRead: number; readBudgetUsed: number };
  budget: {
    maxTokensPerGet: number;
    maxTopicsPerGet: number;
    noteTokenCap: number;
    noteTokenWarn: number;
  };
  warnings: Warning[];
}

/**
 * Report the store: path, topic count, pending suggested edits, session read
 * meter (fed by `get`/`search`), and the read budget (SPEC §5.1). Drift notices
 * (invariant 4: note hash ≠ last approved state) arrive with `approve` in B2b,
 * which establishes the approved baseline to diff against.
 */
export function runStatus(opts: HomeOpts = {}): StatusResult {
  const home = resolveHome(opts);
  const paths = storePaths(home);

  // A store is PRESENT if ANY canonical material exists — not config.json alone (M2).
  // A config-less but SEALED store (keyring + sealed topics + store.enc) or a partial
  // plaintext home (topics/ without config) is still a store to REPORT on, never an
  // E_NOT_FOUND that steers the user to `fimemory init` over real sealed/partial data.
  if (!storeIsPresent(home)) {
    // No canonical store material at `home`. Before pointing at `fimemory init` — which
    // would create a NEW EMPTY store and strand real data as sweepable residue — check
    // for a commit-gap crash: a migration that died between `home → backup` and
    // `staging → home` leaves `home` gone but the intact data under scoped sibling
    // temps (`.<base>.gestalt-plaintext-*` = readable in the CLEAR, `.<base>.gestalt-
    // encrypting-*` = the ciphertext). `fimemory encrypt` self-heals this; `fimemory init`
    // would DESTROY it. Emit the SAME recovery facts, and NEVER the `fimemory init` hint
    // when residue is present. (Grok GATE HIGH: status↔encrypt contradiction.)
    const residue = detectMigrationResidue(home);
    const homeDirExists = existsSync(fsPath(paths.home));
    const memoryBearing = residue.plaintext.filter(siblingHasMemory);

    // `fimemory decrypt`'s residue, FIRST — it is the shape that strands data
    // where the `init` hint is most dangerous. After a crash in decrypt's commit
    // gap the home is simply GONE while the intact encrypted original and the
    // finished plaintext copy sit beside it under scoped temp names; `status` is
    // the command a person runs at that moment, and it used to answer with
    // `fimemory init`, which creates an empty store and makes the plaintext copy
    // look like sweepable residue to the next `decrypt`. Named survivors and the
    // command that reconciles them, never `init`.
    const decryptGuidance = decryptResidueGuidance(home);
    if (decryptGuidance) {
      throw new GestaltError("E_IO", decryptGuidance.message, decryptGuidance.hint);
    }

    if (homeDirExists) {
      // M1: the home DIRECTORY exists (occupied) but holds no store material. NEVER say
      // it "is missing", and NEVER advise renaming a sibling back onto an occupied home.
      if (residue.plaintext.length > 0 || residue.encrypting.length > 0) {
        const found = [...residue.plaintext, ...residue.encrypting].join(", ");
        throw new GestaltError(
          "E_IO",
          `${home} exists but holds no Gestalt store files; interrupted-migration temp dirs sit beside it: ${found}.`,
          `Recover the store you want INTO ${home} from those temp dirs (it is occupied — do not blindly rename over it), then re-run \`fimemory status\`.`,
        );
      }
      throw new GestaltError(
        "E_NOT_FOUND",
        `${home} exists but is not a FIMemory store (no store files found).`,
        `fimemory init --home "${home}"`,
      );
    }

    // home DIRECTORY is truly absent — the commit-gap recovery narrative may say so.
    // Gate the self-heal claim on the EXACT condition `fimemory encrypt` self-heals
    // (reconcileMigrationResidue): home absent AND exactly ONE plaintext sibling that
    // HAS MEMORY. In every other state encrypt REFUSES/errors — status must NOT claim
    // self-heal; it names the real path(s) and points at manual recovery.
    if (memoryBearing.length === 1) {
      const found = [...residue.plaintext, ...residue.encrypting].join(", ");
      throw new GestaltError(
        "E_IO",
        `An earlier "fimemory encrypt" was interrupted and ${home} is missing, but intact data survives under temp names: ${found}. Your data is intact and readable in the clear at ${memoryBearing[0]}.`,
        `Recover by running \`fimemory encrypt\` (it self-heals this state), or rename ` +
          `${memoryBearing[0]} back to ${home} to keep working.`,
      );
    }
    if (residue.plaintext.length > 0) {
      const found = [...residue.plaintext, ...residue.encrypting].join(", ");
      if (memoryBearing.length > 0) {
        // 2+ memory-bearing plaintext copies → encrypt REFUSES (ambiguous). Only CLAIM
        // intact data for the copies that actually HAVE memory (L2); name them.
        const plaintexts = memoryBearing.join(", ");
        throw new GestaltError(
          "E_IO",
          `An earlier "fimemory encrypt" was interrupted and ${home} is missing. Intact data survives under temp names: ${found}. A PLAINTEXT copy of your store is readable in the clear at ${plaintexts}.`,
          `\`fimemory encrypt\` will NOT auto-recover this state. Decide which store is the ` +
            `one to keep and rename it back to ${home} (remove the other copies), then re-run.`,
        );
      }
      // Every plaintext sibling is EMPTY (siblingHasMemory false) — do NOT claim intact
      // data or "readable in the clear" (L2). Word it as an empty leftover temp dir.
      throw new GestaltError(
        "E_IO",
        `An earlier "fimemory encrypt" was interrupted and ${home} is missing. Only empty leftover temp dirs remain (no data in them): ${found}.`,
        `No recoverable store data was found under those temp names; remove them, then ` +
          `restore ${home} from your own backup.`,
      );
    }
    if (residue.encrypting.length > 0) {
      // ONLY a `.gestalt-encrypting-*` (ciphertext staging) dir — no plaintext backup to
      // restore. `fimemory encrypt` does NOT self-heal (it throws); name the actual path.
      const found = residue.encrypting.join(", ");
      throw new GestaltError(
        "E_IO",
        `An earlier "fimemory encrypt" was interrupted and ${home} is missing. It left an encryption staging (ciphertext) dir at ${found}; there is no plaintext backup to restore.`,
        `Do NOT create a new store here (that would leave an empty one). If you have your recovery phrase, rename ${found} back to ${home} to keep the encrypted result; otherwise restore ${home} from your own backup.`,
      );
    }
    throw new GestaltError(
      "E_NOT_FOUND",
      `No FIMemory store at ${home}.`,
      `fimemory init --home "${home}"`,
    );
  }

  const warnings: Warning[] = [];
  const { config, warnings: configWarnings } = loadConfig(paths.config);
  warnings.push(...configWarnings);

  const meter = sessionMeter();
  const pending = countPendingSync(home);
  warnings.push(...pending.warnings);

  // Surface leftover interrupted-migration residue LOUDLY (RESIDUAL 2b). A crash
  // in `fimemory encrypt`'s commit window can strand a scoped sibling temp beside
  // the store — a `.gestalt-plaintext-*` copy is the store's memory readable in
  // the CLEAR. The runtime NEVER auto-deletes a plaintext copy (it cannot prove it
  // is redundant); `status` (routinely run) tells the user so they can recover
  // from it and remove it themselves.
  // ONE listing of the store's parent, shared by both residue detectors.
  //
  // The parent of a store is the user's HOME directory, and `status` runs in a
  // hot loop (the retrieval hook, the MCP server). Letting each detector list it
  // for itself put three readdirs of a large directory on every call and
  // measurably starved the store's own writer under peer read pressure —
  // test/contention-processes.test.ts caught exactly that. Listed once here, it
  // is also one fewer than before this file grew a second detector.
  const parentEntries = listParent(home);
  const residue = detectMigrationResidue(home, parentEntries);
  // The `.gestalt-plaintext-*` copy is the store's memory readable in the CLEAR —
  // ALWAYS the loud warning, regardless of any concurrent migration (it only ever
  // exists AFTER the lock is released, in the commit window, so it is real
  // exposure). Never weakened.
  for (const p of residue.plaintext) {
    if (siblingHasMemory(p)) {
      warnings.push({
        code: "E_STORE_MODE",
        message: `A PLAINTEXT copy from an interrupted "fimemory encrypt" is on disk, readable in the clear: ${p} — the runtime will not remove it for you; recover any needed data from it, then delete it yourself.`,
      });
    } else {
      // L2: an EMPTY leftover temp dir holds no data — do not claim intact/readable data.
      warnings.push({
        code: "E_STORE_MODE",
        message: `An empty leftover temp dir from an interrupted "fimemory encrypt" is on disk (no data in it): ${p} — safe to delete.`,
      });
    }
  }
  // The `.gestalt-encrypting-*` staging dir is where a LIVE migration builds the
  // ciphertext while holding the store lock. If a migration is actively holding
  // that lock right now, this dir is in-flight, NOT deletable residue — suppress
  // the notice entirely so status never invites a user to delete an in-progress
  // migration. Otherwise it is transient: either an interrupted run's leftover OR
  // an in-progress run whose lock we could not observe — word it that way and do
  // NOT tell the user it is unconditionally "safe to delete".
  if (residue.encrypting.length > 0 && !migrationInProgress(paths)) {
    for (const p of residue.encrypting) {
      warnings.push({
        code: "E_STORE_MODE",
        message: `An encryption staging dir is on disk (a "fimemory encrypt" in progress, or leftover from an interrupted run): ${p} — if no migration is running it is safe to delete, or run "fimemory encrypt" to sweep it.`,
      });
    }
  }

  // The same duty for `fimemory decrypt`, with the exposure on the other side.
  // Its STAGING dir is the PLAINTEXT one (`.gestalt-decrypting-*`) — memory
  // readable in the clear, so it is always the loud warning; its BACKUP is the
  // encrypted original (`.gestalt-ciphertext-*`), which leaks nothing but may be
  // the only copy of something and is therefore never auto-removed either.
  const decryptResidue = detectDecryptResidue(home, parentEntries);
  for (const p of decryptResidue.plaintext) {
    if (migrationInProgress(paths)) break; // a decrypt is running right now
    warnings.push({
      code: "E_STORE_MODE",
      message: `A PLAINTEXT copy from an interrupted "fimemory decrypt" is on disk, readable in the clear: ${p} — recover anything you need from it, then delete it (or run "fimemory decrypt" to sweep it).`,
    });
  }
  for (const p of decryptResidue.ciphertext) {
    warnings.push({
      code: "E_STORE_MODE",
      message: `An ENCRYPTED copy from an interrupted "fimemory decrypt" is on disk: ${p} — the runtime will not remove it for you; delete it once you are satisfied ${home} is complete.`,
    });
  }
  // The backup a COMPLETED decrypt kept on purpose. Reported every time, not
  // because it is a problem but because it is the way back — and because a
  // backup nobody is ever reminded of is a backup that sits there forever.
  for (const p of decryptResidue.keptBackup) {
    warnings.push({
      code: "E_STORE_MODE",
      message: `"fimemory decrypt" kept an ENCRYPTED backup of this store at ${p} — rename it back over ${home} to undo that decrypt. Delete it (and its .kept.json marker) once you are satisfied ${home} is complete.`,
    });
  }

  return {
    home,
    topicCount: countTopics(paths, warnings),
    pendingProposals: pending.count,
    session: { topicsRead: meter.topicsServed, readBudgetUsed: meter.tokensServed },
    budget: {
      maxTokensPerGet: config.maxTokensPerGet,
      maxTopicsPerGet: config.maxTopicsPerGet,
      noteTokenCap: config.noteTokenCap,
      noteTokenWarn: config.noteTokenWarn,
    },
    warnings,
  };
}

/**
 * True if a writer (a live `fimemory encrypt`, or any mutating op) is ACTIVELY
 * holding the store's write lock right now. Used ONLY to avoid misreporting an
 * in-progress migration's live staging dir as deletable "leftover" residue.
 *
 * A read-only check (never acquires the lock — readers are lock-free, SPEC §1),
 * using the SAME lockfile path + staleness window the writer's `withLock` uses,
 * so a lock held right now reads as held and a stale one does not. Best-effort:
 * any error → treat as NOT held, falling back to the transient "in progress or
 * leftover" wording (which is safe — it still never says "unconditionally delete").
 */
/** List the store's parent directory once, or `undefined` if it cannot be read
 * (each detector then falls back to its own listing and reports nothing). */
function listParent(home: string): string[] | undefined {
  try {
    return readdirSync(fsPath(path.dirname(home)));
  } catch {
    return undefined;
  }
}

function migrationInProgress(paths: StorePaths): boolean {
  try {
    return lockfile.checkSync(fsPath(paths.home), {
      lockfilePath: fsPath(paths.lockfile),
      realpath: false,
      stale: 60_000,
    });
  } catch {
    return false;
  }
}

/**
 * Is a FIMemory store PRESENT on disk at `home`? Recognized by ANY canonical material,
 * not config.json alone (M2): a config-less but SEALED store (keyring.json OR sealed
 * content) reads as a real store, and a partial plaintext home (topics/, logs/, OR
 * proposals/ without config) is a store to describe — never an E_NOT_FOUND that
 * steers the user to `fimemory init` over real sealed/partial data. The residue-aware
 * not-found handling runs ONLY when none of these are present.
 *
 * This delegates to the SHARED {@link homeHasMemory} predicate — the SAME one
 * `fimemory encrypt`'s `siblingHasMemory` uses — so store-presence and the memory
 * predicate can never disagree (a logs-only or proposals-only home is real memory to
 * BOTH). See the docstring on `homeHasMemory` for the drift history.
 */
function storeIsPresent(home: string): boolean {
  return homeHasMemory(home);
}

/** Topic count from the derived index; falls back to counting note files. */
function countTopics(paths: StorePaths, warnings: Warning[]): number {
  try {
    // index.json is encrypted at rest in an encrypted store; decode it through
    // the codec (identity in a plaintext store). Without the key this throws and
    // we fall back to counting note files below.
    const raw: unknown = JSON.parse(
      decryptFile(paths.index, readFileSync(fsPath(paths.index), "utf8")),
    );
    if (
      raw !== null &&
      typeof raw === "object" &&
      "topics" in raw &&
      typeof (raw as { topics: unknown }).topics === "object" &&
      (raw as { topics: unknown }).topics !== null
    ) {
      return Object.keys((raw as { topics: object }).topics).length;
    }
  } catch {
    // fall through to the file-count fallback
  }
  warnings.push({
    code: "E_CORRUPT_SKIPPED",
    message:
      "index.json missing or unparsable; counted note files (run reindex to rebuild)",
  });
  try {
    return readdirSync(fsPath(paths.topicsDir)).filter((f) =>
      f.endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

