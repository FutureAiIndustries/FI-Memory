import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { topicNotePath } from "../src/paths.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { mergeTopics } from "../src/ops/merge.js";
import { readIndex, reindex } from "../src/store/index.js";
import { clockAt, freshHome } from "./helpers.js";

describe("reindex reproduces the index deep-equal from files alone (SPEC §1)", () => {
  it("matches the index.json that init wrote (B0 example)", async () => {
    const home = freshHome();
    runInit({ home });
    const written = await readIndex(home);
    const { index: rebuilt, warnings } = await reindex(home);
    expect(warnings).toEqual([]);
    expect(rebuilt).toEqual(written); // deep-equal on parsed objects
  });

  it("incremental updates equal a full rebuild after create + log + merge", async () => {
    const home = freshHome();
    runInit({ home });
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1000) });
    await createTopic(home, "bravo", "Bravo", { now: clockAt(1000) });
    await appendLog(home, "alpha", { type: "decision", project: "p", agent: "t", summary: "a1" }, { now: clockAt(3000) });
    await appendLog(home, "bravo", { type: "pattern", project: "p", agent: "t", summary: "b1" }, { now: clockAt(4000) });
    await mergeTopics(home, "bravo", "alpha");

    const incremental = await readIndex(home);
    const { index: rebuilt } = await reindex(home);
    expect(rebuilt).toEqual(incremental);
  });

  it("a hand-mangled note is skipped with a warning, never crashes (invariant 1)", async () => {
    const home = freshHome();
    runInit({ home });
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    writeFileSync(topicNotePath(home, "topic-a"), "not valid frontmatter at all", "utf8");

    const { index, warnings } = await reindex(home);
    expect(
      warnings.some((w) => w.code === "E_CORRUPT_SKIPPED" && w.id === "topic-a"),
    ).toBe(true);
    expect(index.topics["topic-a"]).toBeUndefined();
    expect(index.topics["gestalt-example"]).toBeDefined(); // others still indexed
  });
});
