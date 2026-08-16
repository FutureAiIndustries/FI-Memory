import { loadConfig } from "../config.js";
import type { Warning } from "../errors.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { recordServed } from "../session.js";
import { countTokens } from "../tokens.js";
import { loadIndexOrEmpty } from "../store/index.js";
import { parseLog } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { isTombstone, parseNote } from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { readParsed, readText } from "../store/read.js";

export interface SearchHit {
  id: string;
  title: string;
  excerpt: string;
  noteTokens: number;
  score: number;
}

export interface SearchOptions {
  maxHits?: number;
}

/**
 * Deterministic search (SPEC §5.5, extended 2026-07-26 for log indexing;
 * 2026-07-27 iteration 2: diacritic fold, meta-log demotion, decision boost).
 *
 * Case-insensitive and diacritic-insensitive (`Crookémon` ↔ `crookemon`);
 * the query splits on whitespace/hyphens.
 *
 * Matching:
 *   1. AND first — every query token must hit somewhere in the topic's note
 *      fields OR its typed log entries. Topics that satisfy AND are ranked.
 *   2. Ranked-OR fallback — if AND yields zero hits, re-score with OR
 *      semantics (any token match counts) and rank by coverage + field score.
 *      A topic with no matching tokens still stays out.
 *
 * Per-token field scoring (note): id 10 · title 8 · alias 6 · tag 4 ·
 * heading line 3 · body term-frequency ×1.
 * Per-token field scoring (log, 2026-07-26/27): summary 7 (decision-type
 * summaries 10 — closes decision-keyword gaps); type/project 2; entry body
 * term-frequency ×1. Meta-log demotion: when a multi-token query appears as a
 * contiguous phrase in a log summary/body (eval/probe pollution class — Grok
 * R2 Q1), that phrase contributes at most weight 1 total instead of 7×N.
 *
 * Stable sort: score desc, then id asc. Returns id/title/excerpt/noteTokens —
 * never note bodies.
 */
export async function search(
  home: string,
  query: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; warnings: Warning[] }> {
  const { config } = loadConfig(storePaths(home).config);
  const maxHits = opts.maxHits ?? config.maxSearchHits;
  const tokens = fold(query)
    .split(/[\s-]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { hits: [], warnings: [] };
  const queryPhrase = tokens.length > 1 ? tokens.join(" ") : null;

  const warnings: Warning[] = [];
  const index = await loadIndexOrEmpty(home);
  const andHits: SearchHit[] = [];
  const orHits: SearchHit[] = [];

  for (const id of Object.keys(index.topics)) {
    const note = await readParsed(topicNotePath(home, id), (t) =>
      parseNote(t, id),
    );
    if (!note) {
      warnings.push({
        id,
        code: "E_CORRUPT_SKIPPED",
        message: `topic "${id}" unparsable; skipped`,
      });
      continue;
    }
    if (isTombstone(note)) continue;

    let entries: LogEntry[] = [];
    try {
      const logText = (await readText(topicLogPath(home, id))) ?? "";
      if (logText.length > 0) {
        const parsed = parseLog(logText, id);
        entries = parsed.entries;
        for (const w of parsed.warnings) {
          warnings.push({ ...w, id });
        }
      }
    } catch (err) {
      // A mode/key failure on one log should not kill the whole search — skip
      // that topic's log surface and still score the note (with a warning).
      warnings.push({
        id,
        code: "E_CORRUPT_SKIPPED",
        message: `topic "${id}" log unreadable; note-only search: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    const fields = buildFields(note, entries);
    const andScore = scoreFields(tokens, fields, "and", queryPhrase);
    if (andScore !== null) {
      andHits.push(toHit(note, andScore));
      continue;
    }
    const orScore = scoreFields(tokens, fields, "or", queryPhrase);
    if (orScore !== null) {
      orHits.push(toHit(note, orScore));
    }
  }

  // Prefer AND results; fall back to ranked-OR only when AND is empty.
  const hits = andHits.length > 0 ? andHits : orHits;
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = hits.slice(0, maxHits);
  // Session meter (SPEC §6): search serves summaries, not topics — charge the
  // text served (id + title + excerpt per hit), count no topics as "read".
  recordServed(
    0,
    kept.reduce((sum, h) => sum + countTokens(h.id + h.title + h.excerpt), 0),
  );
  return { hits: kept, warnings };
}

function toHit(
  note: TopicNote,
  scored: { score: number; excerpt: string },
): SearchHit {
  return {
    id: note.id,
    title: note.title,
    excerpt: scored.excerpt,
    noteTokens: countTokens(note.body),
    score: scored.score,
  };
}

// ── Field surface ──────────────────────────────────────────────────────────

/** Lowercase + strip diacritics so Crookémon matches crookemon. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

interface LogSummaryLine {
  textL: string; // folded
  type: string;
}

interface SearchFields {
  idL: string;
  titleL: string;
  aliasesL: string[];
  tagsL: string[];
  headingsL: string[];
  bodyL: string;
  bodyLines: string[];
  /** Per-entry folded summaries + type (for decision boost + meta demotion). */
  logSummaries: LogSummaryLine[];
  /** type + project tokens from every entry. */
  logMetaL: string;
  /** Full entry text after the header (summary + optional body), folded. */
  logBodiesL: string;
  /** Candidate excerpt lines from logs (original casing summaries). */
  logExcerptLines: string[];
  title: string;
}

function buildFields(note: TopicNote, entries: LogEntry[]): SearchFields {
  const bodyLines = note.body.split("\n");
  const logExcerptLines: string[] = [];
  const logSummaries: LogSummaryLine[] = [];
  const metaParts: string[] = [];
  const bodyParts: string[] = [];

  for (const e of entries) {
    const summary = e.summary ?? "";
    if (summary.trim()) {
      logSummaries.push({ textL: fold(summary), type: e.type });
      logExcerptLines.push(summary);
    }
    metaParts.push(e.type, e.project);
    // rest of raw after the header line = summary + optional body
    const nl = e.raw.indexOf("\n");
    const rest = nl === -1 ? "" : e.raw.slice(nl + 1);
    if (rest.trim()) bodyParts.push(rest);
  }

  return {
    idL: fold(note.id),
    titleL: fold(note.title),
    aliasesL: note.aliases.map((a) => fold(a)),
    tagsL: note.tags.map((t) => fold(t)),
    headingsL: bodyLines.filter((l) => l.startsWith("## ")).map((l) => fold(l)),
    bodyL: fold(note.body),
    bodyLines,
    logSummaries,
    logMetaL: fold(metaParts.join(" ")),
    logBodiesL: fold(bodyParts.join("\n")),
    logExcerptLines,
    title: note.title,
  };
}

/**
 * Score log summaries with decision co-occurrence boost and meta-phrase
 * demotion. Summary weight is once-per-token (not per-line) so busy topics
 * with dozens of logs don't dominate — matching the 2026-07-26 log-index
 * baseline. Decision co-occurrence and meta demotion are the iteration-2
 * additions.
 */
function scoreLogSummaries(
  tokens: string[],
  summaries: LogSummaryLine[],
  queryPhrase: string | null,
): { weight: Map<string, number>; matched: Set<string> } {
  const weight = new Map<string, number>();
  const matched = new Set<string>();
  for (const t of tokens) weight.set(t, 0);

  // Track best per-token weight (once per token, not per line — busy topics
  // with dozens of logs must not dominate). Decision-type summaries get a
  // higher once-weight so decision-keyword queries land on the decision topic.
  const best = new Map<string, number>();
  for (const t of tokens) best.set(t, 0);

  for (const line of summaries) {
    // Eval/meta pollution (Grok R2 Q1 class): probe/eval logs that quote the
    // multi-token query. Mark AND-match only — zero rank weight.
    if (queryPhrase && isMetaPollutionLine(line.textL, queryPhrase)) {
      for (const t of tokens) {
        if (line.textL.includes(t)) matched.add(t);
      }
      continue;
    }
    const hitTokens = tokens.filter((t) => line.textL.includes(t));
    if (hitTokens.length === 0) continue;
    // Decision-keyword gap: decision-type summaries weight 10 (base was 7) so
    // multi-token decision facts ("license FSL") outrank same-token chatter
    // on non-decision topics. Once-per-token max (no multi-line stacking).
    const w = line.type === "decision" ? 10 : 7;
    for (const t of hitTokens) {
      matched.add(t);
      best.set(t, Math.max(best.get(t) ?? 0, w));
    }
  }
  for (const t of tokens) weight.set(t, best.get(t) ?? 0);
  return { weight, matched };
}

/** True when a log line is eval/meta noise quoting the full query phrase. */
function isMetaPollutionLine(lineL: string, queryPhrase: string): boolean {
  if (!lineL.includes(queryPhrase)) return false;
  if (lineL.includes(`"${queryPhrase}"`) || lineL.includes(`'${queryPhrase}'`)) return true;
  if (/\b(probe|eval|rank-|hit@|void|pre-registered|delta 0)\b/.test(lineL)) return true;
  if (lineL.includes("→") || lineL.includes("->")) return true;
  return false;
}

function scoreFields(
  tokens: string[],
  f: SearchFields,
  mode: "and" | "or",
  queryPhrase: string | null,
): { score: number; excerpt: string } | null {
  const logSum = scoreLogSummaries(tokens, f.logSummaries, queryPhrase);
  // Scrub meta-pollution phrases from log bodies line-by-line so a single
  // eval entry cannot blank the phrase across the whole joined log surface.
  let logBodies = f.logBodiesL;
  if (queryPhrase) {
    logBodies = f.logBodiesL
      .split("\n")
      .map((line) =>
        isMetaPollutionLine(line, queryPhrase) ? line.split(queryPhrase).join(" ") : line,
      )
      .join("\n");
  }

  let total = 0;
  let matchedTokens = 0;
  for (const t of tokens) {
    let s = 0;
    let hit = logSum.matched.has(t);
    if (f.idL.includes(t)) {
      s += 10;
      hit = true;
    }
    if (f.titleL.includes(t)) {
      s += 8;
      hit = true;
    }
    if (f.aliasesL.some((a) => a.includes(t))) {
      s += 6;
      hit = true;
    }
    if (f.tagsL.some((g) => g.includes(t))) {
      s += 4;
      hit = true;
    }
    const headingHits = f.headingsL.filter((h) => h.includes(t)).length;
    if (headingHits > 0) {
      s += headingHits * 3;
      hit = true;
    }
    const bodyHits = countOccurrences(f.bodyL, t);
    if (bodyHits > 0) {
      s += bodyHits;
      hit = true;
    }
    s += logSum.weight.get(t) ?? 0;
    if (f.logMetaL.includes(t)) {
      s += 2;
      hit = true;
    }
    const logBodyHits = countOccurrences(logBodies, t);
    if (logBodyHits > 0) {
      s += logBodyHits;
      hit = true;
    }
    if (!hit) {
      if (mode === "and") return null; // this token matched nothing → topic excluded
      continue;
    }
    matchedTokens += 1;
    total += s;
  }
  if (matchedTokens === 0) return null;
  // OR mode: boost multi-token partials so a 2-of-3 beat a 1-of-3.
  if (mode === "or" && tokens.length > 1) {
    total = total * matchedTokens + matchedTokens;
  }

  const matchLine =
    f.bodyLines.find(
      (l) => l.trim().length > 0 && tokens.some((t) => fold(l).includes(t)),
    ) ??
    f.logExcerptLines.find(
      (l) => l.trim().length > 0 && tokens.some((t) => fold(l).includes(t)),
    ) ??
    f.bodyLines.find((l) => l.trim().length > 0) ??
    f.logExcerptLines[0] ??
    f.title;
  return { score: total, excerpt: matchLine.trim().slice(0, 120) };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
