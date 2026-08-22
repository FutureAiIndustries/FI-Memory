import { promises as fsp, readdirSync } from "node:fs";
import path from "node:path";
import { BIN } from "../brand.js";
import { insertionDiff } from "../diff.js";
import { GestaltError } from "../errors.js";
import { sha256 } from "../hash.js";
import { loadConfig } from "../config.js";
import { fsPath, proposalPath, storePaths, topicNotePath } from "../paths.js";
import { decryptFile } from "../store/codec.js";
import { withLock } from "../store/lock.js";
import { loadOrCreateMachineId } from "../store/machineId.js";
import { parseNote, serializeNote } from "../store/note.js";
import { listProposals, nextSeq, serializeProposal } from "../store/proposals.js";
import type { ProposalDoc } from "../store/proposals.js";
import { readText } from "../store/read.js";
import { writeFileAtomic } from "../store/atomic.js";

/**
 * `fimemory conflicts` — the recovery flow for the pull resolver's parking lot.
 *
 * The 0.3.0 resolver parks the OTHER machine's side of an unmergeable file at
 * `conflicts/<rel-path>.<short-blob-sha>` and doctor warns about the queue —
 * but until 0.4 nothing could read, promote, or retire a parked file except a
 * human with a text editor, which on an encrypted store (where parked bytes
 * restore verbatim, i.e. ciphertext) meant nobody at all. This op is the
 * missing quarter of the conflict contract: list what is parked, show it
 * decoded, promote a parked NOTE into the same review queue every other
 * disagreement uses, and discard what has been dealt with.
 *
 * Addressing is by the parked PATH, never by index — `review approve 1` on a
 * seeded store approving the seed's leftover (row 21) is the standing lesson.
 */

export type ParkedKind = "note" | "log" | "ledger" | "config" | "schema" | "state" | "other";

export interface ParkedEntry {
  /** Repo-relative parked path — the address every verb takes. */
  parkedRel: string;
  /** The store path this was parked FROM (suffix stripped). */
  originalRel: string;
  kind: ParkedKind;
}

/** The resolver's suffix: `.<4-40 hex>` (git short blob sha, or a content-hash
 * fallback). Anchored so a filename that merely contains hex is not mangled. */
const PARK_SUFFIX_RE = /\.([0-9a-f]{4,40})$/;

function classifyOriginal(originalRel: string): ParkedKind {
  const parts = originalRel.split("/");
  if (parts.length === 2 && parts[0] === "topics" && parts[1]!.endsWith(".md")) return "note";
  if (parts.length === 2 && parts[0] === "logs" && parts[1]!.endsWith(".log.md")) return "log";
  if (parts.length === 2 && parts[0] === "ledgers" && parts[1]!.endsWith(".jsonl")) return "ledger";
  if (originalRel === "config.json") return "config";
  if (originalRel === "schema.json") return "schema";
  if (parts[0] === "state") return "state";
  return "other";
}

/** Scan `conflicts/` (recursively — parked paths mirror store paths, so the
 * depth is bounded by the store's own layout). Missing dir = empty queue. */
export function listParked(home: string): ParkedEntry[] {
  const root = path.join(home, "conflicts");
  const out: ParkedEntry[] = [];
  const walk = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(fsPath(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(path.join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const m = PARK_SUFFIX_RE.exec(rel);
      const originalRel = m ? rel.slice(0, -(m[1]!.length + 1)) : rel;
      out.push({
        parkedRel: `conflicts/${rel}`,
        originalRel,
        kind: classifyOriginal(originalRel),
      });
    }
  };
  walk(root, "");
  return out.sort((a, b) => a.parkedRel.localeCompare(b.parkedRel));
}

function findParked(home: string, parkedRel: string): ParkedEntry {
  const normalized = parkedRel.replace(/\\/g, "/");
  const hit = listParked(home).find((e) => e.parkedRel === normalized);
  if (!hit) {
    throw new GestaltError(
      "E_NOT_FOUND",
      `No parked conflict at "${normalized}".`,
      `\`${BIN} conflicts list\` prints the exact paths this store has parked.`,
    );
  }
  return hit;
}

/**
 * Read a parked file DECODED. Parked bytes are the original file's on-disk
 * form (the resolver restores index bytes verbatim), so on a sealed store they
 * are ciphertext whose AAD binds to the ORIGINAL path — decode against that,
 * never the parked path. A locked store throws E_STORE_MODE, as everywhere.
 */
export async function showParked(
  home: string,
  parkedRel: string,
): Promise<{ entry: ParkedEntry; text: string }> {
  const entry = findParked(home, parkedRel);
  const bytes = await fsp.readFile(fsPath(path.join(home, entry.parkedRel)), "utf8");
  const text = decryptFile(path.join(home, entry.originalRel), bytes);
  return { entry, text };
}

export interface ApplyParkedResult {
  seq: number;
  machineId: string;
  handle: string;
  id: string;
}

/**
 * Promote a parked NOTE into the ordinary review queue — the same pending
 * proposal every other disagreement becomes, so `review show/approve` need to
 * know nothing about conflicts. The parked file is retired on success (its
 * content lives on in the proposal, verbatim).
 *
 * Only notes promote: a parked config/state/schema file has no proposal
 * semantics — `show` it, fold what matters by hand, then `discard`.
 */
export async function applyParked(home: string, parkedRel: string): Promise<ApplyParkedResult> {
  const entry = findParked(home, parkedRel);
  if (entry.kind !== "note") {
    throw new GestaltError(
      "E_SCHEMA",
      `"${entry.parkedRel}" is a parked ${entry.kind}, not a note — there is no review flow for it.`,
      `\`${BIN} conflicts show ${entry.parkedRel}\` prints it decoded; fold what matters by hand, then \`${BIN} conflicts discard ${entry.parkedRel}\`.`,
    );
  }
  const id = path.basename(entry.originalRel, ".md");
  const { config } = loadConfig(storePaths(home).config);
  return withLock(home, config.lockWaitMs, async () => {
    const bytes = await fsp.readFile(fsPath(path.join(home, entry.parkedRel)), "utf8");
    const decoded = decryptFile(path.join(home, entry.originalRel), bytes);
    const parkedNote = parseNote(decoded, id);
    if (parkedNote === null) {
      throw new GestaltError(
        "E_SCHEMA",
        `The parked file does not parse as a note for "${id}".`,
        `\`${BIN} conflicts show ${entry.parkedRel}\` to inspect it; discard when it holds nothing worth keeping.`,
      );
    }
    const currentText = await readText(topicNotePath(home, id));
    if (currentText === null) {
      throw new GestaltError(
        "E_NOT_FOUND",
        `"${id}" has no live note to propose against — the topic was deleted after the park.`,
        `Recreate it first (\`${BIN} create ${id} --title "..."\`), then apply again; or \`${BIN} conflicts show\` and copy what you need.`,
      );
    }
    const current = parseNote(currentText, id);
    if (current === null) {
      throw new GestaltError(
        "E_SCHEMA",
        `The LIVE note for "${id}" does not parse — repair it before promoting a parked version.`,
        `\`${BIN} doctor\` names what is wrong with it.`,
      );
    }
    const pending = (await listProposals(home)).filter((x) => x.status === "pending").length;
    if (pending + 1 > config.maxPendingProposals) {
      throw new GestaltError(
        "E_PROPOSAL_CAP",
        `Promoting this parked note needs a proposal slot and the store already has ${String(pending)} pending (max ${String(config.maxPendingProposals)}).`,
        `Clear some first: \`${BIN} review list\`.`,
      );
    }
    const newText = serializeNote(parkedNote);
    const { seq, machineId } = await nextSeq(home, loadOrCreateMachineId(home));
    const created = new Date().toISOString();
    const doc: ProposalDoc = {
      seq,
      id,
      status: "pending",
      proposer: `${BIN}-conflicts-apply`,
      created,
      compactedThrough: parkedNote.compactedThrough,
      baseUpdated: current.updated ?? created,
      baseHash: sha256(currentText),
      newHash: sha256(newText),
      ownerNotesOverride: false,
      oldNote: currentText,
      newNote: newText,
      diff: insertionDiff(
        currentText,
        newText,
        `topics/${id}.md (current)`,
        `topics/${id}.md (parked version)`,
      ),
      machineId,
    };
    await writeFileAtomic(proposalPath(home, seq, id, machineId), serializeProposal(doc));
    await fsp.unlink(fsPath(path.join(home, entry.parkedRel)));
    return { seq, machineId, handle: `${machineId}-${String(seq)}`, id };
  });
}

/** Retire a parked file. The park is tracked, so the deletion syncs with the
 * next commit — permanent once pushed, exactly like working the queue by hand. */
export async function discardParked(home: string, parkedRel: string): Promise<ParkedEntry> {
  const entry = findParked(home, parkedRel);
  const { config } = loadConfig(storePaths(home).config);
  return withLock(home, config.lockWaitMs, async () => {
    await fsp.unlink(fsPath(path.join(home, entry.parkedRel)));
    return entry;
  });
}
