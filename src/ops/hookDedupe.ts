import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * DOUBLE-HOOK GUARD (plugin un-hold, 0.3.1).
 *
 * A machine can carry the retrieval hook on two surfaces at once: the
 * settings.json handler that `fimemory setup` writes, and the Claude Code
 * plugin's hooks.json. Both fire on the same UserPromptSubmit, both run
 * `hook-retrieve`, and the second injection doubles the context cost of every
 * prompt — the exact hold that kept the plugin out of 0.3.0.
 *
 * Rather than detecting the other surface (plugin install layouts vary by
 * host version and a detector that misses is worse than none), the guard
 * makes the RETRIEVAL idempotent: the first invocation for a given
 * (session, prompt) wins by exclusively creating a marker file in the OS
 * temp dir; a second invocation inside the window sees the marker and exits
 * empty. The marker lives in tmp, never the store — the hook must stay
 * read-only toward the store and must work while the store is locked.
 *
 * Every failure path fails OPEN (retrieve rather than starve): a broken tmp
 * dir, an unreadable marker, or a filesystem race must never cost the user
 * their memory injection. The worst failure of this guard is the status quo.
 */

const PREFIX = "fimemory-hook-";
/** Two handlers for one prompt fire within milliseconds of each other; the
 * window only needs to cover that burst. Kept short so a genuinely repeated
 * prompt (same text, resent by the user) retrieves again. */
const WINDOW_MS = 5_000;
/** Markers a crash left behind are swept opportunistically once they are
 * clearly outside any plausible burst. */
const SWEEP_AGE_MS = 60_000;

export interface HookDedupeOpts {
  /** Marker directory override, for tests. Defaults to the OS temp dir. */
  dir?: string;
  /** Clock override, for tests. */
  now?: number;
}

/**
 * Returns true when another hook invocation already served this exact
 * (session, prompt) within the window — the caller should exit silently.
 * Returns false (and claims the marker) when this invocation should proceed.
 */
export function hookAlreadyServed(
  sessionId: string,
  prompt: string,
  opts: HookDedupeOpts = {},
): boolean {
  const dir = opts.dir ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const key = createHash("sha256").update(`${sessionId}\n${prompt}`).digest("hex").slice(0, 24);
  const marker = path.join(dir, `${PREFIX}${key}`);

  // Opportunistic sweep, bounded and fail-open: tmp is shared, so only our
  // own prefix is ever touched.
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(PREFIX)) continue;
      const p = path.join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > SWEEP_AGE_MS) unlinkSync(p);
      } catch {
        /* another invocation got there first — fine */
      }
    }
  } catch {
    /* unreadable tmp dir — fail open below */
  }

  try {
    // Exclusive create: of two handlers firing simultaneously, exactly one
    // wins the marker and proceeds; the loser lands in the catch.
    closeSync(openSync(marker, "wx"));
    return false;
  } catch {
    try {
      if (now - statSync(marker).mtimeMs <= WINDOW_MS) return true;
      // A marker outside the window is a leftover, not a duplicate: refresh
      // it and proceed.
      unlinkSync(marker);
      closeSync(openSync(marker, "wx"));
      return false;
    } catch {
      // Any surprise on the fallback path: retrieve. Duplicated injection is
      // a cost; a starved injection is a broken product.
      return false;
    }
  }
}
