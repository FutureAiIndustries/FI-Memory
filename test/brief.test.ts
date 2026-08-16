import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  brief,
  expandQuery,
  formatInjectBlock,
  shouldSkipPrompt,
} from "../src/ops/brief.js";
import { appendLog } from "../src/ops/logOp.js";
import { writeNote, freshHome } from "./helpers.js";

describe("brief — prompt skip / query expansion", () => {
  it("skips ultra-short and acknowledgement prompts", () => {
    expect(shouldSkipPrompt("yes")).toBe(true);
    expect(shouldSkipPrompt("ok")).toBe(true);
    expect(shouldSkipPrompt("do that")).toBe(true);
    expect(shouldSkipPrompt("thanks")).toBe(true);
    expect(shouldSkipPrompt("continue")).toBe(true);
    expect(shouldSkipPrompt("")).toBe(true);
    expect(shouldSkipPrompt("hi")).toBe(true);
  });

  it("does not skip real project questions", () => {
    expect(shouldSkipPrompt("What licence is the runtime under?")).toBe(false);
    expect(shouldSkipPrompt("How does office remote work?")).toBe(false);
  });

  it("expands decision keywords (fair-battery miss class 3)", () => {
    // Domain-neutral stems only: these have to help any user, not one project.
    const q = expandQuery("how do we deploy the service?");
    expect(q).toMatch(/deploy/);
    expect(q).toMatch(/deployment|release/);
    const t = expandQuery("what licence is this under?");
    expect(t).toMatch(/licence/);
    expect(t).toMatch(/license/);
  });

  it("keeps every prompt token, expanded or not", () => {
    const q = expandQuery("encryption keys for the database");
    for (const token of ["encryption", "keys", "database"]) {
      expect(q).toMatch(new RegExp(token));
    }
  });

  it("folds a store's own vocabulary over the neutral defaults", () => {
    // Project-specific terms live in the store's config, not in the package —
    // shipping one project's codenames misfires for every other reader.
    const q = expandQuery("status of the atlas rollout", {
      atlas: ["atlas", "migration", "phase2"],
    });
    expect(q).toMatch(/atlas/);
    expect(q).toMatch(/migration/);
    expect(q).toMatch(/phase2/);
  });

  it("ignores malformed user expansions instead of throwing", () => {
    const q = expandQuery("deploy the thing", {
      deploy: ["shipit"],
      bogus: null as unknown as string[],
      empty: [],
    });
    expect(q).toMatch(/shipit/);
    expect(q).toMatch(/deploy/);
  });
});

describe("brief — inject framing", () => {
  it("declares ALREADY-RETRIEVED and AUTHORITATIVE; log before body", () => {
    const { text, tokens } = formatInjectBlock(
      [
        {
          id: "demo",
          summary: "demo — Demo · updated 2026-01-01",
          body: "Stale body saying Apache 2.0.",
          logTail: "### 2026-07-25 | decision | fimemory | cli\nFSL-1.1-ALv2 is the licence.",
        },
      ],
      { query: "licence fsl", tokenCap: 500 },
    );
    expect(tokens).toBeGreaterThan(0);
    expect(text).toContain("ALREADY-RETRIEVED");
    expect(text).toContain("AUTHORITATIVE");
    expect(text).toMatch(/Do NOT request live search/i);
    expect(text).toContain("fimemory_search");
    // Log section must appear before body so fresh decisions win attention.
    const logAt = text.indexOf("Recent log");
    const bodyAt = text.indexOf("Note body");
    expect(logAt).toBeGreaterThan(0);
    expect(bodyAt).toBeGreaterThan(logAt);
    expect(text).toContain("FSL-1.1-ALv2");
  });
});

describe("brief — retrieval against a real store", () => {
  it("returns empty inject on short prompt (silent)", async () => {
    const home = freshHome("brief-short");
    runInit({ home });
    const r = await brief(home, "ok");
    expect(r.inject).toBe("");
    expect(r.skippedReason).toBe("short");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("search→top-2-get injects canary content under budget", async () => {
    const home = freshHome("brief-hit");
    runInit({ home });
    writeNote(home, "canary-topic", {
      title: "Canary Topic",
      body: "The purple zebra dances at midnight under the neon oak.",
      tags: ["canary"],
    });
    // Reindex so search sees the note (init seeds example; writeNote bypasses index).
    const { reindexStore } = await import("../src/ops/reindexOp.js");
    await reindexStore(home);

    const r = await brief(home, "Where does the purple zebra dance?", { force: true });
    expect(r.skippedReason).toBeUndefined();
    expect(r.inject).toContain("ALREADY-RETRIEVED");
    expect(r.inject).toContain("purple zebra");
    expect(r.topics).toContain("canary-topic");
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.tokens).toBeLessThanOrEqual(900);
  });

  it("prefers recent log over stale body in the inject block", async () => {
    const home = freshHome("brief-log");
    runInit({ home });
    writeNote(home, "licence-topic", {
      title: "Licence",
      body: "The runtime ships under Apache-2.0 open core.",
    });
    const { reindexStore } = await import("../src/ops/reindexOp.js");
    await reindexStore(home);
    await appendLog(home, "licence-topic", {
      type: "decision",
      project: "fimemory",
      summary: "Licence is FSL-1.1-ALv2, not Apache-2.0.",
      agent: "test",
    });

    const r = await brief(home, "What licence does the runtime use FSL?", { force: true });
    expect(r.inject).toContain("FSL-1.1-ALv2");
    const logAt = r.inject.indexOf("Recent log");
    const bodyAt = r.inject.indexOf("Note body");
    expect(logAt).toBeGreaterThan(0);
    expect(bodyAt).toBeGreaterThan(logAt);
  });

  it("does not re-inject the same topic twice in one session", async () => {
    const home = freshHome("brief-dedup");
    runInit({ home });
    writeNote(home, "once-topic", {
      title: "Once",
      body: "Unique canary phrase: crystalline mongoose protocol.",
    });
    const { reindexStore } = await import("../src/ops/reindexOp.js");
    await reindexStore(home);

    const sessionId = "sess-dedup-1";
    const first = await brief(home, "Tell me about crystalline mongoose protocol", {
      sessionId,
    });
    expect(first.inject).toContain("crystalline mongoose");
    const second = await brief(home, "Tell me more about crystalline mongoose protocol", {
      sessionId,
    });
    expect(second.inject).toBe("");
    expect(second.skippedReason).toBe("already-injected");
  });
});
