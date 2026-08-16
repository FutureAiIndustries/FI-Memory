import { isoFromMs, nextMonotonic, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { findCollisions } from "../fuzzy.js";
import type { ExistingTopic } from "../fuzzy.js";
import { assertValidId } from "../id.js";
import fsp from "node:fs/promises";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../paths.js";
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
import { serializeLog } from "../store/log.js";
import { serializeNote, skeletonNote } from "../store/note.js";
import { readText } from "../store/read.js";

export interface CreateOptions {
  /** CLI `--new`: bypass the fuzzy collision check (humans only; MCP has no force). */
  force?: boolean;
  now?: Clock;
}

function hasControlChars(s: string): boolean {
  for (const ch of s) if (ch.charCodeAt(0) < 0x20) return true;
  return false;
}

/**
 * Create a topic (SPEC §2/§5.1): validate the id + title, run the frozen fuzzy
 * collision check against every existing id/alias — sourced from the topic
 * files ∪ the index, so a hand-dropped or stale-index note still counts (#24) —
 * then write the note skeleton + empty log + index entry under one lock.
 */
export async function createTopic(
  home: string,
  id: string,
  title: string,
  opts: CreateOptions = {},
): Promise<{ entry: IndexEntry; warnings: Warning[] }> {
  assertValidId(id);
  if (title.length > 120) {
    throw new GestaltError(
      "E_SCHEMA",
      `Title is ${title.length} characters; the max is 120.`,
      `fimemory create ${id} --title "<shorter title>"`,
    );
  }
  if (hasControlChars(title)) {
    throw new GestaltError(
      "E_SCHEMA",
      "Title may not contain control characters or newlines.",
      `fimemory create ${id} --title "<single-line title>"`,
    );
  }
  const { config } = loadConfig(storePaths(home).config);
  const now = opts.now ?? systemClock;

  return withLock(home, config.lockWaitMs, async () => {
    const index = await loadIndexOrEmpty(home, { underLock: true });

    if (index.topics[id] || (await readText(topicNotePath(home, id))) !== null) {
      throw new GestaltError(
        "E_EXISTS",
        `Topic "${id}" already exists.`,
        `fimemory get ${id}`,
      );
    }

    if (!opts.force) {
      const matches = findCollisions(id, await collisionUniverse(home, index));
      if (matches.length > 0) {
        throw new GestaltError(
          "E_ALIAS_COLLISION",
          `"${id}" looks like existing topic(s): ${matches.join(", ")}. Reuse one, or force a new topic.`,
          `fimemory create ${id} --new`,
        );
      }
    }

    const ts = isoFromMs(nextMonotonic(now(), globalLastMs(index)));
    const note = skeletonNote(id, title, ts);
    const emptyLog = serializeLog(id, []);

    // THREE WRITES, AND THE THIRD CAN FAIL ON ITS OWN. Note, log, then index.
    // If the index write threw — and `index.json` is the hottest file in the
    // store, so it is the likeliest of the three to lose a rename race — the
    // note and log stayed on disk with nothing pointing at them. The user then
    // saw a hang, then E_LOCKED telling them to retry, and on retry the flatly
    // contradictory "Topic already exists". Between those two commands the note
    // IS on disk and search returns nothing for it.
    //
    // Nothing is permanently lost even then (the next mutating op rebuilds a
    // stale index), but "the tool contradicts itself about whether my note
    // exists" is what a tester reports, and that is a fair thing to report.
    //
    // Rolling back is safe HERE in a way it would not be elsewhere: the
    // E_EXISTS guard above already refused if either the index knew this id or
    // a note file existed, so both paths were provably absent moments ago and
    // cannot be somebody else's data. Cleanup is best-effort and the ORIGINAL
    // error still propagates — the failed write is what the user needs to hear.
    await writeFileAtomic(topicNotePath(home, id), serializeNote(note));
    await writeFileAtomic(topicLogPath(home, id), emptyLog);

    const entry = buildEntry(note, emptyLog);
    index.topics[id] = entry;
    advanceGlobal(index, ts);
    try {
      await writeIndex(home, index);
    } catch (err) {
      for (const orphan of [topicNotePath(home, id), topicLogPath(home, id)]) {
        try {
          await fsp.unlink(fsPath(orphan));
        } catch {
          /* already gone or unremovable — the original error still wins */
        }
      }
      throw err;
    }

    return { entry, warnings: [] };
  });
}

/** Existing id/alias universe for the fuzzy check: index entries ∪ topic files (#24). */
async function collisionUniverse(
  home: string,
  index: { topics: Record<string, IndexEntry> },
): Promise<ExistingTopic[]> {
  const universe: ExistingTopic[] = [];
  const seen = new Set<string>();
  for (const entry of Object.values(index.topics)) {
    universe.push({ id: entry.id, aliases: entry.aliases });
    seen.add(entry.id);
  }
  for (const fileId of await listTopicIds(home)) {
    if (!seen.has(fileId)) {
      universe.push({ id: fileId, aliases: [] });
      seen.add(fileId);
    }
  }
  return universe;
}
