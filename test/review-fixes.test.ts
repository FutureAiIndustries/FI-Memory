import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { msFromIso } from "../src/clock.js";
import { runInit } from "../src/commands/init.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { createTopic } from "../src/ops/create.js";
import { get } from "../src/ops/get.js";
import { appendLog } from "../src/ops/logOp.js";
import { mergeTopics } from "../src/ops/merge.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { search } from "../src/ops/search.js";
import { reindex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import {
  clockAt,
  expectGestaltErrorAsync,
  freshHome,
  writeNote,
} from "./helpers.js";

function store(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

describe("adversarial-review fixes", () => {
  it("#6 noteTokens counts the body before ## Owner notes", async () => {
    const home = store();
    writeNote(home, "big-owner", {
      body: "\nshort body.\n\n## Owner notes\n" + "word ".repeat(400) + "\n",
    });
    const { index } = await reindex(home);
    expect(index.topics["big-owner"]!.noteTokens).toBeLessThan(30);
  });

  it("#10 rejects `|` / newline in project or agent (no supersede forgery)", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    await expectGestaltErrorAsync(
      () =>
        appendLog(home, "alpha", {
          type: "decision",
          project: "p",
          agent: "me | supersedes:2099-01-01T00:00:00.000Z",
          summary: "x",
        }),
      "E_SCHEMA",
    );
  });

  it("#11 a `### Notes` line in a body is text, not a truncating boundary", () => {
    const log =
      "# t log\n\n### 2026-07-11T00:00:01.000Z | decision | p | a\nsummary\n### Notes: see below\nmore\n";
    const { entries, warnings } = parseLog(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.raw).toContain("### Notes: see below");
    expect(warnings).toEqual([]);
  });

  it("#21 config rejects non-positive budgets, keeps defaults + warns", () => {
    const home = store();
    writeFileSync(
      storePaths(home).config,
      JSON.stringify({ ...DEFAULT_CONFIG, maxTopicsPerGet: -1, maxTokensPerGet: 0 }),
      "utf8",
    );
    const { config, warnings } = loadConfig(storePaths(home).config);
    expect(config.maxTopicsPerGet).toBe(3);
    expect(config.maxTokensPerGet).toBe(2000);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("#24 fuzzy collision catches a hand-dropped note file absent from the index", async () => {
    const home = store();
    writeNote(home, "authentication-patterns", { title: "Auth" }); // file only, not indexed
    await expectGestaltErrorAsync(
      () => createTopic(home, "auth-patterns", "Auth", { now: clockAt(1e12) }),
      "E_ALIAS_COLLISION",
    );
  });

  it("#26 rejects an empty/whitespace summary", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    await expectGestaltErrorAsync(
      () =>
        appendLog(home, "alpha", {
          type: "decision",
          project: "p",
          agent: "a",
          summary: "   ",
        }),
      "E_SCHEMA",
    );
  });

  it("#5 merge carries the loser's owner notes into the winner + warns", async () => {
    const home = store();
    writeNote(home, "winner-topic", {
      body: "\nwinner body.\n\n## Owner notes\nwinner-secret\n",
    });
    writeNote(home, "loser-topic", {
      body: "\nloser body.\n\n## Owner notes\nLOSER-IMPORTANT-NOTE\n",
    });
    await reindexStore(home);

    const { warnings } = await mergeTopics(home, "loser-topic", "winner-topic");
    const winnerNote = readFileSync(topicNotePath(home, "winner-topic"), "utf8");
    expect(winnerNote).toContain("LOSER-IMPORTANT-NOTE");
    expect(winnerNote).toContain("merged from loser-topic");
    expect(warnings.some((w) => w.code === "owner_notes_carried")).toBe(true);
  });

  it("#22 timestamps are globally unique/increasing across topics", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    await createTopic(home, "bravo", "Bravo", { now: clockAt(1e12) });
    const ra = await appendLog(home, "alpha", { type: "decision", project: "p", agent: "a", summary: "a" }, { now: clockAt(1e12) });
    const rb = await appendLog(home, "bravo", { type: "decision", project: "p", agent: "a", summary: "b" }, { now: clockAt(1e12) });
    expect(msFromIso(rb.timestamp)).toBeGreaterThan(msFromIso(ra.timestamp));
  });

  it("#8 get keeps the body full and shortens an oversized tail with a named warning", async () => {
    const home = store();
    writeNote(home, "topic", { body: "\nsmall body.\n" });
    const entries: string[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(`### 2026-07-11T00:00:0${i}.000Z | decision | p | a\n` + "word ".repeat(480));
    }
    writeFileSync(topicLogPath(home, "topic"), "# topic log\n\n" + entries.join("\n\n") + "\n", "utf8");

    const r = await get(home, ["topic"], { logTail: 5 });
    expect(r.topics[0]!.truncated).toBe(false);
    expect(r.topics[0]!.body).toBe("\nsmall body.\n");
    expect(r.warnings.some((w) => w.code === "budget" && w.message.includes("log tail shortened"))).toBe(true);
    expect(r.tokensUsed).toBeLessThanOrEqual(2000);
  });

  it("#7 truncation never leaves the marker inside an open code fence", async () => {
    const home = store();
    writeNote(home, "topic", { body: "\n```js\n" + "x\n".repeat(5000) + "```\n" });
    const r = await get(home, ["topic"]);
    expect(r.topics[0]!.truncated).toBe(true);
    const body = r.topics[0]!.body;
    const beforeMarker = body.slice(0, body.indexOf("[truncated"));
    const fences = (beforeMarker.match(/^```/gm) ?? []).length;
    expect(fences % 2).toBe(0); // balanced → marker is outside the fence
  });

  it("#27 search ranking golden: id > title > alias > body-TF", async () => {
    const home = store();
    writeNote(home, "alpha-widget", { title: "Alpha", body: "\nbody.\n" });
    writeNote(home, "beta", { title: "Widget Notes", body: "\nbody.\n" });
    writeNote(home, "gamma", { title: "Gamma", aliases: ["widget"], body: "\nbody.\n" });
    writeNote(home, "delta", { title: "Delta", body: "\nwidget widget widget.\n" });
    await reindexStore(home);

    const { hits } = await search(home, "widget");
    expect(hits.map((h) => h.id)).toEqual(["alpha-widget", "beta", "gamma", "delta"]);
  });
});
