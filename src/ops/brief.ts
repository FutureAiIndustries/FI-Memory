import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { countTokens } from "../tokens.js";
import { recordRead } from "../telemetry.js";
import { get } from "./get.js";
import { search } from "./search.js";
import {
  markTopicsInjected,
  readShimSession,
  recordShimAudit,
  type ShimSkipReason,
} from "./shimAudit.js";

/**
 * Production L1 retrieval shim core.
 *
 * `brief` / `context` (aliases): for a user prompt, run local search → top-K get,
 * format a budgeted inject block that declares itself ALREADY-RETRIEVED and
 * AUTHORITATIVE so the model answers from it instead of asking for live tools.
 *
 * Defaults measured against the fair-battery miss classes (2026-07-26):
 *   1. Injection framing — header forbids re-search / live tools.
 *   2. Stale notes shadowing fresh logs — log tail is rendered ABOVE body and
 *      called out as prefer-when-newer.
 *   3. Decision-keyword mismatch — light noun expansion of the prompt query.
 *
 * Fail-open contract (hook path): any error / empty / below floor → empty
 * inject string, never prose like "no memory found". The CLI `hook-retrieve`
 * entry enforces the hard 300ms wall budget around this op.
 */

/** Wall-clock budget the hook must finish under (spawn + work + format). */
export const HOOK_BUDGET_MS = 300;

/** Default top hits to pull through get (fair battery used top-2). */
export const DEFAULT_TOP_K = 2;

/** Recent log entries per topic — logs carry the freshest decisions. */
export const DEFAULT_LOG_TAIL = 8;

/** Hard cap on injected tokens per turn (titles + excerpts + log + body). */
export const DEFAULT_INJECT_TOKEN_CAP = 900;

/** Cap total inject tokens per session before silent skip. */
export const DEFAULT_SESSION_INJECT_TOKEN_CAP = 4500;

/** Cap inject count per session. */
export const DEFAULT_SESSION_INJECT_COUNT_CAP = 24;

/** Minimum non-whitespace prompt length to bother retrieving. */
export const MIN_PROMPT_CHARS = 12;

/**
 * Cheap non-human / machine-prompt skip (hook-retrieve, <300ms budget).
 * True when the prompt is a control-tag envelope (starts with `<…`) or the
 * hook payload marks a non-human source. Fail-open callers exit 0 empty and
 * record `lastSkippedReason=non-human`.
 */
export function isNonHumanPrompt(
  prompt: string,
  payload: Record<string, unknown> = {},
): boolean {
  const trimmed = prompt.trimStart();
  // Control-tag shapes: XML/HTML-ish machine envelopes (task notifications,
  // system control blocks). Human prose rarely opens with a tag.
  if (/^<[A-Za-z_!/?]/.test(trimmed)) return true;

  const source = String(
    payload["source"] ??
      payload["origin"] ??
      payload["prompt_source"] ??
      payload["promptSource"] ??
      "",
  )
    .trim()
    .toLowerCase();
  if (
    source === "machine" ||
    source === "system" ||
    source === "agent" ||
    source === "task" ||
    source === "notification" ||
    source === "control" ||
    source === "non-human" ||
    source === "non_human" ||
    source === "nonhuman"
  ) {
    return true;
  }
  if (
    payload["is_meta"] === true ||
    payload["isMeta"] === true ||
    payload["machine"] === true ||
    payload["automatic"] === true ||
    payload["is_automatic"] === true
  ) {
    return true;
  }
  return false;
}

/** Search score floor — below this, treat as no-hit (Arm C precision). */
export const RELEVANCE_FLOOR = 2;

/**
 * Ultra-short / pure-anaphoric lines that must never trigger retrieval
 * (guide F-struct defaults). Guaranteed noise otherwise.
 */
const SKIP_EXACT = new Set(
  [
    "yes", "no", "y", "n", "ok", "okay", "k", "kk", "sure", "thanks", "thank you",
    "thx", "ty", "continue", "go on", "do that", "do it", "proceed", "yep", "yeah",
    "yup", "nah", "nm", "wait", "stop", "please", "pls", "lgtm", "ship it", "ship",
    "done", "next", "more", "again", "same", "why", "how", "what", "huh", "hmm",
    "right", "correct", "agreed", "agree", "got it", "sounds good", "sg", "cool",
    "great", "fine", "alright", "all right",
  ].map((s) => s.toLowerCase()),
);

/** Common English stop words stripped before search (keep content nouns). */
const STOP = new Set(
  `a an the and or but if then else when while for of on in to from by with as at is are was were be been being it this that these those i you we they he she them my your our their me him her us do does did doing done have has had having will would can could should may might must not no nor so than too very just also only own same such into over after before about above below between out up down off again further once here there where why how all each few more most other some any both each what which who whom whose`.split(
    /\s+/,
  ),
);

/**
 * Light expansions for decision-keyword mismatch (fair-battery probe 15 class).
 * Applied only when the stem is present in the prompt — never invents topics.
 *
 * These are DOMAIN-NEUTRAL on purpose. This table used to hold the author's own
 * project vocabulary, which shipped inside the package: it leaked a map of
 * private work to every reader, and it actively misfired for everyone else,
 * since expanding a stranger's "deploy" into someone else's release codename is
 * pure noise in their retrieval.
 *
 * Your own vocabulary belongs in your store instead — see USER_EXPANSIONS_KEY.
 */
const EXPANSIONS: Record<string, string[]> = {
  licence: ["license", "licence"],
  license: ["license", "licence"],
  auth: ["auth", "authentication", "login"],
  login: ["login", "auth", "signin"],
  encryption: ["encryption", "encrypted"],
  encrypted: ["encryption", "encrypted"],
  config: ["config", "configuration", "settings"],
  settings: ["settings", "config", "configuration"],
  deploy: ["deploy", "deployment", "release"],
  release: ["release", "deploy", "ship"],
  test: ["test", "testing", "tests"],
  db: ["db", "database"],
  database: ["database", "db"],
  perf: ["perf", "performance"],
  ci: ["ci", "pipeline", "build"],
};

/**
 * Optional per-store expansions, merged over the neutral defaults above:
 * `{ "briefExpansions": { "yourterm": ["your", "related", "words"] } }` in the
 * store's config.json. This is where project-specific vocabulary belongs — it
 * travels with the store that needs it instead of with the package.
 */
export const USER_EXPANSIONS_KEY = "briefExpansions";

function expansionsFor(userExpansions?: Record<string, string[]>): Record<string, string[]> {
  if (!userExpansions) return EXPANSIONS;
  const merged: Record<string, string[]> = { ...EXPANSIONS };
  for (const [stem, words] of Object.entries(userExpansions)) {
    if (typeof stem !== "string" || !Array.isArray(words)) continue;
    const clean = words.filter((w): w is string => typeof w === "string" && w.trim() !== "");
    if (clean.length) merged[stem.toLowerCase()] = clean;
  }
  return merged;
}

export interface BriefOptions {
  topK?: number;
  logTail?: number;
  injectTokenCap?: number;
  sessionInjectTokenCap?: number;
  sessionInjectCountCap?: number;
  sessionId?: string;
  now?: number;
  /** Bypass session de-dup / session budget (CLI force / tests). */
  force?: boolean;
  /** Minimum search score to inject (default RELEVANCE_FLOOR). */
  floor?: number;
}

export interface BriefResult {
  /** Empty string when nothing to inject (silent skip). */
  inject: string;
  topics: string[];
  /** The expanded query string actually searched. */
  query: string;
  durationMs: number;
  skippedReason?: ShimSkipReason;
  tokens: number;
  warnings: Warning[];
}

/**
 * Expand a user prompt into a search query: keep content tokens, drop stop
 * words, and fold light domain expansions for known decision keywords.
 */
export function expandQuery(
  prompt: string,
  userExpansions?: Record<string, string[]>,
): string {
  const raw = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_/]/g, " ")
    .split(/[\s\-_/,]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  if (raw.length === 0) {
    // Fall back to the whole prompt stripped — better than empty.
    return prompt.trim().slice(0, 200);
  }
  const table = expansionsFor(userExpansions);
  const out = new Set<string>();
  for (const t of raw) {
    out.add(t);
    const extra = table[t];
    if (extra) for (const e of extra) out.add(e);
  }
  return [...out].join(" ");
}

/** True when the prompt is too short / pure acknowledgement to retrieve on. */
export function shouldSkipPrompt(prompt: string): boolean {
  const t = prompt.trim().replace(/\s+/g, " ");
  if (t.length < MIN_PROMPT_CHARS) return true;
  if (SKIP_EXACT.has(t.toLowerCase())) return true;
  // Single ultra-short token (e.g. "lgtm") already covered; multi-word short
  // anaphora like "do that please" is in SKIP_EXACT after normalize.
  const words = t.split(/\s+/);
  if (words.length <= 2 && t.length < 18 && SKIP_EXACT.has(t.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Format the authoritative inject block. Framing is the #1 fair-battery miss
 * class: the model must treat this as already-retrieved, not a nudge to search.
 */
export function formatInjectBlock(
  topics: {
    id: string;
    summary: string;
    body: string;
    logTail: string;
  }[],
  opts: { query: string; tokenCap: number },
): { text: string; tokens: number } {
  if (topics.length === 0) return { text: "", tokens: 0 };

  const header = [
    "## ALREADY-RETRIEVED store context (AUTHORITATIVE)",
    "",
    "The local memory store was already searched for this prompt. This block IS the retrieval result.",
    "Answer from this context. Do NOT request live search, web search, or fimemory_search / fimemory_get",
    "for these topics — re-fetching wastes tokens and is unnecessary.",
    "Prefer Recent log over Note body when they disagree (logs are fresher).",
    `Query used: ${opts.query}`,
    "",
  ].join("\n");

  let remaining = opts.tokenCap - countTokens(header);
  if (remaining < 40) return { text: "", tokens: 0 };

  const parts: string[] = [header];
  for (const t of topics) {
    const head = `### ${t.summary}\n`;
    const logSection = t.logTail.trim()
      ? `Recent log (prefer when newer than body):\n${t.logTail.trim()}\n\n`
      : "";
    const bodySection = t.body.trim()
      ? `Note body:\n${t.body.trim()}\n`
      : "";
    let chunk = head + logSection + bodySection;
    let chunkTok = countTokens(chunk);
    if (chunkTok > remaining) {
      // Prefer keeping the log over the body under pressure.
      const logOnly = head + logSection;
      const logTok = countTokens(logOnly);
      if (logTok <= remaining && logSection) {
        chunk = logOnly;
        chunkTok = logTok;
      } else {
        // Hard-trim the chunk to remaining chars (~4 chars/token).
        const maxChars = Math.max(0, remaining * 4 - 20);
        chunk = chunk.slice(0, maxChars) + "\n…\n";
        chunkTok = countTokens(chunk);
        if (chunkTok > remaining) break;
      }
    }
    parts.push(chunk);
    remaining -= chunkTok;
    if (remaining < 40) break;
  }

  const text = parts.join("\n").trimEnd() + "\n";
  return { text, tokens: countTokens(text) };
}

/**
 * Budgeted per-prompt retrieval. Safe to call from the hook path: never throws
 * for ordinary miss/locked/empty cases — returns empty inject + skippedReason.
 * Unexpected throws are possible only from programmer errors; the hook wrapper
 * still catch-alls them.
 */
export async function brief(
  home: string,
  prompt: string,
  opts: BriefOptions = {},
): Promise<BriefResult> {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const logTail = opts.logTail ?? DEFAULT_LOG_TAIL;
  const injectTokenCap = opts.injectTokenCap ?? DEFAULT_INJECT_TOKEN_CAP;
  const sessionTokenCap = opts.sessionInjectTokenCap ?? DEFAULT_SESSION_INJECT_TOKEN_CAP;
  const sessionCountCap = opts.sessionInjectCountCap ?? DEFAULT_SESSION_INJECT_COUNT_CAP;
  const floor = opts.floor ?? RELEVANCE_FLOOR;
  const sessionId = opts.sessionId ?? "";
  const warnings: Warning[] = [];

  const done = (
    partial: Omit<BriefResult, "durationMs" | "warnings"> & { warnings?: Warning[] },
  ): BriefResult => {
    const durationMs = Math.max(0, Date.now() - t0);
    const result: BriefResult = {
      ...partial,
      durationMs,
      warnings: partial.warnings ?? warnings,
    };
    recordShimAudit(home, {
      durationMs,
      topics: result.topics,
      skippedReason: result.skippedReason ?? null,
      tokens: result.tokens,
      injected: result.inject.length > 0,
    }, now);
    if (result.inject.length > 0 && sessionId) {
      markTopicsInjected(home, sessionId, result.topics, result.tokens, now);
    }
    return result;
  };

  const empty = (reason: ShimSkipReason, query = ""): BriefResult =>
    done({ inject: "", topics: [], query, tokens: 0, skippedReason: reason });

  try {
    if (shouldSkipPrompt(prompt)) return empty("short");

    // Session budget / already-injected filter.
    const session = sessionId && !opts.force ? readShimSession(home, sessionId) : null;
    if (session && !opts.force) {
      if (session.injectTokensUsed >= sessionTokenCap) return empty("session-budget");
      if (session.injectCount >= sessionCountCap) return empty("session-budget");
    }

    const query = expandQuery(prompt);
    if (!query.trim()) return empty("short");

    const { hits, warnings: sw } = await search(home, query, { maxHits: Math.max(topK, 5) });
    warnings.push(...sw);

    const eligible = hits.filter((h) => h.score >= floor).slice(0, topK);
    if (eligible.length === 0) return empty("floor", query);

    // Drop topics already injected this session (unless force).
    const already = new Set(session?.injectedTopics ?? []);
    const fresh = opts.force
      ? eligible
      : eligible.filter((h) => !already.has(h.id));
    if (fresh.length === 0) return empty("already-injected", query);

    const ids = fresh.map((h) => h.id);
    const got = await get(home, ids, { logTail });
    warnings.push(...got.warnings);

    if (got.topics.length === 0) return empty("empty", query);

    // Session-remaining token budget.
    const sessionRemaining = session
      ? Math.max(0, sessionTokenCap - session.injectTokensUsed)
      : injectTokenCap;
    const tokenCap = Math.min(injectTokenCap, sessionRemaining || injectTokenCap);

    const { text, tokens } = formatInjectBlock(
      got.topics.map((t) => ({
        id: t.id,
        summary: t.summary,
        body: t.body,
        logTail: t.logTail,
      })),
      { query, tokenCap },
    );

    if (!text.trim()) return empty("budget", query);

    // Telemetry: record as a real read so doctor "last read" advances.
    recordRead(
      home,
      "brief",
      got.topics.map((t) => t.id),
      "cli",
      now,
    );

    return done({
      inject: text,
      topics: got.topics.map((t) => t.id),
      query,
      tokens,
      warnings,
    });
  } catch (err) {
    // Locked / mode / IO → silent skip (fail-open). Distinct reason for locked
    // so doctor can surface "store locked / cache expired".
    if (err instanceof GestaltError) {
      if (err.code === "E_STORE_MODE" || err.code === "E_LOCKED") {
        return empty("locked");
      }
    }
    return empty("error");
  }
}

/** Alias — same verb, product-facing name used in docs. */
export const context = brief;
