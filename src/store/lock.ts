import lockfile from "proper-lockfile";
import { GestaltError } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";
import { assertStoreWritable } from "./schema.js";

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
): Promise<T> {
  const paths = storePaths(home);
  const key = fsPath(paths.home);

  const prior = queues.get(key) ?? Promise.resolve();
  // Never let one caller's failure poison the queue for the next.
  const mine = prior.then(
    () => holdAndRun(paths, lockWaitMs, fn),
    () => holdAndRun(paths, lockWaitMs, fn),
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
): Promise<T> {
  // Phase B: refuse writes when this client is older than the store format.
  // Runs before the lockfile so a version skew fails fast without contending.
  assertStoreWritable(paths.home);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(fsPath(paths.home), {
      lockfilePath: fsPath(paths.lockfile),
      realpath: false,
      stale: 60_000,
      retries: retrySchedule(lockWaitMs),
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
  } catch {
    throw new GestaltError(
      "E_LOCKED",
      `Another FIMemory write is in progress (waited ${lockWaitMs} ms).`,
      // NEVER tell the reader to delete the lock directory. Two reasons, and
      // the second is why this changed on 2026-08-01.
      //
      // It is unnecessary: `stale: 60_000` above means proper-lockfile reclaims
      // an abandoned lock by itself on the next acquire (lockfile.js: "If it's
      // stale, remove it and try again!"). Waiting IS the remedy.
      //
      // And it is dangerous in a way the old "but check first" caveat could not
      // cover: deleting a LIVE lock kills the process holding it, and this hint
      // does not only reach a human. `mcp/tools.ts` renders `hint` verbatim into
      // the tool response, so the old text instructed an AI agent with shell
      // access to remove a lock directory — with the caveat being exactly the
      // part an eager agent skips.
      "Wait about a minute and try again — an abandoned lock expires on its own. If it persists, `fimemory doctor` reports what is holding the store.",
    );
  }

  try {
    return await fn();
  } finally {
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
