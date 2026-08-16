import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldPathForFs } from "./fsCase.js";

/**
 * Last-read telemetry (trust surface) — a tiny local heartbeat written on every
 * SUCCESSFUL search/get so `fimemory doctor` can answer the one question a
 * stranger actually has: "has any agent read my store recently, or is the whole
 * setup written-but-inert?" (addendum §2.3/§2.4: written ≠ loaded; a config
 * entry or rule block on disk proves nothing until a real read lands).
 *
 * WHERE IT LIVES — NEVER inside the store. The store home (`~/.gestalt`) is
 * synced, git-tracked, exported, and backed up; reads must leave it
 * byte-untouched (a read that dirties the store would poison sync diffs and
 * mid-debug observation). So the heartbeat rides the same out-of-store surface
 * as the E2c session-key cache:
 *   - `GESTALT_TELEMETRY_DIR` env, when set (tests, ops overrides);
 *   - Windows: `%LOCALAPPDATA%\gestalt\telemetry` (sibling of `session-keys`);
 *   - POSIX: `$XDG_CACHE_HOME/gestalt/telemetry` or `~/.cache/gestalt/telemetry`
 *     (deliberately NOT `XDG_RUNTIME_DIR`: that tmpfs is cleared at logout, and
 *     "when was the store last read" should survive a reboot).
 *
 * WHAT IT HOLDS: timestamps, op names, topic ids, and a source label — no note
 * bodies, no secrets, local only, never networked. Best-effort by contract:
 * a failure to record must never fail the read that succeeded.
 */

export interface ReadHeartbeat {
  /** ISO timestamp of the successful read. */
  ts: string;
  /** The op that read (`search`, `get`, `fimemory_search`, `fimemory_get`). */
  op: string;
  /** Topic ids involved (search: the hit ids; get: the requested ids). */
  topics: string[];
  /** Which surface read: `cli` (one-shot spawn) or `mcp` (long-lived server). */
  source: string;
}

/**
 * A self-heal of the derived `index.json` performed by the READ path
 * (`loadIndexOrEmpty`). Recorded here — out of the store, next to the read
 * heartbeat — so `fimemory doctor` can SAY that a repair happened instead of it
 * being another silent success. The index is 100% derived from the note/log
 * files, so a rebuild changes no user data; the record exists for trust, not
 * recovery.
 */
export interface IndexRepairRecord {
  /** ISO timestamp of the rebuild. */
  ts: string;
  /** Why it fired: index.json absent, unparsable, or older than the newest note/log. */
  reason: "missing" | "unreadable" | "stale";
  /** How many topics the rebuilt index holds. */
  topics: number;
  /**
   * Topic ids the rebuild COULD NOT PARSE and therefore dropped. Absent when
   * none were. `reindex` skips an unparsable note by design, so without this
   * the rebuild deleted those entries from index.json with no message anywhere
   * — doctor could not report what it was never told.
   */
  skipped?: string[];
}

export interface TelemetryEntry {
  v: 1;
  /** Normalized store home this telemetry belongs to. */
  home: string;
  /** The most recent successful read, any source. Null when the only thing
   * ever recorded for this store is an index repair (a repair can precede the
   * first successful read — that is exactly the copied-store case). */
  lastRead: ReadHeartbeat | null;
  /** The most recent successful read per source — lets doctor tell a warm
   * long-lived MCP server apart from cold one-shot CLI/shim spawns. */
  bySource: Record<string, ReadHeartbeat>;
  /** Most recent automatic index rebuild by the read path, if any. */
  lastIndexRepair?: IndexRepairRecord;
}

/** Same normalization idea as the session-key cache: absolute, case-folded WHEN
 * THE FILESYSTEM FOLDS CASE (src/fsCase.ts asks the filesystem rather than
 * reading "case-insensitive" off `platform === "win32"`, which is wrong on a
 * default macOS volume), so two spellings of one store share one telemetry
 * slot. (No realpath here — telemetry is diagnostic, not key material; a
 * junction alias at worst splits the history across two slots, which is also
 * all a mis-answered case probe could cost here: doctor would read an empty
 * history rather than the wrong store's.) */
function normalizeHome(home: string): string {
  return foldPathForFs(path.resolve(home));
}

/** The per-user telemetry directory — see the module comment for the choice. */
export function telemetryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GESTALT_TELEMETRY_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "gestalt", "telemetry");
  }
  const cache = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cache, "gestalt", "telemetry");
}

/** The telemetry file for one store — per-store keyed by a digest of the
 * normalized home, exactly like the session-key cache's naming scheme. */
export function telemetryPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash("sha256")
    .update(normalizeHome(home), "utf8")
    .digest("hex")
    .slice(0, 32);
  return path.join(telemetryDir(env), `${digest}.json`);
}

/**
 * Record one successful read. BEST-EFFORT and silent by contract: any failure
 * (read-only dir, exotic ACL, corrupt previous file) is swallowed — telemetry
 * must never fail or slow the read that succeeded, and it must NEVER write
 * into the store home (enforced below, same containment promise as the
 * session-key cache: a store homed at/above the telemetry dir simply goes
 * unrecorded rather than have reads dirty the store's own sync surface).
 */
/** In-process write throttle: a long-lived MCP server answering a burst of
 * identical reads must cost ONE heartbeat, not a disk write per call — the
 * question doctor asks is hours-granular. Keyed per home+op+source so a
 * search followed by a get still records both ops. */
const THROTTLE_MS = 30_000;
const lastRecorded = new Map<string, number>();

export function recordRead(
  home: string,
  op: string,
  topics: string[],
  source: string,
  now: number = Date.now(),
): void {
  try {
    const throttleKey = `${normalizeHome(home)}|${op}|${source}`;
    const prev = lastRecorded.get(throttleKey);
    if (prev !== undefined && now - prev < THROTTLE_MS) return;
    const hb: ReadHeartbeat = {
      ts: new Date(now).toISOString(),
      op,
      topics: topics.slice(0, 10), // ids only, bounded — this is a heartbeat, not a log
      source,
    };
    const previous = readTelemetry(home);
    const written = writeTelemetry(home, {
      v: 1,
      home: normalizeHome(home),
      lastRead: hb,
      bySource: { ...(previous?.bySource ?? {}), [source]: hb },
      // Carry the repair record forward — a heartbeat must not erase it.
      ...(previous?.lastIndexRepair ? { lastIndexRepair: previous.lastIndexRepair } : {}),
    });
    if (written) lastRecorded.set(throttleKey, now);
  } catch {
    /* best effort — never fail the read that succeeded */
  }
}

/**
 * Record that the read path rebuilt the derived index (see `IndexRepairRecord`).
 * Same best-effort/never-inside-the-store contract as `recordRead`: a failure
 * here must never fail the read that just self-healed. Not throttled — repairs
 * are rare by construction (the rebuild's own write clears the trigger).
 */
export function recordIndexRepair(
  home: string,
  reason: IndexRepairRecord["reason"],
  topics: number,
  opts: { skipped?: string[]; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  try {
    const previous = readTelemetry(home);
    writeTelemetry(home, {
      v: 1,
      home: normalizeHome(home),
      lastRead: previous?.lastRead ?? null,
      bySource: previous?.bySource ?? {},
      lastIndexRepair: {
        ts: new Date(now).toISOString(),
        reason,
        topics,
        ...(opts.skipped && opts.skipped.length > 0 ? { skipped: opts.skipped } : {}),
      },
    });
  } catch {
    /* best effort — diagnostics must never break the read */
  }
}

/**
 * Write the telemetry entry atomically-ish (temp + rename): doctor may read
 * concurrently and must never see a torn file. Returns false — without writing
 * — when the telemetry path would land inside the store home, the same
 * containment promise the session-key cache makes: reads leave the store
 * byte-untouched even at the cost of going unrecorded.
 */
function writeTelemetry(home: string, entry: TelemetryEntry): boolean {
  const target = telemetryPath(home);
  const homeKey = normalizeHome(home);
  const targetKey = normalizeHome(target);
  const homePrefix = homeKey.endsWith(path.sep) ? homeKey : homeKey + path.sep;
  if (targetKey === homeKey || targetKey.startsWith(homePrefix)) return false;

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * The telemetry entry for `home`, or null. READ-ONLY and tolerant: a missing,
 * unparsable, mis-shaped, or foreign-home file reads as "no telemetry" — never
 * an error, and never a write (doctor's hard promise is that it writes nothing).
 */
export function readTelemetry(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryEntry | null {
  let raw: string;
  try {
    raw = readFileSync(telemetryPath(home, env), "utf8");
  } catch {
    return null; // absent — the normal never-read state
  }
  try {
    const entry = JSON.parse(raw) as TelemetryEntry;
    const lr = entry?.lastRead;
    // `lastRead` is OPTIONAL now: an index repair can be recorded before the
    // store has ever been read successfully (the copied-store case is exactly
    // that). Present-but-mis-shaped is still rejected wholesale.
    const lastReadOk =
      lr === null ||
      lr === undefined ||
      (typeof lr === "object" &&
        typeof lr.ts === "string" &&
        typeof lr.op === "string" &&
        Array.isArray(lr.topics) &&
        typeof lr.source === "string");
    const rep = entry?.lastIndexRepair;
    const repairOk =
      rep === undefined ||
      (rep !== null &&
        typeof rep === "object" &&
        typeof rep.ts === "string" &&
        typeof rep.reason === "string" &&
        typeof rep.topics === "number");
    if (
      entry !== null &&
      typeof entry === "object" &&
      entry.v === 1 &&
      entry.home === normalizeHome(home) &&
      lastReadOk &&
      repairOk &&
      entry.bySource !== null &&
      typeof entry.bySource === "object"
    ) {
      return { ...entry, lastRead: lr ?? null };
    }
  } catch {
    /* unparsable — treated as absent */
  }
  return null;
}
