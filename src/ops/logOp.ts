import { isoFromMs, nextMonotonic, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { nearMatches } from "../fuzzy.js";
import { assertValidId } from "../id.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import {
  advanceGlobal,
  buildEntry,
  globalLastMs,
  listTopicIds,
  loadIndexOrEmpty,
  writeIndex,
} from "../store/index.js";
import type { IndexEntry } from "../store/index.js";
import { withLock } from "../store/lock.js";
import {
  assertAppendable,
  formatEntryBlock,
  maxTimestampMs,
  normalizeRefs,
  parseLog,
  serializeLog,
  timestampSet,
} from "../store/log.js";
import type { LogEntry, NewEntry } from "../store/log.js";
import { loadOrCreateMachineId } from "../store/machineId.js";
import { parseNote } from "../store/note.js";
import { readText } from "../store/read.js";

export interface LogOptions {
  now?: Clock;
}

/**
 * Append a typed log entry (SPEC §4/§5): the topic must exist (else E_NOT_FOUND
 * with near-match suggestions — never auto-created), the entry is validated
 * (type, token cap, anti-forgery, supersede target), a monotonic server
 * timestamp is assigned, and the log + index are written under one lock.
 */
export async function appendLog(
  home: string,
  id: string,
  entry: NewEntry,
  opts: LogOptions = {},
): Promise<{ timestamp: string; entry: IndexEntry; warnings: Warning[] }> {
  assertValidId(id); // no path join with an unvalidated id (traversal guard)
  const { config } = loadConfig(storePaths(home).config);
  const now = opts.now ?? systemClock;

  return withLock(home, config.lockWaitMs, async () => {
    const index = await loadIndexOrEmpty(home, { underLock: true });
    const noteText = await readText(topicNotePath(home, id));
    if (noteText === null) {
      const suggestions = nearMatches(id, await listTopicIds(home));
      const hint = suggestions.length
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : "";
      throw new GestaltError(
        "E_NOT_FOUND",
        `No topic "${id}".${hint}`,
        `fimemory create ${id} --title "..."`,
      );
    }
    const note = parseNote(noteText, id);
    if (!note) {
      throw new GestaltError(
        "E_SCHEMA",
        `Topic "${id}" note is unparsable.`,
        `Fix topics/${id}.md by hand, then retry.`,
      );
    }

    const logText = (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
    // Pass the AUTHENTICATED id (not the header) so a wrong key / relocated log
    // fails closed here instead of parsing to [] and then being overwritten.
    const { entries, warnings: parseWarnings } = parseLog(logText, id);
    // Timestamps are strictly increasing per store (SPEC §4, rev 4).
    // Self-heal the monotonic floor from THIS topic's log too: a plain git pull
    // leaves index.json (gitignored) with a stale lastTimestamp, so peers' newer
    // entries would otherwise be collidable. (pullStore reindexes fully; this
    // is the cheap write-path guard when someone pulls with raw git.)
    const indexFloor = globalLastMs(index);
    const logFloor = maxTimestampMs(entries);
    const floor =
      indexFloor === null
        ? logFloor
        : logFloor === null
          ? indexFloor
          : Math.max(indexFloor, logFloor);
    const ts = isoFromMs(nextMonotonic(now(), floor));
    // Bare absolute paths become machine-qualified `~<machineId>:<abs>` refs on
    // the wire (§A ruling 3) — normalized BEFORE formatting so the validated
    // block and the written block are the same bytes.
    const refs = normalizeRefs(entry.refs, () => loadOrCreateMachineId(home));
    const resolved: NewEntry = refs ? { ...entry, refs } : entry;
    const block = formatEntryBlock(ts, resolved);
    // The FULL block — refs included — goes to the token check: refs count
    // against entryTokenCap (Eric's ruling H3; the default cap is 350 for it).
    assertAppendable(block, resolved, config.entryTokenCap, timestampSet(entries));

    const appended: LogEntry = {
      timestamp: ts,
      type: entry.type,
      project: entry.project,
      agent: entry.agent,
      supersedes: entry.supersedes ?? null,
      reported: entry.reported ?? null,
      refs: refs && refs.length > 0 ? refs : null,
      summary: entry.summary,
      raw: block,
    };
    const newLog = serializeLog(id, [...entries, appended]);
    await writeFileAtomic(topicLogPath(home, id), newLog);

    index.topics[id] = buildEntry(note, newLog);
    advanceGlobal(index, ts);
    await writeIndex(home, index);

    return { timestamp: ts, entry: index.topics[id]!, warnings: parseWarnings };
  });
}
