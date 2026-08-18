import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { BIN } from "../brand.js";
import { isoFromMs, msFromIso, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { insertionDiff } from "../diff.js";
import { GestaltError } from "../errors.js";
import { sha256 } from "../hash.js";
import { isValidId } from "../id.js";
import { fsPath, proposalPath, storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { writeFileAtomic, writeFileAtomicPlain } from "../store/atomic.js";
import { decodeLedgerLine, decryptFile } from "../store/codec.js";
import { withLock } from "../store/lock.js";
import { formatEntryBlock, parseLog, serializeLog } from "../store/log.js";
import type { LogEntry, NewEntry } from "../store/log.js";
import { parseNote, serializeNote } from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { ownerNotesEqual } from "../store/ownerNotes.js";
import { listProposals, nextSeq, serializeProposal } from "../store/proposals.js";
import type { ProposalDoc } from "../store/proposals.js";
import { conflicted } from "./gitState.js";
import { appendLog } from "./logOp.js";

/**
 * `fimemory pull`'s conflict resolver — the half of the pull contract that turns
 * a wedged merge into a store a human can still read.
 *
 * THE PRODUCT RULE (0.3.0 launch plan §1). This is deliberately NOT "git merges
 * two essays into one essay", which is what a merge driver would do and what
 * produces a paragraph neither machine wrote:
 *
 *     never drop a side · never leave a marker · the store stays readable ·
 *     a human picks.
 *
 * So a same-note conflict keeps ONE body live and files the other as an ordinary
 * pending proposal, minted through the same `nextSeq` / `serializeProposal` path
 * `update` uses — so `review list` and `review approve N` need to know nothing
 * about merges at all. Logs and ledgers union (they are append-only, and both
 * machines' entries are true). Everything else keeps ours live and parks theirs
 * in `conflicts/`, which `doctor` already warns about: a visible queue rather
 * than a silent loss.
 *
 * ── THE WINNER RULE, SAID PLAINLY ────────────────────────────────────────────
 *
 * Winner = the note whose `updated:` is NEWER. A tie keeps OURS (the clone doing
 * the pulling).
 *
 * That is **last-write-wins on each machine's own wall clock**, and nothing
 * more. The two clocks are never compared, synchronised or sanity-checked. A
 * laptop running five minutes slow LOSES a note its human approved last, and
 * the store then serves the other machine's older decision as the live one.
 * Accepted for 0.3.0 because the loser is never destroyed — it is a pending
 * proposal one command away — but it must never be described as "keeping the
 * newer decision". It keeps the note with the larger number in its frontmatter.
 *
 * ── WHY THE INDEX STAGES AND NEVER THE WORKTREE ──────────────────────────────
 *
 * Every side is read with `git show :2:<path>` / `git show :3:<path>`. By the
 * time this runs, git has already spliced `<<<<<<<` / `=======` / `>>>>>>>`
 * lines into the worktree file. On an ENCRYPTED store the two sides are
 * single-line ciphertext blobs with marker lines wrapped around them: the file
 * no longer starts with `ENC_MAGIC`, so `decryptFile` refuses it outright — and
 * even in a plaintext store one side's frontmatter now sits inside the other
 * side's body. The index stages are the only clean copies of what each machine
 * actually wrote. Reading the worktree here would BE the bug.
 *
 * ── WHAT MAKES THIS FAIL THE PULL RATHER THAN GUESS ──────────────────────────
 *
 * A side that will not decrypt, will not parse, or already carries committed
 * conflict markers refuses the whole pull. Picking a winner between two bodies
 * one of which you could not read is how a half-merged paragraph becomes
 * "remembered fact" that `get` hands to a model as authoritative memory.
 * Refusing costs a `fimemory pull --abort`; both sides stay in git either way.
 *
 * Same for the pending-proposal cap: if filing the losers would exceed
 * `maxPendingProposals`, this aborts BEFORE writing anything rather than
 * dropping a side. Silently discarding a side is the one outcome this design
 * exists to prevent, so it is the one thing never traded for convenience.
 *
 * ── ORDER OF OPERATIONS IS LOAD-BEARING ──────────────────────────────────────
 *
 * Read everything · refuse everything that must be refused · only then write.
 * A resolver that discovers an unreadable side halfway through has already
 * rewritten three notes and minted two proposals, and there is no honest way to
 * describe the store it leaves behind.
 */

// ── git plumbing ─────────────────────────────────────────────────────────────

/**
 * A conflicted store can hold a large note or a long log; Node's default 1 MB
 * would TRUNCATE a stage and hand back a short file as though it were the whole
 * side — a wrong answer rather than a failure, which is the worse of the two.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

function runGit(home: string, args: string[], env: NodeJS.ProcessEnv): GitRun {
  const r = spawnSync("git", args, {
    cwd: home,
    encoding: "utf8",
    env,
    maxBuffer: GIT_MAX_BUFFER,
  });
  const err = (r.stderr ?? "").trim() || (r.error ? r.error.message : "");
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err };
}

/**
 * One side of a conflict, exactly as git recorded it.
 *
 * `present: false` is a real answer, not an error: a delete/modify conflict has
 * only one of the two stages, and each file kind below decides for itself what
 * a missing side means (for a log it means "no entries"; for a note it means
 * "refuse — there is no `updated:` to compare").
 */
interface Stage {
  present: boolean;
  /** Raw on-disk-form bytes from the index — ciphertext on a sealed store. */
  bytes: string;
}

function readStage(
  home: string,
  rel: string,
  stage: 2 | 3,
  env: NodeJS.ProcessEnv,
): Stage {
  // `git show :N:<path>` prints the BLOB: no smudge filters, no line-ending
  // translation. That is what makes these bytes safe to hand straight to
  // `decryptFile` — they are byte-for-byte what the file would contain on disk.
  const r = runGit(home, ["show", `:${String(stage)}:${rel}`], env);
  return r.ok ? { present: true, bytes: r.out } : { present: false, bytes: "" };
}

/** Short blob sha of one side — the suffix that makes a parked file identifiable. */
function stageShortSha(
  home: string,
  rel: string,
  stage: 2 | 3,
  fallbackBytes: string,
  env: NodeJS.ProcessEnv,
): string {
  const r = runGit(home, ["rev-parse", "--short", `:${String(stage)}:${rel}`], env);
  const out = r.out.trim();
  if (r.ok && /^[0-9a-f]{4,40}$/.test(out)) return out;
  // A content hash is a worse name than git's own (nobody can `git show` it),
  // but it still keeps two parked versions of one file distinct, which is the
  // only job this suffix has.
  return sha256(fallbackBytes).slice("sha256:".length, "sha256:".length + 7);
}

// ── conflict markers ─────────────────────────────────────────────────────────

/**
 * The ends of a git conflict hunk.
 *
 * THIRD SPELLING, stated rather than hidden: `ops/doctor.ts` and
 * `store/keyring.ts` each carry their own copy, and doctor's own comment asks
 * for them to be collapsed the day one of them is exported. Neither is exported
 * today and this work package owns exactly one file, so the copy lives here with
 * the same shapes and the same both-ends-required rule. Whoever exports one of
 * the other two should delete all three and import it.
 *
 * Both ends are required for doctor's reason: this store is full of prose ABOUT
 * merges, and a note that quotes one marker line while explaining this very
 * feature is not a damaged note.
 */
const CONFLICT_START_LINE = /^<{7}( |$)/;
const CONFLICT_END_LINE = /^>{7}( |$)/;
/** Any of the four marker shapes — for dropping detritus out of a JSONL union. */
const CONFLICT_ANY_LINE = /^(<{7}( |$)|={7}$|\|{7}( |$)|>{7}( |$))/;

function hasConflictMarkers(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) {
    const t = line.trimEnd();
    if (!open) {
      if (CONFLICT_START_LINE.test(t)) open = true;
      continue;
    }
    if (CONFLICT_END_LINE.test(t)) return true;
  }
  return false;
}

// ── classifying an unmerged path ─────────────────────────────────────────────

type ConflictKind = "note" | "log" | "ledger" | "other";
type Side = "ours" | "theirs";

interface ConflictPath {
  /** Repo-relative, forward-slashed — exactly what git handed us. */
  rel: string;
  /** Worktree path. The codec needs it: the AAD binds file kind + basename. */
  abs: string;
  kind: ConflictKind;
  /** Topic id for note/log/ledger; null for everything else. */
  id: string | null;
  ours: Stage;
  theirs: Stage;
}

/**
 * Which resolution a path gets, decided from its store-relative position.
 *
 * An id that fails `isValidId` falls through to "other" on purpose. The note,
 * log and ledger branches all end in a `path.join` with that id, and every other
 * write path in this codebase validates before joining (the traversal guard).
 * A file called `topics/../../evil.md` is not a topic; it is something to park.
 */
function classify(rel: string): { kind: ConflictKind; id: string | null } {
  const parts = rel.split("/");
  if (parts.length === 2) {
    const dir = parts[0]!;
    const base = parts[1]!;
    if (dir === "topics" && base.endsWith(".md")) {
      const id = base.slice(0, -".md".length);
      if (isValidId(id)) return { kind: "note", id };
    }
    if (dir === "logs" && base.endsWith(".log.md")) {
      const id = base.slice(0, -".log.md".length);
      if (isValidId(id)) return { kind: "log", id };
    }
    if (dir === "ledgers" && base.endsWith(".jsonl")) {
      const id = base.slice(0, -".jsonl".length);
      if (isValidId(id)) return { kind: "ledger", id };
    }
  }
  return { kind: "other", id: null };
}

function sides(p: ConflictPath): [Side, Stage][] {
  return [
    ["ours", p.ours],
    ["theirs", p.theirs],
  ];
}

// ── result shape ─────────────────────────────────────────────────────────────

/** A loser filed as an ordinary pending proposal. */
export interface MintedProposal {
  seq: number;
  id: string;
  /** Repo-relative path of the proposal file. */
  file: string;
  /**
   * The two sides' `## Owner notes` sections differ.
   *
   * R4 of the launch plan: `ownerNotesOverride` on the proposal document is
   * ADVISORY — `reviewApprove` gates on its `allowOwnerNotes` OPTION, not on the
   * YAML bit. Setting the bit and saying nothing would leave a proposal that
   * refuses to approve and reads to the user as a failed merge, so the caller
   * gets this flag and the ready-made command below.
   */
  ownerNotesDiffer: boolean;
  /** The exact approve command, `--allow-owner-notes` included when needed. */
  approveCommand: string;
}

/** One same-note conflict, resolved. */
export interface ResolvedNoteConflict {
  /** Repo-relative note path. */
  path: string;
  id: string;
  /** Which clone's copy is now live. */
  winner: Side;
  winnerUpdated: string | null;
  loserUpdated: string | null;
  /** Both sides carried the same (or no) `updated:`, so the tie-break kept ours. */
  tie: boolean;
  /**
   * The loser, filed for review — or null when the two sides canonicalized to
   * byte-identical notes, in which case there is no loser to file.
   */
  proposal: MintedProposal | null;
  /** Timestamp of the `convention` entry written to this topic's log. */
  logTimestamp: string;
}

/** A whole-file conflict: ours stayed live, theirs went to `conflicts/`. */
export interface ParkedFile {
  /** Repo-relative path of the file that stayed live. */
  path: string;
  /** Repo-relative path of the parked copy, or "" when they had deleted it. */
  parked: string;
  /** "deleted" when OUR side was a deletion, so the resolution removed the file. */
  oursWas: "content" | "deleted";
}

export interface ResolveConflictsResult {
  notes: ResolvedNoteConflict[];
  /** Repo-relative log paths union-merged here. */
  logs: string[];
  /** Repo-relative ledger paths union-merged here. */
  ledgers: string[];
  parked: ParkedFile[];
  /** Every path staged (or removed) to finish the merge. */
  staged: string[];
  /** Narration for `pull`'s step list. */
  steps: string[];
  /**
   * Lines the caller MUST show the user. Nothing here is decorative: it is the
   * `--allow-owner-notes` instruction (R4) and any marker the resolver preserved
   * because it was already committed upstream.
   */
  advisories: string[];
}

export interface ResolveConflictsOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable clock, so a test can pin a proposal's `created:`. */
  now?: Clock;
}

function emptyResult(): ResolveConflictsResult {
  return { notes: [], logs: [], ledgers: [], parked: [], staged: [], steps: [], advisories: [] };
}

// ── plans (everything decided in the read phase) ─────────────────────────────

interface NotePlan {
  p: ConflictPath;
  id: string;
  /** Canonical bytes of the winner — the exact string `baseHash` is taken over. */
  winnerText: string;
  winnerNote: TopicNote;
  loserNote: TopicNote;
  /** The note the loser's proposal installs, already canonicalized. */
  proposedText: string;
  proposedNote: TopicNote;
  winner: Side;
  winnerUpdated: string | null;
  loserUpdated: string | null;
  tie: boolean;
  /** False when both sides canonicalized to the same note — nothing to file. */
  needsProposal: boolean;
}

interface FilePlan {
  p: ConflictPath;
  /** Merged on-disk-form bytes for the live path. */
  content: string;
}

interface ParkPlan {
  p: ConflictPath;
  /** Repo-relative `conflicts/…` path, or "" when they had deleted the file. */
  parked: string;
}

// ── the resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve every unmerged path in an ALREADY-UNLOCKED store, leaving nothing for
 * git to complain about and nothing for a human to hand-edit.
 *
 * The store must be unlocked before this is called: `pullStore` does that as its
 * very first step, before git is touched at all, because a resolver running
 * without a DEK on a sealed store either writes plaintext into ciphertext or
 * dies mid-merge with markers already on disk.
 */
export async function resolveConflicts(
  home: string,
  opts: ResolveConflictsOptions = {},
): Promise<ResolveConflictsResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? systemClock;

  const unmerged = conflicted(home, env);
  if (unmerged.length === 0) return emptyResult();

  const { config } = loadConfig(storePaths(home).config);
  const result = emptyResult();

  // ── PHASE 1 — READ EVERY SIDE. No writes, no lock, no git mutation. ────────
  const paths: ConflictPath[] = unmerged.map((rel) => {
    const { kind, id } = classify(rel);
    return {
      rel,
      abs: path.join(home, rel),
      kind,
      id,
      ours: readStage(home, rel, 2, env),
      theirs: readStage(home, rel, 3, env),
    };
  });

  // ── PHASE 2 — DECIDE AND REFUSE. Every decode, parse and merge computation
  // happens here, while the only damage in the world is the merge git already
  // started. Anything that throws below leaves the store byte-identical.
  const notePlans: NotePlan[] = [];
  const logPlans: FilePlan[] = [];
  const ledgerPlans: FilePlan[] = [];
  const parkPlans: ParkPlan[] = [];

  for (const p of paths) {
    switch (p.kind) {
      case "note": {
        const plan = planNote(home, p);
        assertProvenanceFits(plan, config.entryTokenCap);
        notePlans.push(plan);
        break;
      }
      case "log":
        logPlans.push({ p, content: unionLog(p, p.id!) });
        break;
      case "ledger":
        ledgerPlans.push({ p, content: unionLedger(p) });
        break;
      case "other":
        parkPlans.push({
          p,
          parked: p.theirs.present
            ? parkedPathFor(p, stageShortSha(home, p.rel, 3, p.theirs.bytes, env))
            : "",
        });
        break;
    }
  }

  // The pending-proposal cap, checked BEFORE the first write. Over the cap the
  // only alternatives are dropping a loser (never) or wedging the store
  // half-resolved (worse), so this aborts while both sides are still nothing but
  // git objects.
  const willMint = notePlans.filter((n) => n.needsProposal).length;
  if (willMint > 0) {
    const pending = (await listProposals(home)).filter((x) => x.status === "pending").length;
    if (pending + willMint > config.maxPendingProposals) {
      throw new GestaltError(
        "E_PROPOSAL_CAP",
        `Resolving this pull needs ${String(willMint)} new suggested edit(s) to hold the other machine's ` +
          `version of ${willMint === 1 ? "a note" : "some notes"}, and this store already has ` +
          `${String(pending)} pending (max ${String(config.maxPendingProposals)}). NOTHING WAS WRITTEN — ` +
          `the merge is untouched and both sides of every note are still in git.`,
        `Clear some first (\`${BIN} review list\`), then \`${BIN} pull\` again. ` +
          `To back the merge out entirely: \`${BIN} pull --abort\`.`,
      );
    }
  }

  // ── PHASE 3 — WRITE. One lock for every store write the resolution makes, all
  // of it through the codec primitives so a sealed store stays sealed.
  //
  // `appendLog` is deliberately NOT called in here: it takes the store lock
  // itself, and `withLock`'s in-process queue is not reentrant, so a nested call
  // would deadlock against its own outer hold. It runs in phase 4.
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  const minted: (MintedProposal | null)[] = [];

  await withLock(home, config.lockWaitMs, async () => {
    // The log writes must land before phase 4, NOT before the note writes below.
    //
    // Stated carefully because the earlier version of this comment claimed
    // "Logs FIRST" was load-bearing WITHIN this phase, and a mutation test
    // proved it is not: swapping the two loops changes nothing, because phase 4
    // runs only after all of phase 3. The real invariant is the phase boundary.
    // What genuinely matters is that every resolved note appends a `convention`
    // entry to its topic's log in phase 4, and that append READS the log off
    // disk — so by then the log has to be a merged log rather than a marker
    // sandwich. Phase 3 completing is what guarantees that.
    //
    // A comment that names the wrong invariant is worse than none: it invites
    // the next reader to preserve an ordering that costs them options, and to
    // trust a guarantee that is not where they think it is.
    for (const plan of logPlans) {
      await writeFileAtomic(topicLogPath(home, plan.p.id!), plan.content);
      toAdd.push(plan.p.rel);
      result.logs.push(plan.p.rel);
    }

    for (const plan of ledgerPlans) {
      await writeFileAtomic(plan.p.abs, plan.content);
      toAdd.push(plan.p.rel);
      result.ledgers.push(plan.p.rel);
    }

    for (const plan of notePlans) {
      await writeFileAtomic(topicNotePath(home, plan.id), plan.winnerText);
      toAdd.push(plan.p.rel);
      minted.push(plan.needsProposal ? await mintLoser(home, plan, now, toAdd) : null);
    }

    for (const plan of parkPlans) {
      result.parked.push(await parkWholeFile(home, plan, toAdd, toRemove, result.advisories));
    }
  });

  // ── PHASE 4 — the provenance entry, one per resolved note.
  //
  // `appendLog`, never a hand-rolled write: it is what keeps the store's
  // monotonic clock honest and the index in step, and a log line written around
  // it would let the next entry reuse a timestamp that has already arrived.
  for (let i = 0; i < notePlans.length; i += 1) {
    const plan = notePlans[i]!;
    const proposal = minted[i] ?? null;
    const { timestamp } = await appendLog(
      home,
      plan.id,
      provenanceEntry(plan, proposal, config.entryTokenCap),
      { now },
    );
    const logRel = `logs/${plan.id}.log.md`;
    if (!toAdd.includes(logRel)) toAdd.push(logRel);

    result.notes.push({
      path: plan.p.rel,
      id: plan.id,
      winner: plan.winner,
      winnerUpdated: plan.winnerUpdated,
      loserUpdated: plan.loserUpdated,
      tie: plan.tie,
      proposal,
      logTimestamp: timestamp,
    });

    if (proposal !== null && proposal.ownerNotesDiffer) {
      // R4 at the surface. Without this line the user meets a proposal that
      // refuses to approve, citing a protected section they never touched on
      // this machine.
      result.advisories.push(
        `"${plan.id}": the two machines disagree inside \`## Owner notes\`, which is protected. ` +
          `Approving proposal #${String(proposal.seq)} therefore needs the override: ${proposal.approveCommand}`,
      );
    }
  }

  // ── PHASE 5 — hand the resolution to git. Staged last, so nothing is marked
  // resolved that the phases above did not actually finish.
  stageAll(home, toAdd, toRemove, env);
  result.staged = [...new Set([...toAdd, ...toRemove])];

  // ── PHASE 6 — never report success on somebody else's word.
  //
  // The lesson this whole pull contract was rewritten around: git can exit 0
  // having left a state no user would call success. So the post-condition is
  // asked of the index directly, through the same inspector `pull` and `doctor`
  // use — not inferred from the fact that nothing threw.
  const left = conflicted(home, env);
  if (left.length > 0) {
    throw new GestaltError(
      "E_IO",
      `the resolver finished but git still reports ${String(left.length)} unmerged path(s):\n  ` +
        left.join("\n  ") +
        `\nThat is a defect in the resolver, not something you did — and nothing it reported above is ` +
        `trustworthy while it is true.`,
      `Undo the whole pull with \`${BIN} pull --abort\`; nothing already committed is lost. ` +
        `Then report the paths above.`,
    );
  }

  result.steps.push(...narrate(result));
  return result;
}

// ── decoding a side ──────────────────────────────────────────────────────────

/**
 * Decode one stage through the storage codec.
 *
 * The path handed to `decryptFile` is the WORKTREE path, because the AAD binds a
 * blob to its file kind and basename (`gestalt/file/<kind>/<name>`). Give it
 * anything else — a temp name, a repo-relative string, a different basename —
 * and a perfectly good note fails to open.
 *
 * For a log or a ledger this is the identity: both are LINE-oriented codecs
 * (`decodeLogEntry` / `decodeLedgerLine`, inside their own parsers) rather than
 * whole-file blobs. Routing them through here anyway keeps ONE door into the
 * codec instead of two, and it still fails closed if a kind ever changes
 * underneath us — a sealed ledger read with no key throws here rather than being
 * silently re-written as cleartext.
 */
function decodeSide(p: ConflictPath, stage: Stage, side: Side): string {
  try {
    return decryptFile(p.abs, stage.bytes);
  } catch (err) {
    throw new GestaltError(
      "E_STORE_MODE",
      `could not read the ${nameSide(side)} version of ${p.rel}: ` +
        (err instanceof Error ? err.message : String(err)) +
        `\nRefusing to merge two versions when one of them could not be opened.`,
      `Undo the pull with \`${BIN} pull --abort\` (both versions stay in git), check the store is ` +
        `unlocked with the right key, then try again.`,
    );
  }
}

function nameSide(side: Side): string {
  return side === "ours" ? "local" : "incoming";
}

function markersInStage(rel: string, side: Side): GestaltError {
  return new GestaltError(
    "E_SCHEMA",
    `the ${nameSide(side)} version of ${rel} already contains COMMITTED git conflict markers, so it is a ` +
      `half-merged file rather than a version of this file. Nothing was written.`,
    `A raw \`git merge\` / \`git pull\` in this store committed those markers earlier. Repair that file by ` +
      `hand (keep what is true, delete the \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` lines), commit, then ` +
      `\`${BIN} pull\` again. \`${BIN} doctor\` lists every file carrying markers.`,
  );
}

// ── notes ────────────────────────────────────────────────────────────────────

/** `updated:` as epoch ms, or null when absent or unparsable. */
function updatedMs(note: TopicNote): number | null {
  if (note.updated === null) return null;
  const ms = msFromIso(note.updated);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read both sides of a note conflict and decide the winner. Pure apart from the
 * refusals — nothing here writes, so every throw leaves the store untouched.
 */
function planNote(home: string, p: ConflictPath): NotePlan {
  const id = p.id!;

  // A missing stage means one machine DELETED this note while the other edited
  // it. A deletion carries no `updated:`, so the winner rule has nothing to
  // compare and any choice made here would be invented policy — one of which
  // silently un-deletes and the other silently deletes somebody's note.
  for (const [side, stage] of sides(p)) {
    if (!stage.present) {
      const keepEdit = side === "ours" ? "theirs" : "ours";
      const deletedOn = side === "ours" ? "this machine" : "the other machine";
      const editedOn = side === "ours" ? "the other machine" : "this machine";
      throw new GestaltError(
        "E_SCHEMA",
        `${p.rel} was DELETED on ${deletedOn} and edited on ${editedOn}. There is no timestamp on a ` +
          `deletion, so the merge rule cannot choose between them. Nothing was written.`,
        `Decide by hand, then commit:\n` +
          `  git -C ${home} checkout --${keepEdit} -- ${p.rel}   # keep the edit\n` +
          `  git -C ${home} rm -- ${p.rel}                        # keep the deletion\n` +
          `Or back the whole pull out with \`${BIN} pull --abort\`.`,
      );
    }
  }

  const parsed: Partial<Record<Side, TopicNote>> = {};
  for (const [side, stage] of sides(p)) {
    const text = decodeSide(p, stage, side);
    // Markers in a STAGE mean a previous raw `git merge` committed a half-merged
    // note. `parseNote` would happily accept it — the frontmatter is intact and
    // the markers land in the body — so the winner rule would pick a
    // Frankenstein body and this resolver would bake it in as settled memory.
    if (hasConflictMarkers(text)) throw markersInStage(p.rel, side);
    const note = parseNote(text, id);
    if (note === null) {
      throw new GestaltError(
        "E_SCHEMA",
        `the ${nameSide(side)} version of ${p.rel} is not a valid note (no usable frontmatter), so there ` +
          `is no \`updated:\` to compare and no body worth keeping safe. Nothing was written.`,
        `Back the pull out with \`${BIN} pull --abort\` — both versions stay in git — then repair ` +
          `whichever commit carries the broken note.`,
      );
    }
    parsed[side] = note;
  }
  const ourNote = parsed.ours!;
  const theirNote = parsed.theirs!;

  const ourMs = updatedMs(ourNote);
  const theirMs = updatedMs(theirNote);

  // LAST-WRITE-WINS ON EACH MACHINE'S OWN CLOCK — see the module header. A tie,
  // and the case where neither side carries a usable timestamp, both keep ours:
  // the pulling clone is the one whose human is present, so the version already
  // on their disk stays live while they decide.
  let winner: Side;
  let tie = false;
  if (ourMs === null && theirMs === null) {
    winner = "ours";
    tie = true;
  } else if (theirMs === null) {
    winner = "ours";
  } else if (ourMs === null) {
    winner = "theirs";
  } else if (ourMs === theirMs) {
    winner = "ours";
    tie = true;
  } else {
    winner = ourMs > theirMs ? "ours" : "theirs";
  }

  const winnerNote = winner === "ours" ? ourNote : theirNote;
  const loserNote = winner === "ours" ? theirNote : ourNote;
  const proposedNote = proposedFrom(id, winnerNote, loserNote);

  // CANONICAL bytes, not the stage bytes. `baseHash` is taken over exactly this
  // string, and `review approve` re-hashes what `readText` returns from disk —
  // so the thing written and the thing hashed must both be `serializeNote`
  // output, or the very first approve dies E_STALE and the whole feature looks
  // broken.
  const winnerText = serializeNote(winnerNote);
  const proposedText = serializeNote(proposedNote);

  return {
    p,
    id,
    winnerText,
    winnerNote,
    loserNote,
    proposedText,
    proposedNote,
    winner,
    winnerUpdated: winnerNote.updated,
    loserUpdated: loserNote.updated,
    tie,
    // Two sides can differ as bytes and still canonicalize to the same note
    // (frontmatter key order, quoting, a trailing newline). Then the loser is
    // not a loser, and a proposal to replace a note with itself is noise in a
    // queue whose whole value is being short.
    needsProposal: proposedText !== winnerText,
  };
}

/**
 * The note the loser's proposal would install.
 *
 * The loser's own title / aliases / tags / projects are KEPT — dropping them
 * would be dropping half a side, which is the thing this file exists to prevent.
 * The two RUNTIME-OWNED fields come from the winner instead:
 *
 *   - `updated:` because `reviewApprove` overwrites it with the approve time
 *     regardless, so carrying the loser's value would only make the proposal
 *     look like it were proposing a timestamp.
 *   - `compactedThrough:` because approve validates the proposal's watermark
 *     against the note it replaces (`assertValidCompactedThrough`). The loser's
 *     watermark can legitimately sit BEHIND the winner's, and a backward
 *     watermark is precisely what that check rejects — the proposal would be
 *     unapprovable for a reason that has nothing to do with its content.
 */
function proposedFrom(id: string, winnerNote: TopicNote, loserNote: TopicNote): TopicNote {
  return {
    ...loserNote,
    id,
    updated: winnerNote.updated,
    compactedThrough: winnerNote.compactedThrough,
  };
}

/**
 * File the loser as an ordinary pending proposal, through the SAME primitives
 * `update` uses (`nextSeq` for the number, `serializeProposal` for the bytes),
 * so `review list`, `review show` and `review approve` see nothing unusual.
 *
 * Called inside phase 3's `withLock`, which is where `nextSeq` requires to be
 * called: it derives the next number by reading the proposals directory, and two
 * mints racing that read would collide on a filename.
 */
async function mintLoser(
  home: string,
  plan: NotePlan,
  now: Clock,
  toAdd: string[],
): Promise<MintedProposal> {
  const ownerNotesDiffer = !ownerNotesEqual(plan.winnerNote.body, plan.proposedNote.body);

  const { seq, machineId } = await nextSeq(home);
  const created = isoFromMs(now());
  const doc: ProposalDoc = {
    seq,
    id: plan.id,
    status: "pending",
    // Plain, colon-free, pipe-free: it is written as an unquoted YAML scalar and
    // interpolated into approve's own auto entry ("Note updated via proposal #N
    // by <proposer>.").
    proposer: `${BIN}-pull`,
    created,
    compactedThrough: plan.proposedNote.compactedThrough,
    baseUpdated: plan.winnerNote.updated ?? created,
    // BOTH HASHES OVER POST-`serializeNote` BYTES. `serializeNote` rewrites the
    // frontmatter (stable key order, quoting, `null` spellings), so hashing the
    // strings we MEANT to write rather than the ones we did makes `baseHash`
    // disagree with the file on disk, and the very first `review approve` fails
    // E_STALE — which reads to the user as "the merge broke the note".
    baseHash: sha256(plan.winnerText),
    newHash: sha256(plan.proposedText),
    // Advisory only (R4); the caller is told separately. See MintedProposal.
    ownerNotesOverride: ownerNotesDiffer,
    oldNote: plan.winnerText,
    newNote: plan.proposedText,
    diff: insertionDiff(
      plan.winnerText,
      plan.proposedText,
      `topics/${plan.id}.md (kept — ${plan.winner === "ours" ? "this machine" : "the other machine"})`,
      `topics/${plan.id}.md (filed — ${plan.winner === "ours" ? "the other machine" : "this machine"})`,
    ),
    machineId,
  };

  const target = proposalPath(home, seq, plan.id, machineId);
  await fsp.mkdir(fsPath(path.dirname(target)), { recursive: true });
  await writeFileAtomic(target, serializeProposal(doc));

  const file = `proposals/${path.basename(target)}`;
  toAdd.push(file);
  return {
    seq,
    id: plan.id,
    file,
    ownerNotesDiffer,
    // MACHINE-SCOPED on purpose. Proposal numbers are per-clone counters, so
    // on three machines two independent resolutions both mint the same N and a
    // bare `review approve N` then dies E_AMBIGUOUS — the printed remedy would
    // be the one command guaranteed not to work, on exactly the fleet size this
    // feature is for. Naming the machine costs nothing on a two-machine store
    // and is the difference between recoverable and stuck on a larger one.
    approveCommand:
      `${BIN} review approve ${String(seq)} --machine ${machineId}` +
      (ownerNotesDiffer ? " --allow-owner-notes" : ""),
  };
}

/**
 * The one `convention` entry a resolved note gets.
 *
 * IT CARRIES AN EXCERPT OF THE LOSER'S BODY, and that is the point of it rather
 * than a decoration (launch plan R2). `search` reads notes and log entries; it
 * does NOT read `proposals/`. Without the excerpt the filed side is unfindable
 * by its own words — someone who remembers writing a sentence on the other
 * machine searches for it, gets nothing, and concludes the merge ate it. The
 * proposal queue is a list of numbers; this line is the searchable trace.
 *
 * Trimmed to fit `entryTokenCap` (350 by default) rather than left for
 * `assertAppendable` to reject: a resolver that throws on a long note would make
 * long notes unmergeable, which is a worse bug than a shortened excerpt.
 */
function provenanceEntry(
  plan: NotePlan,
  minted: MintedProposal | null,
  entryTokenCap: number,
): NewEntry {
  const base: NewEntry = {
    type: "convention",
    project: BIN,
    agent: `${BIN}-pull`,
    summary: richSummary(plan, minted),
  };
  // Ladder, not a single shot: a store whose owner has tightened
  // `entryTokenCap` must still be mergeable, and the provenance line is the one
  // thing here that scales with prose. Fall back to the short summary before
  // giving up any of it.
  const entry: NewEntry =
    blockTokens(blockLength(base)) > entryTokenCap
      ? { ...base, summary: shortSummary(plan, minted) }
      : base;
  if (minted === null) return entry;

  // Starts with prose, never `### `: `assertAppendable` rejects a body line that
  // looks like an entry header (anti-forgery), and a note body can legitimately
  // begin with one.
  const label = "Other version, excerpted here so search can still find it: ";
  const excerpt = flatten(
    plan.loserNote.body,
    entryTokenCap * 4 - blockLength({ ...entry, body: label }) - 8,
  );
  return excerpt === "" ? entry : { ...entry, body: label + excerpt };
}

function richSummary(plan: NotePlan, minted: MintedProposal | null): string {
  const kept = plan.winner === "ours" ? "this machine's" : "the other machine's";
  const filed = plan.winner === "ours" ? "the other machine's" : "this machine's";
  return minted === null
    ? `Cross-machine merge on "${plan.id}": both machines held the same note; kept ${kept} copy.`
    : `Cross-machine merge on "${plan.id}": kept ${kept} version (updated ${plan.winnerUpdated ?? "unknown"}` +
        `${plan.tie ? ", tie broken in favour of this machine" : ""}); ${filed} version (updated ` +
        `${plan.loserUpdated ?? "unknown"}) is pending proposal #${String(minted.seq)}.`;
}

function shortSummary(plan: NotePlan, minted: { seq: number } | null): string {
  return minted === null
    ? `Cross-machine merge on "${plan.id}": both machines held the same note.`
    : `Cross-machine merge on "${plan.id}": the other version is pending proposal #${String(minted.seq)}.`;
}

/**
 * Length of the block `appendLog` will actually write. The timestamp is
 * fixed-width, so a placeholder of the same width gives the exact answer — and
 * the exact answer is what lets the caller spend the remaining budget on the
 * excerpt instead of guessing at a margin.
 */
function blockLength(entry: NewEntry): number {
  return formatEntryBlock("0000-00-00T00:00:00.000Z", entry).length;
}

function blockTokens(length: number): number {
  return Math.ceil(length / 4);
}

/**
 * Refuse, before anything is written, a store whose `entryTokenCap` cannot hold
 * even the shortest provenance line.
 *
 * This is a pre-flight and not a `try` around `appendLog`, because by the time
 * `appendLog` runs the winner is on disk and the loser's proposal is minted:
 * a throw there leaves a resolved-but-unstaged store with no record of why.
 * The cap is the owner's own setting, so the remedy is theirs to apply.
 */
function assertProvenanceFits(plan: NotePlan, entryTokenCap: number): void {
  // A six-digit seq placeholder — wider than any real one, so this can only
  // over-estimate, never wave through an entry that will not fit.
  const probe: NewEntry = {
    type: "convention",
    project: BIN,
    agent: `${BIN}-pull`,
    summary: shortSummary(plan, { seq: 999999 }),
  };
  const tokens = blockTokens(blockLength(probe));
  if (tokens <= entryTokenCap) return;
  throw new GestaltError(
    "E_TOKEN_CAP",
    `this store's \`entryTokenCap\` is ${String(entryTokenCap)}, and the merge record for "${plan.id}" ` +
      `needs ${String(tokens)} tokens — so the resolution could be written but never explained. ` +
      `Nothing was written.`,
    `Raise \`entryTokenCap\` in the store's config.json to at least ${String(tokens)}, then ` +
      `\`${BIN} pull\` again. To back the merge out entirely: \`${BIN} pull --abort\`.`,
  );
}

/** One line of a note body, whitespace-collapsed and hard-capped. */
function flatten(body: string, maxChars: number): string {
  if (maxChars <= 1) return "";
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return flat.slice(0, maxChars - 1).trimEnd() + "…";
}

// ── logs ─────────────────────────────────────────────────────────────────────

/**
 * Union two sides of a log, because a log is append-only and both machines'
 * entries are true.
 *
 * This path should rarely run: `.gitattributes` sets `merge=union` on
 * `logs/*.log.md` and `pull` repairs those lines before it merges. It exists for
 * the store that reached this build WITHOUT them — the case the repair fixes
 * going forward but cannot fix retroactively for a merge already underway.
 *
 * Identity is the ENTRY BLOCK, not the timestamp. Two machines can mint the same
 * millisecond, and deduping on the timestamp would silently delete one of two
 * genuinely different entries. Equal blocks are the same entry; everything else
 * is kept. Sorted (timestamp, then bytes) so both clones converge on identical
 * files instead of conflicting again on the next pull.
 */
function unionLog(p: ConflictPath, id: string): string {
  const byBlock = new Map<string, LogEntry>();
  for (const [side, stage] of sides(p)) {
    if (!stage.present) continue; // one side deleted the log; the union keeps the other
    const text = decodeSide(p, stage, side);
    // Marker lines are not entry headers, so `parseLog` folds them into the
    // PRECEDING entry's body and the union would re-serialize them as if a human
    // had typed them: a marker laundered into settled memory, which is exactly
    // what `doctor` fails on.
    if (hasConflictMarkers(text)) throw markersInStage(p.rel, side);
    for (const e of parseLog(text, id).entries) {
      if (!byBlock.has(e.raw)) byBlock.set(e.raw, e);
    }
  }
  const all = [...byBlock.values()].sort(
    (a, b) =>
      (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0) ||
      (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0),
  );
  return serializeLog(id, all);
}

// ── ledgers ──────────────────────────────────────────────────────────────────

/**
 * Union two sides of a ledger at the LINE level.
 *
 * Deliberately NOT `parseLedger` + re-serialize: `parseLedger` DROPS a line it
 * cannot decode or JSON-parse, and this is a write path — read-parse-overwrite
 * would make that drop permanent. So the lines themselves are the unit, parsing
 * is used only to ORDER them, and a line nobody can read still survives.
 *
 * Sealed lines are byte-stable for identical events (deterministic AEAD), which
 * is what makes plain string dedupe correct on an encrypted store too.
 */
function unionLedger(p: ConflictPath): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [side, stage] of sides(p)) {
    if (!stage.present) continue;
    for (const raw of decodeSide(p, stage, side).split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      // A marker line is git detritus, never an event: JSONL has no line that
      // begins `<<<<<<<`. Dropping it drops nothing of the user's, and keeping it
      // would leave a marker in the store — the one thing this file promises not
      // to do.
      if (CONFLICT_ANY_LINE.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  if (lines.length === 0) return "";

  // HLC order (ts, machineId, seq) wherever the line can be read, so the file
  // stays meaningful to a human; unreadable lines sort last, by their own bytes.
  // Both halves are total and deterministic, which is what stops the next pull
  // from conflicting all over again on line order.
  const keyed = lines.map((line) => ({ line, key: ledgerSortKey(line) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.line).join("\n") + "\n";
}

function ledgerSortKey(line: string): string {
  try {
    const e = JSON.parse(decodeLedgerLine(line)) as {
      ts?: unknown;
      machineId?: unknown;
      seq?: unknown;
    };
    const ts = typeof e.ts === "string" ? e.ts : "";
    const machineId = typeof e.machineId === "string" ? e.machineId : "local";
    const seq = typeof e.seq === "number" ? e.seq : 0;
    return `1 ${ts} ${machineId} ${String(seq).padStart(12, "0")} ${line}`;
  } catch {
    return `2 ${line}`;
  }
}

// ── everything else ──────────────────────────────────────────────────────────

/** `conflicts/<store-relative-path>.<short-sha>` — one spelling, here. */
function parkedPathFor(p: ConflictPath, shortSha: string): string {
  // git paths never contain `..`, but this one is joined onto the store home, and
  // a traversal guard costs one line.
  if (p.rel.split("/").includes("..")) {
    throw new GestaltError(
      "E_SCHEMA",
      `refusing to park a conflicted path containing "..": ${p.rel}`,
      `Report this — a repository path should never look like that.`,
    );
  }
  return `conflicts/${p.rel}.${shortSha}`;
}

/**
 * `config.json`, `schema.json`, `state/**`, and anything the store layout does
 * not recognise: OURS stays live, THEIRS is parked under `conflicts/`.
 *
 * NEVER union JSON. Two half-merged budget files, or two half-merged machine
 * state records, are not a config — they are a file that parses and lies, and
 * `loadConfig` tolerates hand edits by falling back to defaults, so the lie
 * would be silent. One side whole and the other whole-but-parked is the only
 * shape a human can act on. `doctor` already warns `conflicts_pending` and says
 * out loud that nothing reads that directory.
 *
 * WHY `writeFileAtomicPlain` AND NOT `writeFileAtomic` — the one place in this
 * file that rule is inverted, so it is spelled out. The bytes in hand came out
 * of git's INDEX, which means they are already in ON-DISK form. `state/**` is
 * file kind "other", which IS whole-file sealed, so running those bytes back
 * through `encryptFile` would seal ciphertext a second time and the reader would
 * then "decrypt" the file to an inner `gestalt-enc:1:…` string instead of JSON.
 * Restoring git's own bytes verbatim is not a plaintext write and does not
 * reopen the fail-closed hole: it cannot introduce cleartext the repository was
 * not already carrying.
 */
async function parkWholeFile(
  home: string,
  plan: ParkPlan,
  toAdd: string[],
  toRemove: string[],
  advisories: string[],
): Promise<ParkedFile> {
  const p = plan.p;
  if (plan.parked !== "") {
    const target = path.join(home, plan.parked);
    await fsp.mkdir(fsPath(path.dirname(target)), { recursive: true });
    await writeFileAtomicPlain(target, p.theirs.bytes);
    toAdd.push(plan.parked);
  }

  if (p.ours.present) {
    // The worktree copy has markers spliced through it right now, so this is a
    // rewrite, not a no-op.
    await writeFileAtomicPlain(p.abs, p.ours.bytes);
    toAdd.push(p.rel);
    if (hasConflictMarkers(p.ours.bytes)) {
      // PRESERVED, not introduced: these markers are in the commit this branch
      // already had. Refusing the pull over them would make the store
      // permanently unpullable for damage that predates the pull, so it is said
      // out loud instead — and `doctor` fails on it independently.
      advisories.push(
        `${p.rel} was kept as-is, and the copy committed on this machine already contains git conflict ` +
          `markers. \`${BIN} doctor\` will keep failing on it until they are removed by hand.`,
      );
    }
    return { path: p.rel, parked: plan.parked, oursWas: "content" };
  }

  // Our side was a deletion. Honour it — the other machine's version is parked
  // above, so nothing is gone.
  toRemove.push(p.rel);
  return { path: p.rel, parked: plan.parked, oursWas: "deleted" };
}

// ── staging ──────────────────────────────────────────────────────────────────

/**
 * Mark every path resolved. Chunked because a store with many conflicts would
 * otherwise build a command line past the platform limit — and on Windows that
 * limit is low enough to hit, where the failure mode is a silent partial stage.
 */
function stageAll(
  home: string,
  toAdd: string[],
  toRemove: string[],
  env: NodeJS.ProcessEnv,
): void {
  for (const chunk of chunked([...new Set(toAdd)], 40)) {
    const r = runGit(home, ["add", "--", ...chunk], env);
    if (!r.ok) {
      throw new GestaltError(
        "E_IO",
        `could not stage the resolved files (${chunk.join(", ")}): ${r.err}`,
        `The files themselves are resolved on disk. Stage them yourself with \`git -C ${home} add -A\`, ` +
          `or back the pull out with \`${BIN} pull --abort\`.`,
      );
    }
  }
  for (const chunk of chunked([...new Set(toRemove)], 40)) {
    const r = runGit(home, ["rm", "-f", "--quiet", "--", ...chunk], env);
    if (!r.ok) {
      throw new GestaltError(
        "E_IO",
        `could not record the deletion of ${chunk.join(", ")}: ${r.err}`,
        `Back the pull out with \`${BIN} pull --abort\` and resolve that path by hand.`,
      );
    }
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── narration ────────────────────────────────────────────────────────────────

function narrate(r: ResolveConflictsResult): string[] {
  const steps: string[] = [];
  for (const n of r.notes) {
    const who = n.winner === "ours" ? "this machine's" : "the other machine's";
    steps.push(
      n.proposal === null
        ? `${n.path}: both machines held the same note; kept ${who} copy`
        : `${n.path}: kept ${who} version (updated ${n.winnerUpdated ?? "unknown"}` +
          `${n.tie ? ", tie" : ""}); filed the other as proposal #${String(n.proposal.seq)} — ` +
          `read it with \`${BIN} review show ${String(n.proposal.seq)}\`, keep it with ` +
          `\`${n.proposal.approveCommand}\``,
    );
  }
  if (r.logs.length > 0) {
    steps.push(`merged both machines' log entries in: ${r.logs.join(", ")}`);
  }
  if (r.ledgers.length > 0) {
    steps.push(`merged both machines' ledger lines in: ${r.ledgers.join(", ")}`);
  }
  for (const f of r.parked) {
    steps.push(
      f.oursWas === "deleted"
        ? `${f.path}: kept this machine's deletion; the other machine's copy is in ${f.parked}`
        : f.parked === ""
          ? `${f.path}: kept this machine's version (the other machine had deleted it)`
          : `${f.path}: kept this machine's version; the other machine's is parked in ${f.parked}`,
    );
  }
  return steps;
}
