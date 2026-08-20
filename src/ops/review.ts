import { BIN } from "../brand.js";
import { dirty, isRepo } from "./gitState.js";
import { isoFromMs, msFromIso, nextMonotonic, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { sha256 } from "../hash.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { countTokens } from "../tokens.js";
import { writeFileAtomic } from "../store/atomic.js";
import { assertValidCompactedThrough } from "../store/compactMeta.js";
import {
  advanceGlobal,
  buildEntry,
  globalLastMs,
  loadIndexOrEmpty,
  writeIndex,
} from "../store/index.js";
import { withLock } from "../store/lock.js";
import { formatEntryBlock, parseLog, serializeLog } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { parseNote, serializeNote } from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { nonOwnerBody, ownerNotesEqual } from "../store/ownerNotes.js";
import {
  findProposal,
  listProposals,
  parseProposal,
  setProposalStatus,
} from "../store/proposals.js";
import type { ProposalDoc, ProposalMeta } from "../store/proposals.js";
import { readText } from "../store/read.js";

export function reviewList(home: string): Promise<ProposalMeta[]> {
  return listProposals(home);
}

export async function reviewShow(
  home: string,
  seq: number,
  machineId?: string,
): Promise<ProposalDoc> {
  const found = await findProposal(home, seq, machineId);
  if (!found) throw notFoundProposal(seq);
  const doc = parseProposal(found.text);
  if (!doc) throw unparsableProposal(seq);
  return doc;
}

export interface ApproveOptions {
  allowOwnerNotes?: boolean;
  now?: Clock;
  /**
   * Which machine's proposal, when more than one minted the same seq.
   *
   * Proposal numbers are per-clone counters, so on three machines two
   * independent conflict resolutions both land on the same N. findProposal has
   * always been able to disambiguate, but nothing could ASK it to: the
   * ambiguity error told the owner to disambiguate with the machine-scoped
   * filename, and the CLI had no way to express one -- so the resolver's own
   * printed `review approve N` was unusable and neither side could be picked.
   * No data was ever at risk; the human simply could not act.
   */
  machineId?: string;
}

/**
 * Approve a proposal (SPEC §5.6). One transaction: re-check staleness by
 * `baseHash`, verify `newHash`, re-check the owner-notes contract, then replace
 * the note (frontmatter re-serialized, `updated` = approve time), append the
 * fixed auto-entry, update the index, mark the proposal `approved`, and stale
 * every other pending proposal on the same topic.
 */
export async function reviewApprove(
  home: string,
  seq: number,
  opts: ApproveOptions = {},
): Promise<{ id: string; warnings: Warning[] }> {
  const { config } = loadConfig(storePaths(home).config);
  const now = opts.now ?? systemClock;

  return withLock(home, config.lockWaitMs, async () => {
    const found = await findProposal(home, seq, opts.machineId);
    if (!found) throw notFoundProposal(seq);
    const doc = parseProposal(found.text);
    if (!doc) throw unparsableProposal(seq);
    if (doc.status === "stale") {
      throw new GestaltError(
        "E_STALE_PROPOSAL",
        `Proposal #${seq} is outdated — a newer change on "${doc.id}" was approved first.`,
        `fimemory update ${doc.id}   # re-propose against the current note`,
      );
    }
    if (doc.status !== "pending") {
      throw new GestaltError("E_EXISTS", `Proposal #${seq} is ${doc.status}, not pending.`, "fimemory review list");
    }
    const id = doc.id;

    const currentText = await readText(topicNotePath(home, id));
    if (currentText === null) {
      throw new GestaltError("E_NOT_FOUND", `Topic "${id}" no longer exists.`, "fimemory review list");
    }

    // Extraction integrity: the fenced New must re-hash to newHash.
    if (sha256(doc.newNote) !== doc.newHash) {
      throw new GestaltError("E_SCHEMA", `Proposal #${seq} failed its New-block hash check.`, "fimemory review list");
    }
    const newNote = parseNote(doc.newNote, id);
    const baseNote = parseNote(doc.oldNote, id);
    if (!newNote || !baseNote) {
      throw new GestaltError("E_SCHEMA", `Proposal #${seq} note blocks are not valid notes.`, "fimemory review list");
    }

    // Staleness / idempotent resume (#8): the note is either still the base
    // (fresh approve), already the New (a prior approve crashed mid-transaction
    // → resume completes it), or something else entirely (a real edit → stale).
    const curHash = sha256(currentText);
    const alreadyApplied = curHash === doc.newHash;
    if (!alreadyApplied && curHash !== doc.baseHash) {
      await writeFileAtomic(found.path, setProposalStatus(found.text, "stale"));
      throw new GestaltError(
        "E_STALE_PROPOSAL",
        `"${id}" changed since this edit was proposed — it's now outdated.`,
        `fimemory update ${id}   # re-propose against the current note`,
      );
    }

    // Re-validate at approve (#9), against the *base* note (not the maybe-applied
    // current). Owner-notes override is CLI-only at approve — the proposal's
    // recorded flag is advisory, never authoritative (#3).
    const bodyTokens = countTokens(nonOwnerBody(newNote.body));
    if (bodyTokens > config.noteTokenCap) {
      throw new GestaltError("E_TOKEN_CAP", `Proposed note is ${bodyTokens} tokens; the cap is ${config.noteTokenCap}.`, "fimemory review list");
    }
    if (!ownerNotesEqual(baseNote.body, newNote.body) && !opts.allowOwnerNotes) {
      throw new GestaltError(
        "E_OWNER_NOTES",
        "This edit changes the protected ## Owner notes section — approve with --allow-owner-notes if you intend that.",
        `fimemory review approve ${seq} --allow-owner-notes`,
      );
    }

    const preLog = (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
    assertValidCompactedThrough(doc.compactedThrough, baseNote.compactedThrough, preLog);

    // Apply under the global clock.
    const index = await loadIndexOrEmpty(home, { underLock: true });
    let lastMs = globalLastMs(index);
    let applied: TopicNote;
    if (alreadyApplied) {
      applied = parseNote(currentText, id)!; // already New on disk (resume)
    } else {
      const updatedTs = isoFromMs(nextMonotonic(now(), lastMs));
      lastMs = msFromIso(updatedTs);
      applied = { ...newNote, id, updated: updatedTs, compactedThrough: doc.compactedThrough };
      await writeFileAtomic(topicNotePath(home, id), serializeNote(applied));
    }

    // Fixed auto-entry — appended exactly once (idempotent on resume).
    const { entries } = parseLog(preLog, id);
    const summary = `Note updated via proposal #${seq} by ${doc.proposer}.`;
    // Approving a MERGE-AUTHORED proposal flips which side of a conflict is
    // live, and the side it replaces was the merge's winner — which nothing
    // else preserves. The merge excerpts the side it FILES; without this, the
    // side it KEPT vanishes from search the moment you approve the other one.
    // Round trip on 2026-08-18: kingfisher ended up preserved twice, albatross
    // nowhere, and only doing both halves exposed it.
    //
    // Scoped to merge-authored proposals ON PURPOSE. The everyday loop is
    // update -> approve, and echoing superseded prose into the log there would
    // fill search with text the user deliberately replaced — a worse bug,
    // arriving slowly enough that nobody would attribute it. There is a
    // principled line too: in an ordinary approve a human SAW the diff and
    // chose; in a merge a machine discarded a side nobody ever looked at.
    const supersededBody = mergeSupersedeExcerpt(
      doc.proposer,
      baseNote.body,
      newNote.body,
      config.entryTokenCap,
    );
    let finalLog = preLog;
    if (!entries.some((e) => e.summary === summary)) {
      const autoTs = isoFromMs(nextMonotonic(now(), lastMs));
      const auto: LogEntry = {
        timestamp: autoTs,
        type: "decision",
        project: "gestalt",
        agent: "gestalt-runtime",
        supersedes: null,
        reported: null,
        refs: null,
        summary,
        ...(supersededBody !== null ? { body: supersededBody } : {}),
        raw: formatEntryBlock(autoTs, {
          type: "decision",
          project: "gestalt",
          agent: "gestalt-runtime",
          summary,
          ...(supersededBody !== null ? { body: supersededBody } : {}),
        }),
      };
      finalLog = serializeLog(id, [...entries, auto]);
      await writeFileAtomic(topicLogPath(home, id), finalLog);
    }

    const entry = buildEntry(applied, finalLog);
    index.topics[id] = entry;
    advanceGlobal(index, entry.updated);
    await writeIndex(home, index);

    await writeFileAtomic(found.path, setProposalStatus(found.text, "approved"));

    // Sibling pending proposals on the same topic → stale.
    for (const p of await listProposals(home)) {
      if (p.id === id && p.status === "pending" && p.seq !== null && p.seq !== seq) {
        const sib = await findProposal(home, p.seq);
        if (sib) await writeFileAtomic(sib.path, setProposalStatus(sib.text, "stale"));
      }
    }

    return { id, warnings: unsharedMergeWarning(home, doc.proposer) };
  });
}

export async function reviewReject(
  home: string,
  seq: number,
  machineId?: string,
): Promise<{ id: string }> {
  const { config } = loadConfig(storePaths(home).config);
  return withLock(home, config.lockWaitMs, async () => {
    const found = await findProposal(home, seq, machineId);
    if (!found) throw notFoundProposal(seq);
    const doc = parseProposal(found.text);
    if (!doc) throw unparsableProposal(seq);
    if (doc.status !== "pending") {
      throw new GestaltError("E_EXISTS", `Proposal #${seq} is ${doc.status}, not pending.`, "fimemory review list");
    }
    await writeFileAtomic(found.path, setProposalStatus(found.text, "rejected"));
    return { id: doc.id };
  });
}

function notFoundProposal(seq: number): GestaltError {
  return new GestaltError("E_NOT_FOUND", `No proposal #${seq}.`, "fimemory review list");
}
function unparsableProposal(seq: number): GestaltError {
  return new GestaltError("E_SCHEMA", `Proposal #${seq} is unparsable.`, "fimemory review list");
}

/**
 * An excerpt of the note body an approve is about to discard, or null when
 * nothing should be recorded.
 *
 * Returns non-null only for a proposal the MERGE wrote. See the call site for
 * why this must not fire on the ordinary update -> approve path.
 */
function mergeSupersedeExcerpt(
  proposer: string,
  replacedBody: string,
  incomingBody: string,
  entryTokenCap: number,
): string | null {
  if (proposer !== `${BIN}-pull`) return null;
  const flat = replacedBody.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  if (flat === incomingBody.replace(/\s+/g, " ").trim()) return null;
  // Same shape as the merge's own line so both halves of a conflict read alike.
  const label = "Superseded version, excerpted here so search can still find it: ";
  const room = entryTokenCap * 4 - label.length - 80;
  if (room <= 1) return null;
  const excerpt = flat.length <= room ? flat : `${flat.slice(0, room - 1).trimEnd()}…`;
  return label + excerpt;
}

/**
 * Warn when approving a conflict resolution leaves it sitting in a dirty tree.
 *
 * pull already says "local commits not yet shared" — but it says it BEFORE you
 * approve anything, and approving re-dirties the store with nothing to remind
 * you. On 2026-08-18 that is exactly what happened: pull's reminder was
 * followed, the push ran, then the approve dirtied three files again and the
 * resolution would have stayed local. Two machines then read as "merged" while
 * still disagreeing, which is the failure pull's reminder exists to prevent.
 *
 * Scoped to merge-authored proposals for the same reason the supersede excerpt
 * is: on the everyday update -> approve loop an uncommitted store is normal and
 * harmless, and a reminder on every approve is noise nobody reads. It is only
 * load-bearing when the thing left behind is a cross-machine resolution.
 */
function unsharedMergeWarning(home: string, proposer: string): Warning[] {
  if (proposer !== `${BIN}-pull`) return [];
  try {
    if (!isRepo(home)) return [];
    if (dirty(home).length === 0) return [];
  } catch {
    return [];
  }
  return [
    {
      code: "W_MERGE_NOT_SHARED",
      message:
        `You resolved a cross-machine conflict, and it is only on this machine until ` +
        `you share it. Commit and push ${home}, or the other machine will still disagree.`,
    },
  ];
}
