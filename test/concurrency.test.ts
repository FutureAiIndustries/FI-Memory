import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { mergeTopics } from "../src/ops/merge.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { readIndex, reindex } from "../src/store/index.js";
import { clockAt, freshHome, tickingClock } from "./helpers.js";

function initStore(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

const entry = (summary: string) =>
  ({ type: "decision", project: "p", agent: "x", summary }) as const;

/**
 * Concurrency matrix (SPEC §7). Rows realizable with B1 ops: (a) log×log,
 * (d) reindex×log, (e) merge×other. Plus a lock-serialization proof — the
 * guarantee that makes rows (b) update×update and (c) approve×log hold once
 * those ops arrive in B2b. Every race ends with the on-disk index equal to a
 * fresh from-files rebuild.
 */
describe("concurrency matrix (SPEC §7)", () => {
  it("(a) log × log same topic — both land, logEntries exact", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    const clk = tickingClock(5000);
    await Promise.all([
      appendLog(home, "topic-a", entry("one"), { now: clk }),
      appendLog(home, "topic-a", entry("two"), { now: clk }),
    ]);
    expect((await readIndex(home))!.topics["topic-a"]!.logEntries).toBe(2);
    expect((await reindex(home)).index.topics["topic-a"]!.logEntries).toBe(2);
  });

  it("(d) reindex × log — final index reflects the appended entry", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    await Promise.all([
      reindexStore(home),
      appendLog(home, "topic-a", entry("landed"), { now: clockAt(6000) }),
    ]);
    const idx = await readIndex(home);
    const { index } = await reindex(home);
    expect(idx).toEqual(index);
    expect(index.topics["topic-a"]!.logEntries).toBe(1);
  });

  it("(e) merge × log on another topic — both effects present, index consistent", async () => {
    const home = initStore();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1000) });
    await createTopic(home, "bravo", "Bravo", { now: clockAt(1000) });
    await createTopic(home, "charlie", "Charlie", { now: clockAt(1000) });
    await Promise.all([
      mergeTopics(home, "bravo", "alpha"),
      appendLog(home, "charlie", entry("c1"), { now: clockAt(7000) }),
    ]);
    const idx = await readIndex(home);
    expect(idx!.topics["bravo"]).toBeUndefined();
    expect(idx!.topics["alpha"]!.aliases).toContain("bravo");
    expect(idx!.topics["charlie"]!.logEntries).toBe(1);
    expect(idx).toEqual((await reindex(home)).index);
  });

  it("lock serialization: 8 concurrent appends all land in order (guarantees §7 b/c)", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    const clk = tickingClock(10000);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        appendLog(home, "topic-a", entry(`s${i}`), { now: clk }),
      ),
    );
    expect((await readIndex(home))!.topics["topic-a"]!.logEntries).toBe(8);
    expect((await reindex(home)).index.topics["topic-a"]!.logEntries).toBe(8);
  });

  it("break script #8: 20 concurrent log appends — entry count + index logEntries match", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    const clk = tickingClock(20000);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendLog(home, "topic-a", entry(`e${i}`), { now: clk }),
      ),
    );
    // Every append landed; timestamps stayed monotonic/distinct under the lock.
    expect((await readIndex(home))!.topics["topic-a"]!.logEntries).toBe(20);
    const { index } = await reindex(home);
    expect(index.topics["topic-a"]!.logEntries).toBe(20);
  });
});
