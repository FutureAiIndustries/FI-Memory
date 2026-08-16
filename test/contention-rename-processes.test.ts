/**
 * Rename-deadline probes from the server lane (fix/reader-starvation, f37030a).
 * Kept in their own file so they sit ALONGSIDE the audit probes in
 * contention-processes.test.ts rather than replacing them: those cover read
 * consistency and crash recovery, these cover the 30s rename deadline.
 */
/**
 * Sustained reader pressure through the real write path (withLock + ops).
 *
 * atomic-rename-contention and contention-readers pin the atomic primitive.
 * This file pins the product path: appendLog (and friends) call writeFileAtomic
 * under withLock, and NOTHING above the lock used to retry a rename E_LOCKED —
 * so a write that lost the 2.5 s race was simply gone from the agent's point of
 * view. Approach (d): the write path delays until rename lands; a sustained
 * burst of reader-shaped EPERM must not drop the entry.
 */
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { topicLogPath } from "../src/paths.js";
import { parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { clockAt, freshHome } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function initStore(): string {
  const home = freshHome("sustained-readers");
  runInit({ home });
  return home;
}

describe("sustained reader pressure on the real write path", () => {
  it("sustained reader pressure: appendLog is delayed, never dropped", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1_000) });

    const real = fsp.rename.bind(fsp);
    let attempts = 0;
    // Longer than the old ~2.5 s rename budget. The entry must still land.
    const holdUntil = Date.now() + 4_000;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (Date.now() < holdUntil) {
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(from, to);
    });

    const started = Date.now();
    const result = await appendLog(
      home,
      "topic-a",
      { type: "decision", project: "p", agent: "probe", summary: "survived sustained readers" },
      { now: clockAt(5_000) },
    );
    const elapsed = Date.now() - started;

    expect(result.timestamp).toBeTruthy();
    expect(attempts).toBeGreaterThan(4);
    // Took real time under pressure — delayed, not instant success on try 1.
    expect(elapsed).toBeGreaterThanOrEqual(3_500);

    const logText = await readText(topicLogPath(home, "topic-a"));
    expect(logText).not.toBeNull();
    const { entries } = parseLog(logText!, "topic-a");
    expect(entries.some((e) => e.summary === "survived sustained readers")).toBe(true);
  }, 40_000);

  it("sustained reader pressure: several appends all land (no silent loss under the lock)", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1_000) });

    const real = fsp.rename.bind(fsp);
    // Every rename pays EPERM for a shared wall-clock window — the shape of a
    // store with many tools reading while one process serializes writes under
    // withLock. Multi-file ops (log + index) used to be tight under the old
    // per-rename attempt budget; the deadline path must not drop any entry.
    const pressureUntil = Date.now() + 3_000;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (Date.now() < pressureUntil && String(from).includes(".tmp-")) {
        const e = new Error("EPERM") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(from, to);
    });

    const summaries = ["one", "two", "three", "four", "five"];
    for (let i = 0; i < summaries.length; i++) {
      await appendLog(
        home,
        "topic-a",
        { type: "decision", project: "p", agent: "probe", summary: summaries[i]! },
        { now: clockAt(10_000 + i) },
      );
    }

    const logText = await readText(topicLogPath(home, "topic-a"));
    const { entries } = parseLog(logText!, "topic-a");
    for (const s of summaries) {
      expect(entries.some((e) => e.summary === s)).toBe(true);
    }
    expect(entries.length).toBe(summaries.length);
  }, 60_000);
});
