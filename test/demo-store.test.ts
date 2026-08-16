import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDemoStore } from "../src/ops/demoStore.js";
import { DEMO_TOPICS } from "../src/ops/demoStoreData.js";
import { reviewList } from "../src/ops/review.js";
import { topicLogPath, topicNotePath } from "../src/paths.js";
import { loadIndexOrEmpty } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { readText } from "../src/store/read.js";
import { freshHome } from "./helpers.js";

/** Relative path → sha256 for every file under `dir` (sorted, recursive). */
function fileHashes(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else {
        const digest = createHash("sha256")
          .update(readFileSync(path.join(dir, rel)))
          .digest("hex");
        hashes.set(rel.replace(/\\/g, "/"), digest);
      }
    }
  };
  walk("");
  return hashes;
}

// Every test in here builds the FULL demo store through the REAL write path —
// 19 topics, 103 entries, each one taking the store lock — which routinely runs
// past vitest's 5s default once the suite is executing files in parallel. The
// work is legitimate and the assertions are exact; only the default deadline
// was wrong, so it is raised here rather than the store being made less real.
describe("demo store builder (Lane F, F-D — invented curated history)", { timeout: 120_000 }, () => {
  it("builds the Future Industries store through the real API", async () => {
    const home = freshHome("demo");
    const r = await buildDemoStore(home);

    expect(r.topics).toHaveLength(19);
    expect(r.entries).toBe(103);
    expect(r.approved).toBe(19);
    expect(r.pending).toBe(1);

    const index = await loadIndexOrEmpty(home);
    // The init worked example is purged by design (owner ruling 7/27:
    // no store-meta content; its fixed stamp also pins the clock floor).
    expect(Object.keys(index.topics)).toHaveLength(19);
    for (const id of r.topics) {
      expect(index.topics[id], id).toBeDefined();
    }
  });

  it("curated note bodies landed through update → approve (not skeletons)", async () => {
    const home = freshHome("demo");
    await buildDemoStore(home);
    const note = parseNote(
      (await readText(topicNotePath(home, "studio-pricing-model")))!,
      "studio-pricing-model",
    )!;
    expect(note.body.toLowerCase()).toContain("fixed fee");
    expect(note.body).not.toContain("Newly created");
  });

  it("holds real supersede chains (older decisions corrected by newer ones)", async () => {
    const home = freshHome("demo");
    await buildDemoStore(home);

    let chains = 0;
    for (const t of DEMO_TOPICS) {
      const entries = parseLog((await readText(topicLogPath(home, t.id)))!, t.id).entries;
      for (const e of entries) {
        if (e.type !== "supersede" || !e.supersedes) continue;
        const target = entries.find((x) => x.timestamp === e.supersedes);
        expect(target, `${t.id}: supersede target exists`).toBeDefined();
        expect(target!.timestamp < e.timestamp, `${t.id}: target is older`).toBe(true);
        chains += 1;
      }
    }
    expect(chains).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic — two builds are byte-identical in topics/ and logs/", async () => {
    const a = freshHome("demo-a");
    const b = freshHome("demo-b");
    await buildDemoStore(a);
    await buildDemoStore(b);
    for (const sub of ["topics", "logs"]) {
      expect(fileHashes(path.join(a, sub))).toEqual(fileHashes(path.join(b, sub)));
    }
  });

  it("carries ZERO fictional or demo/meta language (owner ruling 7/27)", async () => {
    const home = freshHome("demo");
    await buildDemoStore(home);
    const banned = [
      /fictional/i,
      /\bdemo\b/i,
      /\bsample\b/i,
      /placeholder/i,
      /lorem/i,
      /—/, // em-dash: not the owner's voice
      // The demo content must stay INVENTED. These are terms from the owner's
      // real notes, which this file used to ship verbatim to every installer.
      // If any of them reappears, real project history has leaked back in.
      /2342/,
      /crookemon/i,
      /confluence/i,
      /arcade/i,
      /squirl/i,
      /halfmoon/i,
    ];
    for (const sub of ["topics", "logs"]) {
      for (const f of readdirSync(path.join(home, sub))) {
        const text = readFileSync(path.join(home, sub, f), "utf8");
        for (const re of banned) {
          expect(re.test(text), `${sub}/${f} matches ${re}`).toBe(false);
        }
      }
    }
  });

  it("leaves exactly one pending suggested edit for review to show", async () => {
    const home = freshHome("demo");
    await buildDemoStore(home);
    const pending = (await reviewList(home)).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("print-proofing-checklist");
  });
});
