import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { runDoctor } from "../src/ops/doctor.js";
import type { DoctorOptions } from "../src/ops/doctor.js";
import { rulesBlock } from "../src/ops/installRules.js";
import type { InstallTarget } from "../src/ops/installMcp.js";
import { appendLog } from "../src/ops/logOp.js";
import { mergeTopics } from "../src/ops/merge.js";
import { search } from "../src/ops/search.js";
import { fsPath, storePaths, topicNotePath } from "../src/paths.js";
import { wipeSessionCache } from "../src/sessionKeyCache.js";
import { clearActiveKey } from "../src/store/codec.js";
import { checkIndexIntegrity, loadIndexOrEmpty, readIndex } from "../src/store/index.js";
import { readTelemetry, recordRead } from "../src/telemetry.js";
import { clockAt, freshHome, writeNote } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
const CLEAN_ENV = {} as NodeJS.ProcessEnv;

/**
 * Fixture host configs / rules / shim settings, so the machine's REAL Claude,
 * Codex and Grok configs can never decide whether these assertions pass. Copied
 * shape from doctor.test.ts on purpose: the point of `healthy === true` here is
 * that ONLY the index check moved.
 */
function hostFixtures(label: string): Partial<Record<InstallTarget, string>> {
  const dir = freshHome(`idx-hosts-${label}`);
  mkdirSync(dir, { recursive: true });
  const cursor = path.join(dir, "cursor-mcp.json");
  writeFileSync(
    cursor,
    JSON.stringify({ mcpServers: { gestalt: { command: "node", args: [] } } }),
    "utf8",
  );
  return {
    "claude-code": path.join(dir, "absent-claude.json"),
    "claude-desktop": path.join(dir, "absent-desktop.json"),
    cursor,
    codex: path.join(dir, "absent-codex.toml"),
    gemini: path.join(dir, "absent-gemini.json"),
    grok: path.join(dir, "absent-grok.toml"),
    windsurf: path.join(dir, "absent-windsurf.json"),
  };
}

function rulesFixtures(label: string): { host: string; file: string }[] {
  const dir = freshHome(`idx-rules-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "CLAUDE.md");
  writeFileSync(file, "mine\n\n" + rulesBlock() + "\n", "utf8");
  return [{ host: "claude", file }];
}

function shimSettingsFixture(label: string): string {
  const dir = freshHome(`idx-shim-${label}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "settings.json");
}

function baseOpts(label: string, over: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    env: CLEAN_ENV,
    hostConfigPaths: hostFixtures(label),
    rulesPaths: rulesFixtures(label),
    shimSettingsPath: shimSettingsFixture(label),
    ...over,
  };
}

/** Recursive path|size|mtime fingerprint — the "doctor writes NOTHING" proof. */
function fingerprint(dir: string): string[] {
  const rows: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(d, name);
      const st = statSync(p);
      rows.push(`${p}|${st.isDirectory() ? "dir" : `${st.size}|${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return rows;
}

/** A store with two real topics, exactly as a user would have it. */
async function storeWithTopics(label: string): Promise<string> {
  const home = freshHome(label);
  runInit({ home });
  await createTopic(home, "alpha", "Alpha", { now: clockAt(1000) });
  await createTopic(home, "bravo", "Bravo", { now: clockAt(2000) });
  await appendLog(
    home,
    "alpha",
    { type: "decision", project: "p", agent: "t", summary: "alpha decided something" },
    { now: clockAt(3000) },
  );
  // Loaded evidence, so `never_read` does not colour the findings list.
  recordRead(home, "fimemory_search", ["alpha"], "mcp");
  return home;
}

describe("doctor sees the derived index (D1)", () => {
  it("healthy store: index check passes and nothing about the index is reported", async () => {
    const home = await storeWithTopics("idx-ok");
    const r = runDoctor(baseOpts("ok", { home }));
    expect(r.healthy).toBe(true);
    expect(r.index!.entriesVerified).toBe(true);
    expect(r.index!.invisible).toEqual([]);
    expect(r.index!.orphaned).toEqual([]);
    expect(r.findings.filter((f) => f.code.startsWith("index_"))).toEqual([]);
  });

  it("FAILS when index.json is absent but topics are on disk (the cloned-store case)", async () => {
    const home = await storeWithTopics("idx-missing");
    // Exactly what `git clone` of a store hands you: init gitignores index.json.
    rmSync(fsPath(storePaths(home).index));

    const r = runDoctor(baseOpts("missing", { home }));
    expect(r.index!.indexPresent).toBe(false);
    expect(r.index!.topicFiles).toBeGreaterThan(0);
    const f = r.findings.find((x) => x.code === "index_missing");
    expect(f?.level).toBe("fail");
    // The exit-code contract is the whole point: this store used to say Healthy.
    expect(r.healthy).toBe(false);
  });

  it("FAILS when a topic exists on disk but the index does not list it", async () => {
    const home = await storeWithTopics("idx-blind");
    // A note that arrived without an index update — a git merge, a restored
    // file, a hand-dropped .md. Search iterates the index, so it is invisible.
    writeNote(home, "charlie", { title: "Charlie", body: "\nCharlie body\n" });

    const r = runDoctor(baseOpts("blind", { home }));
    const f = r.findings.find((x) => x.code === "index_blind");
    expect(f?.level).toBe("fail");
    expect(f?.message).toContain("charlie");
    expect(r.index!.invisible).toEqual(["charlie"]);
    expect(r.healthy).toBe(false);
  });

  it("does NOT cry wolf over a merge tombstone or an unparsable note", async () => {
    const home = await storeWithTopics("idx-tomb");
    await mergeTopics(home, "bravo", "alpha"); // bravo becomes a tombstone file
    writeFileSync(fsPath(topicNotePath(home, "mangled")), "not frontmatter at all", "utf8");

    const r = runDoctor(baseOpts("tomb", { home }));
    // Both files exist with no index entry, and BOTH are omitted from
    // `invisible` on purpose — `reindex` drops tombstones and unparsable notes,
    // so neither is an INDEX defect.
    expect(r.index!.invisible).toEqual([]);
    expect(r.findings.some((f) => f.code === "index_blind")).toBe(false);
    // …but "not an index defect" is not "nothing to say". The unparsable note
    // used to fall through BOTH filters and be reported nowhere at all, which
    // is how a topic could vanish from list and search in silence. A tombstone
    // is still not reported: it is supposed to be gone.
    expect(r.index!.corrupt).toEqual(["mangled"]);
    const corrupt = r.findings.find((f) => f.code === "notes_unparsable");
    expect(corrupt).toBeTruthy();
    expect(corrupt!.level).toBe("fail");
    expect(corrupt!.message).toContain("mangled");
  });

  it("warns (not fails) on index entries whose file is gone, and on a stale index", async () => {
    const home = await storeWithTopics("idx-orphan");
    rmSync(fsPath(topicNotePath(home, "bravo")));

    const r = runDoctor(baseOpts("orphan", { home }));
    expect(r.index!.orphaned).toEqual(["bravo"]);
    const f = r.findings.find((x) => x.code === "index_orphan_entries");
    expect(f?.level).toBe("warn");
    expect(r.findings.some((x) => x.code === "index_blind")).toBe(false);
  });

  it("warns when index.json is older than the newest note/log", async () => {
    const home = await storeWithTopics("idx-stale");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(fsPath(storePaths(home).index), old, old);

    const r = runDoctor(baseOpts("stale", { home }));
    expect(r.index!.stale).toBe(true);
    const f = r.findings.find((x) => x.code === "index_stale");
    expect(f?.level).toBe("warn");
    expect(r.healthy).toBe(true); // stale ≠ blind: search still finds everything
  });

  it("encrypted store: reports the index UNVERIFIED rather than asserting it is fine", () => {
    const home = freshHome("idx-enc");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    wipeSessionCache(home);

    const r = runDoctor(baseOpts("enc", { home }));
    expect(r.mode).toBe("encrypted-locked");
    expect(r.index!.indexPresent).toBe(true);
    expect(r.index!.entriesVerified).toBe(false);
    expect(r.index!.unverifiedReason).toContain("encrypted");
    // Honest: an info that says "not compared", never a silent clean bill.
    expect(r.findings.find((f) => f.code === "index_unverified")?.level).toBe("info");
    // And no invented index failure from reading ciphertext as "unparsable".
    expect(r.findings.some((f) => f.code === "index_blind")).toBe(false);
    expect(r.findings.some((f) => f.code === "index_missing")).toBe(false);
  });

  it("doctor still writes NOTHING, even with a broken index in front of it", async () => {
    const home = await storeWithTopics("idx-readonly");
    rmSync(fsPath(storePaths(home).index));
    const before = fingerprint(home);
    runDoctor(baseOpts("readonly", { home }));
    expect(fingerprint(home)).toEqual(before);
    expect(existsSync(fsPath(storePaths(home).index))).toBe(false);
  });
});

describe("the read path repairs the index (D1 self-heal)", () => {
  it("search on an index-less store rebuilds it and returns the hit", async () => {
    const home = await storeWithTopics("idx-heal-search");
    rmSync(fsPath(storePaths(home).index));

    const { hits } = await search(home, "alpha");
    expect(hits.map((h) => h.id)).toContain("alpha");
    expect(existsSync(fsPath(storePaths(home).index))).toBe(true);
    const rebuilt = await readIndex(home);
    expect(Object.keys(rebuilt!.topics).sort()).toEqual(
      ["alpha", "bravo", "gestalt-example"].sort(),
    );
  });

  it("a WRITE on an index-less store does not leave a one-entry index behind", async () => {
    const home = await storeWithTopics("idx-heal-write");
    rmSync(fsPath(storePaths(home).index));

    // `log` loads the index inside the write lock, mutates one entry, writes it
    // back. Without the repair that produced an index holding ONLY this topic.
    await appendLog(
      home,
      "alpha",
      { type: "pattern", project: "p", agent: "t", summary: "after the wipe" },
      { now: clockAt(9000) },
    );
    const after = await readIndex(home);
    expect(Object.keys(after!.topics).sort()).toEqual(
      ["alpha", "bravo", "gestalt-example"].sort(),
    );
  });

  it("a LOCK-HOLDING caller rebuilds a stale index and never moves the store clock backwards", async () => {
    const home = await storeWithTopics("idx-heal-stale");
    const before = await readIndex(home);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(fsPath(storePaths(home).index), old, old);

    const index = await loadIndexOrEmpty(home, { underLock: true });
    expect(index.lastTimestamp).toBe(before!.lastTimestamp);
    expect(statSync(fsPath(storePaths(home).index)).mtimeMs).toBeGreaterThan(
      old.getTime(),
    );
  });

  it("a lock-free READER does not rebuild a merely stale index (it would starve writers)", async () => {
    const home = await storeWithTopics("idx-stale-reader");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(fsPath(storePaths(home).index), old, old);

    // Measured regression, 2026-08-01: acting on staleness from the lock-free
    // read path made `contention-processes` fail — a reader sampling between a
    // writer's log write and its index write reindexes the whole store, and at
    // hundreds of reads/sec that starved the writer into a hard E_LOCKED.
    // Retrieval is unaffected: the stale index still lists every topic.
    const { hits } = await search(home, "alpha");
    expect(hits.map((h) => h.id)).toContain("alpha");
    expect(statSync(fsPath(storePaths(home).index)).mtimeMs).toBe(old.getTime());

    // A normal WRITE refreshes it, under the lock where that is race-free.
    await appendLog(
      home,
      "alpha",
      { type: "pattern", project: "p", agent: "t", summary: "a later write" },
      { now: clockAt(9000) },
    );
    expect(statSync(fsPath(storePaths(home).index)).mtimeMs).toBeGreaterThan(
      old.getTime(),
    );
  });

  it("leaves a healthy store's index byte-identical (no rebuild churn on reads)", async () => {
    const home = await storeWithTopics("idx-noop");
    const before = statSync(fsPath(storePaths(home).index)).mtimeMs;
    await search(home, "alpha");
    await search(home, "bravo");
    await loadIndexOrEmpty(home);
    expect(statSync(fsPath(storePaths(home).index)).mtimeMs).toBe(before);
  });

  it("an empty store is not rebuilt on every read (nothing to index)", () => {
    const home = freshHome("idx-empty");
    mkdirSync(fsPath(path.join(home, "topics")), { recursive: true });
    const integrity = checkIndexIntegrity(home);
    expect(integrity.topicFiles).toBe(0);
    expect(integrity.indexPresent).toBe(false);
  });

  it("the repair is ANNOUNCED: telemetry records it and doctor reports it", async () => {
    const home = await storeWithTopics("idx-announce");
    rmSync(fsPath(storePaths(home).index));
    await search(home, "alpha");

    const repair = readTelemetry(home)!.lastIndexRepair!;
    expect(repair.reason).toBe("missing");
    expect(repair.topics).toBe(3);

    const r = runDoctor(baseOpts("announce", { home }));
    const f = r.findings.find((x) => x.code === "index_auto_rebuilt");
    expect(f?.level).toBe("info");
    expect(f?.message).toContain("missing");
    // The store is whole again, so the FAIL is gone — but the repair is not
    // silent: it is on the report.
    expect(r.findings.some((x) => x.code === "index_missing")).toBe(false);
    expect(r.healthy).toBe(true);
  });

  /**
   * A REPAIR MAY NOT DELETE WHAT IT CANNOT READ.
   *
   * Reproduced end to end before the fix: a store with topics alpha/beta, alpha
   * left with git conflict markers and a new file added to topics/ (which is
   * exactly what a `git pull` looks like: the directory mtime bumps and one
   * file is conflicted). BEFORE any write, `list` still showed alpha and
   * `search` printed "! topic alpha unparsable; skipped" — the user could SEE
   * the damage. One `log` fired the under-lock staleness rebuild, `reindex`
   * silently skipped alpha, the narrowed index was persisted, and afterwards
   * `list` no longer showed alpha and `search alpha` printed "No topics match"
   * with no warning at all. Doctor reported only an `info` line. That is the
   * D1 silence this whole area exists to kill, newly created by the fix for it.
   */
  it("a rebuild that cannot parse a note does NOT drop it from a readable index", async () => {
    const home = await storeWithTopics("idx-corrupt-keep");
    writeFileSync(fsPath(topicNotePath(home, "alpha")), "<<<<<<< HEAD\nconflict\n", "utf8");
    // Make the index look stale, the way a pull that lands new files does.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(fsPath(storePaths(home).index), old, old);
    const before = await readIndex(home);
    expect(Object.keys(before!.topics)).toContain("alpha");

    // The under-lock path is the one that fires on a write.
    const index = await loadIndexOrEmpty(home, { underLock: true });
    expect(Object.keys(index.topics), "alpha must not be dropped").toContain("alpha");
    // Nothing was persisted over the good index either.
    const after = await readIndex(home);
    expect(Object.keys(after!.topics)).toContain("alpha");

    // …and doctor names the real problem, at fail level.
    const r = runDoctor(baseOpts("corrupt-keep", { home }));
    expect(r.index!.corrupt).toContain("alpha");
    expect(r.findings.some((f) => f.code === "notes_unparsable" && f.level === "fail")).toBe(true);
    expect(r.healthy).toBe(false);
  });

  it("when there is no index to preserve, the narrowed rebuild REPORTS what it dropped", async () => {
    // The other half: with index.json gone there is nothing to keep, so the
    // rebuild is written — but the ids it could not parse ride along on the
    // repair record so doctor can raise them instead of saying only `info`.
    const home = await storeWithTopics("idx-corrupt-drop");
    writeFileSync(fsPath(topicNotePath(home, "alpha")), "<<<<<<< HEAD\nconflict\n", "utf8");
    rmSync(fsPath(storePaths(home).index));

    await search(home, "bravo");

    const repair = readTelemetry(home)!.lastIndexRepair!;
    expect(repair.skipped).toEqual(["alpha"]);

    const r = runDoctor(baseOpts("corrupt-drop", { home }));
    const dropped = r.findings.find((f) => f.code === "index_rebuild_dropped");
    expect(dropped, "the drop must be reported, not left as an info line").toBeTruthy();
    expect(dropped!.level).toBe("fail");
    expect(dropped!.message).toContain("alpha");
    expect(r.healthy).toBe(false);
  });
});
