/**
 * Frozen owner-notes section extraction (SPEC §3, rev 4). The owner section runs
 * from the exact heading line `^## Owner notes\s*$` through the last line before
 * the next `## ` heading at column 0 — but a `## ` line *inside a fenced code
 * block* (``` or ~~~) does not end it (fence-aware, matching §5.4). Callers work
 * on already-newline-normalized text (see `normalizeText`).
 *
 * Used by: `merge` (carry the loser's owner notes, #5), `noteTokens` (count the
 * body *excluding* this section so a large human section can't deadlock agent
 * proposals, #6), and B2b's owner-notes enforcement gate.
 */

const OWNER_HEADING = /^## Owner notes[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const SECTION = /^## /;

export interface OwnerSplit {
  /** Whether an owner-notes heading is present (absent ≠ present-but-empty). */
  present: boolean;
  /** Body text before the owner heading. */
  beforeOwner: string;
  /** The owner section: heading line through end of section ("" if absent). */
  owner: string;
  /** Body text after the owner section (if the owner section isn't last). */
  afterOwner: string;
}

export function splitOwnerNotes(body: string): OwnerSplit {
  const lines = body.split("\n");
  let fenced = false;
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && OWNER_HEADING.test(line)) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return { present: false, beforeOwner: body, owner: "", afterOwner: "" };
  }

  let end = lines.length;
  fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && SECTION.test(line)) {
      end = i;
      break;
    }
  }

  return {
    present: true,
    beforeOwner: lines.slice(0, start).join("\n"),
    owner: lines.slice(start, end).join("\n"),
    afterOwner: lines.slice(end).join("\n"),
  };
}

/**
 * The note body *excluding* the owner section — everything the cap and
 * `noteTokens` count (SPEC §5.7). Including the content *after* the owner
 * section closes the "smuggle a huge `## section` past the owner notes" bypass
 * (Gate #1 #2).
 */
export function nonOwnerBody(body: string): string {
  const s = splitOwnerNotes(body);
  return s.present ? s.beforeOwner + "\n" + s.afterOwner : body;
}

/**
 * The owner-notes protection compare (SPEC §3): two note bodies have equal owner
 * sections iff both present-or-absent alike and byte-identical (callers pass
 * already newline-normalized bodies via `parseNote`).
 */
export function ownerNotesEqual(bodyA: string, bodyB: string): boolean {
  const a = splitOwnerNotes(bodyA);
  const b = splitOwnerNotes(bodyB);
  return a.present === b.present && a.owner === b.owner;
}
