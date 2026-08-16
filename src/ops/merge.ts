import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { assertValidId } from "../id.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import {
  buildEntry,
  loadIndexOrEmpty,
  writeIndex,
} from "../store/index.js";
import type { IndexEntry } from "../store/index.js";
import { withLock } from "../store/lock.js";
import { parseLog, serializeLog } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import {
  isTombstone,
  parseNote,
  serializeNote,
  tombstoneBody,
} from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { splitOwnerNotes } from "../store/ownerNotes.js";
import { pendingCountForTopic } from "../store/proposals.js";
import { readText } from "../store/read.js";

/**
 * Merge `loser` into `winner` (SPEC §2). Rejected with E_PENDING_PROPOSALS if
 * either has a pending suggested edit. Otherwise, in one lock hold: the loser's
 * log folds into the winner's (time-sorted, **deduped by identity so a retried
 * partial merge converges rather than multiplying entries** — #9); the loser's
 * curated **owner notes are carried into the winner** under a marker rather than
 * silently destroyed (#5); the loser's id + aliases become winner aliases; the
 * loser note becomes a tombstone and its log is cleared; the loser leaves the
 * index and the winner entry is rebuilt.
 */
export async function mergeTopics(
  home: string,
  loser: string,
  winner: string,
): Promise<{ winner: IndexEntry; warnings: Warning[] }> {
  assertValidId(loser); // no path join with an unvalidated id (traversal guard)
  assertValidId(winner);
  if (loser === winner) {
    throw new GestaltError(
      "E_INVALID_ID",
      "Cannot merge a topic into itself.",
      "Pick two different topic ids.",
    );
  }
  const { config } = loadConfig(storePaths(home).config);

  return withLock(home, config.lockWaitMs, async () => {
    const loserText = await readText(topicNotePath(home, loser));
    if (loserText === null) throw notFound(loser);
    const winnerText = await readText(topicNotePath(home, winner));
    if (winnerText === null) throw notFound(winner);

    const loserNote = parseNote(loserText, loser);
    const winnerNote = parseNote(winnerText, winner);
    if (!loserNote || !winnerNote) {
      throw new GestaltError(
        "E_SCHEMA",
        "One of the notes is unparsable; fix it by hand and retry.",
        `fimemory reindex`,
      );
    }
    if (isTombstone(loserNote)) {
      throw new GestaltError(
        "E_EXISTS",
        `"${loser}" is already merged into ${loserNote.mergedInto}.`,
        `fimemory get ${loserNote.mergedInto}`,
      );
    }
    if (isTombstone(winnerNote)) {
      throw new GestaltError(
        "E_EXISTS",
        `"${winner}" is a merge tombstone (merged into ${winnerNote.mergedInto}).`,
        `fimemory get ${winnerNote.mergedInto}`,
      );
    }

    if (
      (await pendingCountForTopic(home, loser)) > 0 ||
      (await pendingCountForTopic(home, winner)) > 0
    ) {
      throw new GestaltError(
        "E_PENDING_PROPOSALS",
        `Resolve pending suggested edits on "${loser}"/"${winner}" before merging.`,
        "fimemory review list",
      );
    }

    const warnings: Warning[] = [];

    // Fold logs: time-sorted, deduped by identity so retries converge (#9).
    const loserLog = (await readText(topicLogPath(home, loser))) ?? `# ${loser} log\n`;
    const winnerLog =
      (await readText(topicLogPath(home, winner))) ?? `# ${winner} log\n`;
    const merged = dedupeEntries(
      [
        ...parseLog(winnerLog, winner).entries,
        ...parseLog(loserLog, loser).entries,
      ].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      ),
    );
    const newWinnerLog = serializeLog(winner, merged);

    // Loser id + aliases become winner aliases (deduped; never the winner's own id).
    const aliases = new Set([...winnerNote.aliases, loser, ...loserNote.aliases]);
    aliases.delete(winner);

    // Carry the loser's owner notes into the winner rather than losing them (#5).
    let winnerBody = winnerNote.body;
    const carried = ownerContent(splitOwnerNotes(loserNote.body).owner);
    if (carried.length > 0) {
      const block = `\n<!-- merged from ${loser} -->\n${carried}\n`;
      winnerBody = splitOwnerNotes(winnerNote.body).present
        ? winnerNote.body.replace(/\s*$/, "\n") + block
        : winnerNote.body.replace(/\s*$/, "\n") + `\n## Owner notes\n${block}`;
      warnings.push({
        id: loser,
        code: "owner_notes_carried",
        message: `carried "${loser}" owner notes into "${winner}" (review them)`,
      });
    }

    const updatedWinner: TopicNote = {
      ...winnerNote,
      aliases: [...aliases],
      body: winnerBody,
    };
    const tombstone: TopicNote = {
      ...loserNote,
      aliases: [],
      mergedInto: winner,
      body: tombstoneBody(winner),
    };

    await writeFileAtomic(topicLogPath(home, winner), newWinnerLog);
    await writeFileAtomic(topicNotePath(home, winner), serializeNote(updatedWinner));
    await writeFileAtomic(topicNotePath(home, loser), serializeNote(tombstone));
    await writeFileAtomic(topicLogPath(home, loser), `# ${loser} log\n`); // clear (#9)

    const index = await loadIndexOrEmpty(home, { underLock: true });
    delete index.topics[loser];
    index.topics[winner] = buildEntry(updatedWinner, newWinnerLog);
    await writeIndex(home, index);

    return { winner: index.topics[winner]!, warnings };
  });
}

/**
 * Drop entries with identical raw text (the block includes its timestamp) so a
 * retried partial merge converges instead of multiplying entries (#9).
 */
function dedupeEntries(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.raw)) continue;
    seen.add(e.raw);
    out.push(e);
  }
  return out;
}

/** The owner-notes section content (heading line stripped), trimmed. */
function ownerContent(ownerSection: string): string {
  const nl = ownerSection.indexOf("\n");
  return nl === -1 ? "" : ownerSection.slice(nl + 1).trim();
}

function notFound(id: string): GestaltError {
  return new GestaltError(
    "E_NOT_FOUND",
    `No topic "${id}".`,
    `fimemory create ${id} --title "..."`,
  );
}
