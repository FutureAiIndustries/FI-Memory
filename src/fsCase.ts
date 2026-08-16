import { statSync } from "node:fs";
import path from "node:path";

/**
 * IS THIS PATH ON A CASE-INSENSITIVE FILESYSTEM? Measured, not assumed.
 *
 * ── why this module exists ──────────────────────────────────────────────────
 *
 * Three places key a per-store identity off a digest of the store home:
 * sessionKeyCache (the cache file that holds a plaintext DEK), telemetry, and
 * shimAudit. All three used to fold case with `platform === "win32"`, i.e. they
 * equated "case-insensitive filesystem" with "Windows". That is wrong on macOS:
 * a default APFS volume is case-insensitive and case-preserving, exactly like
 * NTFS. On a Mac, `~/.gestalt` and `~/.Gestalt` are ONE directory that would
 * have produced TWO digests, and the consequence is not cosmetic — see
 * sessionKeyCache's normalizeHome comment: `lock` would wipe the entry for the
 * spelling you typed while a warm session survived under the alias, so a
 * passphrase reset would not end the session it is supposed to end.
 *
 * Folding everywhere is not the fix either, and would be a worse bug: Linux
 * ext4/btrfs is genuinely case-sensitive, so `~/store-a` and `~/store-A` are two
 * different stores and folding would merge them into ONE cache entry — two
 * stores cross-unlocking through a shared key slot.
 *
 * So neither branch of `platform ===` answers the question. The filesystem
 * does, and it can be asked directly.
 *
 * ── how the probe works, and why it writes nothing ──────────────────────────
 *
 * Take the deepest EXISTING ancestor of the path, flip the case of its final
 * segment, and stat that spelling. Three outcomes:
 *
 *   - it resolves to the same (dev, ino)  → case-insensitive
 *   - it does not resolve                 → case-sensitive
 *   - it resolves to a DIFFERENT inode    → case-sensitive, and the user
 *                                           happens to own both spellings
 *
 * Read-only on purpose. The obvious alternative (create a temp file, stat the
 * opposite spelling) would put a stray file in the user's store or home
 * directory, and a crash mid-probe would leave it there.
 *
 * ── when the probe cannot answer ────────────────────────────────────────────
 *
 * A root path, or a segment with no cased characters (`/srv/2026/`), gives no
 * spelling to flip. Then, and only then, this falls back to the platform
 * default, and that fallback is an INFERENCE, not a measurement:
 *
 *   win32   NTFS/ReFS are case-insensitive by default. Per-directory
 *           case-sensitivity exists (the WSL flag) and is not detected by the
 *           fallback — the probe does detect it when it can run.
 *   darwin  APFS and HFS+ are case-insensitive in their default (installer)
 *           configuration. Case-SENSITIVE APFS volumes exist and are a
 *           supported option. UNVERIFIED ON HARDWARE BY THIS PROJECT: nobody
 *           here owns a Mac. The probe above is what actually decides on a
 *           real Mac; this line only covers the no-cased-characters corner.
 *   linux   ext4/btrfs/xfs are case-sensitive. ext4 has an opt-in
 *           casefold feature, not the default.
 *
 * `.github/scripts/posix-modes.mjs` measures the probe against the real
 * filesystem on the Linux and macOS runners and prints what it found, so the
 * fallback's assumptions are never the thing a claim rests on.
 */

/** Measured answers, keyed by the probed directory (folded, since two spellings
 * of one directory must not probe twice). Only MEASURED results are cached; an
 * inconclusive walk is cheap and may become conclusive once a directory is
 * created mid-process (`init` digests the home before it exists). */
const measured = new Map<string, boolean>();

/** Escape hatch for tests and for a user on an exotic filesystem the probe gets
 * wrong. `1`/`true` forces folding on, `0`/`false` forces it off. It changes the
 * digest identity of every store on the machine, so it is a diagnostic, not a
 * setting: set it in one shell to reproduce a problem, not in a profile. */
function override(env: NodeJS.ProcessEnv): boolean | null {
  const v = env["GESTALT_FS_CASE_INSENSITIVE"]?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

function platformFallback(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/** Stat both spellings of one existing directory. `null` = no answer here. */
function probeDir(dir: string): boolean | null {
  const parent = path.dirname(dir);
  if (parent === dir) return null; // a root: nothing to flip
  const base = path.basename(dir);
  const flipped = base.toLowerCase() === base ? base.toUpperCase() : base.toLowerCase();
  if (flipped === base) return null; // no cased characters in this segment
  let self;
  try {
    self = statSync(dir);
  } catch {
    return null; // vanished between the existence walk and here
  }
  let other;
  try {
    other = statSync(path.join(parent, flipped));
  } catch {
    return false; // the other spelling does not resolve → case-sensitive
  }
  // Same directory under both spellings → the filesystem folded it for us.
  // (ino can be 0 on some exotic Windows filesystems; then this compares 0 to 0
  // and answers "insensitive", which is the right answer on Windows anyway.)
  return other.ino === self.ino && other.dev === self.dev;
}

/**
 * True when `target`'s filesystem treats `A` and `a` as the same name. `target`
 * need not exist; the nearest existing ancestor is what gets asked. Never
 * throws — an unanswerable probe returns the documented platform fallback.
 */
export function isCaseInsensitiveFs(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const forced = override(env);
  if (forced !== null) return forced;
  try {
    let dir = path.resolve(target);
    for (let hops = 0; hops < 64; hops++) {
      const key = dir.toLowerCase();
      const hit = measured.get(key);
      if (hit !== undefined) return hit;
      let exists = false;
      try {
        exists = statSync(dir).isDirectory();
      } catch {
        /* walk up */
      }
      if (exists) {
        const answer = probeDir(dir);
        if (answer !== null) {
          measured.set(key, answer);
          return answer;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to the documented inference */
  }
  return platformFallback();
}

/**
 * The case-folded spelling of an absolute path, for use as a KEY: lowercased on
 * a case-insensitive filesystem so two spellings of one directory produce one
 * identity, left exactly as-is on a case-sensitive one so two directories that
 * differ only in case stay two identities.
 */
export function foldPathForFs(abs: string, env: NodeJS.ProcessEnv = process.env): string {
  return isCaseInsensitiveFs(abs, env) ? abs.toLowerCase() : abs;
}

/** Test seam: drop memoized probe results. */
export function resetFsCaseCacheForTests(): void {
  measured.clear();
}
