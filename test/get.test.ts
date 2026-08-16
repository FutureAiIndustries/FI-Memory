import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { topicLogPath } from "../src/paths.js";
import { get } from "../src/ops/get.js";
import { resetSession, sessionMeter } from "../src/session.js";
import { countTokens } from "../src/tokens.js";
import { freshHome, writeNote } from "./helpers.js";

function store(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

describe("get — budgeted read (SPEC §5.4)", () => {
  it("returns a topic in full when it fits, with tokens counted", async () => {
    const home = store();
    writeNote(home, "small", { title: "Small", body: "\nA short body.\n" });
    const r = await get(home, ["small"]);
    expect(r.topics).toHaveLength(1);
    expect(r.topics[0]!.truncated).toBe(false);
    expect(r.topics[0]!.body).toBe("\nA short body.\n");
    expect(r.clamped).toBe(false);
    expect(r.tokensUsed).toBe(r.topics[0]!.tokens);
  });

  it("dedupes ids preserving request order", async () => {
    const home = store();
    writeNote(home, "aa", {});
    writeNote(home, "bb", {});
    const r = await get(home, ["bb", "aa", "bb"]);
    expect(r.topics.map((t) => t.id)).toEqual(["bb", "aa"]);
  });

  it("drops a missing/corrupt id with a warning, not a hard error", async () => {
    const home = store();
    writeNote(home, "real", {});
    const r = await get(home, ["real", "ghost"]);
    expect(r.topics.map((t) => t.id)).toEqual(["real"]);
    expect(r.warnings.some((w) => w.id === "ghost")).toBe(true);
  });

  it("clamps to maxTopicsPerGet (3), warning on the rest", async () => {
    const home = store();
    for (const id of ["topic1", "topic2", "topic3", "topic4"]) writeNote(home, id, {});
    const r = await get(home, ["topic1", "topic2", "topic3", "topic4"]);
    expect(r.topics).toHaveLength(3);
    expect(r.clamped).toBe(true);
    expect(r.warnings.some((w) => w.id === "topic4")).toBe(true);
  });

  it("break script #1: 3 big topics + logTail 50 never exceeds the 2000 budget", async () => {
    const home = store();
    const big = "\n" + "The quick brown fox jumps over the lazy dog. ".repeat(220);
    for (const id of ["big1", "big2", "big3"]) writeNote(home, id, { body: big });
    const r = await get(home, ["big1", "big2", "big3"], { logTail: 50 });

    const total = r.topics.reduce((sum, t) => sum + t.tokens, 0);
    expect(r.tokensUsed).toBeLessThanOrEqual(2000);
    expect(total).toBeLessThanOrEqual(2000);
    // First topic truncated with a marker; the rest dropped for budget.
    expect(r.topics[0]!.truncated).toBe(true);
    expect(r.topics[0]!.body).toContain("[truncated —");
    expect(r.clamped).toBe(true);
    expect(r.warnings.some((w) => w.message.includes("budget exhausted"))).toBe(true);
  });

  it("paragraph-truncates at a blank-line boundary and appends a marker", async () => {
    const home = store();
    // ~700-token paragraphs; three of them (~2100 tokens) exceed the 2000 budget.
    const para = "lorem ipsum dolor sit amet ".repeat(100); // ~2700 chars ≈ 675 tokens
    const body = "\n" + [para, para, para].join("\n\n") + "\n";
    writeNote(home, "long", { body });
    const r = await get(home, ["long"]);
    expect(r.topics[0]!.truncated).toBe(true);
    expect(r.topics[0]!.body.endsWith("tokens over budget]")).toBe(true);
    expect(countTokens(r.topics[0]!.body)).toBeLessThanOrEqual(2000);
  });

  it("includes the requested log tail when it fits (token accounting §5.7)", async () => {
    const home = store();
    writeNote(home, "withlog", { body: "\nbody\n" });
    // Seed a couple of log entries directly.
    writeFileSync(
      topicLogPath(home, "withlog"),
      "# withlog log\n\n### 2026-07-11T00:00:01.000Z | decision | p | a\nfirst\n\n### 2026-07-11T00:00:02.000Z | gotcha | p | a\nsecond\n",
      "utf8",
    );
    const r = await get(home, ["withlog"], { logTail: 1 });
    expect(r.topics[0]!.logTail).toContain("second");
    expect(r.topics[0]!.logTail).not.toContain("first"); // only the last 1
  });

  it("drops a traversal-shaped id without touching the filesystem (Gate #2 #3, verifier catch)", async () => {
    const home = store();
    // Points at a real .md OUTSIDE topics/ — must be dropped, never served.
    const r = await get(home, ["../proposals/1-gestalt-example"]);
    expect(r.topics).toHaveLength(0);
    expect(r.warnings.some((w) => w.code === "E_INVALID_ID")).toBe(true);
  });

  it("caps per-group warnings at 10 + one summary (no warning flood — Gate #2 #1)", async () => {
    const home = store();
    writeNote(home, "real-topic", {});
    const ghosts = Array.from({ length: 25 }, (_, i) => `ghost-${i}`);
    const r = await get(home, ["real-topic", ...ghosts]);
    expect(r.topics.map((t) => t.id)).toEqual(["real-topic"]);
    const dropWarnings = r.warnings.filter((w) => w.code === "E_NOT_FOUND");
    expect(dropWarnings).toHaveLength(11); // 10 itemized + 1 summary
    expect(dropWarnings.at(-1)!.message).toContain("15 more");
  });

  it("feeds the session meter", async () => {
    const home = store();
    resetSession();
    writeNote(home, "metered", { body: "\nsome body text\n" });
    await get(home, ["metered"]);
    expect(sessionMeter().topicsServed).toBe(1);
    expect(sessionMeter().tokensServed).toBeGreaterThan(0);
  });
});
