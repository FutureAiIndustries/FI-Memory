import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fsPath, storePaths } from "../paths.js";

/**
 * D5 — THE JANITOR (fixed 2026-08-21; registry docs/DEFECT-REGISTRY.md).
 *
 * A writer killed inside its temp-write window leaves
 * `.{basename}.tmp-{pid}-{ctr}` behind, and until this module nothing ever
 * removed it: it accumulated across crashes, sleeps and force-quits, and a
 * git-synced store committed it (now also gitignored by the store template).
 *
 * The classifier here is the ONE definition of our atomic-temp name shape —
 * `ops/migrateEncrypt.ts` imports it too, so the migration carry/audit and the
 * janitor can never drift apart on what counts as residue.
 *
 * Sweep rules, exactly the registry's own prescription (age AND liveness both
 * matter), refined by the D5 probe's requirements:
 *  - pid provably dead (kill(pid,0) → ESRCH)  → delete regardless of age — a
 *    fresh orphan from a crash must not linger for a threshold.
 *  - EPERM or a live pid                       → the writer may be mid-rename;
 *    delete only past the age threshold (a real writer holds a temp for
 *    milliseconds; an OLD temp under a live pid means the pid was recycled).
 *  - The threshold sits far above atomic.ts's 30 s rename deadline, so the
 *    ENOENT hazard (sweeping a temp a live writer is about to rename, which
 *    hard-fails that write) cannot fire even for a maximally slow rename —
 *    and callers run the sweep under the store lock anyway, where no same-store
 *    writer can be mid-rename at all.
 *  - Only store-managed directories are scanned, and only names matching the
 *    ANCHORED temp grammar are ever touched. `conflicts/` is never scanned —
 *    parked conflict files are another machine's memory, a human queue.
 */

export const ATOMIC_TEMP_RE = /^\.([^\\/]+)\.tmp-(\d+)-\d+$/;

export function isAtomicTemp(name: string): boolean {
  return ATOMIC_TEMP_RE.test(name);
}

/** The `<base>` captured from an atomic-write temp name, or null if not one. */
export function atomicTempBase(name: string): string | null {
  const m = ATOMIC_TEMP_RE.exec(name);
  return m ? m[1]! : null;
}

/** Residue older than this is swept even when its pid reads as alive (pids
 * recycle); comfortably above RENAME_WAIT_MS (30 s) so a maximally slow but
 * live rename can never lose its temp. Mirrors the session-cache sweeper. */
const TMP_AGE_MS = 5 * 60_000;

function pidProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // answerable → alive
  } catch (e) {
    // EPERM = alive under another user (registry caveat); only ESRCH is proof.
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export interface SweepResult {
  removed: string[];
  kept: string[];
}

/**
 * Remove crashed-writer temp residue from the store's managed directories.
 * Callers hold the store lock (reindex does); every failure is fail-open —
 * a residue file that cannot be removed is simply reported as kept.
 * `dryRun` scans without touching anything (doctor's reporting path — doctor
 * never mutates; the remedy it names is `fimemory reindex`).
 */
export function sweepStoreTmp(
  home: string,
  now: number = Date.now(),
  opts: { dryRun?: boolean } = {},
): SweepResult {
  const paths = storePaths(home);
  const dirs = [paths.home, paths.topicsDir, paths.logsDir, paths.proposalsDir, paths.ledgersDir];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(fsPath(dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = ATOMIC_TEMP_RE.exec(name);
      if (!m) continue;
      const full = path.join(fsPath(dir), name);
      const pid = Number(m[2]);
      let sweep = false;
      if (Number.isFinite(pid) && pidProvablyDead(pid)) {
        sweep = true;
      } else {
        try {
          sweep = now - statSync(full).mtimeMs > TMP_AGE_MS;
        } catch {
          continue; // vanished mid-scan — someone else got it
        }
      }
      const rel = path.relative(fsPath(paths.home), full);
      if (!sweep) {
        kept.push(rel);
        continue;
      }
      if (opts.dryRun) {
        removed.push(rel); // "would remove"
        continue;
      }
      try {
        unlinkSync(full);
        removed.push(rel);
      } catch {
        kept.push(rel);
      }
    }
  }
  return { removed, kept };
}
