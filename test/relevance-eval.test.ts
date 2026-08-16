import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDemoStore } from "../src/ops/demoStore.js";
import {
  parseQueryFile,
  renderEvalMarkdown,
  runRelevanceEval,
} from "../src/ops/relevanceEval.js";
import { expectGestaltError, freshHome } from "./helpers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tools/fixtures/demo-store-queries.json",
);

/** Relative path → sha256 for every file under `dir` (read-only proof). */
function fileHashes(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else {
        hashes.set(
          rel.replace(/\\/g, "/"),
          createHash("sha256").update(readFileSync(path.join(dir, rel))).digest("hex"),
        );
      }
    }
  };
  walk("");
  return hashes;
}

/**
 * TIMEOUTS (measured 2026-07-30). The three tests below each build a real demo
 * store, and that is genuine work, not a pathology: in isolation `buildDemoStore`
 * takes ~900 ms and a 10-query `runRelevanceEval` ~145 ms, stable to ±50 ms over
 * repeated rounds — so ~1.0 s of honest work per test, with no quadratic blowup
 * and no retry ladder involved.
 *
 * Under the FULL suite that same 1.0 s stretches to ~4.9 s, because 56 files run
 * in parallel alongside the contention suites, which spawn dozens of `tsx` child
 * processes and saturate the disk. Against vitest's 5000 ms default that leaves
 * ~76 ms of margin, which made this a coin-flip flake: it timed out on one run
 * and passed at 4924 ms on the next, with no code change in between.
 *
 * So the explicit budget below is buying headroom for SCHEDULING contention on a
 * loaded box, not hiding a slow store build. If one of these ever approaches
 * 30 s, that is a real regression in `buildDemoStore` or retrieval — investigate
 * it, do not raise the number again.
 */
const DEMO_STORE_TIMEOUT_MS = 30_000;

describe("relevance eval harness (Lane F, F-B)", () => {
  it("the registered 10-query set scores 10/10 hit@3 on the demo store", async () => {
    const home = freshHome("eval");
    await buildDemoStore(home);
    const queries = parseQueryFile(readFileSync(FIXTURE, "utf8"));
    expect(queries).toHaveLength(10);

    const report = await runRelevanceEval(home, queries);
    expect(report.total).toBe(10);
    expect(report.hitAt3).toBe(10);
    expect(report.misses).toEqual([]);
    expect(report.hitAt3Rate).toBe(1);
    // The demo store is small and the queries are honest, so top-1 should be
    // strong too — a drop below 9 means retrieval or the store regressed.
    expect(report.hitAt1).toBeGreaterThanOrEqual(9);
    expect(report.warnings).toEqual([]);

    const md = renderEvalMarkdown(report);
    expect(md).toContain("hit@3: 10/10");
    expect(md).toContain("| pricing-model |");
  }, DEMO_STORE_TIMEOUT_MS);

  it("runs READ-ONLY: the store's bytes are untouched by an eval", async () => {
    const home = freshHome("eval-ro");
    await buildDemoStore(home);
    const before = fileHashes(home);
    await runRelevanceEval(home, parseQueryFile(readFileSync(FIXTURE, "utf8")));
    expect(fileHashes(home)).toEqual(before);
  }, DEMO_STORE_TIMEOUT_MS);

  it("records per-miss detail (expected vs got) instead of just a number", async () => {
    const home = freshHome("eval-miss");
    await buildDemoStore(home);
    const report = await runRelevanceEval(home, [
      {
        id: "impossible",
        question: "A query nothing matches",
        queryTerms: ["zzyzxq"],
        expectedTopics: ["engine-and-tools"],
      },
    ]);
    expect(report.hitAt3).toBe(0);
    expect(report.misses).toHaveLength(1);
    expect(report.misses[0]!.expected).toEqual(["engine-and-tools"]);
    expect(report.misses[0]!.top).toEqual([]);
    const md = renderEvalMarkdown(report);
    expect(md).toContain("## Misses");
    expect(md).toContain("(no hits)");
  }, DEMO_STORE_TIMEOUT_MS);

  it("accepts a query file with a UTF-8 BOM (PowerShell 5.1 / Windows editors prepend one)", () => {
    const queries = parseQueryFile(
      "\uFEFF" +
        JSON.stringify([
          { id: "q1", question: "?", queryTerms: ["a"], expectedTopics: ["t"] },
        ]),
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]!.id).toBe("q1");
  });

  it("fails closed on a malformed query file (E_SCHEMA, never a shrunken denominator)", () => {
    expectGestaltError(() => parseQueryFile("not json"), "E_SCHEMA");
    expectGestaltError(() => parseQueryFile("[]"), "E_SCHEMA");
    expectGestaltError(
      () => parseQueryFile(JSON.stringify([{ id: "q1", question: "?" }])),
      "E_SCHEMA",
    );
    expectGestaltError(
      () =>
        parseQueryFile(
          JSON.stringify([
            { id: "q1", question: "?", queryTerms: ["a"], expectedTopics: [] },
          ]),
        ),
      "E_SCHEMA",
    );
    expectGestaltError(
      () =>
        parseQueryFile(
          JSON.stringify([
            { id: "dup", question: "?", queryTerms: ["a"], expectedTopics: ["t"] },
            { id: "dup", question: "?", queryTerms: ["b"], expectedTopics: ["t"] },
          ]),
        ),
      "E_SCHEMA",
    );
  });
});
