/**
 * MANY PROCESSES, ONE STORE (2026-07-28) — the product's actual shape.
 *
 * Every AI tool that connects to FIMemory is its own MCP server process, so the
 * real contention is never `Promise.all` inside one node: it is N *operating
 * system processes* on one directory. `test/concurrency.test.ts` proves the
 * in-process matrix; `test/atomic-rename-contention.test.ts` proves the rename
 * retry budget with a mocked `fsp.rename`. Neither of them spawns anything, so
 * neither can see what only real processes can do to each other: a rename
 * refused because another PROCESS holds the target open, an OS lock that does
 * or does not span processes, and a process that dies with the store's single
 * write lock in its hands.
 *
 * These probes spawn real `node + tsx + src/cli.ts` (and small real-source
 * drivers) against ONE scratch store. No vendor CLI is ever launched and no
 * path outside the test run-root is touched.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { readIndex, reindex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { parseNote, serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";
import { freshHome, tsxEntry } from "./helpers.js";

const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** file:// URL of a real source module, for the spawned driver scripts to import. */
const srcUrl = (rel: string): string =>
  pathToFileURL(fileURLToPath(new URL(`../src/${rel}`, import.meta.url))).href;

const TOPIC = "shared-topic";

/** Child env: inherit the run-root sandbox, drop ambient key material. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GESTALT_PASSPHRASE;
  delete env.GESTALT_KEY;
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Spawn a node process and collect it. Always resolves — never hangs. */
function spawnProc(
  argv: string[],
  opts: { timeoutMs?: number; onStdout?: (line: string, proc: ChildProcessWithoutNullStreams) => void } = {},
): { proc: ChildProcessWithoutNullStreams; done: Promise<Run> } {
  const started = Date.now();
  const proc = spawn(process.execPath, argv, {
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";
  let pending = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!opts.onStdout) return;
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) opts.onStdout(line, proc);
    }
  });
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? 60_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
  return { proc, done };
}

/** Run the REAL cli (`node tsx src/cli.ts ...`) to completion. */
function runCli(args: string[], timeoutMs = 60_000): Promise<Run> {
  return spawnProc([TSX, CLI, ...args], { timeoutMs }).done;
}

/** Wait until `pred(line)` matches a stdout line, or reject on exit/timeout. */
function waitForLine(
  lines: string[],
  bump: { notify?: () => void },
  pred: (line: string) => boolean,
  isDead: () => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return (async (): Promise<string> => {
    for (;;) {
      const hit = lines.find(pred);
      if (hit) return hit;
      if (isDead()) throw new Error(`process exited before the expected line (saw: ${lines.join(" / ")})`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for a line (saw: ${lines.join(" / ")})`);
      await new Promise<void>((resolve) => {
        bump.notify = resolve;
        setTimeout(resolve, 50);
      });
    }
  })();
}

/** A store with one topic, ready for other processes to write into. */
async function seededStore(label: string): Promise<string> {
  const home = freshHome(label);
  runInit({ home });
  await createTopic(home, TOPIC, "Shared topic");
  return home;
}

function helperDir(): string {
  const dir = path.join(process.env.GESTALT_TEST_ROOT!, "contention-helpers");
  mkdirSync(dir, { recursive: true });
  // The drivers are ESM (top-level await); without this tsx/esbuild infers CJS
  // from the nearest package.json, which is nowhere near the run-root.
  writeFileSync(path.join(dir, "package.json"), `{ "type": "module" }\n`, "utf8");
  return dir;
}

/** Write a throwaway driver script under the run-root (never in the repo). */
function writeHelper(name: string, source: string): string {
  const file = path.join(helperDir(), name);
  writeFileSync(file, source, "utf8");
  return file;
}

function entryCount(home: string, id = TOPIC): number {
  const text = readFileSync(topicLogPath(home, id), "utf8");
  return parseLog(text, id).entries.length;
}

// ---------------------------------------------------------------------------
// (1) Several processes appending at the same time.
// ---------------------------------------------------------------------------

describe("many processes appending to one store", () => {
  it(
    "6 simultaneous `fimemory log` processes — every entry lands and the log still parses",
    async () => {
      const home = await seededStore("proc-append");
      const N = 6;

      const runs = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          runCli([
            "log",
            TOPIC,
            "--home",
            home,
            "--type",
            "decision",
            "--project",
            "contention",
            "--proposer",
            `writer-${i}`,
            "-m",
            `simultaneous append ${i}`,
            "--json",
          ]),
        ),
      );

      const failed = runs.filter((r) => r.code !== 0);
      expect(
        failed.map((r) => r.stderr.trim()).join("\n---\n"),
        "every concurrent writer must succeed — a shared store that drops writes under its own advertised shape is the product failing",
      ).toBe("");
      expect(failed.length).toBe(0);

      // The log file itself is well-formed, with every entry present exactly once.
      const text = readFileSync(topicLogPath(home, TOPIC), "utf8");
      const { entries, warnings } = parseLog(text, TOPIC);
      expect(warnings).toEqual([]);
      expect(entries.length).toBe(N);
      const summaries = entries.map((e) => e.summary).sort();
      expect(summaries).toEqual(
        Array.from({ length: N }, (_, i) => `simultaneous append ${i}`).sort(),
      );
      // Timestamps stayed strictly increasing per store (SPEC §4) across processes.
      const stamps = entries.map((e) => e.timestamp);
      expect(new Set(stamps).size).toBe(N);
      expect([...stamps].sort()).toEqual(stamps);

      // And the derived index agrees with a from-files rebuild.
      const idx = await readIndex(home);
      expect(idx!.topics[TOPIC]!.logEntries).toBe(N);
      expect((await reindex(home)).index.topics[TOPIC]!.logEntries).toBe(N);
    },
    110_000,
  );
});

// ---------------------------------------------------------------------------
// (2) One writer, several continuous readers — the exact shape that broke.
// ---------------------------------------------------------------------------

const READER_SRC = `import { readFileSync } from "node:fs";

const logPath = process.argv[2];
const topicId = process.argv[3];
const kind = process.argv[4]; // "log" | "index" | "note"
const HEADER = "# " + topicId + " log";
const HDR = /^### \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z \\| /;

let stop = false;
process.stdin.resume();
process.stdin.on("end", () => { stop = true; });
process.stdin.on("close", () => { stop = true; });

const anomalies = [];
let reads = 0;
let errors = 0;
let maxEntries = 0;
const startedAt = Date.now();
const deadline = startedAt + 45000;

while (!stop && Date.now() < deadline) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
    reads += 1;
  } catch (e) {
    errors += 1;
    if (anomalies.length < 20) anomalies.push("read failed: " + (e && e.code ? e.code : String(e)));
    await new Promise((r) => setTimeout(r, 1));
    continue;
  }
  // A reader must NEVER observe a half-written store file.
  if (text.length === 0) anomalies.push("empty file");
  else if (kind === "index") {
    let idx = null;
    try { idx = JSON.parse(text); } catch (e) { anomalies.push("index.json did not parse: " + JSON.stringify(text.slice(-60))); }
    if (idx) {
      if (!idx.topics || typeof idx.topics !== "object") anomalies.push("index.json has no topics object");
      else {
        const n = idx.topics[topicId] ? idx.topics[topicId].logEntries : 0;
        if (n < maxEntries) anomalies.push("index logEntries went BACKWARDS: " + maxEntries + " -> " + n);
        if (n > maxEntries) maxEntries = n;
      }
    }
  } else if (kind === "note") {
    // A note is frontmatter + body: it must always open AND close its fence.
    if (!text.startsWith("---\\n")) anomalies.push("note lost its frontmatter opener: " + JSON.stringify(text.slice(0, 40)));
    else if (text.indexOf("\\n---\\n", 3) === -1) anomalies.push("note frontmatter never closes (truncated write): " + JSON.stringify(text.slice(0, 80)));
    if (!/^id: \\S+$/m.test(text)) anomalies.push("note lost its id field");
  } else {
    if (!text.startsWith(HEADER)) anomalies.push("missing/truncated header: " + JSON.stringify(text.slice(0, 40)));
    if (!text.endsWith("\\n")) anomalies.push("file does not end with a newline: " + JSON.stringify(text.slice(-40)));
    const headers = text.split("\\n").filter((l) => l.startsWith("### "));
    for (const h of headers) if (!HDR.test(h)) anomalies.push("torn entry header: " + JSON.stringify(h));
    if (headers.length < maxEntries) anomalies.push("entry count went BACKWARDS: " + maxEntries + " -> " + headers.length);
    if (headers.length > maxEntries) maxEntries = headers.length;
  }
  await new Promise((r) => setTimeout(r, 1));
}

const elapsedMs = Date.now() - startedAt;
process.stdout.write(JSON.stringify({ reads, errors, maxEntries, elapsedMs, anomalies: anomalies.slice(0, 20) }) + "\\n");
`;

const WRITER_SRC = `import { appendLog } from ${JSON.stringify(srcUrl("ops/logOp.js"))};

const home = process.argv[2];
const topic = process.argv[3];
const n = Number(process.argv[4]);
const tag = process.argv[5];

const ok = [];
const failures = [];
for (let i = 0; i < n; i++) {
  try {
    const r = await appendLog(home, topic, {
      type: "decision",
      project: "contention",
      agent: tag,
      summary: tag + " write " + i,
    });
    ok.push(r.timestamp);
  } catch (e) {
    failures.push((e && e.code ? e.code : "?") + ": " + (e && e.message ? e.message : String(e)));
  }
}
process.stdout.write(JSON.stringify({ ok: ok.length, failures }) + "\\n");
`;

interface ReaderReport {
  reads: number;
  errors: number;
  maxEntries: number;
  elapsedMs: number;
  anomalies: string[];
}
interface WriterReport {
  ok: number;
  failures: string[];
}

interface StormResult {
  home: string;
  wrote: WriterReport;
  writerRun: Run;
  readers: ReaderReport[];
  /** Total reader opens per second across all reader processes, measured. */
  readsPerSec: number;
}

/**
 * One writer process vs `readerCount` processes reading store files non-stop.
 * This is the exact geometry of the 2026-07-28 failure: a rename over a file
 * another PROCESS holds open is refused on Windows, and Node opens files for
 * reading without FILE_SHARE_DELETE.
 */
async function readerStorm(
  label: string,
  readerCount: number,
  writes: number,
  focus: "all" | "hot" = "all",
): Promise<StormResult> {
  const home = await seededStore(label);
  const readerPath = writeHelper("reader.mjs", READER_SRC);
  const writerPath = writeHelper("writer.ts", WRITER_SRC);

  // "hot" = only the two files `appendLog` renames over on EVERY append (the
  // topic log and index.json). "all" adds the note, which is not rewritten here
  // and so spreads the pressure — useful for the integrity probe, useless for
  // the starvation probe.
  const pool: { path: string; kind: "log" | "index" | "note" }[] = [
    { path: topicLogPath(home, TOPIC), kind: "log" },
    { path: storePaths(home).index, kind: "index" },
    ...(focus === "all"
      ? ([{ path: topicNotePath(home, TOPIC), kind: "note" }] as const)
      : []),
  ];
  const readers = Array.from({ length: readerCount }, (_, i) => {
    const t = pool[i % pool.length]!;
    return spawnProc([readerPath, t.path, TOPIC, t.kind], { timeoutMs: 90_000 });
  });

  // Let the readers actually be reading before the writer starts.
  await new Promise<void>((r) => setTimeout(r, 750));

  const writerRun = await spawnProc(
    [TSX, writerPath, home, TOPIC, String(writes), "solo-writer"],
    { timeoutMs: 90_000 },
  ).done;

  for (const r of readers) r.proc.stdin.end();
  const runs = await Promise.all(readers.map((r) => r.done));
  const reports = runs.map(
    (r) => JSON.parse(r.stdout.trim().split("\n").pop()!) as ReaderReport,
  );
  const readsPerSec = Math.round(
    reports.reduce((sum, r) => sum + (r.reads / Math.max(1, r.elapsedMs)) * 1000, 0),
  );

  const wrote = JSON.parse(writerRun.stdout.trim().split("\n").pop()!) as WriterReport;
  return { home, wrote, writerRun, readers: reports, readsPerSec };
}

describe("one writer vs several continuous readers (the EPERM shape)", () => {
  it(
    "no reader ever observes a torn or partial store file while a writer is renaming over it",
    async () => {
      const storm = await readerStorm("proc-readers-integrity", 4, 10);

      for (const rep of storm.readers) {
        expect(rep.reads, "reader did not actually read anything — probe is vacuous").toBeGreaterThan(50);
        expect(rep.anomalies, "a reader observed a torn/partial store file").toEqual([]);
        expect(rep.errors, "a lock-free reader must never fail to open a store file").toBe(0);
      }
      // Whatever the writer managed to land is coherent on disk. (The COUNT is
      // deliberately a range, not `=== wrote.ok`: an append whose index.json
      // rename is refused after its log rename succeeded lands the entry without
      // being counted as a success. That accounting gap is the starvation
      // probe's business, not this one's — here the only claim is integrity.)
      const { entries, warnings } = parseLog(
        readFileSync(topicLogPath(storm.home, TOPIC), "utf8"),
        TOPIC,
      );
      expect(warnings, "the log did not parse cleanly after concurrent reads").toEqual([]);
      expect(entries.length).toBeGreaterThanOrEqual(storm.wrote.ok);
      expect(entries.length).toBeLessThanOrEqual(storm.wrote.ok + storm.wrote.failures.length);
      // Every entry is whole and distinctly stamped — no half-appended block.
      expect(entries.every((e) => e.type === "decision" && e.summary.startsWith("solo-writer write "))).toBe(true);
      expect(new Set(entries.map((e) => e.timestamp)).size).toBe(entries.length);
    },
    110_000,
  );

  it(
    "sustained reader pressure does not starve the writer into a hard E_LOCKED",
    async () => {
      // NOTE ON LOAD: 6 reader processes in a `readFileSync` loop is heavier
      // than an idle MCP server, but it is NOT unrealistic for the moments that
      // matter — `hook-retrieve` on every prompt, `search`/`reindex` walking
      // every note and log, and N tools waking at once all produce exactly this
      // burst. The point of the probe is the SHAPE of the failure, not the rate:
      // the rename budget is a FIXED ~2.5 s with no ceiling on how much reader
      // overlap it must ride out, and nothing above it retries the OPERATION.
      // When the budget is spent the append is simply refused and the memory is
      // never written — and because `appendLog` is holding the store's single
      // write lock throughout those 2.5 s, the pressure also converts into
      // cross-process E_LOCKED for every other tool waiting on the lock.
      const WRITES = 50; // 100 renames (log + index.json per append)
      const storm = await readerStorm("proc-readers-starve", 6, WRITES, "hot");

      expect(storm.writerRun.code, "the writer process must not crash").toBe(0);

      // One verdict object, so the diff shows BOTH consequences at once:
      //  · refusedWrites  — entries the user asked for that were never recorded;
      //  · index drift    — `appendLog` writes the log and THEN index.json, both
      //    inside one lock but as two separate renames. When only the second is
      //    refused the entry is in the log while the catalog still says it isn't.
      //    That heals on the next SUCCESSFUL write to the topic (which rebuilds
      //    the entry from the log it just wrote), so the exposure is bounded —
      //    but it is unbounded in time if that refused write was the last one
      //    before the tool went idle: `list`/`status`/`search` under-report
      //    until some later write or an explicit `reindex`.
      const idx = await readIndex(storm.home);
      const verdict = {
        refusedWrites: storm.wrote.failures.length,
        entriesInLogFile: entryCount(storm.home),
        entriesIndexClaims: idx!.topics[TOPIC]!.logEntries,
        readsPerSec: storm.readsPerSec,
      };
      expect(
        verdict,
        `writes were refused / the index drifted under ~${storm.readsPerSec} reads/sec of peer traffic:\n${storm.wrote.failures.join("\n")}`,
      ).toEqual({
        refusedWrites: 0,
        entriesInLogFile: WRITES,
        entriesIndexClaims: WRITES,
        readsPerSec: storm.readsPerSec,
      });
    },
    110_000,
  );
});

// ---------------------------------------------------------------------------
// (3) A process SIGKILLed mid-write.
// ---------------------------------------------------------------------------

const KILLME_SRC = `import { readFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(srcUrl("store/lock.js"))};
import { writeFileAtomic } from ${JSON.stringify(srcUrl("store/atomic.js"))};

const home = process.argv[2];
const notePath = process.argv[3];
const bigPath = process.argv[4];
const big = readFileSync(bigPath, "utf8");

await withLock(home, 5000, async () => {
  process.stdout.write("HELD\\n");
  // Rewrite the note as fast as we can so a SIGKILL is very likely to land
  // between the temp-file write and the rename.
  for (;;) await writeFileAtomic(notePath, big);
});
`;

describe("a process killed mid-write", () => {
  it(
    "SIGKILL during a note rewrite leaves the note whole — original or new, never truncated",
    async () => {
      const home = await seededStore("proc-sigkill");
      const notePath = topicNotePath(home, TOPIC);
      const original = readFileSync(notePath, "utf8");

      const bigNote: TopicNote = {
        id: TOPIC,
        title: "Shared topic",
        aliases: [],
        tags: [],
        projects: [],
        updated: "2026-07-28T00:00:00.000Z",
        compactedThrough: null,
        mergedInto: null,
        body: `\nShared topic\n\n${"filler line to widen the write window\n".repeat(4000)}\n## Owner notes\n`,
      };
      const big = serializeNote(bigNote);
      const bigPath = writeHelper("big-note.md", big);
      const killmePath = writeHelper("killme.ts", KILLME_SRC);

      const lines: string[] = [];
      const bump: { notify?: () => void } = {};
      let dead = false;
      const { proc, done } = spawnProc([TSX, killmePath, home, notePath, bigPath], {
        timeoutMs: 40_000,
        onStdout: (line) => {
          lines.push(line);
          bump.notify?.();
        },
      });
      void done.then(() => {
        dead = true;
        bump.notify?.();
      });

      await waitForLine(lines, bump, (l) => l === "HELD", () => dead, 40_000);
      await new Promise<void>((r) => setTimeout(r, 400)); // let it get into the rewrite loop
      proc.kill("SIGKILL");
      await done;

      // THE invariant: the note on disk is one of the two complete versions.
      const after = readFileSync(notePath, "utf8");
      expect(after === original || after === big, "the note was left in a third, torn state").toBe(true);
      expect(parseNote(after, TOPIC), "the note no longer parses after a killed writer").not.toBeNull();

      // And a fresh process can still read the store.
      const read = await runCli(["get", TOPIC, "--home", home, "--json"]);
      expect(read.stderr).toBe("");
      expect(read.code).toBe(0);
    },
    110_000,
  );

  // EXPECTED FAILURE (`it.fails`) — open defect, see docs/DEFECT-REGISTRY.md.
  // Green while the bug is open; goes RED the day it starts passing.
  it(
    // D5 FIXED 2026-08-21: reindexStore sweeps crashed-writer residue under the
    // store lock (store/tmpResidue.ts) — the CLI `reindex` leg below removes it.
    "the temp file a killed writer leaves behind is swept by reindex",
    async () => {
      // Observed for real in the probe above: a SIGKILLed writer leaves
      // `topics/.shared-topic.md.tmp-<pid>-<n>` on disk. Whether a given kill
      // lands inside the temp-write window is a race, so the ARTIFACT is
      // reproduced here exactly as `store/atomic.ts` names it and the question
      // asked is the deterministic one: does anything ever clean it up?
      //
      // Nothing does. `sweepSessionCache` (the one sweeper the CLI runs on
      // every invocation) is scoped to the session-key cache dir by name shape;
      // no code path scans the store for `.tmp-` residue. On the product's real
      // shape — N tools, laptops that sleep, clients that get force-quit —
      // these accumulate, and a git-synced store commits them.
      const home = await seededStore("proc-tmp-litter");
      const orphan = path.join(storePaths(home).topicsDir, `.${TOPIC}.md.tmp-999999-0`);
      writeFileSync(orphan, "half a note, from a writer that died\n", "utf8");

      for (const argv of [
        ["list", "--home", home, "--json"],
        ["status", "--home", home, "--json"],
        ["reindex", "--home", home, "--json"],
        ["get", TOPIC, "--home", home, "--json"],
      ]) {
        const r = await runCli(argv);
        expect(r.stderr, `\`${argv[0]}\` failed with residue in the store`).toBe("");
        expect(r.code).toBe(0);
      }

      // The residue must not corrupt anything — that part holds.
      expect((await reindex(home)).index.topics[TOPIC]).toBeDefined();

      const left = readdirSync(storePaths(home).topicsDir).filter((f) => f.includes(".tmp-"));
      expect(
        left,
        "the D5 janitor (reindex, under the lock) must have removed the dead writer's temp",
      ).toEqual([]);
    },
    110_000,
  );
});

// ---------------------------------------------------------------------------
// (4) The cross-process lock: does it actually block another process?
// ---------------------------------------------------------------------------

const HOLDER_SRC = `import { readFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(srcUrl("store/lock.js"))};

const home = process.argv[2];
const logPath = process.argv[3];
const holdMs = Number(process.argv[4]);

const count = () => {
  try {
    return (readFileSync(logPath, "utf8").split("\\n").filter((l) => l.startsWith("### "))).length;
  } catch {
    return -1;
  }
};

await withLock(home, 5000, async () => {
  process.stdout.write("HELD " + count() + "\\n");
  await new Promise((r) => setTimeout(r, holdMs));
  process.stdout.write("RELEASING " + count() + "\\n");
});
process.stdout.write("RELEASED\\n");
`;

describe("the store lock across processes", () => {
  it(
    "a lock held by ANOTHER process really blocks a write — the second process never proceeds in parallel",
    async () => {
      const home = await seededStore("proc-lock-blocks");
      const holderPath = writeHelper("holder.ts", HOLDER_SRC);
      const logPath = topicLogPath(home, TOPIC);

      // Hold longer than the default lockWaitMs (5000) so the outcome is
      // unambiguous: the second process must be refused, not let through.
      const lines: string[] = [];
      const bump: { notify?: () => void } = {};
      let dead = false;
      const holder = spawnProc([TSX, holderPath, home, logPath, "8000"], {
        timeoutMs: 60_000,
        onStdout: (line) => {
          lines.push(line);
          bump.notify?.();
        },
      });
      void holder.done.then(() => {
        dead = true;
        bump.notify?.();
      });
      await waitForLine(lines, bump, (l) => l.startsWith("HELD"), () => dead, 40_000);

      const blocked = await runCli([
        "log",
        TOPIC,
        "--home",
        home,
        "--type",
        "decision",
        "--project",
        "contention",
        "-m",
        "must not sneak past the lock",
        "--json",
      ]);
      const holderRun = await holder.done;

      const held = Number(lines.find((l) => l.startsWith("HELD"))!.split(" ")[1]);
      const releasing = Number(
        (lines.find((l) => l.startsWith("RELEASING")) ?? "RELEASING -999").split(" ")[1],
      );
      expect(holderRun.code).toBe(0);
      // The decisive assertion: nothing landed in the log while the lock was held.
      expect(releasing, "another process wrote INTO the store while the lock was held").toBe(held);

      // …and the blocked writer failed loudly with the structured lock error,
      // rather than either hanging or silently proceeding.
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("E_LOCKED");
      expect(entryCount(home)).toBe(held);
    },
    110_000,
  );

  it(
    "a lock released in time lets the waiting process through (it waits, it does not fail fast)",
    async () => {
      const home = await seededStore("proc-lock-waits");
      const holderPath = writeHelper("holder.ts", HOLDER_SRC);
      const logPath = topicLogPath(home, TOPIC);

      const lines: string[] = [];
      const bump: { notify?: () => void } = {};
      let dead = false;
      const holder = spawnProc([TSX, holderPath, home, logPath, "2500"], {
        timeoutMs: 60_000,
        onStdout: (line) => {
          lines.push(line);
          bump.notify?.();
        },
      });
      void holder.done.then(() => {
        dead = true;
        bump.notify?.();
      });
      await waitForLine(lines, bump, (l) => l.startsWith("HELD"), () => dead, 40_000);

      const writer = await runCli([
        "log",
        TOPIC,
        "--home",
        home,
        "--type",
        "decision",
        "--project",
        "contention",
        "-m",
        "landed after the holder released",
        "--json",
      ]);
      await holder.done;

      expect(writer.stderr).toBe("");
      expect(writer.code).toBe(0);
      expect(entryCount(home)).toBe(1);
    },
    110_000,
  );

    // FIXED 2026-08-01, and this probe going green is how we found out.
    //
    // It was an `it.fails` expected failure: `withLock` passed no
    // `onCompromised`, so proper-lockfile's default `(err) => { throw err; }`
    // fired from its mtime-refresh timer and became an UNCAUGHT exception,
    // killing the holder. Survivable in a one-shot CLI; fatal in a long-lived
    // MCP server, where the server dies and the AI tool loses its memory
    // connection mid-session.
    //
    // The fix arrived sideways: handling `onCompromised` was done to stop the
    // MCP server dying, and it closed this defect as a side effect, because
    // the uncaught throw WAS the kill. Kept as a live test rather than
    // deleted — the property is worth holding.
  it(
    "removing the lock directory (what E_LOCKED's own hint tells users to do) must not KILL the process holding it",
    async () => {
      // `withLock` now passes `onCompromised`, which writes one line to stderr
      // and does NOT throw, so a holder survives having its lock removed from
      // under it. Before that it inherited proper-lockfile's default,
      // `(err) => { throw err; }`, fired from the mtime-refresh timer with no
      // `process.on("uncaughtException")` anywhere to catch it.
      //
      // Note what else changed alongside: E_LOCKED's hint no longer tells
      // anyone to remove this directory, so the commonest way to trigger this
      // is gone too. The probe stays because the other triggers remain —
      // anything that stalls a holder past the 60 s stale threshold.
      const home = await seededStore("proc-lock-compromised");
      const holderPath = writeHelper("holder.ts", HOLDER_SRC);
      const logPath = topicLogPath(home, TOPIC);

      const lines: string[] = [];
      const bump: { notify?: () => void } = {};
      let dead = false;
      // Hold past proper-lockfile's first mtime-refresh tick (stale/2 = 30 s).
      const holder = spawnProc([TSX, holderPath, home, logPath, "36000"], {
        timeoutMs: 55_000,
        onStdout: (line) => {
          lines.push(line);
          bump.notify?.();
        },
      });
      void holder.done.then(() => {
        dead = true;
        bump.notify?.();
      });
      await waitForLine(lines, bump, (l) => l.startsWith("HELD"), () => dead, 40_000);

      // The user follows the hint FIMemory itself printed.
      rmSync(storePaths(home).lockfile, { recursive: true, force: true });

      const run = await holder.done;
      expect(
        `exit=${run.code} uncaught=${/Error/.test(run.stderr)}`,
        "the lock holder was killed by an uncaught exception instead of surviving a lost lock",
      ).toBe("exit=0 uncaught=false");
      expect(lines).toContain("RELEASED");
    },
    70_000,
  );

  // D7 FIXED 2026-08-21: the holder writes a sibling owner record and a refused
  // contender steals a lock whose same-host owner pid is provably dead (ESRCH)
  // after a 2 s grace — see store/lock.ts. The killed withLock holder below
  // leaves a dead-pid record, so the next write reclaims promptly.
  it(
    "a writer killed WITH the lock does not wedge every other tool's writes",
    async () => {
      // The scenario that actually happens: an MCP server is mid-write when its
      // client quits / the machine sleeps / the user closes the terminal. The
      // lock directory survives the death with a fresh mtime, so every OTHER
      // tool on the shared store is refused until the lock goes stale.
      const home = await seededStore("proc-lock-crash");
      const notePath = topicNotePath(home, TOPIC);
      const big = serializeNote({
        id: TOPIC,
        title: "Shared topic",
        aliases: [],
        tags: [],
        projects: [],
        updated: "2026-07-28T00:00:00.000Z",
        compactedThrough: null,
        mergedInto: null,
        body: `\nShared topic\n\n${"filler\n".repeat(2000)}\n## Owner notes\n`,
      });
      const bigPath = writeHelper("big-note-3.md", big);
      const killmePath = writeHelper("killme.ts", KILLME_SRC);

      const lines: string[] = [];
      const bump: { notify?: () => void } = {};
      let dead = false;
      const { proc, done } = spawnProc([TSX, killmePath, home, notePath, bigPath], {
        timeoutMs: 40_000,
        onStdout: (line) => {
          lines.push(line);
          bump.notify?.();
        },
      });
      void done.then(() => {
        dead = true;
        bump.notify?.();
      });
      await waitForLine(lines, bump, (l) => l === "HELD", () => dead, 40_000);
      proc.kill("SIGKILL");
      await done;

      const next = await runCli([
        "log",
        TOPIC,
        "--home",
        home,
        "--type",
        "decision",
        "--project",
        "contention",
        "-m",
        "after a crashed writer",
        "--json",
      ]);

      // A dead process holds no lock. Another tool must be able to write again
      // promptly — not be told E_LOCKED and told to delete a directory by hand.
      expect(
        `exit=${next.code} stderr=${next.stderr.trim()}`,
        "a crashed writer leaves the store write-locked for other processes",
      ).toBe("exit=0 stderr=");
      expect(entryCount(home)).toBe(1);
    },
    110_000,
  );
});
