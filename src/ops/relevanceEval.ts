import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { search } from "./search.js";

/**
 * Relevance eval harness (Lane F, F-B). Runs a pre-registered query set
 * against a store READ-ONLY through the real `search` op and reports hit@1 /
 * hit@3 with per-miss detail — so retrieval-quality regressions are visible
 * run-over-run instead of anecdotal.
 *
 * The query file is JSON: `[{ id, question, queryTerms, expectedTopics }]`.
 * `question` is the human framing (recorded, not executed); `queryTerms` is
 * what actually gets searched (joined with spaces — the same string a caller
 * would pass to `fimemory search`); `expectedTopics` are the topic ids that
 * count as a hit. Pre-registered means the set is written BEFORE looking at
 * results and versioned with the store snapshot it targets — editing queries
 * until the number looks good is the failure mode this exists to prevent.
 */

export interface EvalQuery {
  id: string;
  question: string;
  queryTerms: string[];
  expectedTopics: string[];
}

export interface EvalHit {
  id: string;
  score: number;
}

export interface EvalQueryResult {
  id: string;
  question: string;
  /** The literal query string that was searched. */
  query: string;
  expected: string[];
  /** Top hits actually returned (id + score), best first. */
  top: EvalHit[];
  hitAt1: boolean;
  hitAt3: boolean;
}

export interface EvalReport {
  total: number;
  hitAt1: number;
  hitAt3: number;
  /** Rates rounded to 3 decimals (0 when total is 0). */
  hitAt1Rate: number;
  hitAt3Rate: number;
  results: EvalQueryResult[];
  /** The subset of `results` that missed at hit@3 — the ones worth reading. */
  misses: EvalQueryResult[];
  warnings: Warning[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/**
 * Parse + validate a query-file's JSON text. Fails closed with E_SCHEMA on any
 * malformed item — a silently-skipped query would quietly shrink the
 * denominator and inflate the score.
 */
export function parseQueryFile(text: string): EvalQuery[] {
  let raw: unknown;
  try {
    // Strip a leading UTF-8 BOM: Windows editors and PowerShell 5.1's
    // `Out-File -Encoding utf8` prepend one, and JSON.parse rejects it — a
    // fine query file would fail with a misleading "not valid JSON".
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new GestaltError(
      "E_SCHEMA",
      "The query file is not valid JSON.",
      "Expected: [{ id, question, queryTerms, expectedTopics }]",
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GestaltError(
      "E_SCHEMA",
      "The query file must be a non-empty JSON array.",
      "Expected: [{ id, question, queryTerms, expectedTopics }]",
    );
  }
  const queries: EvalQuery[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const q = (typeof item === "object" && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const id = q["id"];
    const question = q["question"];
    const queryTerms = q["queryTerms"];
    const expectedTopics = q["expectedTopics"];
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof question !== "string" ||
      !isStringArray(queryTerms) ||
      queryTerms.length === 0 ||
      !isStringArray(expectedTopics) ||
      expectedTopics.length === 0
    ) {
      throw new GestaltError(
        "E_SCHEMA",
        `Query ${i} is malformed (need id, question, non-empty queryTerms[], non-empty expectedTopics[]).`,
        "Fix the query file, then re-run.",
      );
    }
    if (seen.has(id)) {
      throw new GestaltError(
        "E_SCHEMA",
        `Duplicate query id "${id}" — every query needs a distinct id.`,
        "Fix the query file, then re-run.",
      );
    }
    seen.add(id);
    queries.push({ id, question, queryTerms, expectedTopics });
  }
  return queries;
}

/**
 * Run every query through `search` (read-only — search writes nothing) and
 * score hit@1 / hit@3: does any expected topic appear as the top hit / in the
 * top three. Search warnings (unparsable topics skipped) are surfaced on the
 * report, not swallowed — a corrupt topic can silently depress recall.
 */
export async function runRelevanceEval(
  home: string,
  queries: EvalQuery[],
): Promise<EvalReport> {
  const results: EvalQueryResult[] = [];
  const warnings: Warning[] = [];

  for (const q of queries) {
    const query = q.queryTerms.join(" ");
    const { hits, warnings: searchWarnings } = await search(home, query);
    warnings.push(...searchWarnings);
    const top = hits.map((h) => ({ id: h.id, score: h.score }));
    const expected = new Set(q.expectedTopics);
    const hitAt1 = top.length > 0 && expected.has(top[0]!.id);
    const hitAt3 = top.slice(0, 3).some((h) => expected.has(h.id));
    results.push({
      id: q.id,
      question: q.question,
      query,
      expected: q.expectedTopics,
      top,
      hitAt1,
      hitAt3,
    });
  }

  const hitAt1 = results.filter((r) => r.hitAt1).length;
  const hitAt3 = results.filter((r) => r.hitAt3).length;
  const rate = (n: number): number =>
    results.length === 0 ? 0 : Math.round((n / results.length) * 1000) / 1000;
  return {
    total: results.length,
    hitAt1,
    hitAt3,
    hitAt1Rate: rate(hitAt1),
    hitAt3Rate: rate(hitAt3),
    results,
    misses: results.filter((r) => !r.hitAt3),
    warnings,
  };
}

/** Render the report as Markdown: a summary line, a per-query table, per-miss detail. */
export function renderEvalMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# Relevance eval");
  lines.push("");
  lines.push(
    `**hit@1: ${report.hitAt1}/${report.total} (${report.hitAt1Rate})** · ` +
      `**hit@3: ${report.hitAt3}/${report.total} (${report.hitAt3Rate})**`,
  );
  lines.push("");
  lines.push("| query | searched | hit@1 | hit@3 | top hit |");
  lines.push("|---|---|---|---|---|");
  for (const r of report.results) {
    lines.push(
      `| ${r.id} | \`${r.query}\` | ${r.hitAt1 ? "yes" : "no"} | ${r.hitAt3 ? "yes" : "no"} | ${r.top[0]?.id ?? "(none)"} |`,
    );
  }
  if (report.misses.length > 0) {
    lines.push("");
    lines.push("## Misses (not in top 3)");
    for (const m of report.misses) {
      lines.push("");
      lines.push(`### ${m.id} — ${m.question}`);
      lines.push(`- searched: \`${m.query}\``);
      lines.push(`- expected: ${m.expected.join(", ")}`);
      lines.push(
        `- got: ${
          m.top.length === 0
            ? "(no hits)"
            : m.top
                .slice(0, 5)
                .map((h) => `${h.id} (${h.score})`)
                .join(", ")
        }`,
      );
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const w of report.warnings) {
      lines.push(`- ${w.message}${w.id ? ` (${w.id})` : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
