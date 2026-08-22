import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import type { HomeSource } from "../paths.js";
import { runStatus } from "../commands/status.js";
import { createTopic } from "../ops/create.js";
import { get } from "../ops/get.js";
import { appendLog } from "../ops/logOp.js";
import { compact } from "../ops/compact.js";
import { search } from "../ops/search.js";
import { updateTopic } from "../ops/update.js";
import { isValidId } from "../id.js";
import { ensureStoreUnlocked, NO_KEY_AVAILABLE_MESSAGE } from "../ops/unlockOp.js";
import { storePaths } from "../paths.js";
import { sessionMeter, sessionSoftWarning } from "../session.js";
import { recordRead } from "../telemetry.js";
import { countTokens } from "../tokens.js";
import { DEFAULT_LOG_TAIL } from "../ops/brief.js";

/**
 * The frozen MCP tool surface (SPEC §6, rev 6) — the single source of truth
 * used by both the TOOLS definitions below and the absence-proof tests, so the
 * surface can only drift with an explicit edit here.
 */
export const ALLOWED_MCP_TOOLS = [
  "fimemory_status",
  "fimemory_search",
  "fimemory_get",
  "fimemory_create",
  "fimemory_log",
  "fimemory_update",
  "fimemory_compact",
] as const;

export interface ToolDef {
  name: (typeof ALLOWED_MCP_TOOLS)[number];
  description: string;
  inputSchema: Record<string, unknown>;
}

const MAX_LOG_TAIL = 50;

/**
 * Exactly these seven — and provably NOT `list`, `review`/approve, `merge`,
 * `reindex`, `pack`, `ingest`, force-create, or `--allow-owner-notes` (agents
 * get the friction; humans get the overrides, at the CLI). Descriptions carry
 * the usage policy in plain language (SPEC §9); the enforced guarantees are the
 * per-response budgets and the write gates in the ops themselves.
 */
export const TOOLS: ToolDef[] = [
  {
    name: "fimemory_status",
    description:
      "Show the FIMemory store — how many topics, how many suggested edits are waiting for the human, and how much this session has read so far. Check it if you're unsure what you've already read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "fimemory_search",
    description:
      "Find topics by keyword (indexes curated notes AND typed log entries). ALWAYS search first, then fimemory_get the 1–3 that matter — don't guess topic ids or browse everything. Returns id, title, and a one-line excerpt (never full notes).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords. AND first (every word must match somewhere); if that yields nothing, ranked-OR fallback (partial matches, ranked by coverage).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fimemory_get",
    description:
      "Read a few topics within a hard read budget — curated note + recent log. Call after fimemory_search. Limits come from the store's settings (defaults: 3 topics and a 2,000 read budget per request); they cannot be raised through arguments. If a topic comes back trimmed, ask for fewer topics or a shorter log tail.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string", pattern: "^[a-z0-9-]{2,64}$" },
          minItems: 1,
          maxItems: 3,
          description: "Up to 3 topic ids.",
        },
        logTail: {
          type: "integer",
          minimum: 0,
          maximum: MAX_LOG_TAIL,
          description: `How many recent log entries to include (default ${DEFAULT_LOG_TAIL}; pass 0 for the curated note alone).`,
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "fimemory_create",
    description:
      "Create a new topic explicitly (nothing is ever auto-created). Fails if the id looks like an existing topic — reuse that one instead. Writes an empty starter note; add knowledge with fimemory_log and fimemory_update.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "lowercase-with-hyphens, 2–64 characters (a–z, 0–9, hyphen)." },
        title: { type: "string", description: "Free text, up to 120 characters." },
      },
      required: ["id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "fimemory_log",
    // STATE THE LIMIT BEFORE THE CALLER COMPOSES, not after we reject them.
    //
    // This used to end "so log freely" and never mention a cap. An agent reads
    // that, writes a thorough entry, and is refused by a number it had no way to
    // see — then trims and is refused again. Two agents burned eleven and five
    // round trips on single entries on 2026-08-18. The product was teaching the
    // behaviour it then punished, and the word doing the damage was "freely".
    //
    // The neighbouring create tool has always documented its limits exactly
    // ("2–64 characters", "up to 120 characters"); this one simply did not.
    // The numbers interpolate from DEFAULT_CONFIG so they cannot drift again
    // (the literal drifted once already, 200 → 350), and are named as a
    // default, since a store's config.json may set a different cap.
    description:
      `Append a typed changelog entry as you learn something — decision · pattern · gotcha · convention · supersede. Logging never changes the curated note, so log often — but keep each entry (summary + body) under ~${DEFAULT_CONFIG.entryTokenCap * 4} characters (the store's entryTokenCap, ${DEFAULT_CONFIG.entryTokenCap} tokens by default; a store's config.json can set a different cap); longer entries are REJECTED with the exact character cut that will pass. Split a long finding into two entries rather than trimming it to fit.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["decision", "pattern", "gotcha", "convention", "supersede"] },
        project: { type: "string" },
        summary: { type: "string", description: `One line (required). Counts toward the entry cap (~${DEFAULT_CONFIG.entryTokenCap * 4} characters by default).` },
        body: { type: "string", description: `Optional detail. Summary + body must fit the store's entryTokenCap (~${DEFAULT_CONFIG.entryTokenCap * 4} characters by default).` },
        supersedes: { type: "string", description: "Timestamp of an entry this supersedes." },
        refs: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
          description: "Optional file refs (repo#path[@sha]) this entry is grounded in.",
        },
      },
      required: ["id", "type", "project", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "fimemory_update",
    description:
      "Suggest an edit to a topic's curated note. This does NOT change the note — it creates a suggested edit that waits for the human to approve. Use it when the summary is out of date. Provide the full note text: the header block at the top (between the --- lines) plus the body. Base frontmatter (title/aliases/tags/projects/updated) is preserved server-side from the current note — only the body is taken from your draft (so a mangled header rebuilt from fimemory_get cannot damage the note). Changing the ## Owner notes section is refused.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        note: {
          type: "string",
          description:
            "The full proposed note text — header block, then body. Header fields other than id are ignored; the server keeps the current title/aliases/tags/updated.",
        },
      },
      required: ["id", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "fimemory_compact",
    description:
      "Get a work packet for folding old log entries into the note. Returns the FULL current note plus a page of entries to fold — this is not the normal read path, and the response can be larger than the fold budget when the note (or a single entry) is very large. Prefer fimemory_get for ordinary reads. YOU draft the folded note and submit it with fimemory_update — the runtime never summarizes for you. To get the next page, pass `since` = the continue-from time returned by the previous packet.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        since: { type: "string", description: "Continue-from time returned by the previous packet." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// The surface can never silently drift from the frozen list (SPEC §6).
if (
  TOOLS.length !== ALLOWED_MCP_TOOLS.length ||
  !TOOLS.every((t) => (ALLOWED_MCP_TOOLS as readonly string[]).includes(t.name))
) {
  throw new Error("MCP tool surface drifted from ALLOWED_MCP_TOOLS — update both together.");
}

export const TOOL_NAMES = new Set<string>(ALLOWED_MCP_TOOLS);

/** Structured sidecar for MCP results (SPEC §5.8/§6, rev 6). */
export interface ToolStructured {
  warnings?: Warning[];
  error?: { code: string; message: string; hint: string };
  tokensUsed?: number;
  deliveredTokens?: number;
  clamped?: boolean;
  // The READ payload also rides in structuredContent (HS3, SPEC §6 result shape
  // is a floor, not a ceiling): a client that surfaces structuredContent over
  // content[].text (e.g. Claude Code) must see the hits/body, not just meters.
  /** fimemory_search: the actual hits, so the client sees WHICH topics matched — not just "hits: 2". */
  hits?: { id: string; title: string; excerpt: string }[];
  /** fimemory_get: the actual note payload per topic, so the body renders — not an empty read charged at `tokensUsed`. */
  topics?: { id: string; summary: string; body: string; logTail: string }[];
  /** fimemory_status: the numeric store facts the human text prints. */
  topicCount?: number;
  pendingProposals?: number;
  budget?: { maxTokensPerGet: number; maxTopicsPerGet: number; noteTokenCap: number; noteTokenWarn: number };
  /** R2: the store this response answered from, on EVERY response — home path
   * always; `source` (which resolution rule picked it) when the caller knows. */
  store?: { home: string; source?: HomeSource };
  [key: string]: unknown;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  structured?: ToolStructured;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function warningsText(warnings: Warning[]): string {
  return warnings.length
    ? "\n" + warnings.map((w) => `! ${w.message}${w.id ? ` (${w.id})` : ""}`).join("\n")
    : "";
}

/** Hard-cap a rendered payload at `capTokens`, ending with a marker (invariant 3). */
function capText(text: string, capTokens: number): string {
  if (countTokens(text) <= capTokens) return text;
  const marker = "\n[trimmed to fit the read budget]";
  const budgetChars = Math.max(0, (capTokens - countTokens(marker)) * 4);
  let slice = text.slice(0, budgetChars);
  const lastWs = slice.search(/\s\S*$/);
  if (lastWs > 0) slice = slice.slice(0, lastWs);
  return slice + marker;
}

/** The R2 which-store line appended to every tool response's text. Terse on
 * purpose: it rides every response, and two tests budget response tokens. */
function storeLine(home: string): string {
  return `[fimemory store: ${home}]`;
}

/** Tokens to reserve inside a hard-capped response so the appended store line
 * never pushes the delivered text over the budget (invariant 3). Separate
 * ceil-per-part can only overshoot the combined count, so reserving the
 * line's own count keeps the total under the cap. */
function storeLineReserve(home: string): number {
  return countTokens(`\n${storeLine(home)}`);
}

/**
 * Execute one tool call. Inputs are validated at this boundary — before any
 * filesystem read — so an oversized request cannot become an oversized response
 * (Gate #2 #1/#3). Unknown/extra arguments (e.g. a smuggled `force` or
 * `allowOwnerNotes`) are never read. Returns human text plus a structured
 * sidecar (`warnings[]`, error `{code,message,hint}`, meters) per SPEC §5.8.
 *
 * EVERY response — success, E_SCHEMA, E_LOCKED, op error — names the store it
 * answered from, in text and in `structured.store` (R2, ruled transparency UX
 * 2026-08-19: the 8/15 near-miss class is an agent confidently answering from
 * the wrong store, and the absence of this line is why nobody noticed).
 * `source` says which resolution rule picked the home; the MCP server learns
 * it once at startup from the CLI and it never changes for the process.
 */
export async function callTool(
  home: string,
  name: string,
  args: Record<string, unknown>,
  source?: HomeSource,
): Promise<ToolResult> {
  const r = await callToolInner(home, name, args);
  r.text = r.text ? `${r.text}\n${storeLine(home)}` : storeLine(home);
  r.structured = {
    ...r.structured,
    store: { home, ...(source !== undefined ? { source } : {}) },
  };
  // deliveredTokens is a promise about the FINAL on-wire text; recompute it
  // after decoration wherever a tool reported it (fimemory_get today).
  if (r.structured.deliveredTokens !== undefined) {
    r.structured.deliveredTokens = countTokens(r.text);
  }
  return r;
}

async function callToolInner(
  home: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // GRACEFUL LOCKED GATE (trust surface): a LOCKED encrypted store must never
  // kill the server — the server starts, lists tools, and every CALL answers
  // with a structured E_LOCKED naming the exact fixes, until unlock succeeds.
  // The unlock chain is retried LAZILY on every call (`ensureStoreUnlocked` is
  // sub-ms when warm and re-reads the session cache when cold), so a cache
  // warmed by `fimemory unlock` in a terminal recovers the server WITHOUT a
  // client restart. Plaintext stores pass straight through — and that verdict
  // is memoized briefly (`gateUnlocked`): the encrypted-ness probe scans store
  // files, and paying it on every one of a burst of tool calls measurably
  // slows a long-lived server (break script #10). A store that gets
  // `fimemory encrypt`ed mid-session is picked up within seconds.
  try {
    gateUnlocked(home);
  } catch (e) {
    if (e instanceof GestaltError) {
      // Name the REAL cause when there is one: "GESTALT_PASSPHRASE is set but
      // wrong" and "keyring.json is missing" must never be masked as generic
      // "no key available" — a stranger told to "set GESTALT_PASSPHRASE" when
      // it IS set (just wrong) loops forever on the same fix.
      const cause = e.message === NO_KEY_AVAILABLE_MESSAGE ? undefined : e.message;
      return err(
        "E_LOCKED",
        cause !== undefined
          ? `This store is encrypted and locked — a key source exists but does not open it: ${cause}`
          : "This store is encrypted and locked — no key is available to the MCP server yet.",
        `Set GESTALT_PASSPHRASE in the server's environment, or run \`fimemory unlock --passphrase "..."\` in a terminal (the warmed session key is picked up on the next tool call — no restart needed). Check with \`fimemory lock --status\`.`,
      );
    }
    throw e;
  }
  try {
    switch (name) {
      case "fimemory_status": {
        const r = runStatus({ home });
        const m = sessionMeter();
        const soft = sessionSoftWarning();
        return {
          text:
            `Store: ${r.home}\nTopics: ${r.topicCount} · Suggested edits waiting: ${r.pendingProposals}\n` +
            `This session: ${m.topicsServed} topics read, ${m.tokensServed} of the read budget used.\n` +
            `Read budget per request: ${r.budget.maxTokensPerGet} (up to ${r.budget.maxTopicsPerGet} topics).` +
            (soft ? `\n${soft}` : "") +
            warningsText(r.warnings),
          isError: false,
          // structuredContent carries the numeric store facts the human text
          // prints (topic count, pending edits, read budget), not just the
          // session meter — a structuredContent-only client (Claude Code) would
          // otherwise never see how big the store is or what the budget is (HS3).
          structured: {
            warnings: r.warnings,
            session: m,
            topicCount: r.topicCount,
            pendingProposals: r.pendingProposals,
            budget: r.budget,
            ...(soft ? { softWarning: soft } : {}),
          },
        };
      }
      case "fimemory_search": {
        const query = str(args["query"]);
        if (query === undefined) return err("E_SCHEMA", "search needs a query string.", "Pass query: \"<keywords>\".");
        const r = await search(home, query);
        // Last-read heartbeat (trust surface): best-effort, never into the store.
        recordRead(home, "fimemory_search", r.hits.map((h) => h.id), "mcp");
        const body = r.hits.length
          ? r.hits.map((h) => `${h.id} — ${h.title}\n  ${h.excerpt}`).join("\n")
          : `No topics match "${query}".`;
        return {
          text: body + warningsText(r.warnings),
          isError: false,
          // structuredContent carries the actual hits (id/title/excerpt), not a
          // bare count — a structuredContent-only client (Claude Code) must see
          // WHICH topics matched so it can pick ids for fimemory_get, instead of
          // just "hits: 2" (HS3). search never serves note bodies, so this stays
          // within the search summary contract (SPEC §5.5).
          structured: {
            warnings: r.warnings,
            hits: r.hits.map((h) => ({ id: h.id, title: h.title, excerpt: h.excerpt })),
          },
        };
      }
      case "fimemory_get": {
        const { config } = loadConfig(storePaths(home).config);
        const rawIds = args["ids"];
        if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((x): x is string => typeof x === "string")) {
          return err("E_SCHEMA", "get needs `ids`: a non-empty array of topic-id strings.", 'Pass ids: ["topic-id"].');
        }
        if (rawIds.length > config.maxTopicsPerGet) {
          // Rejected BEFORE any filesystem read — an oversized ask can't flood
          // the response with per-id warnings (Gate #2 #1/#3).
          return err(
            "E_SCHEMA",
            `That asks for ${rawIds.length} topics; the limit is ${config.maxTopicsPerGet} per read.`,
            `Search first, then get the ${config.maxTopicsPerGet} that matter most.`,
          );
        }
        // Enforce the declared id pattern at runtime, before any path join —
        // a crafted id (e.g. "../…") must never reach the filesystem.
        const badId = rawIds.find((x) => !isValidId(x));
        if (badId !== undefined) {
          return err(
            "E_SCHEMA",
            `"${badId}" is not a valid topic id (2–64 characters of a–z, 0–9, hyphen).`,
            "Use ids exactly as returned by fimemory_search.",
          );
        }
        const rawTail = args["logTail"];
        if (rawTail !== undefined && (!Number.isInteger(rawTail) || (rawTail as number) < 0 || (rawTail as number) > MAX_LOG_TAIL)) {
          return err("E_SCHEMA", `logTail must be a whole number between 0 and ${MAX_LOG_TAIL}.`, "Pass logTail: 5.");
        }
        // DEFAULTED, not 0. Until 2026-08-01 this was `?? 0`, so the default
        // MCP read served the curated summary and ZERO log entries — while this
        // tool's own description promised "curated note + recent log".
        //
        // Why 0 was the worst possible default: a note's BODY is rewritten only
        // when the owner approves a proposal (review.ts), while `appendLog`
        // never touches the body at all. So the body is the slowest-moving part
        // of a topic and the log is the fastest, and the default served exactly
        // the stale half. Log twenty decisions to a topic, ask about it, and the
        // answer came back with no sign the entries existed.
        //
        // It bit unevenly, which is why it survived: Claude Code reads through
        // the retrieval hook, which calls `brief` and has always defaulted to 8
        // with the log FIRST. Every other host reaches the store only through
        // this path, so the non-Claude hosts were the ones getting a stale read.
        //
        // Same constant as brief rather than a second number, so the two read
        // paths cannot disagree about how much log matters. The headroom is
        // proven rather than assumed: get.test.ts break script #1 pins that
        // three maximum-size topics at logTail 50 stay inside the 2,000 budget,
        // so 8 has roughly 6x margin and `get`'s own clamp handles the rest.
        const r = await get(home, rawIds, {
          logTail: (rawTail as number | undefined) ?? DEFAULT_LOG_TAIL,
        });
        // Last-read heartbeat (trust surface): best-effort, never into the store.
        recordRead(home, "fimemory_get", rawIds, "mcp");
        const parts = r.topics.map((t) => {
          // Log ABOVE the body, and labelled, matching brief.ts. The order is
          // not cosmetic: a model reading top-down meets the freshest material
          // first, and the label says which side wins when the two disagree.
          // Burying the log under the body was the other half of this defect.
          const tail = t.logTail?.trim()
            ? `Recent log (prefer when newer than body):\n${t.logTail.trim()}\n\n`
            : "";
          const body = t.body.trim() ? `Note body:\n${t.body.trim()}` : "";
          return `${t.summary}\n${tail}${body}`.trimEnd();
        });
        parts.push(`\n[served ${r.tokensUsed} of the read budget${r.clamped ? "; clamped" : ""}]`);
        // The DELIVERED text (wrappers + warnings included) is hard-capped at
        // the per-response budget (invariant 3; Gate #2 #1/#4).
        const text = capText(
          parts.join("\n\n") + warningsText(r.warnings),
          // Reserve room for the appended store line so the decorated response
          // still fits the per-response budget (invariant 3; R2).
          config.maxTokensPerGet - storeLineReserve(home),
        );
        return {
          text,
          isError: false,
          // structuredContent carries the actual note payload (summary + body +
          // log tail per topic), not just meters — a structuredContent-only
          // client (Claude Code) would otherwise see an empty read charged at
          // `tokensUsed` with no body at all (HS3). The bodies are the ones the
          // get op already fitted to the budget, so their combined size is
          // ≤ maxTokensPerGet (invariant 3 holds; the on-wire `text` is still
          // independently hard-capped above).
          structured: {
            warnings: r.warnings,
            tokensUsed: r.tokensUsed,
            deliveredTokens: countTokens(text),
            clamped: r.clamped,
            topics: r.topics.map((t) => ({
              id: t.id,
              summary: t.summary,
              body: t.body,
              logTail: t.logTail,
            })),
          },
        };
      }
      case "fimemory_create": {
        const id = str(args["id"]);
        const title = str(args["title"]);
        if (id === undefined || title === undefined) return err("E_SCHEMA", "create needs `id` and `title`.", 'Pass id and title.');
        const r = await createTopic(home, id, title); // no force on the MCP surface — extra args are never read
        return {
          text: `Created "${r.entry.id}". Add entries with fimemory_log, or suggest the note text with fimemory_update.`,
          isError: false,
          structured: { warnings: r.warnings },
        };
      }
      case "fimemory_log": {
        const id = str(args["id"]);
        if (id === undefined) return err("E_SCHEMA", "log needs an `id`.", "Pass the topic id.");
        const r = await appendLog(home, id, {
          type: str(args["type"]) ?? "",
          project: str(args["project"]) ?? "",
          agent: "mcp",
          summary: str(args["summary"]) ?? "",
          ...(str(args["body"]) !== undefined ? { body: str(args["body"])! } : {}),
          ...(str(args["supersedes"]) !== undefined ? { supersedes: str(args["supersedes"])! } : {}),
          // Explicitly read and forward refs — extra args are never read
          // otherwise. Filter to strings; assertAppendable is the real gate
          // (count, charset, grammar, mem: reservation), not this schema.
          ...(Array.isArray(args["refs"])
            ? { refs: (args["refs"] as unknown[]).filter((x): x is string => typeof x === "string") }
            : {}),
        });
        return { text: `Logged a ${str(args["type"])} on "${id}" at ${r.timestamp}.`, isError: false, structured: { warnings: r.warnings, timestamp: r.timestamp } };
      }
      case "fimemory_update": {
        const id = str(args["id"]);
        const note = str(args["note"]);
        if (id === undefined || note === undefined) return err("E_SCHEMA", "update needs `id` and `note`.", "Pass the topic id and the full proposed note text.");
        // No owner-notes override on the MCP surface — extra args are never read.
        const r = await updateTopic(home, id, note, { proposer: "mcp" });
        return {
          text: `Suggested edit ${r.machineId}-${r.seq} on "${id}" is waiting for the human to approve (\`review approve ${r.machineId}-${r.seq}\`). The note is unchanged until then.` + warningsText(r.warnings),
          isError: false,
          structured: { warnings: r.warnings, seq: r.seq, machineId: r.machineId, handle: `${r.machineId}-${r.seq}` },
        };
      }
      case "fimemory_compact": {
        const id = str(args["id"]);
        if (id === undefined) return err("E_SCHEMA", "compact needs an `id`.", "Pass the topic id.");
        const r = await compact(home, id, str(args["since"]) !== undefined ? { since: str(args["since"])! } : {});
        const entries = r.entries.length ? `\n\n— entries to fold —\n${r.entries.join("\n\n")}` : "";
        const more = r.hasMore && r.cursor ? `\n\n(more remain — call again with since: "${r.cursor}")` : "";
        return {
          text:
            `Fold packet for "${id}" (${r.entries.length} entries; the full note is included — this response is allowed to exceed the normal read budget). Draft the folded note and submit it with fimemory_update.\n\n${r.note.trimEnd()}${entries}${more}` +
            warningsText(r.warnings),
          isError: false,
          structured: { warnings: r.warnings, tokensUsed: r.tokensUsed, hasMore: r.hasMore, cursor: r.cursor },
        };
      }
      default:
        return err("E_NOT_FOUND", `Unknown tool: ${name}`, "Call tools/list for the available tools.");
    }
  } catch (e) {
    if (e instanceof GestaltError) {
      return {
        text: `${e.message}\n→ ${e.hint}`,
        isError: true,
        structured: { error: e.toJSON() },
      };
    }
    throw e;
  }
}

function err(code: string, message: string, hint: string): ToolResult {
  return { text: `${message}\n→ ${hint}`, isError: true, structured: { error: { code, message, hint } } };
}

/** How long a "this store is plaintext" verdict may be reused before the
 * encrypted-ness probe runs again. Encrypted verdicts are never cached here —
 * the LOCKED retry must stay per-call so a warmed cache recovers immediately,
 * and an UNLOCKED encrypted store already re-enters via the sub-ms
 * `keyState()` "already" fast path inside `ensureStoreUnlocked`. */
const PLAINTEXT_VERDICT_TTL_MS = 5_000;
const plaintextCheckedAt = new Map<string, number>();

/** Ensure the store is usable for this call, or throw (E_STORE_MODE → mapped
 * to E_LOCKED by the caller). Memoizes only the plaintext verdict. */
function gateUnlocked(home: string): void {
  const at = plaintextCheckedAt.get(home);
  const now = Date.now();
  if (at !== undefined && now - at < PLAINTEXT_VERDICT_TTL_MS) return;
  const r = ensureStoreUnlocked(home);
  if (!r.encrypted) plaintextCheckedAt.set(home, now);
}
