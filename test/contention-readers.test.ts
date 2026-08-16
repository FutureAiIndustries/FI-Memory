/**
 * Read consistency while writes happen (2026-07-28).
 *
 * The premise FIMemory sells is that MANY AI TOOLS SHARE ONE STORE. The
 * rename-retry fix (`test/atomic-rename-contention.test.ts`) proved a *write*
 * survives a reader holding the target open. It said nothing about what the
 * readers themselves see, and nothing about what the store looks like when a
 * write loses that race anyway.
 *
 * These probes hammer the read surface an agent actually uses — `readNoteFull`,
 * `get`, `search`, and the raw `index.json` — while writes proceed, and ask
 * four questions:
 *
 *   1. does a reader ever observe a note that is empty, truncated, or missing
 *      its frontmatter mid-write?
 *   2. does `search` ever throw or return a malformed hit while `reindex`
 *      rewrites the index under it?
 *   3. is `index.json` ever observed half-written (parse failure / null read)?
 *   4. once the writes settle, does the index agree with the files on disk?
 *
 * Result (measured 2026-07-28, Windows 11, Node 20): 1, 2 and 3 HOLD — the
 * atomic-rename discipline really does keep readers off torn bytes, `search`
 * never throws or invents a hit while `reindex` rewrites under it, and
 * `index.json` never reads back partial or empty. 4 holds under clean
 * concurrency.
 *
 * Two tests here fail, and both are real defects, not probe artifacts. Both are
 * marked `it.fails` (2026-07-30) so the suite is green while the bugs are open
 * and turns RED the day one starts passing — see docs/DEFECT-REGISTRY.md.
 * **Both are also `runIf(win32)`-gated**, because both failures are
 * Windows-specific by construction and both PASS on POSIX, which `it.fails`
 * would report as a suite failure. Do not remove the gates; the reasoning is at
 * each call site.
 *
 *   • `a handful of ordinary readers does not push a single note write near
 *     E_LOCKED` — six readers doing nothing but `readNoteFull` make EVERY note
 *     write fail with E_LOCKED. The 2026-07-28 retry-budget fix bought time, not
 *     a landing, and the 2026-07-30 rename-wait change made it slower rather
 *     than better: all 5 writes still fail, each burning the full
 *     RENAME_WAIT_MS = 30_000, ~150 s for the loop, and the write never lands.
 *     **Those are the current numbers; the ~2.7 s figure this header used to
 *     quote, and the reader-latency table further down, both predate the
 *     rename-wait change.** The measurement of record and the reason the probe
 *     carries a 240 s timeout are in the RE-MEASURED block at the test itself —
 *     read that before touching the timeout, because `it.fails` treats a
 *     TIMEOUT as the expected failure, so a budget under the real ~150 s of
 *     work makes this test permanently green without ever evaluating its
 *     assertion. This is the shipped premise (ten MCP servers on one store)
 *     failing at six.
 *
 *   • `a write that fails at the index step leaves no topic the index cannot
 *     see` — a mutating op is three separate atomic writes with no rollback, so
 *     an op that REPORTS failure still leaves a topic on disk that the index,
 *     and therefore `search`, will never see.
 *
 * Note-file churn is driven through `writeFileAtomic` directly — the exact call
 * `ops/review.ts` makes when it applies an approved proposal — because it gives
 * a wide, controllable write window with two byte-exact expected contents, so
 * any torn read is unambiguous.
 */
import { promises as fsp, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { GestaltError } from "../src/errors.js";
import { readNoteFull } from "../src/index.js";
import { createTopic } from "../src/ops/create.js";
import { get } from "../src/ops/get.js";
import { appendLog } from "../src/ops/logOp.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { search } from "../src/ops/search.js";
import { fsPath, storePaths, topicNotePath } from "../src/paths.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import { readIndex } from "../src/store/index.js";
import { parseNote, serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";
import { clockAt, freshHome, tickingClock } from "./helpers.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function initStore(): string {
  const home = freshHome("contention");
  runInit({ home });
  return home;
}

function codeOf(err: unknown): string {
  if (err instanceof GestaltError) return err.code;
  return err instanceof Error ? err.message : String(err);
}

const entry = (summary: string) =>
  ({ type: "pattern", project: "p", agent: "probe", summary }) as const;

// ── 1. torn note reads ───────────────────────────────────────────────────────

const CHURN = "churn-topic";

function churnNote(body: string): string {
  const note: TopicNote = {
    id: CHURN,
    title: "Churn Topic",
    aliases: [],
    tags: [],
    projects: [],
    updated: "2026-07-28T00:00:00.000Z",
    compactedThrough: null,
    mergedInto: null,
    body,
  };
  return serializeNote(note);
}

/** Two byte-exact contents: anything else a reader sees is a torn read. */
const SMALL_NOTE = churnNote("\nSmall body.\n\n## Owner notes\n\nEND-OF-NOTE\n");
const LARGE_NOTE = churnNote(
  "\n" +
    "Large body line, wide enough that a write window actually exists.\n".repeat(150) +
    "\n## Owner notes\n\nEND-OF-NOTE\n",
);

/** A short, legible description of a read that matched neither expected form. */
function describeTear(text: string): string {
  const head = JSON.stringify(text.slice(0, 48));
  const tail = JSON.stringify(text.slice(-32));
  return `torn note read: ${text.length} bytes, head=${head} tail=${tail}`;
}

describe("read consistency while writes happen", () => {
  it("never serves an empty, truncated, or frontmatter-less note mid-write", async () => {
    const home = initStore();
    await createTopic(home, CHURN, "Churn Topic", { now: clockAt(1000) });
    const notePath = topicNotePath(home, CHURN);
    // Prime the file to one of the two expected forms before any reader starts,
    // so the `create` skeleton isn't mistaken for a tear.
    await writeFileAtomic(notePath, SMALL_NOTE);
    const expected = new Set([SMALL_NOTE, LARGE_NOTE]);

    const defects: string[] = [];
    const writeFailures: string[] = [];
    let reads = 0;
    let writes = 0;
    // Two readers with a real yield between cycles, not six in a tight loop:
    // this probe is about WHAT a reader sees, and it needs writes to actually
    // land. What heavier reader pressure costs the writer is the next test.
    const deadline = Date.now() + 4000;

    const writer = (async (): Promise<void> => {
      for (let i = 0; Date.now() < deadline; i++) {
        try {
          await writeFileAtomic(notePath, i % 2 === 0 ? LARGE_NOTE : SMALL_NOTE);
          writes += 1;
        } catch (err) {
          writeFailures.push(codeOf(err));
        }
        await sleep(2);
      }
    })();

    const reader = async (): Promise<void> => {
      while (Date.now() < deadline) {
        // (a) the human/sidebar surface — the editing base for an `update`.
        try {
          const full = await readNoteFull(home, CHURN);
          reads += 1;
          if (!expected.has(full.text)) defects.push(describeTear(full.text));
          if (parseNote(full.text, CHURN) === null) {
            defects.push("readNoteFull returned a note with no usable frontmatter");
          }
          if (full.bytes !== Buffer.byteLength(full.text, "utf8")) {
            defects.push("readNoteFull byte count disagrees with its own text");
          }
        } catch (err) {
          // A live topic that momentarily reads as "No topic" would be the
          // agent-visible form of this bug.
          defects.push(`readNoteFull threw ${codeOf(err)} for a topic that exists`);
        }

        // (b) the agent surface — `get` must never drop a live topic as corrupt.
        const res = await get(home, [CHURN]);
        if (res.topics.length !== 1) {
          defects.push(
            `get dropped "${CHURN}": ${res.warnings.map((w) => w.message).join("; ")}`,
          );
        } else if (res.topics[0]!.body.trim().length === 0) {
          defects.push("get served an empty body");
        }
        await sleep(20);
      }
    };

    await Promise.all([writer, reader(), reader()]);

    // The probe has to have actually raced something.
    expect(writes).toBeGreaterThan(10);
    expect(reads).toBeGreaterThan(100);
    expect(defects).toEqual([]);
    // Readers holding notes open must not starve the writer into E_LOCKED.
    expect(writeFailures).toEqual([]);
  }, 60_000);

  // ── 1b. what that contention costs the writer ─────────────────────────────

  /**
   * The read side of the same race, and this one FAILS.
   *
   * Every reader here is doing nothing exotic — `readNoteFull`, the sidebar's
   * own call — but on Windows each open refuses a rename over the file, so the
   * writer burns its jittered backoff. Measured on this box (2026-07-28) —
   * SUPERSEDED, see the RE-MEASURED block below the table; kept for the shape of
   * the contention curve, not for its numbers:
   *
   *   readers   write latency
   *   0–1       1–3 ms
   *   2         1–3 ms, with occasional ~1.2 s stalls (7 retries)
   *   6         100% E_LOCKED after ~2.7 s
   *
   * The retry ladder is the wrong shape for this contention. A reader's open
   * window is ~1 ms, but the ladder sleeps up to 400 ms per attempt and only
   * gets 12 attempts — so it spends its whole 2.5 s budget asleep while the
   * target is free, and gets ~12 samples of a race it needs to win once. Many
   * cheap attempts (poll every few ms for the same wall-clock budget), or
   * sidestepping the race entirely (open the target with FILE_SHARE_DELETE, or
   * fall back to write-in-place after N failed renames), would land immediately
   * where this fails outright.
   *
   * RE-MEASURED 2026-07-30 — the numbers above predate the rename-wait change.
   * `store/atomic.ts` now waits `RENAME_WAIT_MS = 30_000` per rename (option (d),
   * "treat rename contention as a DELAY, not a drop"), not the ~2.5 s ladder the
   * table describes. The defect did not improve; it got slower and more total:
   * all 5 writes still fail, each burning the full 30 s budget (150 s for the
   * loop) while 6 readers complete ~750,000 reads. The write NEVER lands.
   *
   * That is why this probe carries a 240 s timeout rather than the 60 s it had.
   * `it.fails` treats a TIMEOUT as the expected failure, so at 60 s this test
   * went green without its assertion ever being evaluated — which would have
   * kept it green even if the E_LOCKED defect were fixed but the probe stayed
   * slow. The budget must exceed the work for the tripwire to mean anything.
   */
  // EXPECTED FAILURE (`it.fails`) — open defect, see docs/DEFECT-REGISTRY.md.
  //
  // WINDOWS-GATED, and the gate is load-bearing rather than tidiness. The
  // failure is Windows-specific by construction: writes fail only because
  // `renameWithRetry` burns its whole RENAME_WAIT_MS budget against EPERM from
  // readers holding the target open, and POSIX does not produce EPERM here. On
  // POSIX all five writes land in single-digit ms, `writeFailures` is empty and
  // the assertion PASSES — which `it.fails` then converts into a suite failure
  // ("Expect test to fail") for a non-regression. Without this gate a POSIX
  // `npm test` goes red on first checkout, and a reviewer who sees that message
  // routinely learns to dismiss the one signal that is supposed to announce a
  // real fix. `runIf` reports `skipped` off-Windows instead.
  it.runIf(process.platform === "win32").fails("a handful of ordinary readers does not push a single note write near E_LOCKED", async () => {
    const home = initStore();
    await createTopic(home, CHURN, "Churn Topic", { now: clockAt(1000) });
    const notePath = topicNotePath(home, CHURN);
    await writeFileAtomic(notePath, LARGE_NOTE);

    const latencies: number[] = [];
    const writeFailures: string[] = [];
    let stop = false;

    // Six readers = the ten-MCP-server dogfood shape, scaled to a test.
    const readers = Array.from({ length: 6 }, () => {
      return (async (): Promise<void> => {
        while (!stop) {
          try {
            await readNoteFull(home, CHURN);
          } catch {
            /* counted by the torn-read probe, not here */
          }
        }
      })();
    });

    try {
      for (let i = 0; i < 5; i++) {
        const started = Date.now();
        try {
          await writeFileAtomic(notePath, i % 2 === 0 ? SMALL_NOTE : LARGE_NOTE);
          latencies.push(Date.now() - started);
        } catch (err) {
          writeFailures.push(`${codeOf(err)} after ${Date.now() - started} ms`);
        }
      }
    } finally {
      stop = true;
      await Promise.all(readers);
    }

    const worst = Math.max(...latencies, 0);
    expect({ writeFailures, worstWriteMs: worst < 1500 ? "<1500" : worst }).toEqual({
      writeFailures: [],
      worstWriteMs: "<1500",
    });
  }, 240_000);

  // ── 2. search vs. reindex ──────────────────────────────────────────────────

  it("search never throws or yields a malformed hit while reindex rewrites the index", async () => {
    const home = initStore();
    const ids = ["sentinel-topic", "gardening", "helsinki", "zeppelin", "marmalade"];
    for (const id of ids) {
      await createTopic(home, id, `${id} title`, { now: clockAt(1000) });
    }
    const known = new Set([...ids, "gestalt-example"]);

    const defects: string[] = [];
    const writeFailures: string[] = [];
    let searches = 0;
    let rebuilds = 0;
    const clk = tickingClock(50_000);
    const deadline = Date.now() + 2000;

    const writer = (async (): Promise<void> => {
      for (let i = 0; Date.now() < deadline; i++) {
        try {
          await reindexStore(home);
          rebuilds += 1;
          await appendLog(home, ids[i % ids.length]!, entry(`churn ${i}`), { now: clk });
        } catch (err) {
          writeFailures.push(codeOf(err));
        }
      }
    })();

    const reader = async (): Promise<void> => {
      while (Date.now() < deadline) {
        try {
          const { hits, warnings } = await search(home, "sentinel");
          searches += 1;
          // A topic that is in the store the whole time must never go missing.
          if (!hits.some((h) => h.id === "sentinel-topic")) {
            defects.push(
              `search("sentinel") lost sentinel-topic (${hits.length} hits) mid-reindex`,
            );
          }
          for (const h of hits) {
            if (!known.has(h.id)) defects.push(`hit for unknown id "${h.id}"`);
            if (typeof h.title !== "string" || h.title.length === 0) {
              defects.push(`hit "${h.id}" has no title`);
            }
            if (typeof h.excerpt !== "string") defects.push(`hit "${h.id}" excerpt not a string`);
            if (!Number.isFinite(h.score) || h.score <= 0) {
              defects.push(`hit "${h.id}" has a non-finite/zero score (${h.score})`);
            }
            if (!Number.isFinite(h.noteTokens) || h.noteTokens < 0) {
              defects.push(`hit "${h.id}" has a bad noteTokens (${h.noteTokens})`);
            }
          }
          for (const w of warnings) {
            if (w.code === "E_CORRUPT_SKIPPED") {
              defects.push(`search reported corruption mid-write: ${w.message}`);
            }
          }
        } catch (err) {
          defects.push(`search threw ${codeOf(err)}`);
        }
        await sleep(1);
      }
    };

    await Promise.all([writer, reader(), reader(), reader()]);

    expect(rebuilds).toBeGreaterThan(2);
    expect(searches).toBeGreaterThan(20);
    expect(defects).toEqual([]);
    expect(writeFailures).toEqual([]);
  }, 60_000);

  // ── 3. index.json half-written ────────────────────────────────────────────

  it("index.json is never observed half-written (and never reads back as empty)", async () => {
    const home = initStore();
    const ids = ["gardening", "helsinki", "zeppelin", "marmalade", "trombone"];
    for (const id of ids) {
      await createTopic(home, id, `${id} title`, { now: clockAt(1000) });
    }
    const indexPath = fsPath(storePaths(home).index);
    const baseline = ids.length + 1; // + the init example; topics only ever grow here

    const defects: string[] = [];
    const writeFailures: string[] = [];
    let peeks = 0;
    const clk = tickingClock(60_000);
    const deadline = Date.now() + 2000;

    const writer = (async (): Promise<void> => {
      for (let i = 0; Date.now() < deadline; i++) {
        try {
          await appendLog(home, ids[i % ids.length]!, entry(`index churn ${i}`), { now: clk });
        } catch (err) {
          writeFailures.push(codeOf(err));
        }
      }
    })();

    const reader = async (): Promise<void> => {
      while (Date.now() < deadline) {
        // (a) raw bytes — a partial file would fail JSON.parse.
        try {
          const raw = readFileSync(indexPath, "utf8");
          peeks += 1;
          JSON.parse(raw) as unknown;
        } catch (err) {
          defects.push(`raw index.json read/parse failed: ${codeOf(err)}`);
        }
        // (b) the runtime's own reader. `readIndex` → null means every caller
        // through `loadIndexOrEmpty` silently sees an EMPTY store, and a writer
        // that then persists it would erase every topic from the index.
        const idx = await readIndex(home);
        if (idx === null) {
          defects.push("readIndex returned null — callers would see an empty store");
        } else if (Object.keys(idx.topics).length < baseline) {
          defects.push(
            `index shrank to ${Object.keys(idx.topics).length} topics (baseline ${baseline})`,
          );
        }
        await sleep(1);
      }
    };

    await Promise.all([writer, reader(), reader(), reader()]);

    expect(peeks).toBeGreaterThan(20);
    expect(defects).toEqual([]);
    expect(writeFailures).toEqual([]);
  }, 60_000);

  // ── 4. index vs. disk once everything settles ─────────────────────────────

  /** Topic ids whose note file exists on disk and is not a merge tombstone. */
  function liveIdsOnDisk(home: string): string[] {
    const dir = fsPath(storePaths(home).topicsDir);
    const live: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      const note = parseNote(readFileSync(fsPath(topicNotePath(home, id)), "utf8"), id);
      if (note && note.mergedInto === null) live.push(id);
    }
    return live.sort();
  }

  it("after the writes settle, the index and the files on disk name the same topics", async () => {
    const home = initStore();
    const seeded = ["gardening", "helsinki", "zeppelin"];
    for (const id of seeded) {
      await createTopic(home, id, `${id} title`, { now: clockAt(1000) });
    }
    const late = ["marmalade", "trombone", "quicksand"];

    const failures: string[] = [];
    const clk = tickingClock(70_000);
    const deadline = Date.now() + 1500;

    const reader = async (): Promise<void> => {
      while (Date.now() < deadline) {
        await search(home, "title");
        await get(home, seeded);
        await sleep(2);
      }
    };

    const writers = [
      (async (): Promise<void> => {
        for (const id of late) {
          try {
            await createTopic(home, id, `${id} title`, { now: clk });
          } catch (err) {
            failures.push(`create ${id}: ${codeOf(err)}`);
          }
        }
      })(),
      (async (): Promise<void> => {
        for (let i = 0; Date.now() < deadline; i++) {
          try {
            await appendLog(home, seeded[i % seeded.length]!, entry(`settle ${i}`), { now: clk });
          } catch (err) {
            failures.push(`log: ${codeOf(err)}`);
          }
        }
      })(),
      (async (): Promise<void> => {
        while (Date.now() < deadline) {
          try {
            await reindexStore(home);
          } catch (err) {
            failures.push(`reindex: ${codeOf(err)}`);
          }
          await sleep(20);
        }
      })(),
    ];

    await Promise.all([...writers, reader(), reader(), reader()]);

    const idx = await readIndex(home);
    expect(idx).not.toBeNull();
    const inIndex = Object.keys(idx!.topics).sort();
    const onDisk = liveIdsOnDisk(home);

    // No topic in the index that is missing on disk, and none on disk missing
    // from the index.
    expect({
      missingOnDisk: inIndex.filter((id) => !onDisk.includes(id)),
      missingFromIndex: onDisk.filter((id) => !inIndex.includes(id)),
      opFailures: failures,
    }).toEqual({ missingOnDisk: [], missingFromIndex: [], opFailures: [] });

    // A half-finished atomic write must not leave staging files behind either.
    for (const dir of [storePaths(home).topicsDir, storePaths(home).logsDir]) {
      expect(readdirSync(fsPath(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    }
  }, 60_000);

  // ── 4b. the way point 4 actually breaks ───────────────────────────────────

  /**
   * A mutating op is THREE separate atomic writes (note, log, index) inside one
   * lock, with no rollback. Under the very contention this codebase already
   * documents — another tool holding `index.json` open, which on Windows makes
   * a rename over it fail with EPERM — `create` writes the note and log, then
   * fails on the index write and throws E_LOCKED.
   *
   * The op reported failure, so the store should be unchanged. It is not: the
   * note is on disk, the index has never heard of it, `search` (which iterates
   * `index.topics`) can never find it, and the "retry in a moment" the error
   * suggests returns E_EXISTS forever. That is silent memory loss — the exact
   * failure mode the product cannot have.
   *
   * On platforms where a rename over an open handle succeeds (POSIX) the race
   * does not exist and this test degenerates to a consistency check.
   */
  // EXPECTED FAILURE (`it.fails`) — open defect, see docs/DEFECT-REGISTRY.md.
  //
  // WINDOWS-GATED for the reason the comment above already states: on POSIX the
  // rename over an open handle succeeds, `createErr` is null, and the
  // `createErr === null` branch below asserts a consistency check that PASSES.
  // `it.fails` turns that pass into "Expect test to fail", so the probe would
  // report a false RED on every POSIX run. The branch is kept because it is the
  // correct assertion for a platform where the race does not exist; the gate is
  // what stops it being counted as an expected failure there.
  // FIXED 2026-08-01, and this probe going green is how we found out.
  //
  // `createTopic` wrote note, log, then index with no rollback, so a failed
  // index write left both files on disk with nothing pointing at them — saved
  // and unfindable. It now unlinks them on throw (safe only because the
  // E_EXISTS guard proved both were absent moments earlier) and rethrows the
  // original error. `test/create-rollback.test.ts` pins the properties
  // directly; this one keeps proving it under REAL reader contention, which is
  // the condition that produced it.
  //
  // The win32 gate stays. It is not about the fix: on POSIX a rename over an
  // open handle simply succeeds, so the failed-index-write race never happens
  // there and the run exercises the `createErr === null` branch instead.
  it.runIf(process.platform === "win32")("a write that fails at the index step leaves no topic the index cannot see", async () => {
    const home = initStore();
    const paths = storePaths(home);
    const victim = "quicksand";

    // Exactly what a second MCP server does when it calls `readIndex`: Node
    // opens for reading WITHOUT FILE_SHARE_DELETE.
    const holder = await fsp.open(fsPath(paths.index), "r");
    let createErr: unknown = null;
    try {
      await createTopic(home, victim, "Quicksand", { now: clockAt(80_000) });
    } catch (err) {
      createErr = err;
    } finally {
      await holder.close();
    }

    const onDisk = readdirSync(fsPath(paths.topicsDir)).includes(`${victim}.md`);
    const idx = await readIndex(home);
    const inIndex = idx !== null && Object.hasOwn(idx.topics, victim);
    const searchHits = (await search(home, victim)).hits.length;

    if (createErr === null) {
      // POSIX: the rename went through, so the op simply succeeded.
      expect({ onDisk, inIndex }).toEqual({ onDisk: true, inIndex: true });
      return;
    }

    expect(createErr).toBeInstanceOf(GestaltError);
    expect((createErr as GestaltError).code).toBe("E_LOCKED");

    // Does the retry the error message tells the user to do actually work?
    const retryCode = await createTopic(home, victim, "Quicksand", {
      now: clockAt(81_000),
    }).then(
      () => "created",
      (err: unknown) => codeOf(err),
    );

    // What SHOULD be true after an op that reported failure: nothing landed,
    // and retrying works.
    expect({ onDisk, inIndex, searchHits, retryCode }).toEqual({
      onDisk: false,
      inIndex: false,
      searchHits: 0,
      retryCode: "created",
    });
  }, 60_000);
});
