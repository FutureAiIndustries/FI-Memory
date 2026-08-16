import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { assertValidId } from "../id.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { recordServed } from "../session.js";
import { countTokens } from "../tokens.js";
import { parseLog } from "../store/log.js";
import { parseNote } from "../store/note.js";
import { readText } from "../store/read.js";

export interface CompactPacket {
  id: string;
  /** Full current note text (frontmatter + body) — the agent drafts the folded note from this and submits it via `update` (rev 5, #5). */
  note: string;
  compactedThrough: string | null;
  /** Raw entry blocks to fold, in order. */
  entries: string[];
  hasMore: boolean;
  /** Timestamp of the last included entry — pass as `--since` to continue. */
  cursor: string | null;
  tokensUsed: number;
  warnings: Warning[];
}

/**
 * A paginated compaction work packet (SPEC §5.1/§5.7, rev 4). Read-only: returns
 * the current note + the log entries after `compactedThrough` (or `--since`),
 * capped at `maxTokensPerCompact` with `hasMore` + `cursor` for continuation.
 * The runtime never summarizes (invariant 2). The **note body is exempt from
 * the per-response cap** — if it alone is ≥ the cap, the packet returns the note
 * with zero entries and a "shrink the note first" warning.
 */
export async function compact(
  home: string,
  id: string,
  opts: { since?: string } = {},
): Promise<CompactPacket> {
  assertValidId(id); // no path join with an unvalidated id (traversal guard)
  const { config } = loadConfig(storePaths(home).config);

  const noteText = await readText(topicNotePath(home, id));
  if (noteText === null) {
    throw new GestaltError("E_NOT_FOUND", `No topic "${id}".`, `fimemory create ${id} --title "..."`);
  }
  const note = parseNote(noteText, id);
  if (!note) {
    throw new GestaltError("E_SCHEMA", `Topic "${id}" note is unparsable.`, `Fix topics/${id}.md, then retry.`);
  }

  const logText = (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
  const { entries } = parseLog(logText, id);
  const since = opts.since ?? note.compactedThrough;
  const candidates = since
    ? entries.filter((e) => e.timestamp > since) // "entries after" is strict (SPEC §5.1)
    : entries;

  const bodyTokens = countTokens(note.body); // fold budget counts the body, not frontmatter
  const warnings: Warning[] = [];

  if (bodyTokens >= config.maxTokensPerCompact) {
    warnings.push({
      id,
      code: "budget",
      message: `note body is ${bodyTokens} tokens (≥ the ${config.maxTokensPerCompact} fold budget); shrink the note before folding entries`,
    });
    recordServed(1, bodyTokens); // session meter (SPEC §6)
    return {
      id,
      note: noteText,
      compactedThrough: note.compactedThrough,
      entries: [],
      hasMore: candidates.length > 0,
      cursor: null,
      tokensUsed: bodyTokens,
      warnings,
    };
  }

  const included: string[] = [];
  let used = bodyTokens;
  let hasMore = false;
  let cursor: string | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i]!;
    const entryTokens = countTokens(entry.raw);
    if (used + entryTokens > config.maxTokensPerCompact) {
      if (included.length === 0) {
        // Force progress: a single over-budget entry is returned alone so
        // `--since=cursor` can always advance (never stall — #6).
        warnings.push({ id, code: "budget", message: `one entry (${entryTokens} tokens) exceeds the fold budget; returned alone` });
        included.push(entry.raw);
        used += entryTokens;
        cursor = entry.timestamp;
        hasMore = i < candidates.length - 1;
      } else {
        hasMore = true;
      }
      break;
    }
    included.push(entry.raw);
    used += entryTokens;
    cursor = entry.timestamp;
  }

  recordServed(1, used); // session meter (SPEC §6)
  return {
    id,
    note: noteText,
    compactedThrough: note.compactedThrough,
    entries: included,
    hasMore,
    cursor,
    tokensUsed: used,
    warnings,
  };
}
