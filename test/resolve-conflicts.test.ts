/**
 * W-D ACCEPTANCE — the 0.3.0 launch gate (plan §1, tests T3 and T4).
 *
 * These were written by an agent that did NOT write `src/ops/resolveConflicts.ts`
 * and does not trust its self-report. Everything here drives a real bare remote
 * and two real clones through the plan's protocol:
 *
 *     write → commit → push → pull → push the merge → pull back
 *
 * "Both run pull" is not a protocol. Nothing is shared until somebody pushes, so
 * every fixture below pushes the merge and pulls it back on the other machine.
 *
 * Every bare repo is created with `git init --bare -b main`. A missing `-b main`
 * is what made an earlier proof in this project FALSE-PASS: the clone's default
 * branch and the bare repo's HEAD disagreed, so the "merge" under test was
 * merging nothing.
 *
 * THE CONTRACT UNDER TEST (plan §1) — this is not "git merges two essays":
 *     never drop a side · never leave a marker · the store stays readable ·
 *     a human picks.
 *
 * The winner rule is LAST-WRITE-WINS ON EACH MACHINE'S OWN CLOCK. A laptop five
 * minutes slow loses a note its human approved last. That is accepted for 0.3.0
 * and asserted here as such — the tests say "larger `updated:`", never "the
 * newer decision".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { runDoctor } from "../src/ops/doctor.js";
import { exportPlaintext } from "../src/ops/exportOp.js";
import { conflicted, inProgress } from "../src/ops/gitState.js";
import { appendLog } from "../src/ops/logOp.js";
import { pullStore } from "../src/ops/pullOp.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { resolveConflicts } from "../src/ops/resolveConflicts.js";
import { reviewApprove, reviewList, reviewShow } from "../src/ops/review.js";
import { findProposal } from "../src/store/proposals.js";
import { search } from "../src/ops/search.js";
import { updateTopic } from "../src/ops/update.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import { activateDek, clearActiveKey, decryptFile, keyState } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { parseLog } from "../src/store/log.js";
import { parseNote, serializeNote } from "../src/store/note.js";
import { readText } from "../src/store/read.js";
import { ENC_MAGIC } from "../src/store/wireFormat.js";
import { clockAt, expectGestaltErrorAsync, freshHome } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy launch-gate passphrase";
/**
 * Base wall clock, 2026-07-28T12:00:00Z. It must be LATER than the seeded
 * worked example's timestamps or the store's monotonic watermark overrides the
 * injected clock and the two machines stop having different clocks — which
 * would make the winner rule untestable while every assertion still passed.
 */
const T0 = 1_785_240_000_000;

// ── git plumbing for the fixtures ────────────────────────────────────────────

interface Pair {
  root: string;
  origin: string;
  /** Machine A — created the store, pushes first. */
  a: string;
  /** Machine B — the clone that pulls, resolves, and pushes the merge. */
  b: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Git with the developer's own global/system config held out of the way. Both
 * config paths point at files that do not exist, which git reads as empty, so a
 * box with `merge.conflictStyle=diff3` or an autocrlf setting cannot change what
 * these tests measure — and nothing here can write to the developer's config.
 */
function gitEnvFor(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, "no-global-gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(root, "no-system-gitconfig"),
    GIT_AUTHOR_NAME: "fimemory test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "fimemory test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function git(p: Pair, dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: p.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir} (${String(r.status)}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function gitTry(p: Pair, dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: p.env });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** The exact command `pullStore` issues, run by hand so the resolver can follow it. */
function rawPull(p: Pair, dir: string): { ok: boolean; out: string } {
  return gitTry(p, dir, "pull", "--no-rebase", "--no-edit");
}

function commitAll(p: Pair, dir: string, message: string): void {
  git(p, dir, "add", "-A");
  git(p, dir, "commit", "-q", "-m", message);
}

// ── whole-store inspection ───────────────────────────────────────────────────

/** Every store-relative file path under `home`, `.git` excluded. */
function storeFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(fsPath(dir), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(home, "");
  return out.sort();
}

/**
 * The gate's "no file anywhere in the store contains a conflict marker".
 *
 * Deliberately scans EVERY file, not just notes: a marker in config.json, a
 * ledger or a parked sidecar is the same failure. Both open and close forms are
 * checked independently — `doctor` requires a matched pair (prose about merges
 * is not damage), but a fixture that produced a lone `<<<<<<<` would still be a
 * broken resolution, so this is deliberately the stricter question.
 */
function filesWithMarkers(home: string): string[] {
  const bad: string[] = [];
  for (const rel of storeFiles(home)) {
    let text: string;
    try {
      text = readFileSync(fsPath(path.join(home, rel)), "utf8");
    } catch {
      continue;
    }
    if (/^(<{7}( |$)|={7}$|\|{7}( |$)|>{7}( |$))/m.test(text)) bad.push(rel);
  }
  return bad;
}

/** Content hash of every file in the store — proof that a refusal wrote nothing. */
function hashTree(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of storeFiles(home)) {
    const buf = readFileSync(fsPath(path.join(home, rel)));
    out[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return out;
}

/** Insert a line into a note body, above the protected `## Owner notes` section. */
function editBody(noteText: string, line: string): string {
  return noteText.replace("## Owner notes", `${line}\n\n## Owner notes`);
}

async function liveBody(home: string, id: string): Promise<string> {
  const text = await readText(topicNotePath(home, id));
  expect(text).not.toBeNull();
  return parseNote(text!, id)!.body;
}

async function logSummaries(home: string, id: string): Promise<string[]> {
  const text = (await readText(topicLogPath(home, id)))!;
  const parsed = parseLog(text, id);
  expect(parsed.warnings).toEqual([]);
  return parsed.entries.map((e) => e.summary);
}

/** The whole log surface (summaries + bodies) — where the loser's excerpt lives. */
async function logRawText(home: string, id: string): Promise<string> {
  const text = (await readText(topicLogPath(home, id)))!;
  return parseLog(text, id)
    .entries.map((e) => e.raw)
    .join("\n");
}

// ── the dual-approve fixture ─────────────────────────────────────────────────

/**
 * Two topics that resolve in OPPOSITE directions in one pull, so a single run
 * proves both branches of the winner rule:
 *
 *   alpha — machine A approved LAST, so on B the incoming side wins and B's own
 *           work is the loser. This is the dangerous direction: the human at the
 *           keyboard is the one whose body disappears from the note.
 *   beta  — machine B approved last, so B keeps its own and files A's.
 *
 * The clocks have to interleave to get that, and they cannot be set freely: both
 * `update` and `approve` take `max(injected clock, store watermark + 1ms)`, so
 * each machine's own operations must be issued in increasing time order. Hence A
 * does beta first and alpha last, and B does alpha first and beta last.
 */
const A_BETA_UPDATE = T0 + 100_000;
const A_BETA_APPROVE = T0 + 101_000;
const A_ALPHA_UPDATE = T0 + 300_000;
const A_ALPHA_APPROVE = T0 + 301_000;
const B_ALPHA_UPDATE = T0 + 200_000;
const B_ALPHA_APPROVE = T0 + 201_000;
const B_BETA_UPDATE = T0 + 400_000;
const B_BETA_APPROVE = T0 + 401_000;
const RESOLVE_AT = T0 + 900_000;

/** Distinctive words that exist on exactly one machine's side of one note. */
const A_ALPHA_LINE = "Machine A on alpha: the marmalade budget doubled this quarter.";
const B_ALPHA_LINE = "Machine B on alpha: the quokka telemetry seam is load-bearing.";
const A_BETA_LINE = "Machine A on beta: the kingfisher rollout is paused indefinitely.";
const B_BETA_LINE = "Machine B on beta: the pangolin index is authoritative from now on.";

async function buildPair(label: string, encrypted: boolean): Promise<Pair> {
  const root = freshHome(label);
  mkdirSync(fsPath(root), { recursive: true });
  const p: Pair = {
    root,
    origin: path.join(root, "origin.git"),
    a: path.join(root, "machine-a"),
    b: path.join(root, "machine-b"),
    env: gitEnvFor(root),
  };
  // `-b main` is not optional. See the file header.
  git(p, root, "init", "--bare", "-q", "-b", "main", p.origin);

  if (encrypted) {
    runInit({ home: p.a, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    // `init --encrypted` deliberately clears the process key on the way out.
    activateDek(unlockWithPassphrase(p.a, PASS));
  } else {
    runInit({ home: p.a });
  }

  await createTopic(p.a, "alpha", "Alpha pipeline", { now: clockAt(T0) });
  await createTopic(p.a, "beta", "Beta pipeline", { now: clockAt(T0 + 1_000) });
  await appendLog(
    p.a,
    "alpha",
    { type: "decision", project: "demo", agent: "machine-a", summary: "baseline alpha decision" },
    { now: clockAt(T0 + 2_000) },
  );
  await appendLog(
    p.a,
    "beta",
    { type: "decision", project: "demo", agent: "machine-a", summary: "baseline beta decision" },
    { now: clockAt(T0 + 3_000) },
  );

  git(p, p.a, "init", "-q", "-b", "main");
  git(p, p.a, "remote", "add", "origin", p.origin);
  commitAll(p, p.a, "baseline");
  git(p, p.a, "push", "-q", "-u", "origin", "main");
  git(p, root, "clone", "-q", p.origin, p.b);
  return p;
}

/** Both machines approve a different edit to alpha AND to beta; A pushes. */
async function dualApprove(p: Pair): Promise<void> {
  // ── machine A: beta first, then alpha (its clock must only move forward) ──
  const aBeta = (await readText(topicNotePath(p.a, "beta")))!;
  const aBetaSeq = (
    await updateTopic(p.a, "beta", editBody(aBeta, A_BETA_LINE), {
      proposer: "machine-a",
      now: clockAt(A_BETA_UPDATE),
    })
  ).seq;
  await reviewApprove(p.a, aBetaSeq, { now: clockAt(A_BETA_APPROVE) });

  const aAlpha = (await readText(topicNotePath(p.a, "alpha")))!;
  const aAlphaSeq = (
    await updateTopic(p.a, "alpha", editBody(aAlpha, A_ALPHA_LINE), {
      proposer: "machine-a",
      now: clockAt(A_ALPHA_UPDATE),
    })
  ).seq;
  await reviewApprove(p.a, aAlphaSeq, { now: clockAt(A_ALPHA_APPROVE) });

  commitAll(p, p.a, "machine-a: approved edits to alpha and beta");
  git(p, p.a, "push", "-q", "origin", "main");

  // ── machine B, on the same base, never having pulled ──────────────────────
  const bAlpha = (await readText(topicNotePath(p.b, "alpha")))!;
  const bAlphaSeq = (
    await updateTopic(p.b, "alpha", editBody(bAlpha, B_ALPHA_LINE), {
      proposer: "machine-b",
      now: clockAt(B_ALPHA_UPDATE),
    })
  ).seq;
  await reviewApprove(p.b, bAlphaSeq, { now: clockAt(B_ALPHA_APPROVE) });

  const bBeta = (await readText(topicNotePath(p.b, "beta")))!;
  const bBetaSeq = (
    await updateTopic(p.b, "beta", editBody(bBeta, B_BETA_LINE), {
      proposer: "machine-b",
      now: clockAt(B_BETA_UPDATE),
    })
  ).seq;
  await reviewApprove(p.b, bBetaSeq, { now: clockAt(B_BETA_APPROVE) });

  commitAll(p, p.b, "machine-b: approved edits to alpha and beta");
}

// ═════════════════════════════════════════════════════════════════════════════
// T3 — PLAINTEXT DUAL-APPROVE. THE GATE.
// ═════════════════════════════════════════════════════════════════════════════

describe("T3 — plaintext dual-approve, two clones of one bare remote", () => {
  let p: Pair;
  let alphaSeq = 0;
  let betaSeq = 0;

  beforeAll(async () => {
    // The DEK is process-global. This block must run with no key active, or
    // `runInit` would write a plaintext store that every read fails closed on.
    clearActiveKey();
    expect(keyState().mode).toBe("plaintext");
    p = await buildPair("wd-plain", false);
    await dualApprove(p);
  }, 90_000);

  it("git alone cannot merge two approved edits to one note — that is why a resolver exists", () => {
    const pulled = rawPull(p, p.b);
    expect(pulled.ok).toBe(false);
    expect(pulled.out.toLowerCase()).toContain("conflict");
    expect(conflicted(p.b, p.env)).toEqual(["topics/alpha.md", "topics/beta.md"]);
    expect(inProgress(p.b, p.env)).toBe("merge");
    // Git has already spliced markers into the worktree. Everything below is
    // about removing them without dropping anybody's work.
    expect(filesWithMarkers(p.b)).toContain("topics/alpha.md");
  }, 60_000);

  it("resolving finishes the merge: git reports nothing unmerged and the commit lands", async () => {
    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    expect(conflicted(p.b, p.env)).toEqual([]);
    expect(res.notes.map((n) => n.path).sort()).toEqual(["topics/alpha.md", "topics/beta.md"]);

    // The resolver stages but does not commit — the caller finishes the merge.
    git(p, p.b, "commit", "-q", "--no-edit");
    expect(inProgress(p.b, p.env)).toBe(null);
    expect(git(p, p.b, "status", "--porcelain").trim()).toBe("");

    alphaSeq = res.notes.find((n) => n.id === "alpha")!.proposal!.seq;
    betaSeq = res.notes.find((n) => n.id === "beta")!.proposal!.seq;
    await reindexStore(p.b);
  }, 60_000);

  it("no file anywhere in the store contains a conflict marker", () => {
    expect(filesWithMarkers(p.b)).toEqual([]);
  });

  it("exactly one body is live per note, and it is the one with the larger `updated:`", async () => {
    // alpha: machine A approved later, so the INCOMING side is live and the
    // local human's paragraph is the one that left the note.
    const alpha = await liveBody(p.b, "alpha");
    expect(alpha).toContain(A_ALPHA_LINE);
    expect(alpha).not.toContain(B_ALPHA_LINE);

    // beta: this machine approved later, so it keeps its own.
    const beta = await liveBody(p.b, "beta");
    expect(beta).toContain(B_BETA_LINE);
    expect(beta).not.toContain(A_BETA_LINE);

    // …and "larger `updated:`" is literally what decided it. Not "newer
    // decision" — last-write-wins on each machine's own clock (plan §1).
    const alphaNote = parseNote((await readText(topicNotePath(p.b, "alpha")))!, "alpha")!;
    const betaNote = parseNote((await readText(topicNotePath(p.b, "beta")))!, "beta")!;
    expect(Date.parse(alphaNote.updated!)).toBeGreaterThanOrEqual(A_ALPHA_APPROVE);
    expect(Date.parse(betaNote.updated!)).toBeGreaterThanOrEqual(B_BETA_APPROVE);
  }, 60_000);

  it("`review list` shows a pending proposal whose New block holds the OTHER body", async () => {
    const pending = (await reviewList(p.b)).filter((x) => x.status === "pending");
    expect(pending.map((x) => x.seq)).toEqual(expect.arrayContaining([alphaSeq, betaSeq]));

    const alphaDoc = await reviewShow(p.b, alphaSeq);
    expect(alphaDoc.id).toBe("alpha");
    expect(alphaDoc.newNote).toContain(B_ALPHA_LINE); // the dropped side, whole
    expect(alphaDoc.oldNote).toContain(A_ALPHA_LINE); // the side that stayed live

    const betaDoc = await reviewShow(p.b, betaSeq);
    expect(betaDoc.id).toBe("beta");
    expect(betaDoc.newNote).toContain(A_BETA_LINE);
    expect(betaDoc.oldNote).toContain(B_BETA_LINE);
  }, 60_000);

  it("the log carries both machines' approve entries AND the new merge line", async () => {
    const alphaLog = await logSummaries(p.b, "alpha");
    // Union-merged: both original auto-entries survived.
    expect(alphaLog.filter((s) => s.startsWith("Note updated via proposal"))).toHaveLength(2);
    expect(alphaLog.some((s) => s.includes("by machine-a"))).toBe(true);
    expect(alphaLog.some((s) => s.includes("by machine-b"))).toBe(true);
    expect(alphaLog).toContain("baseline alpha decision");
    // …and the resolution wrote its own record, naming the filed proposal.
    const merge = alphaLog.find((s) => s.toLowerCase().includes("cross-machine merge"));
    expect(merge).toBeDefined();
    expect(merge).toContain(`#${String(alphaSeq)}`);

    const betaLog = await logSummaries(p.b, "beta");
    expect(betaLog.filter((s) => s.startsWith("Note updated via proposal"))).toHaveLength(2);
    expect(betaLog.some((s) => s.toLowerCase().includes("cross-machine merge"))).toBe(true);
  }, 60_000);

  it("SEARCH finds the loser by its own words — a silent loser is a failed gate", async () => {
    // `search` reads notes and log entries. It does NOT read `proposals/`
    // (plan R2), so this can only pass if the convention line really carries an
    // excerpt of the losing body. "quokka" exists on machine B's alpha edit and
    // nowhere else; that body is no longer in any note.
    expect(await liveBody(p.b, "alpha")).not.toContain("quokka");
    const quokka = await search(p.b, "quokka");
    expect(quokka.hits.map((h) => h.id)).toContain("alpha");

    expect(await liveBody(p.b, "beta")).not.toContain("kingfisher");
    const kingfisher = await search(p.b, "kingfisher");
    expect(kingfisher.hits.map((h) => h.id)).toContain("beta");
  }, 60_000);

  it("pushing the merge and pulling it back gives the other machine the same store", async () => {
    // The protocol's last two legs. Resolution writes a LOCAL merge commit;
    // machine A sees nothing at all until this push happens.
    git(p, p.b, "push", "-q", "origin", "main");
    const back = rawPull(p, p.a);
    expect(back.ok).toBe(true);
    await reindexStore(p.a);

    expect(filesWithMarkers(p.a)).toEqual([]);
    expect(await liveBody(p.a, "alpha")).toContain(A_ALPHA_LINE);
    expect(await liveBody(p.a, "beta")).toContain(B_BETA_LINE);
    // Machine A's OWN dropped beta paragraph is recoverable on machine A too.
    const pendingOnA = (await reviewList(p.a)).filter((x) => x.status === "pending");
    expect(pendingOnA.map((x) => x.seq)).toEqual(expect.arrayContaining([alphaSeq, betaSeq]));
    expect((await reviewShow(p.a, betaSeq)).newNote).toContain(A_BETA_LINE);
    expect((await search(p.a, "quokka")).hits.map((h) => h.id)).toContain("alpha");
  }, 60_000);

  it("the log's timestamps stay unique, and `doctor` finds nothing to fail on", async () => {
    // SPEC §4: timestamps are strictly increasing per store, and `--supersedes`
    // resolves its target BY timestamp — two entries sharing an instant makes
    // that command ambiguous forever.
    for (const id of ["alpha", "beta"]) {
      const stamps = parseLog((await readText(topicLogPath(p.b, id)))!, id).entries.map(
        (e) => e.timestamp,
      );
      expect(new Set(stamps).size).toBe(stamps.length);
    }
    const report = runDoctor({ home: p.b, env: p.env, userHome: p.root });
    const codes = report.findings.map((f) => f.code);
    expect(codes).not.toContain("store_conflict_markers");
    expect(codes).not.toContain("use_fimemory_pull");
    expect(codes).not.toContain("conflicts_pending");
  }, 60_000);

  it("the minted proposal is committed, so the other machine sees the filed side too", () => {
    // A product decision worth stating out loud rather than discovering: the
    // proposal travels in the merge commit, so machine A will meet a pending
    // suggestion it never created. That is the point — the side that lost is
    // recoverable from EITHER machine — but it is a decision, not an accident.
    const tracked = git(p, p.b, "ls-files", "proposals/").split("\n").filter(Boolean);
    expect(tracked.some((f) => f.endsWith(`-${String(alphaSeq)}-alpha.md`))).toBe(true);
    expect(tracked.some((f) => f.endsWith(`-${String(betaSeq)}-beta.md`))).toBe(true);
  });

  it("`review approve` of the minted proposal succeeds first try and swaps the body back", async () => {
    // This is where a hash taken over pre-`serializeNote` bytes would surface as
    // E_STALE, and it would read to a user as "the merge broke my note".
    await reviewApprove(p.b, alphaSeq);
    const alpha = await liveBody(p.b, "alpha");
    expect(alpha).toContain(B_ALPHA_LINE);
    expect(alpha).not.toContain(A_ALPHA_LINE);
    expect(filesWithMarkers(p.b)).toEqual([]);
  }, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// The rest of the resolver's surface, all on plaintext stores (no DEK).
// ═════════════════════════════════════════════════════════════════════════════

describe("whole-file conflicts, log unions and the refusals", () => {
  beforeAll(() => {
    clearActiveKey();
    expect(keyState().mode).toBe("plaintext");
  });

  it("T5 — a dual edit of config.json keeps ours live and parks theirs under conflicts/", async () => {
    const p = await buildPair("wd-config", false);
    const cfgPath = (home: string): string => fsPath(storePaths(home).config);
    const bump = (home: string, hits: number): void => {
      const cfg = JSON.parse(readFileSync(cfgPath(home), "utf8")) as Record<string, unknown>;
      cfg["maxSearchHits"] = hits;
      writeFileSync(cfgPath(home), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    };
    // The SAME key on both sides, so git cannot line-merge it away.
    bump(p.a, 111);
    commitAll(p, p.a, "machine-a: config");
    git(p, p.a, "push", "-q", "origin", "main");
    bump(p.b, 222);
    commitAll(p, p.b, "machine-b: config");

    expect(rawPull(p, p.b).ok).toBe(false);
    expect(conflicted(p.b, p.env)).toContain("config.json");

    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");

    // Ours live, whole and parseable — never a unioned JSON that parses and lies.
    const live = JSON.parse(readFileSync(cfgPath(p.b), "utf8")) as Record<string, unknown>;
    expect(live["maxSearchHits"]).toBe(222);
    expect(filesWithMarkers(p.b)).toEqual([]);

    // Theirs is parked, not dropped.
    expect(res.parked).toHaveLength(1);
    const parked = res.parked[0]!.parked;
    expect(parked.startsWith("conflicts/config.json.")).toBe(true);
    const parkedJson = JSON.parse(readFileSync(fsPath(path.join(p.b, parked)), "utf8")) as Record<string, unknown>;
    expect(parkedJson["maxSearchHits"]).toBe(111);
    expect(conflicted(p.b, p.env)).toEqual([]);
    // …and it travels: the sidecar is committed, so machine A can see it too.
    expect(git(p, p.b, "ls-files", "--", parked).trim()).toBe(parked);

    // Parked is a QUEUE, not a resolution: nothing reads conflicts/, so doctor
    // has to say so or the other machine's config edit is invisible forever.
    const report = runDoctor({ home: p.b, env: p.env, userHome: p.root });
    const parkedFinding = report.findings.find((f) => f.code === "conflicts_pending");
    expect(parkedFinding?.level).toBe("warn");
    expect(report.findings.map((f) => f.code)).not.toContain("store_conflict_markers");
  }, 90_000);

  it("T9-adjacent — a log conflict on a store MISSING the union lines still unions, in order", async () => {
    const p = await buildPair("wd-nounion", false);
    // Strip the two merge=union lines, exactly the shape of a store that
    // reached this build before `init`/`pull` learned to write them.
    const attrs = path.join(p.a, ".gitattributes");
    writeFileSync(
      fsPath(attrs),
      readFileSync(fsPath(attrs), "utf8")
        .split("\n")
        .filter((l) => !l.includes("merge=union"))
        .join("\n"),
      "utf8",
    );
    commitAll(p, p.a, "machine-a: drop the union drivers");
    git(p, p.a, "push", "-q", "origin", "main");
    expect(rawPull(p, p.b).ok).toBe(true);

    await appendLog(
      p.a,
      "alpha",
      { type: "gotcha", project: "demo", agent: "machine-a", summary: "the kingfisher landed on A" },
      { now: clockAt(T0 + 10_000) },
    );
    commitAll(p, p.a, "machine-a: log");
    git(p, p.a, "push", "-q", "origin", "main");
    await appendLog(
      p.b,
      "alpha",
      { type: "gotcha", project: "demo", agent: "machine-b", summary: "the quokka landed on B" },
      { now: clockAt(T0 + 20_000) },
    );
    commitAll(p, p.b, "machine-b: log");

    const pulled = rawPull(p, p.b);
    expect(pulled.ok).toBe(false);
    expect(conflicted(p.b, p.env)).toContain("logs/alpha.log.md");

    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    expect(res.logs).toContain("logs/alpha.log.md");
    expect(filesWithMarkers(p.b)).toEqual([]);

    const text = (await readText(topicLogPath(p.b, "alpha")))!;
    const entries = parseLog(text, "alpha").entries;
    const summaries = entries.map((e) => e.summary);
    expect(summaries).toContain("the kingfisher landed on A");
    expect(summaries).toContain("the quokka landed on B");
    // Sorted, so both clones converge instead of conflicting again next pull.
    const stamps = entries.map((e) => e.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
    expect(conflicted(p.b, p.env)).toEqual([]);
  }, 90_000);

  it("a note AND its own log conflicting in the same pull never launders a marker into the log", async () => {
    // Phase 4 appends the merge record with `appendLog`, which READS the log off
    // disk. If that append ran while the log was still a marker sandwich,
    // `parseLog` would fold the `<<<<<<<` lines into the preceding entry's body
    // and re-serialize them as though a human had typed them — a marker
    // laundered into settled memory, which is exactly what doctor fails on.
    //
    // Be honest about what this case does and does not guard. It proves the
    // OUTCOME: no marker reaches the log. It does NOT pin the order of the two
    // write loops inside phase 3 — a mutation test showed swapping them changes
    // nothing, because phase 4 runs only after all of phase 3 completes. The
    // comment here used to claim otherwise, which would have let a future reader
    // believe this test was protecting an ordering it cannot see.
    const p = await buildPair("wd-note-and-log", false);
    const attrs = path.join(p.a, ".gitattributes");
    writeFileSync(
      fsPath(attrs),
      readFileSync(fsPath(attrs), "utf8")
        .split("\n")
        .filter((l) => !l.includes("merge=union"))
        .join("\n"),
      "utf8",
    );
    commitAll(p, p.a, "machine-a: drop the union drivers");
    git(p, p.a, "push", "-q", "origin", "main");
    expect(rawPull(p, p.b).ok).toBe(true);

    const bump = async (home: string, line: string, updatedMs: number, summary: string): Promise<void> => {
      await appendLog(
        home,
        "alpha",
        { type: "gotcha", project: "demo", agent: "m", summary },
        { now: clockAt(updatedMs) },
      );
      const note = parseNote((await readText(topicNotePath(home, "alpha")))!, "alpha")!;
      await writeFileAtomic(
        topicNotePath(home, "alpha"),
        serializeNote({ ...note, updated: new Date(updatedMs).toISOString(), body: editBody(note.body, line) }),
      );
    };
    await bump(p.a, "note side A", T0 + 60_000, "log line from A");
    commitAll(p, p.a, "machine-a: note and log");
    git(p, p.a, "push", "-q", "origin", "main");
    await bump(p.b, "note side B", T0 + 50_000, "log line from B");
    commitAll(p, p.b, "machine-b: note and log");

    expect(rawPull(p, p.b).ok).toBe(false);
    expect(conflicted(p.b, p.env)).toEqual(["logs/alpha.log.md", "topics/alpha.md"]);

    await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");

    expect(filesWithMarkers(p.b)).toEqual([]);
    const parsed = parseLog((await readText(topicLogPath(p.b, "alpha")))!, "alpha");
    expect(parsed.warnings).toEqual([]);
    const summaries = parsed.entries.map((e) => e.summary);
    expect(summaries).toContain("log line from A");
    expect(summaries).toContain("log line from B");
    expect(summaries.some((s) => s.toLowerCase().includes("cross-machine merge"))).toBe(true);
    for (const e of parsed.entries) expect(e.raw).not.toContain("<<<<<<<");
    expect(await liveBody(p.b, "alpha")).toContain("note side A"); // larger `updated:`
  }, 90_000);

  it("a SECOND conflict round on the same topic still resolves — and stales the first loser", async () => {
    // Nothing in a one-shot fixture says the feature survives being used twice.
    // Round 2 mints a second proposal on a topic that already has one pending,
    // and `reviewApprove` stales every sibling on the same topic by design — so
    // approving round 2's loser makes round 1's loser permanently unapprovable.
    // The text is still on disk and still excerpted in the log, so nothing is
    // destroyed, but "one command away" stops being true for the older side.
    const p = await buildPair("wd-round2", false);
    await divergeNote(p, "alpha", "round one A", T0 + 60_000, "round one B", T0 + 50_000);
    expect(rawPull(p, p.b).ok).toBe(false);
    const r1 = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    git(p, p.b, "push", "-q", "origin", "main");
    expect(rawPull(p, p.a).ok).toBe(true);
    const r1Seq = r1.notes[0]!.proposal!.seq;

    const write = async (home: string, line: string, updatedMs: number): Promise<void> => {
      const note = parseNote((await readText(topicNotePath(home, "alpha")))!, "alpha")!;
      await writeFileAtomic(
        topicNotePath(home, "alpha"),
        serializeNote({ ...note, updated: new Date(updatedMs).toISOString(), body: editBody(note.body, line) }),
      );
    };
    await write(p.a, "round two A", T0 + 150_000);
    commitAll(p, p.a, "machine-a: round two");
    git(p, p.a, "push", "-q", "origin", "main");
    await write(p.b, "round two B", T0 + 160_000);
    commitAll(p, p.b, "machine-b: round two");

    expect(rawPull(p, p.b).ok).toBe(false);
    const r2 = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT + 60_000) });
    git(p, p.b, "commit", "-q", "--no-edit");
    const r2Seq = r2.notes[0]!.proposal!.seq;
    expect(r2Seq).not.toBe(r1Seq);
    expect(filesWithMarkers(p.b)).toEqual([]);
    expect(await liveBody(p.b, "alpha")).toContain("round two B");

    // Both losers are still filed and readable…
    const pending = (await reviewList(p.b)).filter((x) => x.status === "pending" && x.id === "alpha");
    expect(pending.map((x) => x.seq).sort((x, y) => x! - y!)).toEqual([r1Seq, r2Seq]);
    expect((await reviewShow(p.b, r1Seq)).newNote).toContain("round one B");
    expect((await reviewShow(p.b, r2Seq)).newNote).toContain("round two A");

    // …until one is approved, which stales the other. That is `review`'s own
    // rule, not the resolver's, but it is what a user meets.
    await reviewApprove(p.b, r2Seq);
    expect(await liveBody(p.b, "alpha")).toContain("round two A");
    expect((await reviewShow(p.b, r1Seq)).status).toBe("stale");
    await expectGestaltErrorAsync(() => reviewApprove(p.b, r1Seq), "E_STALE_PROPOSAL");
  }, 120_000);

  it("over `maxPendingProposals` it ABORTS with nothing written — it never drops a side", async () => {
    const p = await buildPair("wd-cap", false);
    // Divergent notes written straight to disk: this fixture is about the cap,
    // not the proposal flow, and `update` enforces the same cap on the way in.
    await divergeNote(p, "alpha", "cap side A", T0 + 50_000, "cap side B", T0 + 60_000);

    const cfgPath = fsPath(storePaths(p.b).config);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg["maxPendingProposals"] = 1; // the seeded worked example is already pending
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    commitAll(p, p.b, "machine-b: tighten the pending cap");

    expect(rawPull(p, p.b).ok).toBe(false);
    const before = hashTree(p.b);

    const err = await expectGestaltErrorAsync(
      () => resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) }),
      "E_PROPOSAL_CAP",
    );
    expect(err.message.toUpperCase()).toContain("NOTHING WAS WRITTEN");
    // Proved, not asserted: every byte in the store is where it was.
    expect(hashTree(p.b)).toEqual(before);
    // And the merge is still intact, so `pull --abort` is still a way out.
    expect(inProgress(p.b, p.env)).toBe("merge");
    expect(conflicted(p.b, p.env)).toContain("topics/alpha.md");
  }, 90_000);

  it("a tie on `updated:` keeps ours and still files theirs", async () => {
    const p = await buildPair("wd-tie", false);
    const same = T0 + 70_000;
    await divergeNote(p, "alpha", "tie side A", same, "tie side B", same);
    expect(rawPull(p, p.b).ok).toBe(false);

    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    const note = res.notes[0]!;
    expect(note.tie).toBe(true);
    expect(note.winner).toBe("ours");
    expect(await liveBody(p.b, "alpha")).toContain("tie side B");
    expect((await reviewShow(p.b, note.proposal!.seq)).newNote).toContain("tie side A");
    expect(filesWithMarkers(p.b)).toEqual([]);
  }, 90_000);

  it("the loser's excerpt is BOUNDED, so a phrase deep in a long note is unfindable", async () => {
    // Not a bug report — a boundary. `entryTokenCap` is 350 (1400 chars) and
    // `noteTokenCap` is 1000 (4000 chars), so the searchable trace of a dropped
    // side is at most about a third of a full-size note. This test pins WHERE
    // the promise "search finds the loser" stops holding, so nobody discovers it
    // from a user saying their paragraph vanished.
    const p = await buildPair("wd-excerpt", false);
    const filler = "The pipeline runs nightly and reports to the dashboard. ".repeat(40);
    await divergeNote(
      p,
      "alpha",
      `${filler}\nThe capybara clause is buried at the very end.`,
      T0 + 50_000,
      "machine B keeps this one",
      T0 + 60_000,
    );
    expect(rawPull(p, p.b).ok).toBe(false);
    await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    await reindexStore(p.b);

    // The head of the loser IS searchable…
    expect((await search(p.b, "nightly")).hits.map((h) => h.id)).toContain("alpha");
    // …the tail is not, and the proposal that holds it is invisible to search.
    const excerpted = await logRawText(p.b, "alpha");
    const capybaraFound = (await search(p.b, "capybara")).hits.map((h) => h.id);
    expect(excerpted).not.toContain("capybara");
    expect(capybaraFound).not.toContain("alpha");
  }, 90_000);

  it("R4 — when the sides disagree inside `## Owner notes`, approve needs the override and says so", async () => {
    const p = await buildPair("wd-owner", false);
    const write = async (home: string, line: string, updatedMs: number): Promise<void> => {
      const note = parseNote((await readText(topicNotePath(home, "alpha")))!, "alpha")!;
      await writeFileAtomic(
        topicNotePath(home, "alpha"),
        serializeNote({
          ...note,
          updated: new Date(updatedMs).toISOString(),
          body: note.body.replace("## Owner notes", `## Owner notes\n${line}`),
        }),
      );
    };
    await write(p.a, "Owner note from machine A.", T0 + 60_000);
    commitAll(p, p.a, "machine-a: owner notes");
    git(p, p.a, "push", "-q", "origin", "main");
    await write(p.b, "Owner note from machine B.", T0 + 50_000);
    commitAll(p, p.b, "machine-b: owner notes");
    expect(rawPull(p, p.b).ok).toBe(false);

    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    const minted = res.notes[0]!.proposal!;
    expect(minted.ownerNotesDiffer).toBe(true);
    expect(minted.approveCommand).toContain("--allow-owner-notes");
    // The YAML bit is ADVISORY (plan R4): `reviewApprove` gates on its OPTION.
    // If the resolver only set the bit, the user would meet a proposal that
    // refuses to approve and reads as a failed merge — so it must ALSO be in an
    // advisory the caller is obliged to print.
    expect(res.advisories.join("\n")).toContain("--allow-owner-notes");
    await expectGestaltErrorAsync(() => reviewApprove(p.b, minted.seq), "E_OWNER_NOTES");
    await reviewApprove(p.b, minted.seq, { allowOwnerNotes: true });
    expect(await liveBody(p.b, "alpha")).toContain("Owner note from machine B.");
  }, 90_000);

  it("a delete/modify conflict on a note REFUSES rather than inventing a policy", async () => {
    const p = await buildPair("wd-deletemod", false);
    git(p, p.a, "rm", "-q", "--", "topics/alpha.md");
    git(p, p.a, "commit", "-q", "-m", "machine-a: delete alpha");
    git(p, p.a, "push", "-q", "origin", "main");
    const note = parseNote((await readText(topicNotePath(p.b, "alpha")))!, "alpha")!;
    await writeFileAtomic(
      topicNotePath(p.b, "alpha"),
      serializeNote({ ...note, updated: new Date(T0 + 50_000).toISOString(), body: editBody(note.body, "B kept editing it") }),
    );
    commitAll(p, p.b, "machine-b: edit alpha");
    expect(rawPull(p, p.b).ok).toBe(false);

    const before = hashTree(p.b);
    const err = await expectGestaltErrorAsync(
      () => resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) }),
      "E_SCHEMA",
    );
    // A deletion has no `updated:`, so the winner rule has nothing to compare —
    // either choice would silently un-delete or silently delete somebody's note.
    expect(err.message).toContain("DELETED");
    expect(err.message).toContain("Nothing was written");
    expect(hashTree(p.b)).toEqual(before);
    expect(inProgress(p.b, p.env)).toBe("merge");
  }, 90_000);

  it("a side that is ALREADY a half-merged file refuses, rather than electing a Frankenstein body", async () => {
    const p = await buildPair("wd-committed-markers", false);
    // Somebody ran a raw `git merge` earlier and committed the markers.
    // `parseNote` accepts that happily — the frontmatter is intact — so without
    // an explicit check the resolver would pick that body and bake it in as
    // settled memory.
    const damaged = parseNote((await readText(topicNotePath(p.a, "alpha")))!, "alpha")!;
    writeFileSync(
      fsPath(topicNotePath(p.a, "alpha")),
      serializeNote({
        ...damaged,
        updated: new Date(T0 + 60_000).toISOString(),
        body: editBody(damaged.body, "<<<<<<< HEAD\nside one\n=======\nside two\n>>>>>>> origin/main"),
      }),
      "utf8",
    );
    commitAll(p, p.a, "machine-a: commit a half-merged note");
    git(p, p.a, "push", "-q", "origin", "main");
    const clean = parseNote((await readText(topicNotePath(p.b, "alpha")))!, "alpha")!;
    await writeFileAtomic(
      topicNotePath(p.b, "alpha"),
      serializeNote({ ...clean, updated: new Date(T0 + 50_000).toISOString(), body: editBody(clean.body, "B's honest edit") }),
    );
    commitAll(p, p.b, "machine-b: honest edit");
    expect(rawPull(p, p.b).ok).toBe(false);

    const before = hashTree(p.b);
    const err = await expectGestaltErrorAsync(
      () => resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) }),
      "E_SCHEMA",
    );
    expect(err.message).toContain("COMMITTED git conflict markers");
    expect(hashTree(p.b)).toEqual(before);
    expect(inProgress(p.b, p.env)).toBe("merge");
  }, 90_000);

  it("an `entryTokenCap` too small to hold the merge record refuses BEFORE writing anything", async () => {
    // Otherwise `appendLog` throws in the middle: winner on disk, proposal
    // minted, nothing staged, and no record anywhere of why.
    const p = await buildPair("wd-tokencap", false);
    const cfgPath = fsPath(storePaths(p.b).config);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg["entryTokenCap"] = 10;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    commitAll(p, p.b, "machine-b: tiny entry cap");
    await divergeNote(p, "alpha", "cap side A", T0 + 60_000, "cap side B", T0 + 50_000);
    expect(rawPull(p, p.b).ok).toBe(false);

    const before = hashTree(p.b);
    const err = await expectGestaltErrorAsync(
      () => resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) }),
      "E_TOKEN_CAP",
    );
    expect(err.message).toContain("Nothing was written");
    expect(hashTree(p.b)).toEqual(before);
    expect(inProgress(p.b, p.env)).toBe("merge");
  }, 90_000);
});

/**
 * Give one topic two divergent committed versions, one per clone, with chosen
 * `updated:` values — the proposal flow bypassed so a fixture can aim the winner
 * rule (and the tie) precisely.
 */
async function divergeNote(
  p: Pair,
  id: string,
  aLine: string,
  aUpdated: number,
  bLine: string,
  bUpdated: number,
): Promise<void> {
  const write = async (home: string, line: string, updatedMs: number): Promise<void> => {
    const note = parseNote((await readText(topicNotePath(home, id)))!, id)!;
    await writeFileAtomic(
      topicNotePath(home, id),
      serializeNote({
        ...note,
        updated: new Date(updatedMs).toISOString(),
        body: editBody(note.body, line),
      }),
    );
  };
  await write(p.a, aLine, aUpdated);
  commitAll(p, p.a, `machine-a: ${id}`);
  git(p, p.a, "push", "-q", "origin", "main");
  await write(p.b, bLine, bUpdated);
  commitAll(p, p.b, `machine-b: ${id}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// The pull contract itself — the gate says "the pull exits 0".
// ═════════════════════════════════════════════════════════════════════════════

describe("`fimemory pull` over a same-note conflict", () => {
  beforeAll(() => {
    clearActiveKey();
    expect(keyState().mode).toBe("plaintext");
  });

  it("resolves the conflict, leaves no marker, and exits 0", async () => {
    // Plan §1: "Not wedged. No `<<<<<<<` anywhere. One body live; the other a
    // pending proposal." — and §4 W-C: "…→ `git pull --no-rebase --no-edit` →
    // resolve → reindex → print `git push`". This is the whole gate as a USER
    // meets it, through the one command they are told to run. Nothing else in
    // this file goes through `pull`; every other test calls the resolver by
    // hand, which is a thing no user can do.
    const p = await buildPair("wd-pullop", false);
    await divergeNote(p, "alpha", "pull side A", T0 + 60_000, "pull side B", T0 + 50_000);

    let refusal: string | null = null;
    try {
      await pullStore({ home: p.b, env: p.env });
    } catch (err) {
      refusal = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }

    // One assertion, so the failure diff shows the whole state of the store the
    // user is left holding rather than stopping at the first bad field.
    expect({
      refusal,
      markers: filesWithMarkers(p.b),
      midOperation: inProgress(p.b, p.env),
      unmerged: conflicted(p.b, p.env),
    }).toEqual({ refusal: null, markers: [], midOperation: null, unmerged: [] });

    expect(await liveBody(p.b, "alpha")).toContain("pull side A");
    const pending = (await reviewList(p.b)).filter((x) => x.status === "pending" && x.id === "alpha");
    expect(pending).toHaveLength(1);
    expect((await reviewShow(p.b, pending[0]!.seq!)).newNote).toContain("pull side B");
  }, 90_000);

  it("and prints `git push` — resolution writes a LOCAL commit nobody else can see", async () => {
    const p = await buildPair("wd-pullpush", false);
    await divergeNote(p, "alpha", "push side A", T0 + 60_000, "push side B", T0 + 50_000);
    const res = await pullStore({ home: p.b, env: p.env }).catch(() => null);
    expect(res).not.toBeNull();
    expect(res!.needsPush).toBe(true);
    expect(res!.steps.join("\n")).toContain("push");
  }, 90_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// T4 — THE SAME GATE ON AN ENCRYPTED STORE. Runs last: it activates a
// process-global DEK, and every block above must have run without one.
// ═════════════════════════════════════════════════════════════════════════════

describe("T4 — encrypted dual-approve, same protocol, same gate", () => {
  let p: Pair;
  let alphaSeq = 0;
  let betaSeq = 0;

  beforeAll(async () => {
    p = await buildPair("wd-enc", true);
    expect(keyState().mode).toBe("encrypted");
    await dualApprove(p);
  }, 120_000);

  afterAll(() => {
    clearActiveKey();
  });

  it("the store really is sealed at rest before the merge", () => {
    expect(readFileSync(fsPath(topicNotePath(p.b, "alpha")), "utf8")).toMatch(
      new RegExp(`^${ENC_MAGIC}`),
    );
  });

  it("resolves two sealed same-note conflicts and finishes the merge", async () => {
    const pulled = rawPull(p, p.b);
    expect(pulled.ok).toBe(false);
    expect(conflicted(p.b, p.env)).toEqual(["topics/alpha.md", "topics/beta.md"]);
    // The worktree copy is now marker lines wrapped around two ciphertext blobs.
    // Nothing can read that; the resolver has to go to the index stages.
    await expect(readText(topicNotePath(p.b, "alpha"))).rejects.toThrow(
      /E_STORE_MODE|decrypt|plaintext|encrypted/i,
    );

    const res = await resolveConflicts(p.b, { env: p.env, now: clockAt(RESOLVE_AT) });
    git(p, p.b, "commit", "-q", "--no-edit");
    expect(conflicted(p.b, p.env)).toEqual([]);
    expect(inProgress(p.b, p.env)).toBe(null);
    expect(git(p, p.b, "status", "--porcelain").trim()).toBe("");
    alphaSeq = res.notes.find((n) => n.id === "alpha")!.proposal!.seq;
    betaSeq = res.notes.find((n) => n.id === "beta")!.proposal!.seq;
    await reindexStore(p.b);
  }, 90_000);

  it("no conflict markers, and the resolved files are still ciphertext at rest", () => {
    expect(filesWithMarkers(p.b)).toEqual([]);
    for (const rel of ["topics/alpha.md", "topics/beta.md"]) {
      expect(readFileSync(fsPath(path.join(p.b, rel)), "utf8")).toMatch(new RegExp(`^${ENC_MAGIC}`));
    }
    for (const f of readdirSync(fsPath(storePaths(p.b).proposalsDir))) {
      expect(readFileSync(fsPath(path.join(p.b, "proposals", f)), "utf8")).toMatch(
        new RegExp(`^${ENC_MAGIC}`),
      );
    }
    // No plaintext body anywhere on disk, including the minted proposals.
    for (const rel of storeFiles(p.b)) {
      if (rel === "index.json" || rel.startsWith("conflicts/")) continue;
      const text = readFileSync(fsPath(path.join(p.b, rel)), "utf8");
      expect(text).not.toContain(A_ALPHA_LINE);
      expect(text).not.toContain(B_ALPHA_LINE);
    }
  });

  it("one body live per note, the other filed, and approve succeeds first try", async () => {
    expect(await liveBody(p.b, "alpha")).toContain(A_ALPHA_LINE);
    expect(await liveBody(p.b, "beta")).toContain(B_BETA_LINE);
    expect((await reviewShow(p.b, alphaSeq)).newNote).toContain(B_ALPHA_LINE);
    expect((await reviewShow(p.b, betaSeq)).newNote).toContain(A_BETA_LINE);

    await reviewApprove(p.b, alphaSeq);
    expect(await liveBody(p.b, "alpha")).toContain(B_ALPHA_LINE);
    expect(readFileSync(fsPath(topicNotePath(p.b, "alpha")), "utf8")).toMatch(
      new RegExp(`^${ENC_MAGIC}`),
    );
  }, 60_000);

  it("both approve entries, the merge line, and SEARCH still finds the loser", async () => {
    const betaLog = await logSummaries(p.b, "beta");
    expect(betaLog.filter((s) => s.startsWith("Note updated via proposal"))).toHaveLength(2);
    expect(betaLog.some((s) => s.toLowerCase().includes("cross-machine merge"))).toBe(true);
    // beta's loser is machine A's "kingfisher" paragraph, and it is not in any
    // note — the only trace search can reach is the sealed log entry's excerpt.
    expect(await liveBody(p.b, "beta")).not.toContain("kingfisher");
    expect((await search(p.b, "kingfisher")).hits.map((h) => h.id)).toContain("beta");
  }, 60_000);

  it("the merge travels: push it, pull it back, machine A is intact and sealed", async () => {
    git(p, p.b, "push", "-q", "origin", "main");
    expect(rawPull(p, p.a).ok).toBe(true);
    await reindexStore(p.a);
    expect(filesWithMarkers(p.a)).toEqual([]);
    expect(await liveBody(p.a, "beta")).toContain(B_BETA_LINE);
    expect((await reviewShow(p.a, betaSeq)).newNote).toContain(A_BETA_LINE);
    expect(readFileSync(fsPath(topicNotePath(p.a, "beta")), "utf8")).toMatch(
      new RegExp(`^${ENC_MAGIC}`),
    );
  }, 60_000);

  it("a whole-file SEALED conflict (state/*.json) is not double-sealed, and both sides survive", async () => {
    // `state/**` is file kind "other", which IS whole-file sealed — this is
    // where the resolver deliberately inverts its own rule and restores git's
    // index bytes VERBATIM (`writeFileAtomicPlain`). If it used
    // `writeFileAtomic` the bytes would be sealed a second time and the reader
    // would "decrypt" the file to an inner `gestalt-enc:1:` string, not JSON.
    // Nothing else in this suite covers that inversion.
    //
    // This fixture is a SECOND encrypted store, and `buildPair` activates its
    // DEK — which is process-global. Everything below therefore runs under q's
    // key, and `p`'s key is restored in the `finally` or the tests after this
    // one would silently read the T4 store with the wrong key. (That is not a
    // hypothetical: it cost this file one red run.)
    const q = await buildPair("wd-enc-state", true);
    try {
      await sealedStateConflict(q);
    } finally {
      activateDek(unlockWithPassphrase(p.a, PASS));
    }
  }, 120_000);

  it("`export --plaintext` has no markers and no raw ciphertext", async () => {
    const dest = path.join(p.root, "export");
    const out = await exportPlaintext(p.b, dest);
    expect(out.failed).toBe(0);
    expect(out.notes).toBeGreaterThan(0);

    const files = storeFiles(dest);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const text = readFileSync(fsPath(path.join(dest, rel)), "utf8");
      expect(text).not.toContain(ENC_MAGIC);
      expect(/^(<{7}( |$)|={7}$|\|{7}( |$)|>{7}( |$))/m.test(text)).toBe(false);
    }
    // Readable, as promised: the escape hatch shows both sides of the merge.
    const exportedLog = readFileSync(fsPath(path.join(dest, "logs", "beta.log.md")), "utf8");
    expect(exportedLog).toContain("Cross-machine merge");
    expect(exportedLog).toContain("kingfisher");
    expect(existsSync(fsPath(path.join(dest, "topics", "beta.md")))).toBe(true);
  }, 90_000);

  /**
   * Plan section-1 row 5: "store encrypted and LOCKED -> pull refuses BEFORE
   * git, nothing rewritten."
   *
   * This row was claimed by the gate and asserted by nobody, which the verifier
   * caught. The structural argument is that `ensureStoreUnlocked` is the first
   * thing pullStore does — but "it is first in the source" is not evidence, and
   * the whole reason this row exists is that a resolver running without a DEK on
   * a sealed store either writes plaintext into ciphertext or dies mid-merge with
   * markers already on disk. So prove the refusal, and prove git was untouched:
   * same HEAD, clean worktree, no merge in progress.
   */
  it("row 5: a LOCKED encrypted store refuses before git, and nothing is rewritten", async () => {
    // Diverge both sides so there is genuinely something to pull — a refusal on
    // an already-up-to-date store would prove nothing.
    await divergeNote(p, "alpha", "locked-side-A", T0 + 400_000, "locked-side-B", T0 + 401_000);

    const headBefore = git(p, p.b, "rev-parse", "HEAD").trim();
    const statusBefore = git(p, p.b, "status", "--porcelain");

    // Lock it: drop the in-process DEK, exactly as a fresh shell would start.
    clearActiveKey();
    expect(keyState().mode).not.toBe("encrypted");

    // E_STORE_MODE: the store is sealed and this process holds no key. The code
    // matters as much as the refusal — it is what tells the user their store is
    // fine and their SESSION is locked, rather than implying the data is wrong.
    const err = await expectGestaltErrorAsync(
      () => pullStore({ home: p.b, env: p.env }),
      "E_STORE_MODE",
    );
    expect(err.hint ?? "").not.toBe("");

    expect(git(p, p.b, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(p, p.b, "status", "--porcelain")).toBe(statusBefore);
    expect(inProgress(p.b, p.env)).toBeNull();
    expect(conflicted(p.b, p.env)).toEqual([]);

    // And it is a refusal, not damage: unlocking lets the same pull proceed.
    //
    // Unlock from A, not from B. `keyring.json` is gitignored, so a CLONE never
    // receives one — B can hold a live DEK (copied keyring, GESTALT_KEY, warm
    // session cache) but it cannot derive one from a passphrase, and asking it
    // to throws E_STORE_MODE "keyring.json is missing". That absence is not a
    // quirk of this fixture; it is the same fact that let a keyring-less clone
    // accept plaintext writes into a sealed store earlier tonight.
    activateDek(unlockWithPassphrase(p.a, PASS));
    const after = await pullStore({ home: p.b, env: p.env });
    expect(after.unresolved).toEqual([]);
  }, 90_000);
});

/**
 * A whole-file SEALED conflict, driven on its own encrypted pair. Split out of
 * the test body only so the DEK swap it forces is contained by one `finally`.
 */
async function sealedStateConflict(q: Pair): Promise<void> {
  const statePath = (home: string): string => path.join(home, "state", "box.json");
  {
    const put = async (home: string, who: string): Promise<void> => {
      mkdirSync(fsPath(path.join(home, "state")), { recursive: true });
      await writeFileAtomic(statePath(home), JSON.stringify({ machine: who }) + "\n");
    };
    await put(q.a, "seed");
    commitAll(q, q.a, "machine-a: seed state");
    git(q, q.a, "push", "-q", "origin", "main");
    expect(rawPull(q, q.b).ok).toBe(true);

    await put(q.a, "alpha-machine");
    const theirBytes = readFileSync(fsPath(statePath(q.a)), "utf8");
    commitAll(q, q.a, "machine-a: state");
    git(q, q.a, "push", "-q", "origin", "main");
    await put(q.b, "bravo-machine");
    commitAll(q, q.b, "machine-b: state");
    expect(rawPull(q, q.b).ok).toBe(false);
    expect(conflicted(q.b, q.env)).toContain("state/box.json");

    const res = await resolveConflicts(q.b, { env: q.env, now: clockAt(RESOLVE_AT) });
    git(q, q.b, "commit", "-q", "--no-edit");
    expect(filesWithMarkers(q.b)).toEqual([]);

    // Ours live, sealed ONCE: the decrypt yields JSON, not more ciphertext.
    const liveRaw = readFileSync(fsPath(statePath(q.b)), "utf8");
    expect(liveRaw.startsWith(ENC_MAGIC)).toBe(true);
    const opened = decryptFile(statePath(q.b), liveRaw);
    expect(opened).not.toContain(ENC_MAGIC);
    expect(JSON.parse(opened)).toEqual({ machine: "bravo-machine" });

    // Theirs parked, byte-for-byte — nothing was dropped.
    const parked = res.parked.find((f) => f.path === "state/box.json")!.parked;
    const parkedAbs = path.join(q.b, parked);
    expect(readFileSync(fsPath(parkedAbs), "utf8")).toBe(theirBytes);

    // …but the parked copy is NOT readable where it sits: the AEAD associated
    // data pins the BASENAME (`gestalt/file/other/box.json`) and parking renames
    // the file to `box.json.<sha>`. Nothing in the product opens it from there.
    // Recorded, not asserted as desirable — see the report accompanying these tests.
    expect(() => decryptFile(parkedAbs, readFileSync(fsPath(parkedAbs), "utf8"))).toThrow();
    // The bytes really are intact: under the original basename it opens.
    const restored = path.join(q.root, "restore", "box.json");
    mkdirSync(fsPath(path.dirname(restored)), { recursive: true });
    writeFileSync(fsPath(restored), theirBytes, "utf8");
    expect(JSON.parse(decryptFile(restored, theirBytes))).toEqual({ machine: "alpha-machine" });
  }
}

/**
 * Proposal seqs are PER-CLONE counters, so on three machines two independent
 * resolutions mint the same N. This property moved here from
 * contention-gitsync.test.ts, where it had quietly stopped being tested: it only
 * saw a collision when two counters happened to line up in a shared fixture, and
 * once the resolver started minting proposals they stopped lining up. The
 * tripwire kept failing for the wrong reason, which reads identical to passing.
 *
 * So the collision is CONSTRUCTED. Nothing here depends on arithmetic.
 */
describe("colliding proposal seqs across machines", () => {
  it("refuse a bare lookup, and each is reachable by the machine that minted it", async () => {
    const home = freshHome("seq-collision");
    runInit({ home });
    await createTopic(home, "shared", "Shared", { now: clockAt(T0) });

    const note = readFileSync(fsPath(topicNotePath(home, "shared")), "utf8");
    const mine = await updateTopic(home, "shared", `${note.trimEnd()}\n\nfrom this machine\n`, {
      allowOwnerNotes: true,
      now: clockAt(T0 + 1_000),
    });

    // A second clone, resolving the same divergence independently, produces a
    // proposal with the SAME seq under its own machine id. Re-seal rather than
    // rename: the codec's AEAD binds `gestalt/file/<kind>/<basename>`, so a
    // sealed file moved to a new name can never be opened again.
    const dir = fsPath(storePaths(home).proposalsDir);
    const NAMED = /^([0-9a-f]+)-(\d+)-(.+)\.md$/;
    const ours = readdirSync(dir).find((f) => {
      const m = NAMED.exec(f);
      return m !== null && Number(m[2]) === mine.seq;
    })!;
    const parts = NAMED.exec(ours)!;
    const theirs = `beefcafe-${String(mine.seq)}-${parts[3]}.md`;
    await writeFileAtomic(
      path.join(storePaths(home).proposalsDir, theirs),
      readFileSync(path.join(dir, ours), "utf8"),
    );

    // A bare lookup must REFUSE and name both, never answer with whichever file
    // it read first — silently picking one is indistinguishable from being right.
    await expect(findProposal(home, mine.seq)).rejects.toMatchObject({ code: "E_AMBIGUOUS" });

    // Scoped, each is reachable — which is what the resolver's printed
    // `review approve N --machine <id>` depends on.
    for (const machineId of [parts[1]!, "beefcafe"]) {
      const found = await findProposal(home, mine.seq, machineId);
      expect(found, `seq ${mine.seq} unreachable for machine ${machineId}`).not.toBeNull();
      expect(path.basename(found!.path)).toContain(machineId);
    }

    // And the scoped approve actually applies, rather than merely resolving.
    const applied = await reviewApprove(home, mine.seq, {
      machineId: "beefcafe",
      allowOwnerNotes: true,
    });
    expect(applied.id).toBe("shared");
  }, 60_000);
});
