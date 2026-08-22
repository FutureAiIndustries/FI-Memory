import { promises as fsp, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Warning } from "../errors.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { isoFromMs, msFromIso } from "../clock.js";
import { recordIndexRepair } from "../telemetry.js";
import { countTokens } from "../tokens.js";
import { writeFileAtomic } from "./atomic.js";
import { CLIENT_SCHEMA_VERSION, readStoreSchemaVersion } from "./schema.js";
import { parseLog } from "./log.js";
import { isTombstone, parseNote } from "./note.js";
import type { TopicNote } from "./note.js";
import { nonOwnerBody } from "./ownerNotes.js";
import { readParsed, readText } from "./read.js";

/** Derived index entry (SPEC §2), fields in canonical order. */
export interface IndexEntry {
  id: string;
  title: string;
  aliases: string[];
  tags: string[];
  projects: string[];
  updated: string;
  noteTokens: number;
  logEntries: number;
  compactedThrough: string | null;
}

/** The derived index (SPEC §1). `reindex` reproduces this from files alone. */
export interface StoreIndex {
  version: number;
  /**
   * The latest server-assigned timestamp anywhere in the store (SPEC §4, rev 4:
   * timestamps are strictly increasing *per store*). All writes hold the one
   * lock, so this is the cheap global monotonic clock; `reindex` recomputes it
   * as the max over all topics.
   */
  lastTimestamp: string | null;
  topics: Record<string, IndexEntry>;
}

export const INDEX_VERSION = 1;

export function emptyIndex(): StoreIndex {
  return { version: INDEX_VERSION, lastTimestamp: null, topics: {} };
}

/** Global last-issued timestamp in epoch ms, or null if the store is empty. */
export function globalLastMs(index: StoreIndex): number | null {
  return index.lastTimestamp ? msFromIso(index.lastTimestamp) : null;
}

/** Advance the global clock to `ts` if it is later (ISO-ms strings sort chronologically). */
export function advanceGlobal(index: StoreIndex, ts: string): void {
  if (index.lastTimestamp === null || ts > index.lastTimestamp) {
    index.lastTimestamp = ts;
  }
}

/**
 * `updated` = the latest of the note's frontmatter `updated` and every log
 * entry timestamp. ISO-8601 UTC millisecond strings sort lexicographically in
 * chronological order, so a string max preserves exact bytes and is fully
 * reproducible by `reindex` (this is the definition the SPEC §1 ops→index table
 * implies: `log` bumps `updated`, yet the note is never mutated by `log`).
 */
export function computeUpdated(note: TopicNote, logText: string): string {
  const { entries } = parseLog(logText, note.id);
  let latest = note.updated;
  for (const entry of entries) {
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest ?? isoFromMs(0);
}

/** Build one index entry from a parsed note + its raw log text. */
export function buildEntry(note: TopicNote, logText: string): IndexEntry {
  const { entries } = parseLog(logText, note.id);
  return {
    id: note.id,
    title: note.title,
    aliases: note.aliases,
    tags: note.tags,
    projects: note.projects,
    updated: computeUpdated(note, logText),
    // noteTokens counts the body *excluding* the ## Owner notes section (SPEC
    // §5.7, rev 5) — before + after the owner section — so a large human-owned
    // section can't inflate the cap and a post-owner section can't be smuggled
    // past it.
    noteTokens: countTokens(nonOwnerBody(note.body)),
    logEntries: entries.length,
    compactedThrough: note.compactedThrough,
  };
}

/** Serialize the index with topics sorted by id (stable output); trailing `\n`. */
export function serializeIndex(index: StoreIndex): string {
  const topics: Record<string, IndexEntry> = {};
  for (const id of Object.keys(index.topics).sort()) {
    topics[id] = index.topics[id]!;
  }
  return (
    JSON.stringify(
      { version: index.version, lastTimestamp: index.lastTimestamp, topics },
      null,
      2,
    ) + "\n"
  );
}

export async function writeIndex(
  home: string,
  index: StoreIndex,
  opts: { verify?: "strict" | "racedOk" } = {},
): Promise<boolean> {
  return writeFileAtomic(storePaths(home).index, serializeIndex(index), opts);
}

export async function readIndex(home: string): Promise<StoreIndex | null> {
  return readParsed(storePaths(home).index, (text) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== "object") return null;
    const obj = raw as {
      version?: unknown;
      lastTimestamp?: unknown;
      topics?: unknown;
    };
    if (typeof obj.topics !== "object" || obj.topics === null) return null;
    return {
      version: typeof obj.version === "number" ? obj.version : INDEX_VERSION,
      lastTimestamp:
        typeof obj.lastTimestamp === "string" ? obj.lastTimestamp : null,
      topics: obj.topics as Record<string, IndexEntry>,
    };
  });
}

// ── Index integrity + self-heal (D1: "a broken store and a working one look
//    identical") ────────────────────────────────────────────────────────────
//
// `index.json` is DERIVED (rebuildable from `topics/*.md` + `logs/*.log.md`)
// and per-machine, so `init` gitignores it. That is the right call for sync —
// and it is why a store that was cloned, copied, restored from a backup, or
// unzipped arrives with every note intact and NO index. Search iterates
// `index.topics` and reads the note/log files fresh for each id, so the index
// is effectively the topic LIST search walks: no index → zero results, no
// error, no warning. Same failure shape as a store that is genuinely empty.
//
// Two halves, deliberately split:
//   - `checkIndexIntegrity` DIAGNOSES (read-only, sync) — what `doctor` calls.
//   - `loadIndexOrEmpty` REPAIRS — see the comment on it for why the read path
//     owns the repair and doctor does not.

/** mtime of a file/dir in ms, or null when it does not exist / cannot be stat'd. */
function mtimeMs(p: string): number | null {
  try {
    return statSync(fsPath(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Raw `index.json` bytes as a string, or null when it does not exist / cannot
 * be read. Used ONLY as a change detector around a lock-free rebuild — never
 * parsed, so a torn read is harmless (it simply reads as "changed"). */
function rawIndexBytes(home: string): string | null {
  try {
    return readFileSync(fsPath(storePaths(home).index), "utf8");
  } catch {
    return null;
  }
}

/** Topic ids with a `topics/<id>.md` file, sorted. Sync sibling of `listTopicIds`. */
function listTopicIdsSync(home: string): string[] {
  try {
    return readdirSync(fsPath(storePaths(home).topicsDir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Newest mtime across the DURABLE files the index is derived from. */
function newestDurable(home: string): { ms: number | null; path: string | null } {
  const paths = storePaths(home);
  let best: { ms: number | null; path: string | null } = { ms: null, path: null };
  const scan = (dir: string, suffix: string): void => {
    let names: string[];
    try {
      names = readdirSync(fsPath(dir));
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const full = path.join(dir, name);
      const ms = mtimeMs(full);
      if (ms !== null && (best.ms === null || ms > best.ms)) best = { ms, path: full };
    }
  };
  scan(paths.topicsDir, ".md");
  scan(paths.logsDir, ".log.md");
  return best;
}

/** What `checkIndexIntegrity` found. Every field is observed, never assumed. */
export interface IndexIntegrity {
  /** `index.json` exists on disk. */
  indexPresent: boolean;
  /** Number of `topics/*.md` files (tombstones included — they are files too). */
  topicFiles: number;
  /** Entries in `index.json`; null when the contents could not be compared. */
  indexEntries: number | null;
  /**
   * Whether the ENTRY-level comparison actually ran. False on an encrypted
   * store (doctor never derives keys, so the sealed index.json is opaque to it)
   * and on an unparsable index. When false, `invisible`/`orphaned` are empty
   * because they are UNKNOWN — not because they are zero.
   */
  entriesVerified: boolean;
  /** Why the entry comparison did not run; null when it did. */
  unverifiedReason: string | null;
  /** Live, parsable topic files the index does not list — search cannot see these. */
  invisible: string[];
  /**
   * Topic files that exist on disk and CANNOT BE PARSED. Empty (and unknown,
   * not zero) when `entriesVerified` is false — an encrypted store's sealed
   * notes are unparsable to a doctor that never derives keys, so counting them
   * here would cry wolf on every encrypted store.
   *
   * Why this exists: `reindex` deliberately SKIPS an unparsable note, so the
   * read path's auto-rebuild silently drops it from index.json, and `invisible`
   * deliberately excludes unparsable notes so it does not cry wolf over
   * tombstones. Between the two, a topic the user still has on disk could
   * vanish from `list` and `search` with no message anywhere. One `git pull`
   * that leaves a conflicted note is enough to produce it.
   */
  corrupt: string[];
  /** Index entries with no `topics/<id>.md` on disk. */
  orphaned: string[];
  indexMtimeMs: number | null;
  /** Newest `topics/*.md` or `logs/*.log.md` mtime, and which file it was. */
  newestDurableMs: number | null;
  newestDurablePath: string | null;
  /** Index is older than the newest note/log — its entry fields may be behind. */
  stale: boolean;
}

export interface IndexIntegrityOptions {
  /**
   * The store is encrypted. Callers that must not derive keys (doctor) pass
   * true so the entry comparison is reported UNVERIFIED rather than run against
   * ciphertext — reading a sealed note as "unparsable" and quietly concluding
   * "no problem" is exactly the false-clean this check exists to kill.
   */
  encrypted?: boolean;
}

/**
 * Compare `topics/*.md` on disk against `index.json`. READ-ONLY and sync: this
 * is doctor's half of the contract, and doctor writes nothing.
 */
export function checkIndexIntegrity(
  home: string,
  opts: IndexIntegrityOptions = {},
): IndexIntegrity {
  const paths = storePaths(home);
  const ids = listTopicIdsSync(home);
  const indexMtimeMs = mtimeMs(paths.index);
  const durable = newestDurable(home);
  const stale =
    indexMtimeMs !== null && durable.ms !== null && durable.ms > indexMtimeMs;

  const base = {
    indexPresent: indexMtimeMs !== null,
    topicFiles: ids.length,
    indexMtimeMs,
    newestDurableMs: durable.ms,
    newestDurablePath: durable.path,
    stale,
  };

  if (indexMtimeMs === null) {
    return {
      ...base,
      indexEntries: null,
      entriesVerified: false,
      unverifiedReason: "index.json is absent",
      invisible: [],
      corrupt: [],
      orphaned: [],
    };
  }
  if (opts.encrypted === true) {
    return {
      ...base,
      indexEntries: null,
      entriesVerified: false,
      unverifiedReason:
        "store is encrypted and doctor never derives keys — only index.json's presence and age were checked, not its contents",
      invisible: [],
      corrupt: [],
      orphaned: [],
    };
  }

  let indexIds: string[];
  try {
    const parsed = JSON.parse(readFileSync(fsPath(paths.index), "utf8")) as {
      topics?: unknown;
    };
    if (parsed === null || typeof parsed !== "object" || typeof parsed.topics !== "object" || parsed.topics === null) {
      throw new Error("shape");
    }
    indexIds = Object.keys(parsed.topics as Record<string, unknown>);
  } catch {
    return {
      ...base,
      indexEntries: null,
      entriesVerified: false,
      unverifiedReason: "index.json is present but is not readable as an index",
      invisible: [],
      corrupt: [],
      orphaned: [],
    };
  }

  const known = new Set(indexIds);
  const invisible: string[] = [];
  // Every topic file is parsed, not only the ones missing from the index: a
  // note that is BOTH indexed and unparsable is the dangerous one, because the
  // next rebuild deletes its entry and nothing says so.
  const corrupt: string[] = [];
  for (const id of ids) {
    let note: TopicNote | null;
    try {
      note = parseNote(readFileSync(fsPath(topicNotePath(home, id)), "utf8"), id);
    } catch {
      note = null;
    }
    if (note === null) corrupt.push(id);
    if (known.has(id)) continue;
    // A note the index legitimately omits is not a defect: `reindex` drops
    // tombstones (merged-away losers) and unparsable notes on purpose. Only
    // files that a rebuild WOULD index count as invisible, so this never cries
    // wolf over a merge. Unparsable ones are reported through `corrupt`
    // instead — before this they fell through BOTH filters and were reported
    // nowhere at all.
    if (note === null || isTombstone(note)) continue;
    invisible.push(id);
  }
  const onDisk = new Set(ids);

  return {
    ...base,
    indexEntries: indexIds.length,
    entriesVerified: true,
    unverifiedReason: null,
    invisible,
    corrupt,
    orphaned: indexIds.filter((id) => !onDisk.has(id)).sort(),
  };
}

/** Why a rebuild is warranted, or null when the index is trustworthy enough. */
export type IndexRepairReason = "missing" | "unreadable" | "stale";

/**
 * The repair TRIGGER — deliberately cheap (three `stat`s in the common case),
 * because it runs on every index load including the MCP hot path.
 *
 * Directory mtimes, not per-file: every store write lands through
 * `writeFileAtomic`, i.e. a rename INTO `topics/` or `logs/`, and a rename
 * always bumps the containing directory's mtime on both NTFS and POSIX. Since
 * every op writes `index.json` last, a healthy store always has
 * `mtime(index.json) >= mtime(topics/, logs/)`, and the check is silent.
 *
 * Known limit, stated rather than papered over: a human editing a note IN PLACE
 * with an editor that rewrites the file without a rename does not move the
 * directory mtime, so that edit is not picked up here. It cannot cause the
 * silent-search failure this exists to fix (the topic id set is unchanged —
 * search reads note bodies fresh) — only `list`'s cached title/size go stale,
 * which `doctor` reports and `fimemory reindex` fixes. Doctor's own check stats
 * every file, so the two disagree only in that narrow, reported case.
 */
export function indexRepairReason(
  home: string,
  loaded: StoreIndex | null,
  opts: LoadIndexOptions = {},
): IndexRepairReason | null {
  const paths = storePaths(home);
  const indexMs = mtimeMs(paths.index);
  if (loaded === null) {
    // Nothing to index → nothing to repair. An empty store is legitimately
    // index-less, and rebuilding it on every read would be pure noise.
    if (listTopicIdsSync(home).length === 0) return null;
    return indexMs === null ? "missing" : "unreadable";
  }
  // STALE is a WRITER-ONLY trigger. Measured 2026-08-01: letting lock-free
  // readers act on it regressed `contention-processes` ("sustained reader
  // pressure does not starve the writer"), because a reader that samples in the
  // window between a writer's log write and its index write sees logs newer
  // than the index — at ~390 reads/sec that is a full reindex (every note and
  // log re-read) per read, and the extra open handles starved the writer into a
  // hard E_LOCKED. Under the lock the window cannot exist and the rebuild is
  // free of races, which is also where it needs to fire: `appendLog` derives
  // the monotonic timestamp watermark from the index, and a git pull that lands
  // new log files is exactly a stale index (registry D4).
  //
  // Readers lose nothing that matters: a stale index still holds every topic
  // id, and `search` re-reads notes and logs itself, so retrieval is correct.
  // Only `list`/`brief` metadata can lag, doctor reports that as `index_stale`,
  // and the next write refreshes it.
  if (opts.underLock !== true) return null;
  const topicsMs = mtimeMs(paths.topicsDir);
  if (topicsMs === null || indexMs === null) return null;
  const logsMs = mtimeMs(paths.logsDir) ?? 0;
  return Math.max(topicsMs, logsMs) > indexMs ? "stale" : null;
}

export interface LoadIndexOptions {
  /**
   * The caller already holds the store write lock (every mutating op does).
   * Enables the staleness rebuild — see `indexRepairReason` for why that one is
   * writers-only. Readers leave it false and still get the missing/unreadable
   * repair, which is the case that makes search silently return nothing.
   */
  underLock?: boolean;
}

/**
 * Load the index, rebuilding it first when it is missing or unparsable — and,
 * for callers holding the write lock, when it is older than the newest note or
 * log. (`indexRepairReason` explains why staleness is writers-only; it cost a
 * measured contention regression to learn.)
 *
 * WHY HERE, and why not in `doctor`:
 *
 *  - This is the single funnel. Every consumer of the index — `search`, `list`,
 *    `review`, `create`, `log`, `merge`, `ledger` — comes through this one
 *    function, so one repair covers all of them. Repairing in `search` alone
 *    would leave `fimemory log` on a freshly-cloned store writing a one-entry
 *    index over the top of a store full of topics.
 *  - `doctor` must keep its read-only contract. It is the tool you run WHEN
 *    things are broken; a diagnostic that mutates the thing it is measuring
 *    cannot be trusted mid-debug, and the suite asserts a byte-for-byte
 *    fingerprint of the store across a doctor run. So doctor DIAGNOSES (loudly,
 *    `fail`) and the read path REPAIRS. The repair is still announced: it is
 *    recorded via `recordIndexRepair`, out of the store, and doctor reports it.
 *  - It is safe under the write lock. The rebuild calls `reindex` + `writeIndex`
 *    DIRECTLY, never `reindexStore` — `withLock` is not reentrant, and the
 *    mutating ops call this from inside their lock, so acquiring the lock here
 *    would self-deadlock every write.
 *
 * Lock-free readers race writers, so the rebuild re-checks `index.json`'s mtime
 * before writing and yields to a fresher index rather than clobbering it. That
 * is safe in the worst case regardless: the index is derived, so the worst a
 * lost race can cost is a rebuild that has to happen again.
 *
 * Best-effort by contract — any failure (locked store, read-only disk, a
 * concurrent writer) falls back to the previous behaviour rather than turning a
 * read into an error.
 */
export async function loadIndexOrEmpty(
  home: string,
  opts: LoadIndexOptions = {},
): Promise<StoreIndex> {
  const onDisk = await readIndex(home);
  const reason = indexRepairReason(home, onDisk, opts);
  if (reason === null) return onDisk ?? emptyIndex();

  const indexMtimeBefore = mtimeMs(storePaths(home).index);
  // Only when an index EXISTS: that is the one case the mtime guard below can
  // be blind for. With no index at all, `indexMtimeBefore` is null and any
  // mtime afterwards already proves a writer landed one, so this read would be
  // pure cost on the cloned-store path (the common repair).
  const indexBytesBefore = indexMtimeBefore === null ? null : rawIndexBytes(home);
  try {
    const { index, warnings } = await reindex(home);
    // Never move the store clock backwards: `lastTimestamp` is the monotonic
    // issuer for new writes, and a rebuild derives it from files it can read.
    if (
      onDisk?.lastTimestamp &&
      (index.lastTimestamp === null || onDisk.lastTimestamp > index.lastTimestamp)
    ) {
      index.lastTimestamp = onDisk.lastTimestamp;
    }
    // A REPAIR MAY NOT DELETE WHAT IT CANNOT READ. `reindex` silently SKIPS an
    // unparsable note (E_CORRUPT_SKIPPED), so persisting its output over an
    // index that still listed that topic permanently removes it: `list` stops
    // showing it and `search` stops even warning "topic unparsable; skipped",
    // because the id is no longer in the index it iterates. Reproduced end to
    // end — a `git pull` that leaves one note with conflict markers plus one
    // new file is exactly this shape, and one `log` afterwards was enough.
    //
    // So when the rebuild lost anything and we still HAVE a readable index, we
    // keep the old one: the entries stay in place, the corrupt note stays
    // visible to the user, and nothing is written. When there is no readable
    // index at all (missing/unreadable) the narrowed rebuild is still better
    // than nothing — it is written, but the skipped ids ride along on the
    // repair record so `doctor` can raise them instead of the silence.
    const skipped = warnings.map((w) => w.id).filter((id): id is string => typeof id === "string").sort();
    if (skipped.length > 0 && onDisk !== null) {
      return onDisk;
    }
    // Did a writer land a fresher index while we rebuilt lock-free? Theirs is
    // the one taken under the lock — take it, do not overwrite it.
    //
    // CONTENT first, mtime second. An mtime-only guard is BLIND on filesystems
    // with coarse timestamps: exFAT/FAT32 (a synced or removable drive, a
    // plausible home for a portable store) resolve modification times to 2
    // seconds, and network shares are coarse too, so a writer's index write
    // inside that window compares EQUAL and the lock-free reader overwrote it
    // with a snapshot taken before the writer's new note landed — leaving a
    // just-created topic missing from index.json, invisible to list/search,
    // with neither repair trigger able to fire again. Comparing the bytes
    // detects any write that changed the file, whatever the clock says.
    const indexMtimeNow = mtimeMs(storePaths(home).index);
    const indexBytesNow = indexBytesBefore === null ? null : rawIndexBytes(home);
    const changedUnderUs =
      (indexBytesNow !== null && indexBytesNow !== indexBytesBefore) ||
      (indexMtimeNow !== null &&
        (indexMtimeBefore === null || indexMtimeNow > indexMtimeBefore));
    if (changedUnderUs) {
      return (await readIndex(home)) ?? index;
    }
    // 0.4 skew-gate bypass closed: a v1 client that merely SEARCHES a newer
    // store must not rebuild index.json with parsers that silently skip what
    // they cannot read. Serve the in-memory index, write nothing.
    if (readStoreSchemaVersion(home) > CLIENT_SCHEMA_VERSION) {
      return index;
    }
    // Lock-free repair: verify with "racedOk" — a mismatch on the read-back
    // means a real writer landed after us, which is the same benign race the
    // byte/mtime check above yields to. Their index is at least as fresh.
    const landed = await writeIndex(home, index, { verify: "racedOk" });
    if (!landed) {
      return (await readIndex(home)) ?? index;
    }
    recordIndexRepair(home, reason, Object.keys(index.topics).length, {
      ...(skipped.length > 0 ? { skipped } : {}),
    });
    return index;
  } catch {
    return onDisk ?? emptyIndex();
  }
}

export async function listTopicIds(home: string): Promise<string[]> {
  let files: string[];
  try {
    files = await fsp.readdir(fsPath(storePaths(home).topicsDir));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * Full rebuild from `topics/*.md` + `logs/*.log.md` (SPEC §1). Tombstones
 * (merged-away losers) are excluded; unparsable notes are skipped with a
 * warning. This is the reference the incremental updates must match deep-equal.
 */
export async function reindex(
  home: string,
): Promise<{ index: StoreIndex; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const topics: Record<string, IndexEntry> = {};
  let lastTimestamp: string | null = null;

  for (const id of await listTopicIds(home)) {
    const note = await readParsed(topicNotePath(home, id), (t) =>
      parseNote(t, id),
    );
    if (!note) {
      warnings.push({
        id,
        code: "E_CORRUPT_SKIPPED",
        message: `topic "${id}" note is unparsable; skipped (fix the file and run reindex)`,
      });
      continue;
    }
    if (isTombstone(note)) continue;
    const logText =
      (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
    const entry = buildEntry(note, logText);
    topics[id] = entry;
    if (lastTimestamp === null || entry.updated > lastTimestamp) {
      lastTimestamp = entry.updated;
    }
  }

  return { index: { version: INDEX_VERSION, lastTimestamp, topics }, warnings };
}
