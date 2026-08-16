/**
 * CONCURRENT WRITERS to one store (probe, 2026-07-28).
 *
 * FIMemory's whole claim is that many AI tools share ONE store. The
 * atomic-rename fix (src/store/atomic.ts) covered the READ side of that: a
 * reader holding a file open while a writer renames over it. This file probes
 * the WRITE side — several writers hitting one store at once. Do all the writes
 * land? Is the loser of a race a clean typed error? Does the single store lock
 * (src/store/lock.ts) actually serialise them, and at what granularity?
 *
 * Real ops only (appendLog / createTopic / updateTopic / reindexStore) against
 * a scratch plaintext store. No vendor CLI is spawned.
 *
 * ONE TEST IN HERE FAILS ON PURPOSE — see "60 queued appends". It documents a
 * live defect: a healthy store rejects its own writes past ~50 queued writers,
 * because `withLock` retries on a fixed 100 ms tick with no wake-on-release.
 */
import { promises as fsp } from "node:fs";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { DEFAULT_CONFIG, serializeConfig } from "../src/config.js";
import { GestaltError } from "../src/errors.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { updateTopic } from "../src/ops/update.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { readIndex, reindex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { listProposals } from "../src/store/proposals.js";
import { readText } from "../src/store/read.js";
import { freshHome } from "./helpers.js";

/** `init` seeds the `gestalt-example` topic and one pending proposal (#1). */
const SEEDED_TOPIC = "gestalt-example";

function initStore(label = "contention"): string {
  const home = freshHome(label);
  runInit({ home });
  return home;
}

/** Rewrite config.json with an override (these probe budgets, not the ops). */
function setConfig(home: string, patch: Partial<typeof DEFAULT_CONFIG>): void {
  writeFileSync(
    fsPath(storePaths(home).config),
    serializeConfig({ ...DEFAULT_CONFIG, ...patch }),
    "utf8",
  );
}

const entry = (summary: string) =>
  ({ type: "decision", project: "p", agent: "x", summary }) as const;

function asGestalt(err: unknown): GestaltError {
  expect(err).toBeInstanceOf(GestaltError);
  return err as GestaltError;
}

/** Split a settled batch into fulfilled values and rejection reasons. */
function split<T>(results: PromiseSettledResult<T>[]): {
  ok: T[];
  failed: unknown[];
} {
  const ok: T[] = [];
  const failed: unknown[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(r.value);
    else failed.push(r.reason);
  }
  return { ok, failed };
}

/** Read a topic's log straight off disk and parse it with the store's parser. */
async function readLog(
  home: string,
  id: string,
): Promise<ReturnType<typeof parseLog>> {
  const text = await readText(topicLogPath(home, id));
  expect(text).not.toBeNull();
  return parseLog(text as string, id);
}

/** A note body proposing `marker`, built from the topic's real current note. */
async function proposalFor(
  home: string,
  id: string,
  marker: string,
): Promise<string> {
  const note = parseNote((await readText(topicNotePath(home, id))) as string, id)!;
  return `---\nid: ${id}\ntitle: ${note.title}\nupdated: ${note.updated}\n---\n\n${note.title}\n\n${marker}\n\n## Owner notes\n`;
}

describe("concurrent writers: N parallel appends to the SAME topic", () => {
  it("40 in-process appends all survive and the log parses cleanly", async () => {
    const home = initStore();
    await createTopic(home, "hot-topic", "Hot");

    const N = 40;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        appendLog(home, "hot-topic", entry(`append-${i}`)),
      ),
    );
    const { ok, failed } = split(results);
    // A healthy store with no other process on it must not reject a write.
    expect(failed.map((f) => asGestalt(f).code)).toEqual([]);
    expect(ok).toHaveLength(N);

    const { entries, warnings } = await readLog(home, "hot-topic");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(N);

    // No lost update: every summary is present exactly once.
    expect(entries.map((e) => e.summary).sort()).toEqual(
      Array.from({ length: N }, (_, i) => `append-${i}`).sort(),
    );

    // No interleaved corruption: timestamps unique and strictly increasing.
    const stamps = entries.map((e) => e.timestamp);
    expect(new Set(stamps).size).toBe(N);
    expect([...stamps].sort()).toEqual(stamps);

    // The timestamps handed back to callers are exactly what landed.
    expect(ok.map((r) => r.timestamp).sort()).toEqual([...stamps].sort());

    // The index agrees with a from-files rebuild.
    const idx = await readIndex(home);
    expect(idx!.topics["hot-topic"]!.logEntries).toBe(N);
    expect(idx).toEqual((await reindex(home)).index);
  }, 60_000);

  it("the log file never contains a torn or partial entry block", async () => {
    const home = initStore();
    await createTopic(home, "torn", "Torn");
    const { failed } = split(
      await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) =>
          appendLog(home, "torn", {
            ...entry(`s${i}`),
            body: `body line for ${i}\nsecond line for ${i}`,
          }),
        ),
      ),
    );
    expect(failed).toEqual([]);

    const text = (await readText(topicLogPath(home, "torn"))) as string;
    expect(text.startsWith("# torn log\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    // Every entry that opened also closed: header count == parsed entry count,
    // and each parsed block still carries both of its body lines.
    const headers = text.split("\n").filter((l) => l.startsWith("### ")).length;
    const { entries, warnings } = parseLog(text, "torn");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(headers);
    expect(entries).toHaveLength(24);
    for (const e of entries) {
      expect(e.raw.split("\n")).toHaveLength(4); // header + summary + 2 body lines
    }
  }, 60_000);
});

describe("concurrent writers: parallel appends to DIFFERENT topics", () => {
  const IDS = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "hotel",
    "india",
  ];

  it("8 topics x 4 appends — every entry lands on its own topic", async () => {
    const home = initStore();
    for (const id of IDS) await createTopic(home, id, id.toUpperCase());

    const jobs: Promise<unknown>[] = [];
    for (const id of IDS) {
      for (let i = 0; i < 4; i++) jobs.push(appendLog(home, id, entry(`${id}-e${i}`)));
    }
    const { failed } = split(await Promise.allSettled(jobs));
    expect(failed.map((f) => asGestalt(f).code)).toEqual([]);

    const all: string[] = [];
    for (const id of IDS) {
      const { entries, warnings } = await readLog(home, id);
      expect(warnings).toEqual([]);
      expect(entries.map((e) => e.summary).sort()).toEqual(
        Array.from({ length: 4 }, (_, i) => `${id}-e${i}`).sort(),
      );
      all.push(...entries.map((e) => e.timestamp));
    }
    // Timestamps are strictly increasing PER STORE (SPEC §4 rev 4), so no two
    // topics may share one — that is what makes `supersedes` a stable id.
    expect(new Set(all).size).toBe(all.length);

    expect(await readIndex(home)).toEqual((await reindex(home)).index);
  }, 60_000);

  it("the lock is PER-STORE, not per-file: an unrelated topic is blocked too", async () => {
    const home = initStore();
    await createTopic(home, "alpha", "Alpha");
    await createTopic(home, "bravo", "Bravo");
    setConfig(home, { lockWaitMs: 0 });

    const paths = storePaths(home);
    const release = await lockfile.lock(fsPath(paths.home), {
      lockfilePath: fsPath(paths.lockfile),
      realpath: false,
      stale: 60_000,
      retries: 0,
    });
    try {
      // Nothing about `bravo` is held — only the one store-wide lockfile is.
      const err = await appendLog(home, "bravo", entry("blocked")).catch(
        (e: unknown) => e,
      );
      expect(asGestalt(err).code).toBe("E_LOCKED");
      // Granularity, documented: one writer anywhere in the store stops every
      // other writer on every other topic. Safe, but it means write throughput
      // is a single store-wide queue, never per-topic.
    } finally {
      await release();
    }

    // The blocked write left nothing behind.
    expect((await readLog(home, "bravo")).entries).toHaveLength(0);
    expect(await readIndex(home)).toEqual((await reindex(home)).index);
  }, 30_000);

  it("a crashed writer's lock wedges EVERY writer until the 60 s stale window", async () => {
    const home = initStore();
    await createTopic(home, "alpha", "Alpha");
    setConfig(home, { lockWaitMs: 0 });
    const paths = storePaths(home);

    // A process that died holding the lock leaves exactly this: the lock
    // directory, with no owner. proper-lockfile has no liveness check — it
    // only ages the lock out by mtime against `stale` (60 s in lock.ts).
    mkdirSync(fsPath(paths.lockfile));

    const err = await appendLog(home, "alpha", entry("after crash")).catch(
      (e: unknown) => e,
    );
    expect(asGestalt(err).code).toBe("E_LOCKED");

    // Age the abandoned lock past the stale window; the store frees itself.
    const old = new Date(Date.now() - 120_000);
    utimesSync(fsPath(paths.lockfile), old, old);
    await appendLog(home, "alpha", entry("recovered"));
    expect((await readLog(home, "alpha")).entries.map((e) => e.summary)).toEqual([
      "recovered",
    ]);
  }, 30_000);
});

describe("concurrent writers: parallel createTopic of the SAME id", () => {
  it("exactly one wins; losers are clean typed errors, never a half-topic", async () => {
    const home = initStore();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createTopic(home, "dup-race", "Dup Race")),
    );
    const { ok, failed } = split(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) {
      // A loser must be told "already exists" — not a lock timeout, not the
      // fuzzy-collision error, and never a raw EEXIST/ENOENT from fs.
      expect(asGestalt(f).code).toBe("E_EXISTS");
    }

    // No corrupt half-topic: the note parses, the log parses, both exist once.
    const noteText = await readText(topicNotePath(home, "dup-race"));
    expect(noteText).not.toBeNull();
    const note = parseNote(noteText as string, "dup-race");
    expect(note).not.toBeNull();
    expect(note!.title).toBe("Dup Race");
    expect((await readLog(home, "dup-race")).entries).toHaveLength(0);

    const idx = await readIndex(home);
    expect(Object.keys(idx!.topics).sort()).toEqual([SEEDED_TOPIC, "dup-race"].sort());
    expect(idx).toEqual((await reindex(home)).index);
  }, 30_000);

  it("a create racing appends to it either wins-then-accepts or is cleanly rejected", async () => {
    const home = initStore();
    // The topic does not exist yet, so the appends may legitimately lose.
    const settled = await Promise.allSettled([
      createTopic(home, "late", "Late"),
      appendLog(home, "late", entry("early-1")),
      appendLog(home, "late", entry("early-2")),
    ]);
    const { failed } = split(settled);
    for (const f of failed) {
      // Losing an append to a not-yet-created topic is E_NOT_FOUND, the
      // documented answer. E_SCHEMA or a raw fs error would mean a caller had
      // observed a partially-created topic.
      expect(asGestalt(f).code).toBe("E_NOT_FOUND");
    }
    expect((await readLog(home, "late")).warnings).toEqual([]);
    expect(await readIndex(home)).toEqual((await reindex(home)).index);
  }, 30_000);
});

describe("concurrent writers: parallel updateTopic proposals", () => {
  it("12 parallel proposals get 12 distinct seqs and 12 distinct files", async () => {
    const home = initStore();
    await createTopic(home, "proposed", "Proposed");
    const base = (await readText(topicNotePath(home, "proposed"))) as string;
    const before = await listProposals(home); // init seeds one

    const N = 12; // stays under the default maxPendingProposals (20)
    const bodies = await Promise.all(
      Array.from({ length: N }, (_, i) => proposalFor(home, "proposed", `revision ${i}`)),
    );
    const results = await Promise.allSettled(
      bodies.map((body, i) =>
        updateTopic(home, "proposed", body, { proposer: `agent-${i}` }),
      ),
    );
    const { ok, failed } = split(results);
    expect(failed.map((f) => asGestalt(f).code)).toEqual([]);
    expect(ok).toHaveLength(N);

    // THE probe: two proposals must never be handed the same seq, or the
    // second silently overwrites the first's file — a lost suggested edit.
    expect(new Set(ok.map((r) => r.seq)).size).toBe(N);

    const files = (await fsp.readdir(fsPath(storePaths(home).proposalsDir))).filter(
      (f) => f.endsWith(".md"),
    );
    expect(files).toHaveLength(before.length + N);

    const proposals = await listProposals(home);
    expect(proposals).toHaveLength(before.length + N);
    expect(new Set(proposals.map((p) => p.seq)).size).toBe(before.length + N);
    // Every proposer survived — none was clobbered by a seq collision.
    const mine = proposals.filter((p) => p.id === "proposed");
    expect(new Set(mine.map((p) => p.proposer)).size).toBe(N);

    // Proposals never touch the note itself.
    expect(await readText(topicNotePath(home, "proposed"))).toBe(base);
  }, 60_000);

  it("the pending cap is enforced exactly once, not raced past", async () => {
    const home = initStore();
    setConfig(home, { maxPendingProposals: 5 });
    await createTopic(home, "capped", "Capped");
    const seeded = (await listProposals(home)).filter((p) => p.status === "pending").length;
    const room = 5 - seeded;

    const bodies = await Promise.all(
      Array.from({ length: 12 }, (_, i) => proposalFor(home, "capped", `rev ${i}`)),
    );
    const results = await Promise.allSettled(
      bodies.map((body, i) => updateTopic(home, "capped", body, { proposer: `agent-${i}` })),
    );
    const { ok, failed } = split(results);
    // The cap is a store invariant: concurrency must not let writers past it.
    expect(ok).toHaveLength(room);
    expect(failed.map((f) => asGestalt(f).code)).toEqual(
      Array.from({ length: 12 - room }, () => "E_PROPOSAL_CAP"),
    );
    expect(
      (await listProposals(home)).filter((p) => p.status === "pending"),
    ).toHaveLength(5);
  }, 60_000);
});

describe("concurrent writers: append racing reindex", () => {
  it("interleaved reindexes never drop an append or rewind the store clock", async () => {
    const home = initStore();
    const ids = ["alpha", "mango", "zulu"];
    for (const id of ids) await createTopic(home, id, id);

    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(appendLog(home, ids[i % ids.length]!, entry(`r${i}`)));
      if (i % 3 === 0) jobs.push(reindexStore(home));
    }
    const { failed } = split(await Promise.allSettled(jobs));
    expect(failed.map((f) => asGestalt(f).code)).toEqual([]);

    const idx = await readIndex(home);
    expect(idx).toEqual((await reindex(home)).index);

    let total = 0;
    const stamps: string[] = [];
    for (const id of ids) {
      const { entries, warnings } = await readLog(home, id);
      expect(warnings).toEqual([]);
      total += entries.length;
      stamps.push(...entries.map((e) => e.timestamp));
    }
    expect(total).toBe(12);
    expect(new Set(stamps).size).toBe(12);

    // The global monotonic watermark must still cover every issued timestamp:
    // a reindex that rewound it would let the next append reissue a live
    // timestamp and break `supersedes` (SPEC §4).
    const newest = [...stamps].sort().at(-1)!;
    expect(idx!.lastTimestamp).not.toBeNull();
    expect(idx!.lastTimestamp! >= newest).toBe(true);

    // And prove it end-to-end: one more append is strictly newer than all.
    const after = await appendLog(home, "alpha", entry("after-reindex"));
    expect(after.timestamp > newest).toBe(true);
  }, 60_000);
});

describe("concurrent writers: the lock's retry budget under a burst", () => {
  /**
   * FAILING ON PURPOSE — this documents a live defect, not a flaky test.
   *
   * `withLock` (src/store/lock.ts) builds proper-lockfile's retry schedule as
   * `retries: ceil(lockWaitMs / 100)` with `minTimeout: maxTimeout: 100,
   * factor: 1`. There is no wake-on-release and no randomization: every waiter
   * sleeps a FIXED 100 ms and re-polls. So the store hands the lock off at most
   * ~10 times per second no matter how fast the op is, and the default
   * lockWaitMs of 5000 buys only ~50 handoffs before a waiter is refused.
   *
   * Consequence for the product's own premise (~10 tools on one store): a
   * healthy store that nothing else is touching starts rejecting its OWN writes
   * with E_LOCKED once ~50 writes are queued. The counts below are not
   * machine-dependent — they follow from 5000/100.
   */
  it("60 queued appends on the default 5 s budget: none may be rejected", async () => {
    const home = initStore();
    await createTopic(home, "burst", "Burst");

    const N = 60;
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => appendLog(home, "burst", entry(`b${i}`))),
    );
    const elapsed = Date.now() - started;
    const { ok, failed } = split(results);
    const locked = failed.filter((f) => asGestalt(f).code === "E_LOCKED");

     
    console.log(
      `[burst] ${ok.length}/${N} landed, ${locked.length} rejected E_LOCKED, ${elapsed} ms`,
    );

    // What is NOT broken, asserted first so a fix is not credited for it: the
    // rejected writes are refused cleanly, never half-written, and everything
    // that was accepted is intact on disk.
    const { entries, warnings } = await readLog(home, "burst");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(ok.length);
    expect(failed).toHaveLength(locked.length);

    // THE DEFECT: a store nobody else is touching refuses its own writes.
    expect(locked).toHaveLength(0);
  }, 120_000);

  it("a contended write costs a fixed 100 ms tick, ~20x the work it does", async () => {
    const home = initStore();
    await createTopic(home, "serial", "Serial");
    await createTopic(home, "parallel", "Parallel");

    const N = 20;
    const serialStart = Date.now();
    for (let i = 0; i < N; i++) await appendLog(home, "serial", entry(`s${i}`));
    const serialMs = Date.now() - serialStart;

    const parallelStart = Date.now();
    const { failed } = split(
      await Promise.allSettled(
        Array.from({ length: N }, (_, i) => appendLog(home, "parallel", entry(`p${i}`))),
      ),
    );
    const parallelMs = Date.now() - parallelStart;
    expect(failed).toEqual([]);

     
    console.log(
      `[handoff] ${N} appends: ${serialMs} ms serial vs ${parallelMs} ms contended ` +
        `(${(parallelMs / N).toFixed(0)} ms per contended handoff)`,
    );

    // Same N writes, same bytes. Serial measures the real cost of the work
    // (~4 ms each here). Contended, each write costs a full fixed 100 ms retry
    // tick because nothing wakes a waiter when the lock frees — so the ceiling
    // is ~10 store-wide writes/second however fast the disk is. A number at or
    // above the tick proves waiters are sleeping the whole interval.
    expect(parallelMs / N).toBeLessThan(50);
  }, 120_000);
});
