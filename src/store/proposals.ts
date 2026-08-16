import { promises as fsp, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Warning } from "../errors.js";
import { GestaltError } from "../errors.js";
import { fsPath, proposalPath, storePaths } from "../paths.js";
import { decryptFile } from "./codec.js";
import {
  asString,
  normalizeText,
  parseYaml,
  splitFrontmatter,
} from "./frontmatter.js";
import { loadOrCreateMachineId } from "./machineId.js";
import { readText } from "./read.js";

/** Summary of a proposal file (for `merge`'s gate and `review list`). */
export interface ProposalMeta {
  seq: number | null;
  id: string;
  status: string;
  proposer: string;
  created: string;
  file: string;
  /** Replica that minted this proposal (absent on legacy files). */
  machineId?: string;
}

export async function listProposals(home: string): Promise<ProposalMeta[]> {
  const dir = storePaths(home).proposalsDir;
  let files: string[];
  try {
    files = await fsp.readdir(fsPath(dir));
  } catch {
    return [];
  }

  const out: ProposalMeta[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await readText(path.join(dir, file));
    if (text === null) continue;
    const split = splitFrontmatter(text);
    if (!split) continue;
    const data = parseYaml(split.yaml);
    if (!data) continue;
    const id = asString(data["id"]);
    const status = asString(data["status"]);
    if (id === null || status === null) continue;
    const parsedName = parseProposalFilename(file);
    out.push({
      seq: typeof data["seq"] === "number" ? data["seq"] : parsedName?.seq ?? null,
      id,
      status,
      proposer: asString(data["proposer"]) ?? "unknown",
      created: asString(data["created"]) ?? "",
      file,
      ...(parsedName?.machineId ? { machineId: parsedName.machineId } : {}),
    });
  }
  return out.sort((a, b) => {
    const sa = a.seq ?? 0;
    const sb = b.seq ?? 0;
    if (sa !== sb) return sa - sb;
    return (a.machineId ?? "").localeCompare(b.machineId ?? "");
  });
}

export async function pendingCountForTopic(
  home: string,
  id: string,
): Promise<number> {
  const proposals = await listProposals(home);
  return proposals.filter((p) => p.id === id && p.status === "pending").length;
}

/**
 * Synchronous pending-proposal count for `status` — uses the *same* frontmatter
 * parse (splitFrontmatter + js-yaml) as the async path, so the two never
 * disagree (#14). Unreadable/malformed proposals are skipped with a warning.
 */
export function countPendingSync(home: string): {
  count: number;
  warnings: Warning[];
} {
  const dir = storePaths(home).proposalsDir;
  const warnings: Warning[] = [];
  let files: string[];
  try {
    files = readdirSync(fsPath(dir));
  } catch {
    return { count: 0, warnings };
  }

  let count = 0;
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    let text: string;
    try {
      // Proposals are whole-file encrypted (they embed note bodies). Decode
      // through the codec — identity in a plaintext store, decrypt in an
      // encrypted one (the key is already unlocked before status runs).
      const p = path.join(dir, file);
      text = decryptFile(p, readFileSync(fsPath(p), "utf8"));
    } catch {
      warnings.push({ id: file, code: "E_CORRUPT_SKIPPED", message: `could not read proposal ${file}; skipped` });
      continue;
    }
    const split = splitFrontmatter(text);
    const data = split ? parseYaml(split.yaml) : null;
    if (!data) {
      warnings.push({ id: file, code: "E_CORRUPT_SKIPPED", message: `proposal ${file} is unparsable; skipped` });
      continue;
    }
    if (asString(data["status"]) === "pending") count++;
  }
  return { count, warnings };
}

// ---- proposal document format (SPEC §5.6, rev 4) ----

/** Legacy: `{seq}-{topicId}.md` (pre team-sync). */
const LEGACY_PROPOSAL_FILE_RE = /^(\d+)-([a-z0-9-]+)\.md$/;
/** Machine-scoped: `{machineId}-{seq}-{topicId}.md` — collision-free across clones. */
const MACHINE_PROPOSAL_FILE_RE = /^([a-f0-9]{8})-(\d+)-([a-z0-9-]+)\.md$/;

export function parseProposalFilename(
  file: string,
): { seq: number; id: string; machineId?: string } | null {
  const m = MACHINE_PROPOSAL_FILE_RE.exec(file);
  if (m) return { machineId: m[1]!, seq: Number(m[2]), id: m[3]! };
  const legacy = LEGACY_PROPOSAL_FILE_RE.exec(file);
  if (legacy) return { seq: Number(legacy[1]), id: legacy[2]! };
  return null;
}

export interface ProposalDoc {
  seq: number;
  id: string;
  status: string; // pending | approved | rejected | stale
  proposer: string;
  created: string;
  compactedThrough: string | null;
  baseUpdated: string;
  baseHash: string;
  newHash: string;
  ownerNotesOverride: boolean;
  oldNote: string;
  newNote: string;
  diff: string;
  /** Replica that minted this proposal (machine-scoped identity). */
  machineId?: string;
}

function longestBacktickRun(text: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of text) {
    if (ch === "`") {
      cur++;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

/** A fence longer than any backtick run in the notes (≥ 4) so inner ``` are safe. */
function fenceFor(...texts: string[]): string {
  const longest = Math.max(0, ...texts.map(longestBacktickRun));
  return "`".repeat(Math.max(4, longest + 1));
}

export function serializeProposal(p: ProposalDoc): string {
  const fence = fenceFor(p.oldNote, p.newNote);
  const fm = [
    "---",
    `seq: ${p.seq}`,
    `id: ${p.id}`,
    `status: ${p.status}`,
    `proposer: ${p.proposer}`,
    `created: ${p.created}`,
    `compactedThrough: ${p.compactedThrough ?? "null"}`,
    `baseUpdated: ${p.baseUpdated}`,
    `baseHash: ${p.baseHash}`,
    `newHash: ${p.newHash}`,
  ];
  if (p.machineId) fm.push(`machineId: ${p.machineId}`);
  if (p.ownerNotesOverride) fm.push("ownerNotesOverride: true");
  fm.push("---");
  // Ensure a trailing newline so the closing fence is always on its own line.
  const oldN = p.oldNote.endsWith("\n") ? p.oldNote : p.oldNote + "\n";
  const newN = p.newNote.endsWith("\n") ? p.newNote : p.newNote + "\n";
  return (
    fm.join("\n") +
    "\n\n" +
    `## Old\n${fence}markdown\n${oldN}${fence}\n\n` +
    `## New\n${fence}markdown\n${newN}${fence}\n\n` +
    "## Diff\n```diff\n" +
    p.diff +
    "```\n"
  );
}

/** Extract a fenced note block (`## <section>` → a ````markdown … ```` fence). */
export function extractFenced(body: string, section: string): string | null {
  const marker = `## ${section}\n`;
  const at = body.indexOf(marker);
  if (at === -1) return null;
  const after = body.slice(at + marker.length);
  const open = /^(`{4,})markdown[ \t]*\n/.exec(after);
  if (!open) return null;
  const fence = open[1]!;
  const start = open[0].length;
  const close = after.indexOf(`\n${fence}`, start);
  if (close === -1) return null;
  return after.slice(start, close + 1); // include the note's trailing newline
}

export function parseProposal(text: string): ProposalDoc | null {
  const split = splitFrontmatter(normalizeText(text));
  if (!split) return null;
  const data = parseYaml(split.yaml);
  if (!data) return null;
  const seq = typeof data["seq"] === "number" ? data["seq"] : null;
  const id = asString(data["id"]);
  const status = asString(data["status"]);
  if (seq === null || id === null || status === null) return null;
  const oldNote = extractFenced(split.body, "Old");
  const newNote = extractFenced(split.body, "New");
  if (oldNote === null || newNote === null) return null;
  const machineId = asString(data["machineId"]) ?? undefined;
  return {
    seq,
    id,
    status,
    proposer: asString(data["proposer"]) ?? "unknown",
    created: asString(data["created"]) ?? "",
    compactedThrough: asString(data["compactedThrough"]),
    baseUpdated: asString(data["baseUpdated"]) ?? "",
    baseHash: asString(data["baseHash"]) ?? "",
    newHash: asString(data["newHash"]) ?? "",
    ownerNotesOverride: data["ownerNotesOverride"] === true,
    oldNote,
    newNote,
    diff: "",
    ...(machineId ? { machineId } : {}),
  };
}

/**
 * Change the `status:` key in the *frontmatter only*, preserving the Old/New/Diff
 * body exactly (a note body could contain a leading `status:` line — #13).
 */
export function setProposalStatus(text: string, status: string): string {
  const split = splitFrontmatter(text);
  if (!split) return text;
  const yaml = split.yaml.replace(/^status:.*$/m, `status: ${status}`);
  return `---\n${yaml}\n---\n${split.body}`;
}

/**
 * Next proposal seq = max existing (any machine or legacy file) + 1, plus this
 * clone's machineId for the filename. Call under the lock.
 *
 * Human-facing N stays a small integer (`review show N`) and stays monotonic on
 * a single machine. Cross-clone concurrent mints can still share an N when both
 * read the same max before syncing — identity is collision-free via the
 * `machineId` filename prefix, and `findProposal` refuses to silently pick one
 * when N is ambiguous after a merge.
 */
export async function nextSeq(
  home: string,
  machineId?: string,
): Promise<{ seq: number; machineId: string }> {
  const mid = machineId ?? loadOrCreateMachineId(home);
  const dir = storePaths(home).proposalsDir;
  let files: string[];
  try {
    files = await fsp.readdir(fsPath(dir));
  } catch {
    return { seq: 1, machineId: mid };
  }
  let max = 0;
  for (const file of files) {
    const parsed = parseProposalFilename(file);
    if (parsed && parsed.seq > max) max = parsed.seq;
  }
  return { seq: max + 1, machineId: mid };
}

/**
 * Find a proposal by human-facing seq. When exactly one file matches, returns
 * it (so `review show N` stays usable). When several machines minted the same
 * N, throws E_AMBIGUOUS with the filenames so the owner can disambiguate.
 */
export async function findProposal(
  home: string,
  seq: number,
  machineId?: string,
): Promise<{ path: string; text: string; machineId?: string } | null> {
  const dir = storePaths(home).proposalsDir;
  let files: string[];
  try {
    files = await fsp.readdir(fsPath(dir));
  } catch {
    return null;
  }
  const matches: { file: string; id: string; machineId?: string }[] = [];
  for (const file of files) {
    const parsed = parseProposalFilename(file);
    if (!parsed || parsed.seq !== seq) continue;
    if (machineId && parsed.machineId && parsed.machineId !== machineId) continue;
    matches.push({ file, id: parsed.id, machineId: parsed.machineId });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1 && !machineId) {
    const names = matches.map((m) => m.file).join(", ");
    throw new GestaltError(
      "E_AMBIGUOUS",
      `Multiple proposals share #${seq}: ${names}.`,
      `Disambiguate with the machine-scoped filename, or approve/reject from \`fimemory review list\`.`,
    );
  }
  const hit = matches[0]!;
  const target = path.join(dir, hit.file);
  const text = await readText(target);
  return text === null ? null : { path: target, text, machineId: hit.machineId };
}

/** @deprecated kept for path helpers that still build legacy names in tests */
export function legacyProposalPath(home: string, seq: number, id: string): string {
  return proposalPath(home, seq, id);
}
