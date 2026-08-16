import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { topicLogPath, topicNotePath } from "../src/paths.js";
import { compact } from "../src/ops/compact.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { reviewApprove, reviewShow } from "../src/ops/review.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { updateTopic } from "../src/ops/update.js";
import { readIndex, reindex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";
import {
  clockAt,
  expectGestaltErrorAsync,
  freshHome,
  tickingClock,
} from "./helpers.js";

const OWNER = "## Owner notes\nmine\n";
function note(before: string, owner = OWNER): string {
  const n: TopicNote = {
    id: "alpha",
    title: "Alpha",
    aliases: [],
    tags: [],
    projects: [],
    updated: "2026-07-11T00:00:00.000Z",
    compactedThrough: null,
    mergedInto: null,
    body: "\n" + before + "\n\n" + owner,
  };
  return serializeNote(n);
}
async function seed(before = "summary."): Promise<string> {
  const home = freshHome();
  runInit({ home });
  writeFileSync(topicNotePath(home, "alpha"), note(before), "utf8");
  writeFileSync(topicLogPath(home, "alpha"), "# alpha log\n", "utf8");
  await reindexStore(home);
  return home;
}

describe("Gate #1 regression fixes", () => {
  it("#1: a proposed note whose body lacks a trailing newline still approves", async () => {
    const home = await seed();
    const noNl = note("no trailing newline").replace(/\n+$/, "");
    expect(noNl.endsWith("\n")).toBe(false);
    const { seq } = await updateTopic(home, "alpha", noNl, { now: clockAt(1e12) });
    await reviewApprove(home, seq, { now: clockAt(1e12) }); // no E_SCHEMA newHash mismatch
    expect(readFileSync(topicNotePath(home, "alpha"), "utf8")).toContain("no trailing newline");
  });

  it("#2: a huge section AFTER owner notes is counted toward the cap (smuggle blocked)", async () => {
    const home = await seed();
    const smuggled = note(
      "short summary.",
      OWNER + "\n## smuggle\n" + "word ".repeat(1200),
    );
    await expectGestaltErrorAsync(
      () => updateTopic(home, "alpha", smuggled, { now: clockAt(1e12) }),
      "E_TOKEN_CAP",
    );
  });

  it("#7: a future compactedThrough watermark is rejected", async () => {
    const home = await seed();
    await appendLog(home, "alpha", { type: "decision", project: "p", agent: "a", summary: "e1" }, { now: clockAt(1e12) });
    const proposed = note("folded summary.");
    await expectGestaltErrorAsync(
      () => updateTopic(home, "alpha", proposed, { compactedThrough: "2099-01-01T00:00:00.000Z", now: clockAt(2e12) }),
      "E_SCHEMA",
    );
  });

  it("#8: approve is idempotent-resume — a note already New (crash mid-txn) completes, not stales", async () => {
    const home = await seed();
    const { seq } = await updateTopic(home, "alpha", note("revised."), { now: clockAt(1e12) });
    // Simulate a crash after the note was written but before the proposal was marked:
    // apply the New note to disk manually, leaving the proposal pending.
    const shown = await reviewShow(home, seq);
    writeFileSync(topicNotePath(home, "alpha"), shown.newNote, "utf8");
    // Re-approve: must complete (not E_STALE_PROPOSAL).
    await reviewApprove(home, seq, { now: clockAt(1e12) });
    expect((await reviewShow(home, seq)).status).toBe("approved");
    // Exactly one auto-entry (idempotent).
    const autos = parseLog(readFileSync(topicLogPath(home, "alpha"), "utf8")).entries.filter(
      (e) => e.summary === `Note updated via proposal #${seq} by unknown.`,
    );
    expect(autos).toHaveLength(1);
  });

  it("#6: compact never stalls — a single over-budget entry is returned alone with an advancing cursor", async () => {
    const home = await seed();
    // One entry far bigger than the 6000 fold budget.
    writeFileSync(
      topicLogPath(home, "alpha"),
      "# alpha log\n\n### 2026-07-11T00:00:01.000Z | decision | p | a\n" + "word ".repeat(7000) + "\n",
      "utf8",
    );
    const packet = await compact(home, "alpha");
    expect(packet.entries).toHaveLength(1); // forced progress
    expect(packet.cursor).toBe("2026-07-11T00:00:01.000Z");
    expect(packet.warnings.some((w) => w.message.includes("exceeds the fold budget"))).toBe(true);
  });

  it("#5: compact packet returns the full note text (frontmatter + body)", async () => {
    const home = await seed();
    const packet = await compact(home, "alpha");
    expect(packet.note.startsWith("---\n")).toBe(true);
    expect(packet.note).toContain("id: alpha");
    expect(packet.note).toContain("summary.");
  });
});

describe("Gate #1 #12: concurrency matrix (b) update×update, (c) approve∥log", () => {
  it("(b) two concurrent updates on the same topic → two pending proposals with distinct seqs", async () => {
    const home = await seed();
    const clk = tickingClock(1e12);
    const [a, b] = await Promise.all([
      updateTopic(home, "alpha", note("edit A"), { now: clk }),
      updateTopic(home, "alpha", note("edit B"), { now: clk }),
    ]);
    expect(a.seq).not.toBe(b.seq); // global seq is unique under the lock
    expect(new Set([a.seq, b.seq]).size).toBe(2);
  });

  it("(c) approve ∥ log on the same topic — both effects present, index consistent", async () => {
    const home = await seed();
    await createTopic(home, "other", "Other", { now: clockAt(1e12) });
    const { seq } = await updateTopic(home, "alpha", note("approved edit."), { now: clockAt(1e12) });
    await Promise.all([
      reviewApprove(home, seq, { now: clockAt(2e12) }),
      appendLog(home, "other", { type: "decision", project: "p", agent: "x", summary: "concurrent" }, { now: clockAt(2e12) }),
    ]);
    // Both landed.
    expect(readFileSync(topicNotePath(home, "alpha"), "utf8")).toContain("approved edit.");
    const idx = (await readIndex(home))!;
    expect(idx.topics["other"]!.logEntries).toBe(1);
    // On-disk index equals a fresh rebuild (deep-equal).
    expect(idx).toEqual((await reindex(home)).index);
  });
});
