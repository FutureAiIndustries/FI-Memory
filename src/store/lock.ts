import { readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import lockfile from "proper-lockfile";
import { GestaltError } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";
import { assertStoreWritable } from "./schema.js";

/**
 * D7 — LIVENESS RECLAIM (fixed 2026-08-21; registry docs/DEFECT-REGISTRY.md).
 *
 * proper-lockfile's staleness is mtime-only, so a holder hard-killed (SIGKILL,
 * Windows TerminateProcess, OOM) leaves `.gestalt.lock` with a fresh mtime and
 * wedges every other tool's writes with E_LOCKED for up to the 60 s stale
 * window. The fix: the holder writes a SIBLING owner record (never inside the
 * lock dir — proper-lockfile removes the dir with rmdir on three paths, and a
 * file inside breaks all three with ENOTEMPTY), and a refused contender may
 * steal a lock whose recorded owner is PROVABLY dead.
 *
 * The steal rule is deliberately conservative — a false steal is the one way
 * this code can lose data (two writers interleaving in one store):
 *  - no owner record            → today's mtime semantics (wait it out). This
 *    keeps a user-mkdir'd or third-party lock exactly as it behaved before.
 *  - record from ANOTHER host   → never steal (an SMB-shared store home defeats
 *    pid liveness; the hostname gate is what keeps the oracle sound).
 *  - kill(pid, 0) throws EPERM  → ALIVE (a live other-user process; registry
 *    D5/D7 caveat), never steal.
 *  - pid alive                  → never steal, even though pids recycle —
 *    the worst case of that caution is the status quo, a ≤60 s wait.
 *  - lock dir mtime < GRACE     → not yet: a brand-new mkdir may be a fresh
 *    holder that has not written its owner record over a crashed one's leavings
 *    yet. Dead-crash steals just wait out the 2 s grace instead of 60.
 *  - only ESRCH on a same-host record past the grace window steals: unlink the
 *    record, remove the lock dir, take one immediate re-acquire attempt.
 */
interface LockOwnerRecord {
  pid: number;
  /** Date.now() - uptime at acquisition — identifies the holder process
   * generation so a future reader can spot pid recycling. */
  processStartTime: number;
  host: string;
  acquiredAt: number;
}

const STEAL_GRACE_MS = 2_000;

function ownerRecordPath(lockPath: string): string {
  return `${lockPath}.owner`;
}

/** Best-effort — a lock without a record degrades to mtime semantics, which is
 * the pre-fix behavior, never worse. */
function writeOwnerRecord(lockPath: string): void {
  const record: LockOwnerRecord = {
    pid: process.pid,
    processStartTime: Math.round(Date.now() - process.uptime() * 1000),
    host: os.hostname(),
    acquiredAt: Date.now(),
  };
  try {
    writeFileSync(ownerRecordPath(lockPath), JSON.stringify(record), "utf8");
  } catch {
    /* degrade to mtime semantics */
  }
}

function removeOwnerRecord(lockPath: string): void {
  try {
    unlinkSync(ownerRecordPath(lockPath));
  } catch {
    /* already gone, or degrade */
  }
}

/** True only when the record proves the holder dead and the lock was removed —
 * the caller then gets exactly one immediate re-acquire attempt. */
function tryStealDeadLock(lockPath: string): boolean {
  try {
    const raw = readFileSync(ownerRecordPath(lockPath), "utf8");
    const record = JSON.parse(raw) as Partial<LockOwnerRecord>;
    if (typeof record.pid !== "number" || record.host !== os.hostname()) return false;
    // A record with no lock dir is garbage from a crashed release — it is
    // overwritten on the next successful acquire and never a reason to steal.
    let lockMtime: number;
    try {
      lockMtime = statSync(lockPath).mtimeMs;
    } catch {
      return false;
    }
    if (Date.now() - lockMtime < STEAL_GRACE_MS) return false;
    try {
      process.kill(record.pid, 0);
      return false; // alive (or at least answerable) — never steal
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false; // EPERM = alive
    }
    unlinkSync(ownerRecordPath(lockPath));
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-process queue, one per store home.
 *
 * The cross-process lockfile is the wrong tool for same-process contention,
 * and same-process contention is the common case: ONE MCP server handling many
 * concurrent tool calls. Before this, every one of those calls raced for the
 * same file lock and slept a fixed 100 ms tick on each miss, so a store shared
 * by a few tools had a hard global ceiling of ~10 writes/second and, past
 * roughly 50 queued writers, simply started REFUSING writes that were never
 * retried anywhere above (measured 2026-07-28: 60 parallel appends → 9 lost).
 *
 * Now callers in one process form an ordered queue and hand off in
 * microseconds, and only the queue head ever touches the lockfile — so the
 * filesystem sees one contender per process instead of N.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Cross-process wait schedule. Jittered exponential, not a fixed tick: a fixed
 * tick both wastes the whole interval on every miss and makes two processes
 * retry in lockstep forever. Randomised so colliding waiters spread out.
 */
function retrySchedule(lockWaitMs: number): {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
  randomize: boolean;
} {
  // ~5 ms first wait doubling to a 250 ms ceiling: reaches a 5 s budget in
  // about 30 attempts instead of the 50 a flat 100 ms tick allowed, while
  // giving a fast handoff to whoever is waiting on a lock held briefly.
  const minTimeout = 5;
  const maxTimeout = 250;
  let total = 0;
  let wait = minTimeout;
  let retries = 0;
  while (total < lockWaitMs && retries < 1000) {
    total += wait;
    wait = Math.min(wait * 1.5, maxTimeout);
    retries += 1;
  }
  return { retries: Math.max(1, retries), minTimeout, maxTimeout, factor: 1.5, randomize: true };
}

/**
 * Run `fn` while holding the store's single write lock (SPEC §1). Every mutating
 * op does *all* its file writes inside one `withLock` call, then releases.
 * Waits up to `lockWaitMs`; on timeout throws `E_LOCKED` with a retry hint.
 * Readers never call this — they are lock-free (SPEC §1).
 *
 * Two layers, deliberately: an in-process queue (fast, ordered, no filesystem)
 * and the cross-process lockfile (correct across tools). A caller waits at most
 * `lockWaitMs` for the FILE lock; time spent behind same-process callers is not
 * charged against that budget, because those hand off in microseconds and
 * charging them is what made a healthy store reject its own writes.
 */
export async function withLock<T>(
  home: string,
  lockWaitMs: number,
  fn: () => Promise<T>,
  opts: {
    /** ONLY `fimemory migrate` passes this: the migrate verb exists to REPAIR
     * the very state (corrupt or behind schema.json) the gate refuses, so
     * gating it would make the repair unreachable. Every other mutating op
     * keeps the gate. */
    skipSchemaGate?: boolean;
  } = {},
): Promise<T> {
  const paths = storePaths(home);
  const key = fsPath(paths.home);

  const prior = queues.get(key) ?? Promise.resolve();
  // Never let one caller's failure poison the queue for the next.
  const mine = prior.then(
    () => holdAndRun(paths, lockWaitMs, fn, opts),
    () => holdAndRun(paths, lockWaitMs, fn, opts),
  );
  // Keep the chain alive regardless of outcome, and drop the entry when this
  // is the last waiter so the map cannot grow without bound.
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return mine;
}

async function holdAndRun<T>(
  paths: ReturnType<typeof storePaths>,
  lockWaitMs: number,
  fn: () => Promise<T>,
  opts: { skipSchemaGate?: boolean } = {},
): Promise<T> {
  // Phase B: refuse writes when this client is older than the store format
  // (or the format marker is unparsable — 0.4). Runs before the lockfile so a
  // version skew fails fast without contending.
  if (!opts.skipSchemaGate) assertStoreWritable(paths.home);

  const lockPath = fsPath(paths.lockfile);
  const acquire = (retries: ReturnType<typeof retrySchedule>) =>
    lockfile.lock(fsPath(paths.home), {
      lockfilePath: lockPath,
      realpath: false,
      stale: 60_000,
      retries,
      // WITHOUT THIS, proper-lockfile's default is `(err) => { throw err; }`,
      // and it fires from a TIMER callback — so it lands as an uncaught
      // exception, and there is no `process.on("uncaughtException")` anywhere
      // in this codebase to catch it. When the holder is the MCP server, that
      // kills the server mid-session and every memory tool goes dead for the
      // rest of the conversation, from a background timer nobody saw.
      //
      // A compromised lock is worth saying out loud and worth SURVIVING. Write
      // one line to stderr and never throw: `release()` then rejects with
      // ERELEASED, which the catch below already swallows.
      onCompromised: (err: Error) => {
        process.stderr.write(
          `fimemory: the write lock on this store was lost or removed while a write was running (${err.message}). ` +
            `That write may not have finished — re-run the command, then check \`fimemory doctor\`.\n`,
        );
      },
    });

  const lockedError = () =>
    new GestaltError(
      "E_LOCKED",
      `Another FIMemory write is in progress (waited ${lockWaitMs} ms).`,
      // NEVER tell the reader to delete the lock directory. Two reasons, and
      // the second is why this changed on 2026-08-01.
      //
      // It is unnecessary: a lock whose holder died is reclaimed by liveness
      // (the owner record above) or, absent a record, by proper-lockfile's own
      // 60 s staleness on the next acquire. Waiting IS the remedy.
      //
      // And it is dangerous in a way the old "but check first" caveat could not
      // cover: deleting a LIVE lock kills the process holding it, and this hint
      // does not only reach a human. `mcp/tools.ts` renders `hint` verbatim into
      // the tool response, so the old text instructed an AI agent with shell
      // access to remove a lock directory — with the caveat being exactly the
      // part an eager agent skips.
      "Wait about a minute and try again — an abandoned lock expires on its own. If it persists, `fimemory doctor` reports what is holding the store.",
    );

  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquire(retrySchedule(lockWaitMs));
  } catch {
    // D7 liveness reclaim: a same-host owner record whose pid is provably dead
    // earns exactly one steal + immediate re-acquire; anything less certain
    // falls through to the same E_LOCKED as before.
    if (tryStealDeadLock(lockPath)) {
      try {
        release = await acquire(retrySchedule(Math.min(lockWaitMs, 500)));
      } catch {
        throw lockedError();
      }
    } else {
      throw lockedError();
    }
  }
  // Write (or overwrite a crashed predecessor's) owner record immediately —
  // the mkdir-to-record gap is what the steal's grace window covers.
  writeOwnerRecord(lockPath);

  try {
    return await fn();
  } finally {
    // Owner record goes first: once it is gone a contender can no longer read
    // a stale record during the release itself, and a record that outlives a
    // successful release is plain garbage (handled as such by the steal path).
    removeOwnerRecord(lockPath);
    try {
      await release();
    } catch {
      // Best-effort, but NOT indifferent. `unlock` deletes the entry from
      // proper-lockfile's internal map BEFORE removing the directory, so once
      // this rmdir fails the signal-exit backstop is disarmed too — a perfectly
      // clean exit can then leave a FRESH-mtime lock behind, wedging every
      // other tool for the full 60 s stale window with no crash involved. That
      // path needs no kill at all, which makes it likelier than the SIGKILL
      // case the probes measure. Transient EPERM/EBUSY on directory removal is
      // the same Windows class this codebase already concedes for renames with
      // a 30 s budget, while release got zero retries.
      await retryRelease(release);
    }
  }
}

/**
 * A few jittered attempts to remove the lock directory after the first failed.
 *
 * Deliberately short and deliberately silent: this runs in a `finally`, the
 * caller's own result is already decided, and the worst case is exactly the
 * status quo — the lock ages out after `stale`. Jitter so two processes losing
 * the race do not retry in lockstep.
 */
async function retryRelease(release: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 60 + i * 80 + Math.floor(Math.random() * 60)));
    try {
      await release();
      return;
    } catch {
      /* keep trying, then give up quietly */
    }
  }
}
