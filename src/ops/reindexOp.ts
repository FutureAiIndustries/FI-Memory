import { loadConfig } from "../config.js";
import type { Warning } from "../errors.js";
import { storePaths } from "../paths.js";
import { reindex, writeIndex } from "../store/index.js";
import type { StoreIndex } from "../store/index.js";
import { withLock } from "../store/lock.js";
import { sweepStoreTmp } from "../store/tmpResidue.js";

/**
 * Rebuild `index.json` entirely from the note/log files (SPEC §1) under the
 * write lock, so a concurrent mutation can't race the rebuild.
 */
export async function reindexStore(
  home: string,
): Promise<{ index: StoreIndex; warnings: Warning[] }> {
  const { config } = loadConfig(storePaths(home).config);
  return withLock(home, config.lockWaitMs, async () => {
    // D5 janitor: under the lock no same-store writer can be mid-rename, so
    // sweeping crashed-writer temp residue here is race-free. Reindex is the
    // natural host — it already runs after every pull and on repair.
    sweepStoreTmp(home);
    const { index, warnings } = await reindex(home);
    await writeIndex(home, index);
    return { index, warnings };
  });
}
