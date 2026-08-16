import { loadConfig } from "../config.js";
import type { Warning } from "../errors.js";
import { storePaths } from "../paths.js";
import { reindex, writeIndex } from "../store/index.js";
import type { StoreIndex } from "../store/index.js";
import { withLock } from "../store/lock.js";

/**
 * Rebuild `index.json` entirely from the note/log files (SPEC §1) under the
 * write lock, so a concurrent mutation can't race the rebuild.
 */
export async function reindexStore(
  home: string,
): Promise<{ index: StoreIndex; warnings: Warning[] }> {
  const { config } = loadConfig(storePaths(home).config);
  return withLock(home, config.lockWaitMs, async () => {
    const { index, warnings } = await reindex(home);
    await writeIndex(home, index);
    return { index, warnings };
  });
}
