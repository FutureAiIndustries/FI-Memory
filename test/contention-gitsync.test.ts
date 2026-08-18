/**
 * THE TEAM SHAPE — one encrypted store on a private git remote, everyone clones
 * it (docs/squirl/TEAM-PLAYBOOK.md, 2026-07-27). This is the workflow the
 * product tells paying teams to run, and until now nothing exercised it end to
 * end: `scripts/e1-merge-harness.mjs` proved the log codec union-merges, but it
 * is a script nobody runs in CI, it drives the CLI, and it silently does the one
 * thing the playbook never tells a user to do — `reindex` after cloning.
 *
 * Everything here is local: a bare repo in the test run-root as the "remote",
 * two clones, real `git` via spawnSync, no network, no vendor CLI. The store is
 * encrypted (the documented shape), unlocked in-process.
 *
 * The tests named DEFECT are EXPECTED TO FAIL. They are not flaky and not
 * mis-written: each asserts a property the product promises, and each fails on
 * the documented workflow. They are marked `it.fails`, so the suite is green
 * while the bug is open and turns RED the day the behaviour is fixed and the
 * assertion starts passing ("Expect test to fail") — a tripwire, not a mute.
 * When that happens, drop the `.fails` and the DEFECT prefix in the same edit.
 * Catalogued in docs/DEFECT-REGISTRY.md (2026-07-30).
 *
 * OPEN:
 *   2. "a union-merged log is still in timestamp order"
 *      — union merge concatenates OURS-then-THEIRS, nothing re-sorts, and
 *        `get --log-tail` slices by POSITION, so the tail shown to an AI omits
 *        the newest entry from the first merge onward.
 *   3. "every pending proposal stays reachable by its seq"
 *      — proposal seq is `max(existing) + 1` computed per clone, so two machines
 *        mint the same seq; after a merge, `review approve N` can only ever
 *        reach one of them and the other is permanently unreviewable.
 *
 * CLOSED 2026-08-01 by the index self-heal in `loadIndexOrEmpty`
 * (src/store/index.ts), which rebuilds the derived index when it is missing or
 * older than the newest note/log. The tripwires below fired and are now plain
 * passing tests:
 *   1. "a teammate who clones the store can find what the team knows"
 *      — index.json is (correctly) gitignored as derived state, and nothing in
 *        clone → unlock → doctor → ask-your-AI used to rebuild it, so a fresh
 *        clone was blind to every topic until someone ran `fimemory reindex`.
 *        Now the first read rebuilds it, and `doctor` FAILS on a blind index
 *        instead of reporting "Healthy."
 *   4. "after a plain pull, the next entry still gets a strictly-increasing
 *      timestamp" — the monotonic watermark lives in the gitignored index, so a
 *        fast-forward pull left it behind the log's own contents and the next
 *        append could duplicate an existing entry's timestamp (SPEC §4 says they
 *        are strictly increasing per store; `supersedes` targets by timestamp).
 *        A pull moves `logs/`' mtime past the index's, which is the self-heal's
 *        staleness trigger, so the watermark is recomputed before the append.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { get } from "../src/ops/get.js";
import { appendLog } from "../src/ops/logOp.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { resolveConflicts } from "../src/ops/resolveConflicts.js";
import { reviewApprove, reviewShow } from "../src/ops/review.js";
import { search } from "../src/ops/search.js";
import { ensureStoreUnlocked } from "../src/ops/unlockOp.js";
import { updateTopic } from "../src/ops/update.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { parseLog } from "../src/store/log.js";
import { findProposal, listProposals } from "../src/store/proposals.js";
import { readText } from "../src/store/read.js";
import { clockAt, expectGestaltError, freshHome } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
/**
 * Wall-clock base for every op here: 2026-07-28T12:00:00Z. It must be LATER
 * than the seeded example's timestamps, or the store's monotonic watermark
 * (max seen so far, + 1 ms) overrides the injected clock and the machines'
 * "different clocks" stop being different.
 */
const T0 = 1_785_240_000_000;
const PASS = "a perfectly sturdy team passphrase";
const TOPIC = "widget";
/** A word that appears only in this store, so a search hit is unambiguous. */
const TEAM_FACT = "chose the seam approach over a rewrite";

/**
 * Git with the host's own config held out of the way: the user's global/system
 * gitconfig must not change the merge result, and nothing here may write to it.
 * Both paths point at files that do not exist, which git reads as empty.
 */
let GIT_ENV: NodeJS.ProcessEnv;

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${dir} (${r.status}):\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

function gitTry(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** Commit everything in a store work tree and push it to the shared remote. */
function commitAndPush(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  git(dir, "push", "-q", "origin", "main");
}

function hasConflictMarkers(text: string): boolean {
  return /^<{7} |^={7}$|^>{7} /m.test(text);
}

/** Insert a line into a note body, above the protected `## Owner notes` section. */
function editBody(noteText: string, line: string): string {
  return noteText.replace("## Owner notes", `${line}\n\n## Owner notes`);
}

let root = "";
let origin = "";
let owner = ""; // machine A — the owner's clone, also the store home
let mate = ""; // machine B — a teammate's clone
/** The seq both machines minted for their competing note edit. */

describe("git-synced team store (TEAM-PLAYBOOK shape)", () => {
  beforeAll(async () => {
    root = freshHome("teamsync");
    mkdirSync(root, { recursive: true });
    GIT_ENV = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(root, "no-global-gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(root, "no-system-gitconfig"),
      GIT_AUTHOR_NAME: "fimemory test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "fimemory test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };

    origin = path.join(root, "origin.git");
    owner = path.join(root, "owner");
    mate = path.join(root, "teammate");
    git(root, "init", "--bare", "-q", "-b", "main", origin);

    // ── Owner setup, exactly the playbook's five steps ────────────────────────
    runInit({ home: owner, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    activateDek(unlockWithPassphrase(owner, PASS));

    await createTopic(owner, TOPIC, "Widget pipeline", { now: clockAt(T0) });
    await appendLog(
      owner,
      TOPIC,
      { type: "decision", project: "demo", agent: "owner-cli", summary: TEAM_FACT },
      { now: clockAt(T0 + 1_000) },
    );

    git(owner, "init", "-q", "-b", "main");
    git(owner, "remote", "add", "origin", origin);
    commitAndPush(owner, "baseline: encrypted team store");

    // ── Teammate: step 1 of Join, "clone the private remote". ─────────────────
    git(root, "clone", "-q", origin, mate);
  }, 60_000);

  it("puts only durable state on the remote: no lock, no keyring, no derived index", () => {
    const tracked = git(mate, "ls-files").split("\n").filter(Boolean);

    // The three things that must never sync, and why they must not: the lock is
    // transient, the keyring is per-machine, the index is derived.
    expect(tracked).not.toContain("index.json");
    expect(tracked).not.toContain("keyring.json");
    expect(tracked.some((f) => f.startsWith(".gestalt.lock"))).toBe(false);
    // And the durable content IS there — the clone is a real store on disk.
    expect(tracked).toContain(`topics/${TOPIC}.md`);
    expect(tracked).toContain(`logs/${TOPIC}.log.md`);
    expect(tracked).toContain(".gitattributes");
    expect(existsSync(fsPath(storePaths(mate).index))).toBe(false);
    // Sealed on the remote: the git host holds ciphertext, as promised.
    expect(readFileSync(fsPath(topicNotePath(mate, TOPIC)), "utf8")).toMatch(/^gestalt-enc:1:/);
  });

  it("a teammate who clones the store can find what the team knows", async () => {
    // The playbook's join success check is: "Ask your AI something the team
    // already knows. If it answers from the store, you're in." Retrieval goes
    // through `search`, and `search` iterates the topics in index.json — which
    // is gitignored (correctly: it is derived, and it would conflict on every
    // pull). Nothing in the documented join flow rebuilds it: `joinStore`
    // clones, doctors, installs rules and prints the success check, and never
    // calls reindex.
    //
    // So the clone WAS a complete, valid, decryptable store that answered
    // NOTHING. `loadIndexOrEmpty` now rebuilds a missing index on the first
    // read, so the very first question a teammate asks is answered — no manual
    // reindex, no step the playbook forgot to write down.
    expect(existsSync(fsPath(storePaths(mate).index))).toBe(false); // fresh clone
    const firstAsk = await search(mate, "seam approach");
    expect(firstAsk.hits.map((h) => h.id)).toContain(TOPIC);
    expect(existsSync(fsPath(storePaths(mate).index))).toBe(true); // self-healed
  }, 30_000);

  it("one `reindex` is the whole fix — and it is the step the playbook is missing", async () => {
    await reindexStore(mate);
    const after = await search(mate, "seam approach");
    expect(after.hits.map((h) => h.id)).toContain(TOPIC);
    expect(after.warnings).toEqual([]);
    // The rebuilt index sees the log entry the owner pushed.
    expect(existsSync(fsPath(storePaths(mate).index))).toBe(true);
  }, 30_000);

  it("append-only logs really do merge: two clones, two entries, nothing lost", async () => {
    // Owner appends and pushes.
    await appendLog(
      owner,
      TOPIC,
      { type: "pattern", project: "demo", agent: "owner-cli", summary: "entry from the owner machine" },
      { now: clockAt(T0 + 10_000) },
    );
    commitAndPush(owner, "owner: log entry");

    // Teammate appends the same topic without having pulled — the everyday case.
    await appendLog(
      mate,
      TOPIC,
      { type: "gotcha", project: "demo", agent: "mate-cli", summary: "entry from the teammate machine" },
      { now: clockAt(T0 + 11_000) },
    );
    git(mate, "add", "-A");
    git(mate, "commit", "-q", "-m", "teammate: log entry");

    git(mate, "fetch", "-q", "origin");
    const merge = gitTry(mate, "merge", "--no-edit", "origin/main");
    expect(merge.ok).toBe(true); // merge=union from init's .gitattributes

    const mergedRaw = readFileSync(fsPath(topicLogPath(mate, TOPIC)), "utf8");
    expect(hasConflictMarkers(mergedRaw)).toBe(false);

    // Both machines' entries survive, decrypt, and parse — no warnings.
    const parsed = parseLog((await readText(topicLogPath(mate, TOPIC)))!, TOPIC);
    expect(parsed.warnings).toEqual([]);
    const summaries = parsed.entries.map((e) => e.summary);
    expect(summaries).toContain("entry from the owner machine");
    expect(summaries).toContain("entry from the teammate machine");
    expect(summaries).toContain(TEAM_FACT);

    // …and the merged log is retrievable after the (again, manual) reindex.
    await reindexStore(mate);
    const hits = await search(mate, "teammate machine");
    expect(hits.hits.map((h) => h.id)).toContain(TOPIC);

    // Push the merge back so both clones share a base for the next probe.
    git(mate, "push", "-q", "origin", "main");
    git(owner, "pull", "-q", "--no-rebase", "origin", "main");
    await reindexStore(owner);
  }, 30_000);

  it("two clones approving different edits to one note: git ALONE conflicts on an opaque blob", async () => {
    // Owner proposes + approves an edit.
    const ownerNote = (await readText(topicNotePath(owner, TOPIC)))!;
    const ownerSeq = (
      await updateTopic(owner, TOPIC, editBody(ownerNote, "The owner decided X."), {
        proposer: "owner",
        now: clockAt(T0 + 20_000),
      })
    ).seq;
    await reviewApprove(owner, ownerSeq, { now: clockAt(T0 + 21_000) });
    commitAndPush(owner, "owner: approved a note edit");

    // Teammate, on the same base, proposes + approves a DIFFERENT edit.
    const mateNote = (await readText(topicNotePath(mate, TOPIC)))!;
    const mateSeq = (
      await updateTopic(mate, TOPIC, editBody(mateNote, "The teammate decided Y."), {
        proposer: "teammate",
        now: clockAt(T0 + 22_000),
      })
    ).seq;
    await reviewApprove(mate, mateSeq, { now: clockAt(T0 + 23_000) });
    git(mate, "add", "-A");
    git(mate, "commit", "-q", "-m", "teammate: approved a note edit");

    // Both minted the SAME seq — the counter is per-clone (max filename + 1).
    expect(mateSeq).toBe(ownerSeq);

    git(mate, "fetch", "-q", "origin");
    const merge = gitTry(mate, "merge", "--no-edit", "origin/main");
    // Conflicting, not silently merged: correct. A note is a whole-file blob.
    expect(merge.ok).toBe(false);
    expect(merge.out.toLowerCase()).toContain("conflict");
    const conflicted = git(mate, "diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean);
    expect(conflicted).toContain(`topics/${TOPIC}.md`);
    // The PROPOSAL no longer collides, and that is the team-sync fix landing.
    // Both clones still mint the same `seq` (the counter is per-clone, max
    // filename + 1, asserted above), but a proposal filename is now
    // machine-scoped — `{machineId}-{seq}-{topicId}.md` — so two clones each
    // writing "proposal 2" produce two different files and git unions them.
    // This assertion previously REQUIRED the add/add conflict, because it was
    // written to characterise the defect. The note itself still conflicts and
    // must: it is one whole-file sealed blob with two different edits.
    expect(conflicted.filter((f) => f.startsWith("proposals/"))).toEqual([]);

    // What a RAW `git merge` leaves: conflict markers wrapped around two base64
    // blobs. There is no hand-merge here — nobody can read either side, and the
    // runtime fails closed rather than pretending. This is the state the pull
    // resolver is handed, not an outcome any user is expected to fix. Raw
    // `git pull`/`git merge` in a store stays unsupported (0.3.0 plan §7).
    const raw = readFileSync(fsPath(topicNotePath(mate, TOPIC)), "utf8");
    expect(hasConflictMarkers(raw)).toBe(true);
    expect(raw).not.toContain("The owner decided X.");
    await expect(readText(topicNotePath(mate, TOPIC))).rejects.toThrow(
      /E_STORE_MODE|decrypt|plaintext/i,
    );
  }, 30_000);

  it("the store's own resolver keeps BOTH sides: one body live, the other a pending proposal", async () => {
    // REPLACES the old `git checkout --theirs` case, which asserted that
    // resolving a dual approve DROPS one body and leaves the log claiming an
    // edit that is gone. That is the behaviour the 0.3.0 conflict resolver
    // exists to end (plan §1): never drop a side, never leave a marker, the
    // store stays readable, a human picks.
    //
    // Winner = the larger `updated:`, tie to ours — last-write-wins on each
    // machine's own clock, nothing cleverer. The teammate approved at
    // T0+23_000 and the owner at T0+21_000, so the TEAMMATE's body stays live
    // here and the owner's becomes an ordinary pending proposal.
    const res = await resolveConflicts(mate, { env: GIT_ENV, now: clockAt(T0 + 24_000) });
    git(mate, "commit", "-q", "--no-edit");

    const resolved = res.notes.find((n) => n.id === TOPIC)!;
    expect(resolved.winner).toBe("ours");
    const minted = resolved.proposal!;

    const note = (await readText(topicNotePath(mate, TOPIC)))!;
    expect(note).toContain("The teammate decided Y."); // larger `updated:`
    expect(note).not.toContain("The owner decided X.");
    expect(hasConflictMarkers(readFileSync(fsPath(topicNotePath(mate, TOPIC)), "utf8"))).toBe(false);
    // Still sealed at rest — resolution went through the codec, not around it.
    expect(readFileSync(fsPath(topicNotePath(mate, TOPIC)), "utf8")).toMatch(/^gestalt-enc:1:/);

    // The owner's body is NOT gone. It is filed, whole, one command away.
    const filed = await reviewShow(mate, minted.seq);
    expect(filed.id).toBe(TOPIC);
    expect(filed.newNote).toContain("The owner decided X.");

    const { index, warnings } = await reindexStore(mate);
    expect(warnings).toEqual([]);
    expect(Object.keys(index.topics)).toContain(TOPIC);

    // Every log entry ever written is still present (union merge never drops).
    const entries = parseLog((await readText(topicLogPath(mate, TOPIC)))!, TOPIC).entries;
    const summaries = entries.map((e) => e.summary);
    expect(summaries).toContain(TEAM_FACT);
    expect(summaries).toContain("entry from the owner machine");
    expect(summaries).toContain("entry from the teammate machine");
    const approvals = summaries.filter((s) => s.startsWith("Note updated via proposal"));
    expect(approvals).toHaveLength(2);
    expect(approvals.some((s) => s.includes("by owner"))).toBe(true);
    expect(approvals.some((s) => s.includes("by teammate"))).toBe(true);

    // …and, unlike the old resolution, the log now RECORDS that a side was
    // filed rather than leaving a reader hunting for an edit that is not there.
    // The excerpt is what makes the dropped body findable: `search` reads notes
    // and log entries, never `proposals/`.
    expect(summaries.some((s) => s.includes("Cross-machine merge"))).toBe(true);
    expect((await search(mate, "owner decided")).hits.map((h) => h.id)).toContain(TOPIC);

    // Approving it swaps the owner's body back in, first try — this is where a
    // hash taken over pre-`serializeNote` bytes would surface as E_STALE.
    //
    // NOTE for whoever reads the two `it.fails` tripwires below: minting this
    // proposal advances THIS clone's `nextSeq` past the owner's, so the
    // "every pending proposal stays reachable by its seq" case no longer
    // reaches its collision setup — it now fails at `expect(a.seq).toBe(b.seq)`.
    // It is still red, so the tripwire is still green, but it is no longer
    // proving what it was written to prove.
    await reviewApprove(mate, minted.seq);
    const swapped = (await readText(topicNotePath(mate, TOPIC)))!;
    expect(swapped).toContain("The owner decided X.");
  }, 30_000);

  // FIXED by W-E (sort-on-parse), so this is no longer `it.fails` — it is now an
  // ordinary assertion guarding the repaired behaviour. Per the project's
  // defect-registry process, a fixed defect's tripwire is unmarked rather than
  // deleted: the case that proved the bug becomes the case that stops it coming
  // back.
  //
  // The original defect, kept because it explains what the assertion is for:
  // `merge=union` concatenates the conflicting hunk as OURS-then-THEIRS, so the
  // entries the remote wrote landed AFTER the ones this machine wrote, whatever
  // the clock said, and nothing re-sorted. Position IS the runtime's idea of
  // recency for every reader except `get`, which sorts for itself — so `compact`
  // folding `entries.slice(-N)` would drop the newest team fact and keep an
  // older local one. parseLog now sorts on both the plaintext and encrypted
  // paths, so the invariant belongs to the parse and every reader inherits it.
  it("a union-merged log comes back in timestamp order", async () => {
    const entries = parseLog((await readText(topicLogPath(mate, TOPIC)))!, TOPIC).entries;
    const timestamps = entries.map((e) => e.timestamp);
    const newest = [...timestamps].sort().at(-1)!;
    const newestSummary = entries.find((e) => e.timestamp === newest)!.summary;

    const tail = await get(mate, [TOPIC], { logTail: 1 });
    expect(tail.topics[0]!.logTail).toContain(newestSummary);
    expect([...timestamps].sort()).toEqual(timestamps);
  }, 30_000);
  // WAS `it.fails("DEFECT: every pending proposal stays reachable by its seq")`.
  //
  // The defect is FIXED — `--machine <id>` on review show/approve/reject, and a
  // bare lookup now refuses an ambiguous seq instead of silently answering with
  // whichever file it happened to read first. The property moved to
  // test/resolve-conflicts.test.ts rather than being unmarked in place, for a
  // reason worth recording: this fixture only produced a collision when two
  // per-clone counters happened to line up, and the merge-resolver test added
  // above now mints a proposal and shifts them. The tripwire had already stopped
  // reaching its own assertion — still red, so still reading green, while
  // proving nothing. A property that depends on counter arithmetic in a shared
  // fixture is a property that will quietly stop being tested again, so it now
  // lives next to the resolver that relies on it, with the collision built
  // explicitly instead of awaited.

  it("index.json is derived, so the merge-hostile file never reaches the remote — and reindex is authoritative", async () => {
    // The prime suspect for a merge-hostile file is index.json: it is a whole
    // sealed blob on an encrypted store, it changes on every write, and it is
    // regenerable. init's .gitignore keeps it out of git entirely, which is the
    // right answer — verify git agrees, and that a destroyed index is fully
    // rebuilt from the durable files.
    expect(gitTry(mate, "check-ignore", "-q", "index.json").ok).toBe(true);
    expect(gitTry(mate, "check-ignore", "-q", "keyring.json").ok).toBe(true);

    const before = await reindexStore(mate);
    const idxPath = fsPath(storePaths(mate).index);
    const sealed = readFileSync(idxPath, "utf8");
    expect(sealed).toMatch(/^gestalt-enc:1:/);

    const after = await reindexStore(mate);
    expect(readFileSync(idxPath, "utf8")).toBe(sealed); // byte-stable rebuild
    expect(after.index).toEqual(before.index);
    expect(after.warnings).toEqual([]);
  }, 30_000);

  it("after a plain pull, the next entry still gets a strictly-increasing timestamp", async () => {
    // Same root cause as the blind clone, but this one corrupted data rather
    // than hiding it. SPEC §4: "timestamps are strictly increasing per store".
    // The high-water mark lives in index.json — gitignored, per-machine — and
    // `appendLog` takes `max(local clock, watermark + 1)`. A pull brings in
    // entries the local index has never seen, so until someone reindexed, the
    // watermark was behind the file's own contents and the next append landed
    // at or before an entry that was already there.
    //
    // No merge, no conflict, no warning: this is a fast-forward pull, the
    // playbook's "pull before you start", on a machine whose clock is not
    // ahead of its teammate's. The pull moves `logs/`'s mtime past the index's,
    // which is the self-heal's staleness trigger, so `appendLog` rebuilds the
    // watermark from the log files before it issues a timestamp.
    const late = path.join(root, "latecomer");
    git(root, "clone", "-q", origin, late);
    await reindexStore(late); // a properly set-up machine, index built once

    await appendLog(
      owner,
      TOPIC,
      { type: "decision", project: "demo", agent: "owner-cli", summary: "owner entry, later clock" },
      { now: clockAt(T0 + 90_000) },
    );
    commitAndPush(owner, "owner: a later entry");

    git(late, "pull", "-q", "--no-rebase", "origin", "main");
    const appended = await appendLog(
      late,
      TOPIC,
      { type: "gotcha", project: "demo", agent: "late-cli", summary: "latecomer entry, same clock" },
      { now: clockAt(T0 + 90_000) },
    );

    const entries = parseLog((await readText(topicLogPath(late, TOPIC)))!, TOPIC).entries;
    const timestamps = entries.map((e) => e.timestamp);
    // Two different entries now carry the same instant, so `--supersedes <ts>`
    // (which resolves its target by timestamp) cannot say which one it retires.
    expect(timestamps.filter((t) => t === appended.timestamp)).toHaveLength(1);
    expect(new Set(timestamps).size).toBe(timestamps.length);
  }, 30_000);

  it("no store file that git tracks is a merge-hostile counter file (only notes/proposals are whole-file sealed)", () => {
    const tracked = git(mate, "ls-files").split("\n").filter(Boolean);
    const wholeFileSealed = tracked.filter((f) => {
      const p = path.join(mate, f);
      if (!existsSync(p)) return false;
      return readFileSync(p, "utf8").startsWith("gestalt-enc:1:");
    });
    // Sealed whole-file = conflicts are unresolvable by hand. That set must be
    // exactly the files a human edits one-at-a-time (notes, proposals) — never a
    // counter, a manifest, or anything two machines both append to. store.enc is
    // the one other member and is harmless: fixed content, deterministic
    // ciphertext, byte-identical on every clone, so it can never conflict.
    for (const f of wholeFileSealed) {
      expect(f).toMatch(/^(topics|proposals)\/|^store\.enc$/);
    }
    expect(wholeFileSealed).toContain("store.enc");
    // Logs and ledgers — the files both machines write — are line-oriented and
    // carry a union merge driver.
    const attrs = readFileSync(path.join(mate, ".gitattributes"), "utf8");
    expect(attrs).toContain("logs/*.log.md merge=union");
    expect(attrs).toContain("ledgers/*.jsonl merge=union");
  });
});

describe("the passphrase does not travel with the repo", () => {
  it("a clone cannot be unlocked with the shared passphrase — keyring.json is gitignored", () => {
    // TEAM-PLAYBOOK Join step 3: "Get the passphrase from the owner out of band
    // … plant it machine-locally, run `fimemory unlock`". That cannot work on a
    // fresh clone: the wrapped DEK lives in keyring.json, which .gitignore
    // (correctly, it is per-machine) keeps off the remote. The teammate needs
    // the OWNER'S 24-word recovery phrase — which the same playbook calls the
    // owner's offline-only secret — or a hand-copied keyring.json.
    expect(existsSync(fsPath(path.join(mate, "keyring.json")))).toBe(false);

    clearActiveKey(); // the DEK is process-global; restored in `finally`
    try {
      expectGestaltError(
        () => ensureStoreUnlocked(mate, { passphrase: PASS, env: {} as NodeJS.ProcessEnv }),
        "E_STORE_MODE",
      );
      // It fails loudly and names the only real way out, which is the one part
      // of this the runtime gets right.
      let hint = "";
      try {
        ensureStoreUnlocked(mate, { passphrase: PASS, env: {} as NodeJS.ProcessEnv });
      } catch (err) {
        hint = `${(err as Error).message} ${(err as { hint?: string }).hint ?? ""}`;
      }
      expect(hint).toMatch(/keyring\.json is missing/i);
      expect(hint).toMatch(/recover/i);

      // Sanity: the owner's own machine, which has keyring.json, opens fine.
      expect(unlockWithPassphrase(owner, PASS).length).toBe(32);
    } finally {
      activateDek(unlockWithPassphrase(owner, PASS));
    }
  }, 30_000);

  it("the remote leaks nothing readable: every tracked topic/proposal is ciphertext", () => {
    for (const sub of ["topics", "proposals"]) {
      for (const f of readdirSync(path.join(mate, sub))) {
        const text = readFileSync(path.join(mate, sub, f), "utf8");
        expect(text).toMatch(/^gestalt-enc:1:/);
      }
    }
    // Log lines leak only their timestamps (a deliberate, documented tradeoff).
    const log = readFileSync(fsPath(topicLogPath(mate, TOPIC)), "utf8");
    expect(log).not.toContain(TEAM_FACT);
  });
});
