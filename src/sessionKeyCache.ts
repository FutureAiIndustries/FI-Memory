import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { foldPathForFs } from "./fsCase.js";

/**
 * Session key cache (E2c) — after ONE passphrase unlock, subsequent one-shot
 * CLI commands skip the ~1.5 s pure-JS Argon2id derivation and unlock in
 * milliseconds, for a bounded window (config `sessionKeyCacheTtlHours`,
 * default 8 h; `fimemory lock` ends it immediately).
 *
 * WHAT IS CACHED, HONESTLY: the unwrapped 32-byte DEK, hex-encoded — the same
 * exposure class as the already-documented `GESTALT_KEY` env seam (which users
 * put in shell profiles on this same disk). This cache is a usability wrapper
 * on that ALREADY-ACCEPTED path, not a new class of secret. Its one hard job
 * is to never widen the STOLEN-ARTIFACT surface of the at-rest threat model
 * (a stolen/backed-up/synced copy of the STORE): the cache lives OUTSIDE the
 * store home, so it can never ride the store's git sync, an `export`, or a
 * backup of `~/.gestalt`. An adversary running as the user is out of scope —
 * that adversary already owns GESTALT_KEY/GESTALT_PASSPHRASE too.
 *
 * WHERE IT LIVES (never under any store home — ENFORCED at write, see
 * `writeSessionCache`: a store homed at/above the cache dir refuses to cache
 * rather than put the DEK inside the store's own git/backup/export surface):
 *   - `GESTALT_SESSION_DIR` env, when set (tests, ops overrides);
 *   - Windows: `%LOCALAPPDATA%\gestalt\session-keys` (per-user ACL'd);
 *   - POSIX with `XDG_RUNTIME_DIR`: `$XDG_RUNTIME_DIR/gestalt/session-keys` —
 *     tmpfs, mode 0700, cleared at logout/reboot, so on mainstream Linux the
 *     cached key never touches the disk at all (the best stolen-disk story);
 *   - else `$XDG_CACHE_HOME/gestalt/session-keys` or `~/.cache/gestalt/session-keys`.
 * Files are 0600, dirs 0700 (POSIX; Windows relies on the per-user ACL of
 * LOCALAPPDATA). DPAPI is deliberately NOT on this path: the only dependency-
 * free binding is spawning powershell, which costs hundreds of ms per command —
 * it would reinstate the very tax this cache exists to remove.
 *
 * FULL-DISK THEFT, HONESTLY: on Windows / non-XDG_RUNTIME_DIR paths a thief of
 * the WHOLE disk gets a not-yet-expired cache file alongside the store — the
 * same way they'd get a GESTALT_KEY export in `.bashrc` or a `GESTALT_PASSPHRASE`
 * in a shell history. What bounds that window, stated exactly:
 *   - EVERY gestalt invocation sweeps this directory (`sweepSessionCache`) —
 *     any command, any store, with or without GESTALT_KEY, whatever the ttl
 *     config, including `--version`/`--help`/bare `gestalt` (the CLI sweeps
 *     before its early returns). Expired entries and orphaned temp files
 *     (ours by shape/naming — see `isSessionEntryShape`) are deleted on sight,
 *     and the invoked store's entry is re-clamped against the CURRENT config
 *     TTL (lowering `sessionKeyCacheTtlHours` is retroactive; `0` wipes the
 *     entry, it does not merely ignore it).
 *   - `fimemory lock` wipes every cached key NOW (`--home` scopes it to one
 *     store) and fails LOUDLY, non-zero, if it cannot.
 *   - The residue, honestly: a machine that never runs gestalt again CANNOT
 *     sweep itself. On the Windows / XDG_CACHE paths the last entry simply
 *     sits on disk past its expiry until some future invocation or `gestalt
 *     lock` deletes it — the TTL is a promise the next run keeps, not a
 *     self-destruct. Run `fimemory lock` before lending, imaging, or
 *     decommissioning a machine. (On the XDG_RUNTIME_DIR tmpfs path,
 *     logout/reboot clears it by construction.)
 *
 * FAIL-CLOSED, NEVER SCARY: a missing/expired/corrupt/mismatched cache file is
 * silently discarded (best-effort zeroize + unlink) and the caller falls back
 * to the normal passphrase path. The cache can never poison an unlock — the
 * CLI verifies a cached DEK against the store's own ciphertext (the same
 * `verifyDekOpensStore` binding every other unlock path uses) before trusting it.
 */

export interface SessionCacheEntry {
  v: 1;
  /** Normalized store home this key belongs to (also encoded in the filename). */
  home: string;
  /** Hex-encoded 32-byte DEK — same exposure class as GESTALT_KEY (see above). */
  dek: string;
  /** Epoch ms after which this entry is dead (fixed at unlock; never slides). */
  expires: number;
  /** Epoch ms the entry was written — the anchor the CURRENT config TTL clamps
   * against on every sweep/read, so lowering the TTL applies retroactively. */
  created: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** This module's own on-disk naming scheme — the sweep and `lock` touch ONLY
 * files matching these, so a user who points GESTALT_SESSION_DIR at a shared
 * directory can never have unrelated files deleted out from under them. A
 * name is necessary but NOT sufficient for EITHER blind scan (the sweep AND
 * `fimemory lock` with no `--home`): 32-hex `.json` is a plausible content-
 * addressed name for some other tool's files, so both additionally require the
 * CONTENT to parse to this module's entry shape (`isSessionEntryShape`) before
 * they will zeroize or delete a file. Temps cannot be shape-checked (a temp is
 * by definition possibly half-written), so their name is pinned to exactly what
 * `writeSessionCache` produces (`.tmp-<pid digits>`); the sweep adds an age
 * gate, an explicit `lock` ends them on sight. */
const ENTRY_NAME = /^[0-9a-f]{32}\.json$/;
const TMP_NAME = /^[0-9a-f]{32}\.json\.tmp-\d+$/;

/** Positive ownership proof for the blind dir scans — BOTH `sweepSessionCache`
 * AND `wipeAllSessionCaches` (`fimemory lock` with no `--home`): this is OUR
 * entry shape (v/home/dek/expires), not merely our filename pattern. Anything
 * that does not parse to this — unparsable bytes included — is treated as
 * FOREIGN and left alone; deleting an unrelated file in a user-pointed shared
 * GESTALT_SESSION_DIR would be data destruction. (The deliberate residue: a
 * corrupted-on-disk entry of ours no longer proves itself and is left too by
 * the blind scans — but it is still cleared by NAME where the home is known:
 * `readSessionCache` clears the invoked store's own slot, and `fimemory lock
 * --home` / `recover` / re-`init` wipe that store's exact digest file.) */
function isSessionEntryShape(e: unknown): e is SessionCacheEntry {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as SessionCacheEntry).v === 1 &&
    typeof (e as SessionCacheEntry).home === "string" &&
    typeof (e as SessionCacheEntry).dek === "string" &&
    typeof (e as SessionCacheEntry).expires === "number"
  );
}

/** An atomic-write temp older than this is a crash leftover holding a live
 * key, not a write in flight — writes go open→write→fsync→rename within
 * milliseconds, so minutes of age proves abandonment. */
const TMP_ORPHAN_AGE_MS = 5 * 60_000;

/**
 * Rename with the same contention budget the store's atomic writer uses.
 *
 * 2026-07-28 contention audit: this was a bare `renameSync`, so ONE concurrent
 * reader of the cache file (Windows refuses a rename over a file another
 * process holds open) lost the cache write silently and forever — the caller
 * swallows throws by contract, so the user just unlocked and got no warm
 * cache, with nothing said. Synchronous because this whole path is sync; the
 * budget is short since the loser here is a best-effort cache, not data.
 */
function renameWithRetrySync(from: string, to: string): void {
  const RETRIES = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retriable || attempt >= RETRIES) throw err;
      // Busy-wait briefly: sync context, and the holder is a reader that
      // closes in microseconds.
      const until = Date.now() + Math.min(10 * 2 ** attempt, 120);
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

/**
 * Normalize a store home for keying: the REAL path (resolving junctions,
 * symlinks, `subst` drives and 8.3 short names), absolute, and case-folded WHEN
 * THE FILESYSTEM FOLDS CASE. This must be the one true identity of a store: if
 * two spellings of the SAME directory produced different digests,
 * `lock`/`recover`/re-`init` would wipe the invoked spelling while a warm
 * session survived under the alias — a passphrase reset that does not end the
 * session it should.
 *
 * The fold used to be `platform === "win32"`, which reads "Windows" for
 * "case-insensitive filesystem" and is wrong on a default macOS volume: APFS
 * folds case exactly like NTFS, so `--home ~/.Gestalt` and `--home ~/.gestalt`
 * are one directory that produced two cache entries, and `lock` ended only one
 * of them. Folding unconditionally would be a worse bug on Linux, where two
 * spellings really are two stores. `isCaseInsensitiveFs` asks the filesystem
 * instead of the platform; see src/fsCase.ts for how and for what it does when
 * it cannot get an answer.
 */
function normalizeHome(home: string): string {
  const abs = resolveReal(path.resolve(home));
  return foldPathForFs(abs);
}

/** realpath with a documented fallback for a not-yet-existing path (a fresh
 * `init` wipes/keys the cache before mkdir): realpath the deepest EXISTING
 * ancestor and re-append the rest, which matches the digest the store will
 * have once it is created through that same ancestor. If no ancestor exists
 * at all (a dead drive letter), fall back to the resolved spelling. */
function resolveReal(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** The per-user cache directory — see the module comment for the choice. */
export function sessionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GESTALT_SESSION_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "gestalt", "session-keys");
  }
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return path.join(runtime, "gestalt", "session-keys");
  const cache = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cache, "gestalt", "session-keys");
}

/**
 * The cache file for one store — PER-STORE by construction: the filename is a
 * digest of the normalized (realpathed) home, and the entry inside repeats the
 * home and is checked on read, so two stores can never cross-unlock through
 * the cache — and two SPELLINGS of one store share one entry.
 */
export function sessionCachePath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash("sha256").update(normalizeHome(home), "utf8").digest("hex").slice(0, 32);
  return path.join(sessionCacheDir(env), `${digest}.json`);
}

/** Best-effort zeroize: overwrite the file's bytes in place (fsync'd) before
 * the caller unlinks. Honest limits: on journaling/CoW filesystems and
 * wear-leveled SSDs old sectors may survive; what this buys is that the LIVE
 * filesystem no longer serves the key (and on the XDG_RUNTIME_DIR tmpfs path,
 * that IS physical erasure). Never throws — removal is the load-bearing part. */
function zeroize(file: string): void {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r+");
    try {
      writeSync(fd, Buffer.alloc(size), 0, size, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}

export interface SweepOptions {
  /** The store this invocation is about, if any — its entry is additionally
   * clamped against `ttlMs` (the CURRENT config TTL), not just its own
   * embedded expiry. */
  home?: string;
  /** Current `sessionKeyCacheTtlHours` for `home`, in ms. `<= 0` (the
   * paranoid opt-out) wipes any entry for `home` on sight. */
  ttlMs?: number;
  now?: number;
}

/**
 * Opportunistic sweep of the session-keys dir — the enforcement teeth of the
 * TTL. Without it the TTL existed only at warm-read time: a user who unlocked
 * once and then stopped using the CLI left the plaintext DEK on disk forever,
 * because only a later warm read deleted it. Called on EVERY touch of the
 * cache dir (read, write, lock) and once per CLI invocation regardless of
 * command, GESTALT_KEY, or ttl config. Deletes, best-effort:
 *   - every entry whose own embedded expiry has passed (ANY store's);
 *   - the invoked store's entry when the CURRENT config TTL says it is too
 *     old — validity is min(embedded expires, created + current ttl), so
 *     lowering the TTL is retroactive — or when the TTL is `<= 0`;
 *   - orphaned atomic-write temp files, in OUR exact temp naming, older than
 *     a few minutes (a crash between temp-write and rename would otherwise
 *     hold the full key, invisible to warm reads and expiry, forever).
 * A file is OURS to judge only if it parses to this module's entry shape
 * (`isSessionEntryShape`); a 32-hex `.json` that does not — another tool's
 * file in a user-pointed shared GESTALT_SESSION_DIR — is FOREIGN and is left
 * untouched, never zeroized, never deleted. Entries for OTHER stores are
 * judged by their embedded expiry only — their config (and so their current
 * TTL) lives inside stores this invocation has no business opening. Never
 * throws: a sweep failure must not break the command that triggered it.
 */
export function sweepSessionCache(opts: SweepOptions = {}): void {
  const now = opts.now ?? Date.now();
  const dir = sessionCacheDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Absent (the common case: nothing was ever cached) or unlistable. The
    // sweep is best-effort by contract and stays quiet either way; the LOUD
    // path for an unlistable dir is `fimemory lock` (wipeAllSessionCaches),
    // which refuses to claim "nothing was cached" it cannot prove.
    return;
  }
  let invoked: string | undefined;
  if (opts.home !== undefined) {
    try {
      invoked = path.basename(sessionCachePath(opts.home));
    } catch {
      /* keying failure — sweep the rest on embedded expiry alone */
    }
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (TMP_NAME.test(name)) {
      try {
        if (now - statSync(file).mtimeMs >= TMP_ORPHAN_AGE_MS) {
          zeroize(file);
          unlinkSync(file);
        }
      } catch {
        /* in flight or held open — a later sweep gets it */
      }
      continue;
    }
    if (!ENTRY_NAME.test(name)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // unreadable or unparsable — ownership unproven, not ours to touch
    }
    if (!isSessionEntryShape(entry)) continue; // FOREIGN — see isSessionEntryShape
    let dead = now >= entry.expires;
    if (!dead && name === invoked && opts.ttlMs !== undefined) {
      dead =
        opts.ttlMs <= 0 ||
        (typeof entry.created === "number" && now >= entry.created + opts.ttlMs);
    }
    if (dead) {
      zeroize(file);
      try {
        unlinkSync(file);
      } catch {
        /* held open — `fimemory lock` is the loud path for this */
      }
    }
  }
}

/**
 * Persist the unlocked DEK for `home` until `now + ttlMs`. BEST-EFFORT by
 * contract: a failure to cache (read-only cache dir, exotic ACL) must never
 * fail the command that just unlocked successfully — callers swallow throws.
 * Atomic (temp + rename); a failed write unlinks its own temp so no
 * half-written file holds the key (the sweep catches crash leftovers).
 *
 * CONTAINMENT, enforced: if the cache target would land inside the
 * (realpathed) store home — a store homed at/above the cache dir, e.g.
 * `GESTALT_HOME=%LOCALAPPDATA%\gestalt` — this REFUSES to cache and returns.
 * "Never under any store home" is the module's one hard promise; the command
 * still works, it just stays cold on every run.
 */
export function writeSessionCache(
  home: string,
  dek: Uint8Array,
  ttlMs: number,
  now: number = Date.now(),
): void {
  if (ttlMs <= 0) return;
  const target = sessionCachePath(home);
  const homeKey = normalizeHome(home);
  const targetKey = normalizeHome(target);
  // A store homed at a filesystem ROOT keeps its trailing separator
  // (`C:\`, `/`), so blindly appending `path.sep` built an impossible
  // double-separator prefix and the guard waved the root case through —
  // the one home that contains EVERYTHING, cache dir included.
  const homePrefix = homeKey.endsWith(path.sep) ? homeKey : homeKey + path.sep;
  if (targetKey === homeKey || targetKey.startsWith(homePrefix)) {
    return; // refuse: the DEK must never enter the store's own surface
  }
  sweepSessionCache({ home, ttlMs, now });
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const entry: SessionCacheEntry = {
    v: 1,
    home: homeKey,
    dek: Buffer.from(dek).toString("hex"),
    expires: now + ttlMs,
    created: now,
  };
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(entry) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetrySync(tmp, target);
  } catch (err) {
    zeroize(tmp);
    try {
      unlinkSync(tmp);
    } catch {
      /* the sweep's orphan pass is the backstop */
    }
    throw err;
  }
}

/**
 * The cached DEK for `home` as 64-hex, or null. NEVER throws and NEVER returns
 * a stale claim: anything missing, expired (by its own expiry OR the caller's
 * current `ttlMs` clamp), unparsable, mis-shaped, or keyed to a different home
 * is wiped (best-effort) and reported as absent, so the caller falls back to
 * the ordinary passphrase path — requirement: a broken cache must read as
 * "please unlock", never as an error that scares the user.
 *
 * This proves freshness and shape ONLY. Whether the key actually opens THIS
 * store's ciphertext is the caller's job (`assertEnvKeyMatchesStore`), exactly
 * as for GESTALT_KEY — the cache adds no new trust path.
 */
export function readSessionCache(
  home: string,
  now: number = Date.now(),
  opts: { ttlMs?: number } = {},
): string | null {
  sweepSessionCache(
    opts.ttlMs !== undefined ? { home, now, ttlMs: opts.ttlMs } : { home, now },
  );
  const file = sessionCachePath(home);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // absent — the normal cold state
  }
  const dek = validSessionDek(raw, home, now, opts.ttlMs);
  if (dek !== null) return dek;
  wipeSessionCache(home); // expired/corrupt/foreign — remove it, fall back quietly
  return null;
}

/** The one definition of "this cache entry is live and this store's" — shared
 * by the reading path (which repairs) and the peeking path (which must not). */
function validSessionDek(
  raw: string,
  home: string,
  now: number,
  ttlMs?: number,
): string | null {
  try {
    const entry = JSON.parse(raw) as SessionCacheEntry;
    if (
      entry !== null &&
      typeof entry === "object" &&
      entry.v === 1 &&
      entry.home === normalizeHome(home) &&
      typeof entry.dek === "string" &&
      HEX64.test(entry.dek) &&
      typeof entry.expires === "number" &&
      now < entry.expires &&
      (ttlMs === undefined ||
        (typeof entry.created === "number" && now < entry.created + ttlMs))
    ) {
      return entry.dek;
    }
  } catch {
    /* unparsable → invalid */
  }
  return null;
}

/**
 * The warm DEK, read WITHOUT `readSessionCache`'s sweep-and-wipe side effects.
 * Doctor's sealed content pass (0.5) needs the key itself, and doctor never
 * writes — a stale or corrupt entry is simply null here and stays on disk for
 * the next REAL unlock to clear.
 */
export function peekSessionDek(
  home: string,
  now: number = Date.now(),
  opts: { ttlMs?: number } = {},
): string | null {
  let raw: string;
  try {
    raw = readFileSync(sessionCachePath(home), "utf8");
  } catch {
    return null;
  }
  return validSessionDek(raw, home, now, opts.ttlMs);
}

/** What a read-only observer may know about the cache for one store. Never
 * carries the DEK. `expired` is distinct from `cold` on purpose: "a key WAS
 * cached and has aged out" and "nothing was ever cached" are different answers
 * to "why is my shim asking for the passphrase again?". */
export type SessionCachePeek =
  | { state: "warm"; expires: number; msRemaining: number }
  | { state: "expired"; expires: number }
  | { state: "cold" };

/**
 * READ-ONLY cache status for `home` — the observer `fimemory doctor` and
 * `fimemory lock --status` share. Unlike `readSessionCache` it NEVER sweeps,
 * wipes, zeroizes, or writes anything (doctor's hard promise is zero writes),
 * and it never returns key material — only the freshness verdict. The same
 * validity rule as a real read applies: entry shape, matching home, and
 * min(embedded expires, created + current ttl) when `ttlMs` is given; a
 * mis-shaped/foreign/unparsable file reads as `cold`, exactly as a warm read
 * would treat it — a broken cache must never look healthier to the observer
 * than to the unlock path.
 */
export function peekSessionCache(
  home: string,
  now: number = Date.now(),
  opts: { ttlMs?: number } = {},
): SessionCachePeek {
  let raw: string;
  try {
    raw = readFileSync(sessionCachePath(home), "utf8");
  } catch {
    return { state: "cold" };
  }
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    return { state: "cold" };
  }
  if (
    !isSessionEntryShape(entry) ||
    entry.home !== normalizeHome(home) ||
    !HEX64.test(entry.dek)
  ) {
    return { state: "cold" };
  }
  let expires = entry.expires;
  if (opts.ttlMs !== undefined && typeof entry.created === "number") {
    expires = Math.min(expires, entry.created + opts.ttlMs);
  }
  if (opts.ttlMs !== undefined && opts.ttlMs <= 0) return { state: "expired", expires };
  return now < expires
    ? { state: "warm", expires, msRemaining: expires - now }
    : { state: "expired", expires };
}

/** The three honest outcomes of a wipe. `lock` must distinguish them: "did
 * not exist" and "exists but could not be deleted" are opposite claims about
 * whether a live key remains on disk, and conflating them made `lock` print
 * "nothing was cached" and exit 0 while an AV-held/ACL'd file kept serving. */
export type WipeOutcome =
  | { outcome: "wiped" }
  | { outcome: "nothing" }
  | { outcome: "failed"; path: string; error: string };

/**
 * Wipe the cache for `home` NOW (the `fimemory lock --home` verb, and the
 * invalidation hook for `recover`/re-`init` — all keyed by the realpathed
 * home, so any spelling of the store kills the one true entry). Best-effort
 * zeroize before unlink (limits stated on `zeroize`). Then sweeps the rest of
 * the dir — a lock is a cache-dir touch like any other.
 *
 * "Nothing was cached" is claimed ONLY on the unlink's own ENOENT — never
 * from a pre-check. The old `existsSync` gate returned false on ANY stat
 * error (EPERM'd dir, exotic ACL), which read as "nothing" while a live key
 * sat behind the error; the unlink itself is the one probe whose answer is
 * exact: removed, provably absent, or FAILED with the OS's reason.
 */
export function wipeSessionCache(home: string): WipeOutcome {
  const file = sessionCachePath(home);
  let result: WipeOutcome;
  zeroize(file); // no-op when the file is absent; removal below is the load-bearing act
  try {
    unlinkSync(file);
    result = { outcome: "wiped" };
  } catch (err) {
    result =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? { outcome: "nothing" }
        : {
            outcome: "failed",
            path: file,
            error: err instanceof Error ? err.message : String(err),
          };
  }
  sweepSessionCache({ home });
  return result;
}

export interface WipeAllResult {
  /** Cache files (entries AND temp leftovers) that were removed. */
  wiped: number;
  /** Files that exist but could NOT be removed — the caller must be LOUD:
   * key material is still on disk. */
  failed: { path: string; error: string }[];
}

/**
 * Wipe EVERY cached session key — all stores' entries plus any temp leftovers,
 * valid or expired. This is `fimemory lock` with no `--home`: "lock" with no
 * qualifier must mean "no usable cached key remains on this machine", never
 * "only the store some cwd/env spelling happened to select". OWNERSHIP is
 * PROVEN, never assumed from the filename alone (the SAME rule the sweep uses):
 * a 32-hex `.json` entry is wiped only if its CONTENT parses to this module's
 * shape (`isSessionEntryShape`), and a temp only if it wears our exact
 * `.tmp-<pid>` name. A FOREIGN 32-hex `.json` — another tool's file in a
 * user-pointed shared GESTALT_SESSION_DIR, whether valid-JSON-wrong-shape or
 * not JSON at all — is left BYTE-IDENTICAL, never zeroized, never unlinked.
 * An UNREADABLE 32-hex `.json` (held open, ACL'd) is the one entry we cannot
 * judge by content: we still refuse to delete it (a blind unlink would destroy
 * it if foreign — on POSIX unlink needs only the dir's write bit), but `lock`
 * reports it as a NAMED failure rather than skipping it silently, so a
 * possibly-live key it could not clear is never passed off as "nothing cached".
 * The deliberate residue, stated: a genuinely corrupted entry of OURS no
 * longer proves itself and is left too (the safer choice in a shared dir,
 * where by name alone it is indistinguishable from a foreign non-JSON file);
 * it is still cleared by NAME where the home is known — `fimemory lock --home
 * <store>`, `recover`, and re-`init` target that store's exact digest file —
 * and it cannot warm-unlock anyway (`readSessionCache` rejects and clears it).
 *
 * Only ENOENT on the cache dir means "nothing was cached": an UNLISTABLE dir
 * (EPERM/EACCES/anything else) is the opposite claim — entries may exist
 * behind the error and this wipe cannot even SEE them, let alone delete them —
 * so it is reported as a failure for `lock` to be loud about, naming the dir.
 *
 * Documented non-fix (round-2 audit, single-verifier: not a bug): `lock`
 * cannot atomically fence a CONCURRENT unlock — another gestalt process
 * mid-unlock can re-cache a key an instant after this wipe scanned the dir.
 * That is the user's own live action on their own machine, not the passive
 * stolen-artifact adversary this cache defends against; the re-cached entry
 * is bounded by the same TTL/sweep/lock lifecycle as any other.
 */
export function wipeAllSessionCaches(): WipeAllResult {
  const result: WipeAllResult = { wiped: 0, failed: [] };
  const dir = sessionCacheDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return result; // no cache dir — nothing cached anywhere
    }
    result.failed.push({
      path: dir,
      error: `cannot list the session cache dir — cached keys may remain: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return result;
  }
  const wipe = (file: string): void => {
    zeroize(file);
    try {
      unlinkSync(file);
      result.wiped += 1;
    } catch (err) {
      result.failed.push({
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  for (const name of names) {
    const file = path.join(dir, name);
    if (TMP_NAME.test(name)) {
      // OUR atomic-write temp, pinned to writeSessionCache's exact
      // `.tmp-<pid digits>` naming. A temp is possibly half-written, so it
      // cannot be shape-checked — the pinned name IS the ownership proof, and
      // lock wipes it NOW regardless of age (the sweep's orphan-age gate is a
      // sweep concern; an explicit lock ends every one of OUR temps).
      wipe(file);
      continue;
    }
    if (!ENTRY_NAME.test(name)) continue;
    // 32-hex `.json` is NECESSARY but NOT SUFFICIENT: it is a plausible
    // content-addressed name for another tool's file in a user-pointed shared
    // GESTALT_SESSION_DIR. Prove OURS by CONTENT before touching a byte — the
    // SAME positive-ownership gate `sweepSessionCache` applies. Zeroize/unlink
    // run only AFTER that proof (`wipe` below); a blind pre-unlink zeroize
    // would blank a foreign file even when the unlink was correctly skipped.
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished — nothing to do
      // Held open / ACL'd / otherwise unreadable: ownership is UNPROVEN. We do
      // NOT delete a file we cannot prove is ours — it may be a foreign tool's,
      // and on POSIX an unlink needs only the DIR's write bit, so blindly
      // unlinking would destroy a merely-unreadable foreign file. But `lock`
      // must stay LOUD about a possibly-live key it could not clear, so this is
      // a NAMED failure, never a silent skip. (A held FOREIGN file thus draws a
      // false "may remain" warning — a false alarm loses no data, the one thing
      // that must never happen in a shared dir.)
      result.failed.push({
        path: file,
        error: `unreadable — cannot confirm it is a gestalt session entry, so it was left in place; a cached key may still be here: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue; // readable but not our JSON — FOREIGN (or a corrupted entry of ours), left byte-identical
    }
    if (!isSessionEntryShape(entry)) continue; // FOREIGN — left byte-identical
    wipe(file); // OURS by shape
  }
  return result;
}
