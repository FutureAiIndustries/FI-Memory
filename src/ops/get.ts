import { loadConfig } from "../config.js";
import type { Warning } from "../errors.js";
import { isValidId } from "../id.js";
import { storePaths, topicLogPath, topicNotePath } from "../paths.js";
import { warnStoreReadable } from "../store/schema.js";
import { recordServed } from "../session.js";
import { countTokens } from "../tokens.js";
import { parseLog } from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { isTombstone, parseNote } from "../store/note.js";
import type { TopicNote } from "../store/note.js";
import { readParsed, readText } from "../store/read.js";

export interface GetOptions {
  logTail?: number;
}

export interface GetTopicResult {
  id: string;
  summary: string;
  body: string;
  logTail: string;
  truncated: boolean;
  tokens: number;
}

export interface GetResult {
  topics: GetTopicResult[];
  clamped: boolean;
  reasons: string[];
  warnings: Warning[];
  tokensUsed: number;
}

const SEP_TOKENS = countTokens("\n\n");

// Per-response cap on individual warning entries per group (SPEC §5.8, rev 6):
// a request naming hundreds of missing ids must not flood the payload with
// warnings — the first N are itemized, the rest are one summary line.
const MAX_WARNINGS_PER_GROUP = 10;

function pushCapped(
  warnings: Warning[],
  group: Warning[],
  summarize: (omitted: number) => Warning,
): void {
  if (group.length <= MAX_WARNINGS_PER_GROUP) {
    warnings.push(...group);
    return;
  }
  warnings.push(...group.slice(0, MAX_WARNINGS_PER_GROUP));
  warnings.push(summarize(group.length - MAX_WARNINGS_PER_GROUP));
}

/**
 * Budgeted read (SPEC §5.4). Lock-free. Deterministic pipeline: dedupe →
 * drop missing/corrupt/tombstone → clamp to `maxTopicsPerGet` → greedily fill
 * `maxTokensPerGet`. Under budget pressure the **note body wins over the log
 * tail** (rev 4, #8): a topic whose body fits keeps its body in full and takes
 * as much tail as remains (a shortened tail is a named warning, not a
 * truncation); only when the body itself can't fit is it paragraph-truncated
 * (fence-aware, #7), marked, and the remaining topics dropped. Total charged is
 * hard-capped at `maxTokensPerGet` (invariant 3).
 */
export async function get(
  home: string,
  requestedIds: string[],
  opts: GetOptions = {},
): Promise<GetResult> {
  const { config } = loadConfig(storePaths(home).config);
  const logTailN = opts.logTail ?? 0;
  const warnings: Warning[] = [];
  {
    // 0.4: min_reader warning (see search.ts) — same rule on the read surface
    // agents actually consume.
    const readable = warnStoreReadable(home);
    if (readable) warnings.push({ code: "schema_min_reader", message: readable });
  }
  const reasons: string[] = [];
  let clamped = false;

  // 1. dedupe, preserve order
  const seen = new Set<string>();
  const ids = requestedIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // 2. read + drop missing / corrupt / tombstone
  interface Survivor {
    id: string;
    note: TopicNote;
    logText: string;
  }
  const survivors: Survivor[] = [];
  const dropWarnings: Warning[] = [];
  for (const id of ids) {
    // An invalid-shaped id never reaches a path join (no traversal — a crafted
    // "../…" id must not read files outside topics/).
    if (!isValidId(id)) {
      dropWarnings.push({ id, code: "E_INVALID_ID", message: `dropped "${id}" (not a valid topic id)` });
      continue;
    }
    const note = await readParsed(topicNotePath(home, id), (t) =>
      parseNote(t, id),
    );
    if (!note) {
      dropWarnings.push({ id, code: "E_NOT_FOUND", message: `dropped "${id}" (missing or corrupt)` });
      continue;
    }
    if (isTombstone(note)) {
      dropWarnings.push({
        id,
        code: "E_NOT_FOUND",
        message: `dropped "${id}" (merged into ${note.mergedInto})`,
      });
      continue;
    }
    const logText = (await readText(topicLogPath(home, id))) ?? `# ${id} log\n`;
    survivors.push({ id, note, logText });
  }
  pushCapped(warnings, dropWarnings, (omitted) => ({
    code: "E_NOT_FOUND",
    message: `…and ${omitted} more requested ids were dropped (missing, corrupt, or merged)`,
  }));

  // 3. clamp to maxTopicsPerGet
  let working = survivors;
  if (survivors.length > config.maxTopicsPerGet) {
    working = survivors.slice(0, config.maxTopicsPerGet);
    const clampWarnings: Warning[] = survivors
      .slice(config.maxTopicsPerGet)
      .map((s) => ({
        id: s.id,
        code: "clamped",
        message: `clamped: topics (max ${config.maxTopicsPerGet} per get)`,
      }));
    pushCapped(warnings, clampWarnings, (omitted) => ({
      code: "clamped",
      message: `…and ${omitted} more topics were clamped (max ${config.maxTopicsPerGet} per get)`,
    }));
    clamped = true;
    reasons.push(`clamped to ${config.maxTopicsPerGet} topics`);
  }

  // 4. greedy fill maxTokensPerGet
  let remaining = config.maxTokensPerGet;
  const topics: GetTopicResult[] = [];
  for (let i = 0; i < working.length; i++) {
    const s = working[i]!;
    const summary = makeSummary(s.note);
    const sTok = countTokens(summary);
    const bodyTok = countTokens(s.note.body);

    if (sTok + bodyTok <= remaining) {
      // Body fits fully; give the log tail whatever budget remains.
      remaining -= sTok + bodyTok;
      const { text: tail, dropped } = fitLogTail(s.logText, logTailN, remaining);
      const tTok = countTokens(tail);
      remaining -= tTok;
      topics.push({
        id: s.id,
        summary,
        body: s.note.body,
        logTail: tail,
        truncated: false,
        tokens: sTok + bodyTok + tTok,
      });
      if (dropped > 0) {
        warnings.push({
          id: s.id,
          code: "budget",
          message: `log tail shortened for "${s.id}" (${dropped} of ${logTailN} entries omitted for budget)`,
        });
        clamped = true;
      }
      continue; // budget may remain — keep serving later topics
    }

    // Body does not fit → truncate it (drop the tail), then stop.
    const MARKER_RESERVE = 16; // tokens set aside for the marker (bounds its size)
    if (remaining < sTok + MARKER_RESERVE) {
      for (const rest of working.slice(i)) {
        warnings.push({ id: rest.id, code: "budget", message: `dropped "${rest.id}" (read budget exhausted)` });
      }
      clamped = true;
      break;
    }
    const truncated = truncateBody(s.note.body, remaining - sTok - MARKER_RESERVE);
    // Report the tokens actually dropped, not the pre-truncation overage (#15).
    const over = bodyTok - countTokens(truncated);
    const finalBody = truncated + `\n\n[truncated — ${over} tokens over budget]`;
    const charge = sTok + countTokens(finalBody);
    topics.push({
      id: s.id,
      summary,
      body: finalBody,
      logTail: "",
      truncated: true,
      tokens: charge,
    });
    remaining -= charge;
    clamped = true;
    reasons.push(`budget: truncated "${s.id}"`);
    for (const rest of working.slice(i + 1)) {
      warnings.push({ id: rest.id, code: "budget", message: `dropped "${rest.id}" (read budget exhausted)` });
    }
    break;
  }

  const tokensUsed = config.maxTokensPerGet - remaining;
  recordServed(topics.length, tokensUsed);
  return { topics, clamped, reasons, warnings, tokensUsed };
}

/** Frozen summary-line template (SPEC §5.4, rev 4, #20). */
function makeSummary(note: TopicNote): string {
  return `${note.id} — ${note.title} · updated ${note.updated ?? "?"}`;
}

/**
 * Fit as many of the `n` most recent entries as `budget` allows.
 * Recency is by **timestamp**, not file position — a union-merged log is no
 * longer in chronological order, so slicing the tail of the array can serve a
 * stale "latest" to the agent.
 */
function fitLogTail(
  logText: string,
  n: number,
  budget: number,
): { text: string; dropped: number } {
  if (n <= 0) return { text: "", dropped: 0 };
  const { entries } = parseLog(logText);
  const byRecency = [...entries].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  const tail = byRecency.slice(Math.max(0, byRecency.length - n));
  const kept: LogEntry[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i]!;
    const sep = kept.length > 0 ? SEP_TOKENS : 0;
    const eTok = countTokens(e.raw);
    if (used + sep + eTok > budget) break;
    kept.unshift(e);
    used += sep + eTok;
  }
  return { text: kept.map((e) => e.raw).join("\n\n"), dropped: tail.length - kept.length };
}

const FENCE_LINE = /^[ \t]*(```|~~~)/;

/**
 * Paragraph-truncate a body to fit `budgetTokens`, fence-aware (SPEC §5.4, #7):
 * a fenced code block is one indivisible paragraph, and the result never leaves
 * a fence open (so the caller's marker can't render inside code).
 */
function truncateBody(body: string, budgetTokens: number): string {
  if (countTokens(body) <= budgetTokens) return body;
  const kept: string[] = [];
  let used = 0;
  for (const p of splitParagraphs(body)) {
    const sep = kept.length > 0 ? SEP_TOKENS : 0;
    if (used + sep + countTokens(p) <= budgetTokens) {
      kept.push(p);
      used += sep + countTokens(p);
      continue;
    }
    // First paragraph over budget: hard-truncate it (a dangling fence is closed
    // below). If we've already kept whole paragraphs, just stop here.
    if (kept.length === 0) kept.push(hardTruncate(p, budgetTokens));
    break;
  }
  let result = kept.join("\n\n");
  if (fenceCount(result) % 2 === 1) result += "\n```"; // close a dangling fence (#7)
  return result;
}

/** Split on blank lines, but keep each fenced code block whole (SPEC §5.4). */
function splitParagraphs(body: string): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (cur.length > 0) paras.push(cur.join("\n"));
    cur = [];
  };
  for (const line of body.split("\n")) {
    if (FENCE_LINE.test(line)) {
      if (!fenced) {
        flush();
        cur.push(line);
        fenced = true;
      } else {
        cur.push(line);
        fenced = false;
        flush();
      }
      continue;
    }
    if (!fenced && line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return paras;
}

function fenceCount(text: string): number {
  return text.split("\n").filter((l) => FENCE_LINE.test(l)).length;
}

function hardTruncate(text: string, budgetTokens: number): string {
  const maxChars = Math.max(0, budgetTokens * 4);
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  for (let k = slice.length - 1; k >= 0; k--) {
    if (/\s/.test(slice[k]!)) return slice.slice(0, k);
  }
  return slice;
}
