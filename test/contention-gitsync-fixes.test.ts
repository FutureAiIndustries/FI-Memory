/**
 * CONTENTION: git-synced team store (2026-07-28 audit).
 *
 * The TEAM-PLAYBOOK promised a small team could share one encrypted store over
 * a private git remote. A bare-repo + two-clones probe found the transport half
 * holds (union-merge never lost a log entry; the remote stays ciphertext) while
 * the setup half does not. These four tests pin the gaps that make a fresh
 * teammate's store answer nothing, refuse to open on passphrase alone, mint
 * colliding proposal numbers, and serve a stale "latest" after a merge/pull.
 *
 * Do not weaken these. Each fix on fix/team-sync flips one (or more) to green.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { get } from "../src/ops/get.js";
import { joinStore } from "../src/ops/joinOp.js";
import { appendLog } from "../src/ops/logOp.js";
import { createTopic } from "../src/ops/create.js";
import { runDoctor } from "../src/ops/doctor.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { search } from "../src/ops/search.js";
import { updateTopic } from "../src/ops/update.js";
import { reviewList, reviewShow } from "../src/ops/review.js";
import { pullStore } from "../src/ops/pullOp.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import { keyringExists, unlockWithPassphrase } from "../src/store/keyring.js";
import { readIndex } from "../src/store/index.js";
import { parseLog, serializeLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { fsPath, storePaths, topicLogPath } from "../src/paths.js";
import { clockAt, freshHome } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy team passphrase";
const CLEAN_ENV = {} as NodeJS.ProcessEnv;

const temps: string[] = [];
afterEach(() => {
  clearActiveKey();
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  temps.length = 0;
});

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

function doctorOpts(home: string, env: NodeJS.ProcessEnv = CLEAN_ENV) {
  return {
    home,
    env,
    hostConfigPaths: {} as Record<string, string>,
    rulesPaths: [{ host: "claude", file: path.join(home, "no-rules.md") }],
    shimSettingsPath: path.join(home, "no-settings.json"),
  };
}

/** Seed encrypted store → bare remote. keyring + index stay local (gitignored). */
async function buildRemoteWithTopic(): Promise<{
  remote: string;
  seedHome: string;
  keyringSrc: string;
  topicId: string;
}> {
  const seedHome = freshHome("gitsync-seed");
  runInit({
    home: seedHome,
    encrypted: true,
    passphrase: PASS,
    argon2: TINY,
    allowWeakParams: true,
  });
  clearActiveKey();
  activateDek(unlockWithPassphrase(seedHome, PASS));

  const topicId = "shared-memory";
  await createTopic(seedHome, topicId, "Shared memory", {
    now: clockAt(1_700_000_000_000),
  });
  await appendLog(
    seedHome,
    topicId,
    {
      type: "decision",
      project: "team",
      agent: "owner",
      summary: "the team uses one encrypted store over private git",
    },
    { now: clockAt(1_700_000_000_100) },
  );

  git(seedHome, ["init"]);
  git(seedHome, ["config", "user.email", "gitsync@example.com"]);
  git(seedHome, ["config", "user.name", "Gitsync Test"]);
  git(seedHome, ["add", "-A"]);
  git(seedHome, ["commit", "-m", "seed encrypted store"]);

  const bare = mkdtempSync(path.join(tmpdir(), "gitsync-remote-"));
  temps.push(bare);
  const remote = path.join(bare, "store.git");
  spawnSync("git", ["clone", "--bare", seedHome, remote], { encoding: "utf8" });
  return {
    remote,
    seedHome,
    keyringSrc: path.join(seedHome, "keyring.json"),
    topicId,
  };
}

/** Teammate clone: no keyring, no index (both gitignored). */
function plainClone(remote: string, label: string): string {
  const dest = freshHome(label);
  const r = spawnSync("git", ["clone", remote, dest], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`clone failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  expect(existsSync(path.join(dest, "index.json"))).toBe(false);
  expect(existsSync(path.join(dest, "keyring.json"))).toBe(false);
  return dest;
}

async function cloneReady(
  remote: string,
  keyringSrc: string,
  label: string,
): Promise<string> {
  const dest = plainClone(remote, label);
  copyFileSync(keyringSrc, path.join(dest, "keyring.json"));
  clearActiveKey();
  activateDek(unlockWithPassphrase(dest, PASS));
  await reindexStore(dest);
  return dest;
}

describe("contention: git-synced team store", () => {
  it("1. a fresh clone has no catalog — the read path self-heals, join rebuilds it, doctor names the gap", async () => {
    const { remote, keyringSrc, topicId } = await buildRemoteWithTopic();
    const dest = plainClone(remote, "gitsync-clone-index");
    copyFileSync(keyringSrc, path.join(dest, "keyring.json"));
    clearActiveKey();
    activateDek(unlockWithPassphrase(dest, PASS));

    // Catalog is gitignored — raw clone has none.
    expect(existsSync(path.join(dest, "index.json"))).toBe(false);

    // doctor must say so in plain words with the one-line fix.
    const d0 = runDoctor(doctorOpts(dest, { GESTALT_PASSPHRASE: PASS } as NodeJS.ProcessEnv));
    const indexFinding = d0.findings.find(
      (f) => f.code === "index_missing" || f.code === "index_stale",
    );
    expect(indexFinding, "doctor must report a missing/stale index").toBeDefined();
    expect(indexFinding!.message.toLowerCase()).toMatch(/index|catalog/);
    expect(indexFinding!.hint ?? "").toMatch(/reindex/i);

    // Search is NOT silent, and that premise changing is the point. This test
    // came from the branch that fixed "a fresh clone answers nothing" by making
    // `join` reindex explicitly; main had independently fixed the same blocker
    // in the READ path, where `loadIndexOrEmpty` rebuilds a missing index on
    // the spot and records the repair for doctor to report. Both fixes are
    // real. Main's is the one a user never has to know about, so it wins, and
    // what gets rewritten here is the assertion of the old broken behaviour,
    // never the guarantee: the clone must ANSWER, which is a stronger claim
    // than the silence this line used to require.
    const selfHealed = await search(dest, "encrypted store");
    expect(selfHealed.hits.some((h) => h.id === topicId)).toBe(true);
    expect(existsSync(path.join(dest, "index.json"))).toBe(true);

    // join on the already-cloned tree rebuilds the catalog.
    await joinStore({
      gitUrl: remote,
      home: dest,
      skipClone: true,
      installHooks: false,
      // Scoped INTO the sandbox. Without this, join's rules step writes the
      // developer's LIVE ~/.claude/CLAUDE.md — the exact defect the rulesFile
      // opt-out exists for. This test predates the opt-out (it came from the
      // team-sync branch) and rewrote the real file on every full-suite run
      // until doctor's stale-block check exposed it on 2026-08-07.
      rulesFile: path.join(dest, "rules-scratch.md"),
      env: { GESTALT_PASSPHRASE: PASS } as NodeJS.ProcessEnv,
    });

    expect(existsSync(path.join(dest, "index.json"))).toBe(true);
    const hits = await search(dest, "encrypted store");
    expect(hits.hits.some((h) => h.id === topicId)).toBe(true);

    // Staleness: index mtime older than a log → doctor flags it.
    const indexPath = storePaths(dest).index;
    const old = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(fsPath(indexPath), old, old);
    const logPath = topicLogPath(dest, topicId);
    const now = Math.floor(Date.now() / 1000) + 10;
    utimesSync(fsPath(logPath), now, now);

    const d1 = runDoctor(doctorOpts(dest, { GESTALT_PASSPHRASE: PASS } as NodeJS.ProcessEnv));
    const stale = d1.findings.find((f) => f.code === "index_stale" || f.code === "index_missing");
    expect(stale, "doctor must detect index older than newest log").toBeDefined();
    expect(stale!.hint ?? "").toMatch(/reindex/i);
  });

  it("2. passphrase alone cannot open a clone — join carries an explicit keyring step (never via git)", async () => {
    const { remote, keyringSrc } = await buildRemoteWithTopic();
    const dest = plainClone(remote, "gitsync-clone-keyring");

    clearActiveKey();
    expect(keyringExists(dest)).toBe(false);
    expect(() => unlockWithPassphrase(dest, PASS)).toThrow();

    // join without a keyring source: clear OOB instructions; no keyring written.
    const r = await joinStore({
      gitUrl: remote,
      home: dest,
      skipClone: true,
      installHooks: false,
      rulesFile: path.join(dest, "rules-scratch.md"), // never the live file
      env: CLEAN_ENV,
    });
    const guide = [...r.passphraseGuide, ...r.steps, ...r.warnings].join("\n");
    expect(guide.toLowerCase()).toMatch(/keyring/);
    expect(guide.toLowerCase()).toMatch(/out of band|out-of-band|password manager|in person/);
    expect(keyringExists(dest)).toBe(false);

    // Explicit portable-keyring import (file delivered OOB — never from git).
    const portableDir = freshHome("portable-keyring-dir");
    mkdirSync(portableDir, { recursive: true });
    const portable = path.join(portableDir, "keyring.json");
    copyFileSync(keyringSrc, portable);

    const r2 = await joinStore({
      gitUrl: remote,
      home: dest,
      skipClone: true,
      installHooks: false,
      rulesFile: path.join(dest, "rules-scratch.md"), // never the live file
      env: CLEAN_ENV,
      keyringFile: portable,
    });
    expect(keyringExists(dest)).toBe(true);
    expect(r2.steps.some((s) => /keyring/i.test(s))).toBe(true);

    clearActiveKey();
    const dek = unlockWithPassphrase(dest, PASS);
    expect(dek.byteLength).toBe(32);

    // Security story: the bare remote must still have no keyring / passphrase.
    const remoteListing = spawnSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "HEAD", "--name-only"],
      { encoding: "utf8" },
    );
    const remoteFiles = (remoteListing.stdout || "").split("\n").filter(Boolean);
    expect(remoteFiles.some((f) => /(^|\/)keyring\.json$/.test(f))).toBe(false);
    for (const f of remoteFiles) {
      const show = spawnSync("git", ["--git-dir", remote, "show", `HEAD:${f}`], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      if (show.status === 0 && typeof show.stdout === "string") {
        expect(show.stdout.includes(PASS)).toBe(false);
      }
    }
  });

  it("3. proposal seq is collision-free across clones; review show N still works", async () => {
    const { remote, keyringSrc, topicId } = await buildRemoteWithTopic();
    const a = await cloneReady(remote, keyringSrc, "gitsync-prop-a");
    const b = await cloneReady(remote, keyringSrc, "gitsync-prop-b");

    const noteA = `---\nid: ${topicId}\ntitle: Shared memory\naliases: []\ntags: []\nprojects: []\nupdated: 2026-07-28T00:00:00.000Z\ncompactedThrough: null\nmergedInto: null\n---\n\nBody from machine A\n\n## Owner notes\n`;
    const noteB = `---\nid: ${topicId}\ntitle: Shared memory\naliases: []\ntags: []\nprojects: []\nupdated: 2026-07-28T00:00:00.000Z\ncompactedThrough: null\nmergedInto: null\n---\n\nBody from machine B\n\n## Owner notes\n`;

    const ra = await updateTopic(a, topicId, noteA, {
      proposer: "machine-a",
      now: clockAt(1_700_000_001_000),
    });
    const rb = await updateTopic(b, topicId, noteB, {
      proposer: "machine-b",
      now: clockAt(1_700_000_001_100),
    });

    // Simulate git merge of proposals/: both files land in one store.
    const merged = await cloneReady(remote, keyringSrc, "gitsync-prop-merged");
    for (const home of [a, b]) {
      const dir = storePaths(home).proposalsDir;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const src = path.join(dir, f);
        const dst = path.join(storePaths(merged).proposalsDir, f);
        if (!existsSync(dst)) copyFileSync(src, dst);
      }
    }

    const list = await reviewList(merged);
    const pending = list.filter((p) => p.status === "pending");
    const proposers = new Set(pending.map((p) => p.proposer));
    expect(proposers.has("machine-a")).toBe(true);
    expect(proposers.has("machine-b")).toBe(true);

    // File identity must differ — that is the collision-free guarantee.
    const filesA = readdirSync(storePaths(a).proposalsDir).filter((f) =>
      f.includes(topicId),
    );
    const filesB = readdirSync(storePaths(b).proposalsDir).filter((f) =>
      f.includes(topicId),
    );
    expect(filesA.length).toBeGreaterThanOrEqual(1);
    expect(filesB.length).toBeGreaterThanOrEqual(1);
    const overlap = filesA.filter((f) => filesB.includes(f));
    expect(overlap.length).toBe(0);

    // review show N stays usable when N is unique; concurrent cross-clone mints
    // may share an N (both saw the same max) but never share a filename.
    if (ra.seq !== rb.seq) {
      const shownA = await reviewShow(merged, ra.seq);
      const shownB = await reviewShow(merged, rb.seq);
      expect(shownA.proposer).toMatch(/machine-a/);
      expect(shownB.proposer).toMatch(/machine-b/);
    } else {
      // Same human N, two files: show must not silently pick one.
      await expect(reviewShow(merged, ra.seq)).rejects.toMatchObject({
        code: "E_AMBIGUOUS",
      });
      // Both still visible in list for the owner to act on.
      expect(pending.filter((p) => p.seq === ra.seq).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("4. recency is by timestamp (not file position); pull refreshes the watermark", async () => {
    const { remote, keyringSrc, topicId } = await buildRemoteWithTopic();
    const home = await cloneReady(remote, keyringSrc, "gitsync-order");

    // Union-merge-shaped log: physical order is NOT chronological.
    const older = {
      timestamp: "2026-07-28T10:00:00.000Z",
      type: "decision",
      project: "team",
      agent: "a",
      supersedes: null,
      reported: null,
      summary: "older decision that landed later in the file",
      raw: "### 2026-07-28T10:00:00.000Z | decision | team | a\nolder decision that landed later in the file",
    };
    const mid = {
      timestamp: "2026-07-28T11:00:00.000Z",
      type: "pattern",
      project: "team",
      agent: "c",
      supersedes: null,
      reported: null,
      summary: "middle entry",
      raw: "### 2026-07-28T11:00:00.000Z | pattern | team | c\nmiddle entry",
    };
    const newer = {
      timestamp: "2026-07-28T12:00:00.000Z",
      type: "gotcha",
      project: "team",
      agent: "b",
      supersedes: null,
      reported: null,
      summary: "newest fact the agent must see",
      raw: "### 2026-07-28T12:00:00.000Z | gotcha | team | b\nnewest fact the agent must see",
    };
    // Physical: mid, newer, older — position-based tail(1) would return older.
    await writeFileAtomic(topicLogPath(home, topicId), serializeLog(topicId, [mid, newer, older]));

    const raw = await readText(topicLogPath(home, topicId));

    // The hazard is REAL ON DISK: the physical order of the entry headers is
    // not chronological, which is exactly what a union merge produces.
    // Both shapes: a plaintext log is `### <ts> | ...`, a sealed one is
    // `<ts> <base64url>` per line. The timestamp is in the clear either way,
    // which is what makes a union merge possible on an encrypted store at all.
    const ISO_AT_LINE_START = /^(?:### )?(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/gm;
    const physical = [...raw!.matchAll(ISO_AT_LINE_START)].map((m) => m[1]!);
    expect(physical.length, "fixture produced no readable timestamps").toBeGreaterThan(1);
    const sortedPhysical = [...physical].sort();
    expect(physical).not.toEqual(sortedPhysical);

    // And the parse repairs it. This assertion used to be inverted — it pinned
    // parseLog returning FILE order, which was the defect this test's own title
    // describes ("recency is by timestamp, not file position"). W-E moved the
    // guarantee into the parse, so every reader inherits it instead of each one
    // having to sort for itself, and the test now asserts the property rather
    // than the bug.
    const reparsed = parseLog(raw!, topicId).entries;
    const chronological = [...reparsed]
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
      .map((e) => e.timestamp);
    expect(reparsed.map((e) => e.timestamp)).toEqual(chronological);

    const g = await get(home, [topicId], { logTail: 1 });
    const tail = g.topics[0]?.logTail ?? "";
    expect(tail).toMatch(/newest fact the agent must see/);
    expect(tail).not.toMatch(/older decision that landed later/);

    // ── watermark after pull ──────────────────────────────────────────────
    const a = await cloneReady(remote, keyringSrc, "gitsync-wm-a");
    const b = await cloneReady(remote, keyringSrc, "gitsync-wm-b");

    const bTs = await appendLog(
      b,
      topicId,
      {
        type: "decision",
        project: "team",
        agent: "b",
        summary: "entry from B at a high watermark",
      },
      { now: clockAt(1_800_000_000_000) },
    );

    // Simulate a plain pull: log arrives, index.json (gitignored) stays stale.
    const idxBefore = await readIndex(a);
    copyFileSync(topicLogPath(b, topicId), topicLogPath(a, topicId));
    if (idxBefore) {
      writeFileSync(fsPath(storePaths(a).index), JSON.stringify(idxBefore, null, 2) + "\n", "utf8");
    }

    await pullStore({ home: a, skipGit: true });

    const idxAfter = await readIndex(a);
    expect(idxAfter?.lastTimestamp).toBeTruthy();
    expect(idxAfter!.lastTimestamp! >= bTs.timestamp).toBe(true);

    // Next append on A with a wall clock BELOW B's ts must still mint later.
    const aTs = await appendLog(
      a,
      topicId,
      {
        type: "gotcha",
        project: "team",
        agent: "a",
        summary: "entry from A after pull",
      },
      { now: clockAt(1_700_000_000_500) },
    );
    expect(aTs.timestamp > bTs.timestamp).toBe(true);
  });
});
