import { loadIndexOrEmpty } from "../store/index.js";
import { countPendingSync } from "../store/proposals.js";

export interface ListRow {
  id: string;
  title: string;
  updated: string;
  noteTokens: number;
  logEntries: number;
}

/**
 * Index summaries only, newest first (SPEC §5.1). **CLI-only** — the MCP surface
 * must not expose this (agents search, they don't browse).
 */
export async function list(
  home: string,
): Promise<{ rows: ListRow[]; pending: number }> {
  const index = await loadIndexOrEmpty(home);
  const rows = Object.values(index.topics)
    .map((e) => ({
      id: e.id,
      title: e.title,
      updated: e.updated,
      noteTokens: e.noteTokens,
      logEntries: e.logEntries,
    }))
    .sort((a, b) =>
      a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1,
    );
  return { rows, pending: countPendingSync(home).count };
}
