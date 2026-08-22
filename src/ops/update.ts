import { isoFromMs, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { insertionDiff } from "../diff.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { nearMatches } from "../fuzzy.js";
import { sha256 } from "../hash.js";
import { assertValidId } from "../id.js";
import { proposalPath, storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { countTokens } from "../tokens.js";
import { writeFileAtomic } from "../store/atomic.js";
import { listTopicIds } from "../store/index.js";
import { withLock } from "../store/lock.js";
import { assertValidCompactedThrough } from "../store/compactMeta.js";
import { parseNote, serializeNote } from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { nonOwnerBody, ownerNotesEqual } from "../store/ownerNotes.js";
import { listProposals, nextSeq, serializeProposal } from "../store/proposals.js";
import type { ProposalDoc } from "../store/proposals.js";
import { readText } from "../store/read.js";

export interface UpdateOptions {
  proposer?: string;
  /** CLI `--allow-owner-notes` only (MCP has no override). */
  allowOwnerNotes?: boolean;
  /** Set by the `compact` flow — records the fold's coverage on the proposal. */
  compactedThrough?: string | null;
  now?: Clock;
}

/**
 * Propose a note edit (SPEC §5.6). Never mutates the note — writes a pending
 * proposal file. Enforces the note-token cap (body before owner notes), the
 * owner-notes contract (unless `--allow-owner-notes`), and the global pending
 * proposal cap. The `seq` is the global max + 1, computed under the lock.
 */
export async function updateTopic(
  home: string,
  id: string,
  proposedNote: string,
  opts: UpdateOptions = {},
): Promise<{ seq: number; machineId: string; ownerNotesChanged: boolean; warnings: Warning[] }> {
  assertValidId(id); // no path join with an unvalidated id (traversal guard)
  const { config } = loadConfig(storePaths(home).config);
  const now = opts.now ?? systemClock;
  const proposer = (opts.proposer ?? "unknown").replace(/[|\n\r]/g, " ");

  return withLock(home, config.lockWaitMs, async () => {
    const currentText = await readText(topicNotePath(home, id));
    if (currentText === null) {
      const suggestions = nearMatches(id, await listTopicIds(home));
      const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      throw new GestaltError("E_NOT_FOUND", `No topic "${id}".${hint}`, `fimemory create ${id} --title "..."`);
    }
    const current = parseNote(currentText, id);
    if (!current) {
      throw new GestaltError("E_SCHEMA", `Topic "${id}" note is unparsable.`, `Fix topics/${id}.md, then retry.`);
    }

    const proposed = parseNote(proposedNote, id);
    if (!proposed) {
      throw new GestaltError(
        "E_SCHEMA",
        "The proposed note is not a valid topic note (needs YAML frontmatter + body).",
        "Provide a full note: frontmatter, then body.",
      );
    }

    // Base frontmatter is preserved verbatim. Agents build proposals from
    // fimemory_get output, which returns a stripped body — reconstructed headers
    // commonly set updated: null and drop/alter title/aliases/tags (8 of 10
    // proposals rejected for this on 2026-07-27). Only the body (and
    // compact's compactedThrough watermark) may change here; `updated` is set
    // at approve time. Spec §5.6: "verbatim" governs the body, not runtime-
    // owned frontmatter.
    const newNote: TopicNote = {
      id,
      title: current.title,
      aliases: current.aliases,
      tags: current.tags,
      projects: current.projects,
      updated: current.updated,
      compactedThrough:
        opts.compactedThrough !== undefined
          ? opts.compactedThrough
          : current.compactedThrough,
      mergedInto: current.mergedInto,
      body: proposed.body.endsWith("\n") ? proposed.body : proposed.body + "\n",
    };
    const newText = serializeNote(newNote);

    // noteTokenCap over the body *excluding* the owner section (rev 5, #2).
    const bodyTokens = countTokens(nonOwnerBody(newNote.body));
    if (bodyTokens > config.noteTokenCap) {
      throw new GestaltError(
        "E_TOKEN_CAP",
        `Proposed note is ${bodyTokens} tokens; the cap is ${config.noteTokenCap} (owner notes aren't counted).`,
        `fimemory update ${id}   # trim the summary`,
      );
    }

    // compactedThrough integrity — never a future/backward watermark (#7).
    const logText = (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
    assertValidCompactedThrough(newNote.compactedThrough, current.compactedThrough, logText);

    // Owner-notes protection contract.
    const ownerNotesChanged = !ownerNotesEqual(current.body, newNote.body);
    if (ownerNotesChanged && !opts.allowOwnerNotes) {
      throw new GestaltError(
        "E_OWNER_NOTES",
        "This edit changes the ## Owner notes section, which is yours and protected.",
        `fimemory update ${id} --allow-owner-notes`,
      );
    }

    // Global pending-proposal cap.
    const pending = (await listProposals(home)).filter((p) => p.status === "pending").length;
    if (pending >= config.maxPendingProposals) {
      throw new GestaltError(
        "E_PROPOSAL_CAP",
        `There are already ${pending} pending suggested edits (max ${config.maxPendingProposals}). Review some first.`,
        "fimemory review list",
      );
    }

    const { seq, machineId } = await nextSeq(home);
    const created = isoFromMs(now());
    const doc: ProposalDoc = {
      seq,
      id,
      status: "pending",
      proposer,
      created,
      compactedThrough: newNote.compactedThrough,
      baseUpdated: current.updated ?? created,
      baseHash: sha256(currentText),
      newHash: sha256(newText),
      ownerNotesOverride: ownerNotesChanged && !!opts.allowOwnerNotes,
      oldNote: currentText,
      newNote: newText,
      diff: insertionDiff(
        currentText,
        newText,
        `topics/${id}.md (current)`,
        `topics/${id}.md (proposed)`,
      ),
      machineId,
    };
    await writeFileAtomic(proposalPath(home, seq, id, machineId), serializeProposal(doc));

    const warnings: Warning[] = ownerNotesChanged
      ? [{ id, code: "owner_notes", message: "this edit changes owner notes (override recorded on the proposal)" }]
      : [];
    return { seq, machineId, ownerNotesChanged, warnings };
  });
}
