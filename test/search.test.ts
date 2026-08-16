import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { mergeTopics } from "../src/ops/merge.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { search } from "../src/ops/search.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { clockAt, freshHome, writeNote } from "./helpers.js";

async function store(): Promise<string> {
  const home = freshHome();
  runInit({ home });
  return home;
}

describe("search — deterministic ranking (SPEC §5.5)", () => {
  it("AND semantics: every query token must hit somewhere", async () => {
    const home = await store();
    writeNote(home, "auth-notes", {
      title: "Auth Notes",
      body: "\nWe use OAuth for login and sessions.\n",
    });
    writeNote(home, "deploy-notes", {
      title: "Deploy Notes",
      body: "\nWe deploy with a tunnel.\n",
    });
    await reindexStore(home);

    // "auth login" — both tokens hit auth-notes; deploy-notes lacks both.
    const { hits } = await search(home, "auth login");
    expect(hits.map((h) => h.id)).toEqual(["auth-notes"]);
  });

  it("field weighting: an id hit outranks a body-only hit", async () => {
    const home = await store();
    writeNote(home, "tunnel", { title: "Networking", body: "\nGeneral notes.\n" });
    writeNote(home, "hosting", {
      title: "Hosting",
      body: "\nWe run a tunnel here, tunnel tunnel.\n",
    });
    await reindexStore(home);

    const { hits } = await search(home, "tunnel");
    expect(hits[0]!.id).toBe("tunnel"); // id hit (10) beats body TF
  });

  it("returns id/title/excerpt/noteTokens — never the body", async () => {
    const home = await store();
    writeNote(home, "budget-notes", {
      title: "Budget Notes",
      body: "\nEvery read is capped by a budget.\nSecond line.\n",
    });
    await reindexStore(home);

    const { hits } = await search(home, "budget");
    const hit = hits.find((h) => h.id === "budget-notes")!;
    expect(hit.excerpt).toContain("budget");
    expect(hit.excerpt.length).toBeLessThanOrEqual(120);
    expect(hit.noteTokens).toBeGreaterThan(0);
    expect(Object.keys(hit)).not.toContain("body");
  });

  it("respects maxHits", async () => {
    const home = await store();
    for (let i = 0; i < 5; i++) {
      writeNote(home, `note-${i}`, { title: `Note ${i}`, body: "\nshared keyword here.\n" });
    }
    await reindexStore(home);
    const { hits } = await search(home, "keyword", { maxHits: 2 });
    expect(hits).toHaveLength(2);
  });

  it("excludes merged-away tombstones", async () => {
    const home = await store();
    await createTopic(home, "primary", "Primary", { now: clockAt(1000) });
    await createTopic(home, "secondary", "Secondary", { now: clockAt(1000) });
    await mergeTopics(home, "secondary", "primary");
    const { hits } = await search(home, "secondary");
    expect(hits.map((h) => h.id)).not.toContain("secondary");
  });

  it("indexes typed log summaries — a note-only search would miss them", async () => {
    const home = await store();
    writeNote(home, "gestalt-decisions", {
      title: "Gestalt Decisions",
      body: "\nOlder curated facts only.\n",
    });
    await reindexStore(home);
    await appendLog(home, "gestalt-decisions", {
      type: "decision",
      project: "fimemory",
      agent: "test",
      summary: "Name DECIDED: FIMemory is the public product name.",
    });

    // Term lives only in the log — pre-fix search would return zero hits.
    const { hits } = await search(home, "fimemory name");
    expect(hits.map((h) => h.id)).toContain("gestalt-decisions");
    expect(hits[0]!.excerpt.toLowerCase()).toMatch(/fimemory|name decided/);
  });

  it("AND→ranked-OR fallback: partial token match when AND is empty", async () => {
    const home = await store();
    writeNote(home, "gestalt-encryption", {
      title: "Encryption",
      body: "\nAt-rest encryption plan and default flip remaining work.\n",
    });
    writeNote(home, "unrelated", {
      title: "Unrelated",
      body: "\nNothing about security here.\n",
    });
    await reindexStore(home);

    // "encryption default remaining" — note has encryption + remaining but not
    // necessarily every word as AND would require if one is absent. Use a
    // query where one term is missing from all notes so AND empties, then OR
    // recovers the right topic via the terms that ARE present.
    const { hits } = await search(home, "encryption default zebra");
    // AND fails (zebra nowhere); OR recovers gestalt-encryption via encryption.
    expect(hits.map((h) => h.id)).toContain("gestalt-encryption");
    expect(hits[0]!.id).toBe("gestalt-encryption");
  });

  it("AND results win over OR — no OR pollution when AND hits exist", async () => {
    const home = await store();
    writeNote(home, "full-match", {
      title: "Full",
      body: "\nalpha beta gamma together.\n",
    });
    writeNote(home, "partial-only", {
      title: "Partial",
      body: "\nalpha only here.\n",
    });
    await reindexStore(home);

    const { hits } = await search(home, "alpha beta gamma");
    // AND finds full-match; partial-only must not appear (OR is not used).
    expect(hits.map((h) => h.id)).toEqual(["full-match"]);
  });

  it("diacritic fold: crookemon matches Crookémon in the note body", async () => {
    const home = await store();
    writeNote(home, "hd2d-art-pipeline", {
      title: "HD-2D Art Pipeline",
      body: "\nCrookémon sprite pipeline for canvas games.\n",
    });
    await reindexStore(home);
    const { hits } = await search(home, "crookemon sprites");
    expect(hits.map((h) => h.id)).toContain("hd2d-art-pipeline");
    expect(hits[0]!.id).toBe("hd2d-art-pipeline");
  });

  it("meta-log phrase pollution: exact query in an eval log does not outrank real content", async () => {
    // Grok R2 Q1 class: a supersede/eval log quoting the probe phrase
    // ("crookemon sprites") on gestalt-decisions used to rank above the real
    // art topic that actually owns the content.
    const home = await store();
    writeNote(home, "gestalt-decisions", {
      title: "Gestalt Product Decisions",
      body: "\nProduct decisions only — no art content.\n",
    });
    writeNote(home, "hd2d-art-pipeline", {
      title: "HD-2D Art Pipeline",
      body: "\nCrookémon sprites and scene art for the browser HD-2D pipeline.\n",
    });
    await reindexStore(home);
    await appendLog(home, "gestalt-decisions", {
      type: "supersede",
      project: "fimemory",
      agent: "test",
      summary:
        'Grok R2 VOID — probe proof: "crookemon sprites"→hd2d-art-pipeline rank-1 on the new CLI.',
    });

    const { hits } = await search(home, "crookemon sprites");
    expect(hits.map((h) => h.id)).toContain("hd2d-art-pipeline");
    expect(hits[0]!.id).toBe("hd2d-art-pipeline");
  });

  it("decision-type log summaries outrank ordinary log chatter for the same tokens", async () => {
    const home = await store();
    writeNote(home, "gestalt-decisions", {
      title: "Gestalt Decisions",
      body: "\nOlder curated facts.\n",
    });
    writeNote(home, "noise-topic", {
      title: "Noise",
      body: "\nUnrelated body.\n",
    });
    await reindexStore(home);
    await appendLog(home, "gestalt-decisions", {
      type: "decision",
      project: "fimemory",
      agent: "test",
      summary: "License DECIDED: FSL-1.1-ALv2 is the ship licence.",
    });
    await appendLog(home, "noise-topic", {
      type: "gotcha",
      project: "misc",
      agent: "test",
      summary: "Someone mentioned license FSL in passing while debugging.",
    });

    const { hits } = await search(home, "license FSL");
    expect(hits[0]!.id).toBe("gestalt-decisions");
  });
});
