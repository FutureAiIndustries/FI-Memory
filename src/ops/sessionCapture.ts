import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { storePaths, topicNotePath } from "../paths.js";
import { countTokens } from "../tokens.js";
import { createTopic } from "./create.js";
import { isNonHumanPrompt } from "./brief.js";
import {
  hasCapturedSession,
  markSessionCaptured,
  readShimAudit,
  recordShimAudit,
  type ShimSkipReason,
} from "./shimAudit.js";
import { updateTopic } from "./update.js";
import { parseNote, serializeNote } from "../store/note.js";
import { nonOwnerBody, splitOwnerNotes } from "../store/ownerNotes.js";
import { readText } from "../store/read.js";

/** Wall budget for hook-capture (SessionEnd must never block host shutdown). */
export const CAPTURE_BUDGET_MS = 500;

/** Hard file-size gate before we attempt a parse (keeps us under budget). */
export const CAPTURE_MAX_TRANSCRIPT_BYTES = 2_000_000;

export const WORKLOG_TOPIC_ID = "worklog";
export const WORKLOG_TITLE = "Session worklog";
export const CAPTURE_PROPOSER = "session-capture";

export interface TranscriptExtract {
  sessionId: string | null;
  finalAssistantText: string;
  filesTouched: string[];
  toolCallCount: number;
  gestaltLogCount: number;
  bashCount: number;
}

export interface CaptureResult {
  captured: boolean;
  skippedReason?: ShimSkipReason | "already-captured" | "empty-session" | "no-transcript";
  seq?: number;
  sessionId?: string;
  durationMs: number;
}

/**
 * Mechanical transcript parse — NO model calls. Claude Code JSONL shape:
 * lines with `type: "assistant"|"user"` and `message.content` blocks, plus
 * tool_use names Write/Edit/Bash and mcp fimemory_log.
 */
export function extractTranscript(jsonl: string, fallbackSessionId?: string): TranscriptExtract {
  let sessionId: string | null = fallbackSessionId?.trim() || null;
  let finalAssistantText = "";
  const files = new Set<string>();
  let toolCallCount = 0;
  let gestaltLogCount = 0;
  let bashCount = 0;

  const lines = jsonl.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj["sessionId"] === "string" && obj["sessionId"]) {
      sessionId = obj["sessionId"];
    }
    const type = obj["type"];
    const message = obj["message"];
    if (type !== "assistant" && type !== "user") {
      // Some exports put role only on message
      if (!message || typeof message !== "object") continue;
    }
    const msg = (message && typeof message === "object" ? message : null) as Record<
      string,
      unknown
    > | null;
    if (!msg) continue;
    const role = msg["role"];
    const content = msg["content"];

    if (role === "assistant") {
      const text = contentToText(content);
      if (text.trim()) finalAssistantText = text.trim();
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_use") continue;
        toolCallCount += 1;
        const name = String(b["name"] ?? "");
        const input = (b["input"] && typeof b["input"] === "object"
          ? (b["input"] as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        if (name === "Write" || name === "Edit" || name === "write_file" || name === "search_replace") {
          const p =
            (typeof input["file_path"] === "string" && input["file_path"]) ||
            (typeof input["path"] === "string" && input["path"]) ||
            (typeof input["filePath"] === "string" && input["filePath"]) ||
            "";
          if (p) files.add(p);
        }
        if (name === "Bash" || name === "bash") {
          bashCount += 1;
          const cmd = typeof input["command"] === "string" ? input["command"] : "";
          // Light path scrape from common redirect/write patterns
          for (const m of cmd.matchAll(/(?:^|[\s'"=])((?:\.\/|\/|~\/)[^\s'"]+\.[A-Za-z0-9]{1,8})/g)) {
            if (m[1]) files.add(m[1]);
          }
        }
        if (
          name === "mcp__fimemory__fimemory_log" ||
          name === "fimemory_log" ||
          name.endsWith("__fimemory_log")
        ) {
          gestaltLogCount += 1;
        }
      }
    }
  }

  return {
    sessionId,
    finalAssistantText,
    filesTouched: [...files].sort(),
    toolCallCount,
    gestaltLogCount,
    bashCount,
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}

/** Build 3–6 bullets from the final assistant message (mechanical, not model). */
export function bulletsFromSummary(text: string, max = 6): string[] {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`]/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!cleaned) return [];

  // Prefer existing bullet / numbered lines.
  const lineBullets = cleaned
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length >= 12 && l.length <= 200);
  if (lineBullets.length >= 2) return lineBullets.slice(0, max);

  // Else sentence split.
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  if (sentences.length > 0) return sentences.slice(0, max).map((s) => (s.length > 180 ? s.slice(0, 177) + "…" : s));

  // Fallback: first chunk of the text.
  return [cleaned.slice(0, 180) + (cleaned.length > 180 ? "…" : "")];
}

/**
 * Append a dated session section to the worklog body. Oldest `## ` session
 * sections are dropped from the DRAFT when over the note token cap (owner
 * notes preserved). The owner sees exactly what approval produces.
 */
export function buildWorklogBody(
  currentBody: string,
  section: { date: string; sessionId: string; bullets: string[]; files: string[]; stats: string },
  noteTokenCap: number,
): string {
  const split = splitOwnerNotes(currentBody);
  const heading = `## ${section.date} · session ${section.sessionId}`;
  const bulletLines = section.bullets.map((b) => `- ${b}`);
  const filesLine =
    section.files.length > 0
      ? `- Files touched: ${section.files.slice(0, 20).map((f) => `\`${f}\``).join(", ")}${
          section.files.length > 20 ? ` (+${section.files.length - 20} more)` : ""
        }`
      : "- Files touched: (none recorded)";
  const newSection = [heading, "", ...bulletLines, filesLine, `- ${section.stats}`, ""].join("\n");

  let before = split.beforeOwner.trimEnd();
  if (before && !before.endsWith("\n")) before += "\n";
  // Drop oldest ## sections (except a leading title block) until under cap.
  let bodyCore = before ? before + "\n" + newSection : newSection + "\n";
  bodyCore = trimOldestSections(bodyCore, noteTokenCap, split.owner);

  if (split.present) {
    const owner = split.owner.endsWith("\n") ? split.owner : split.owner + "\n";
    const after = split.afterOwner ? (split.afterOwner.startsWith("\n") ? split.afterOwner : "\n" + split.afterOwner) : "";
    return bodyCore.trimEnd() + "\n\n" + owner + after;
  }
  // Ensure owner stub exists for future human notes.
  return bodyCore.trimEnd() + "\n\n## Owner notes\n";
}

function trimOldestSections(body: string, noteTokenCap: number, ownerSection: string): string {
  const ownerTok = countTokens(ownerSection);
  const budget = Math.max(200, noteTokenCap - ownerTok - 20);
  if (countTokens(body) <= budget) return body;

  // Split into optional preamble + dated ## YYYY-MM-DD sections.
  const lines = body.split("\n");
  const preamble: string[] = [];
  const dated: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^## \d{4}-\d{2}-\d{2}/.test(line)) {
      if (cur) dated.push(cur.join("\n"));
      else if (preamble.length) {
        /* keep preamble as-is */
      }
      cur = [line];
    } else if (cur) {
      cur.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) dated.push(cur.join("\n"));

  // Drop oldest dated sections first; always keep the newest one if possible.
  while (dated.length > 1) {
    const candidate = [...(preamble.length ? [preamble.join("\n")] : []), ...dated].join("\n\n");
    if (countTokens(candidate) <= budget) break;
    dated.shift();
  }
  // If still over, drop preamble.
  const parts = [...(preamble.length ? [preamble.join("\n")] : []), ...dated];
  while (parts.length > 1 && countTokens(parts.join("\n\n")) > budget) {
    parts.shift();
  }
  let out = parts.join("\n\n");
  if (countTokens(out) > budget && dated.length > 0) {
    // Keep only the newest dated section, hard-trim if needed.
    out = dated[dated.length - 1]!;
    const maxChars = budget * 4;
    if (out.length > maxChars) out = out.slice(0, maxChars);
  }
  return out.endsWith("\n") ? out : out + "\n";
}

export interface RunCaptureOptions {
  home: string;
  payload: Record<string, unknown>;
  /** Injected for tests — default Date.now / real clock. */
  nowMs?: number;
  /** Override budget (tests). */
  budgetMs?: number;
  /** Skip wall-clock race (unit tests of pure path). */
  disableBudgetRace?: boolean;
}

/**
 * Session-end capture: mechanical extract → worklog proposal via updateTopic.
 * Fail-open: never throws to caller for normal skip paths; returns result.
 */
export async function runSessionCapture(opts: RunCaptureOptions): Promise<CaptureResult> {
  const started = opts.nowMs ?? Date.now();
  const budgetMs = opts.budgetMs ?? CAPTURE_BUDGET_MS;
  const home = path.resolve(opts.home);
  const payload = opts.payload;

  const work = async (): Promise<CaptureResult> => {
    try {
      return await captureOnce(home, payload, started, budgetMs);
    } catch {
      recordShimAudit(home, {
        durationMs: Date.now() - started,
        skippedReason: "error",
        injected: false,
      });
      return { captured: false, skippedReason: "error", durationMs: Date.now() - started };
    }
  };

  if (opts.disableBudgetRace) {
    return work();
  }

  const raced = await Promise.race([
    work(),
    sleep(budgetMs).then(
      (): CaptureResult => ({
        captured: false,
        skippedReason: "budget",
        durationMs: budgetMs,
      }),
    ),
  ]);

  if (raced.skippedReason === "budget" && !raced.captured) {
    recordShimAudit(home, {
      durationMs: budgetMs,
      skippedReason: "budget",
      sessionRef: "hook-capture",
      injected: false,
    });
  }
  return raced;
}

async function captureOnce(
  home: string,
  payload: Record<string, unknown>,
  started: number,
  budgetMs: number,
): Promise<CaptureResult> {
  const sessionId =
    (typeof payload["session_id"] === "string" && payload["session_id"]) ||
    (typeof payload["sessionId"] === "string" && payload["sessionId"]) ||
    "";
  const transcriptPath =
    (typeof payload["transcript_path"] === "string" && payload["transcript_path"]) ||
    (typeof payload["transcriptPath"] === "string" && payload["transcriptPath"]) ||
    "";

  // Non-human / machine sessions (shared skip heuristic with hook-retrieve).
  // SessionEnd often has no prompt — only skip on explicit non-human signals.
  const promptStr = typeof payload["prompt"] === "string" ? payload["prompt"] : "";
  const explicitNonHuman =
    (promptStr.trim() !== "" && isNonHumanPrompt(promptStr, payload)) ||
    payload["isSidechain"] === true ||
    payload["is_sidechain"] === true ||
    String(payload["userType"] ?? "").toLowerCase() === "subagent" ||
    ["machine", "system", "agent", "task", "notification", "control", "non-human", "non_human", "subagent"].includes(
      String(payload["source"] ?? payload["origin"] ?? "").toLowerCase(),
    );
  if (explicitNonHuman) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "non-human",
      sessionRef: sessionId || "hook-capture",
      injected: false,
    });
    return { captured: false, skippedReason: "non-human", sessionId, durationMs: Date.now() - started };
  }

  if (sessionId && hasCapturedSession(home, sessionId)) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "empty",
      sessionRef: sessionId,
      injected: false,
    });
    return {
      captured: false,
      skippedReason: "already-captured",
      sessionId,
      durationMs: Date.now() - started,
    };
  }

  if (!transcriptPath || !existsSync(transcriptPath)) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "empty",
      sessionRef: sessionId || "no-transcript",
      injected: false,
    });
    return { captured: false, skippedReason: "no-transcript", sessionId, durationMs: Date.now() - started };
  }

  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return { captured: false, skippedReason: "no-transcript", sessionId, durationMs: Date.now() - started };
  }
  if (st.size > CAPTURE_MAX_TRANSCRIPT_BYTES) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "budget",
      sessionRef: sessionId || "oversized-transcript",
      injected: false,
    });
    return { captured: false, skippedReason: "budget", sessionId, durationMs: Date.now() - started };
  }

  let jsonl: string;
  try {
    jsonl = readFileSync(transcriptPath, "utf8");
  } catch {
    return { captured: false, skippedReason: "error", sessionId, durationMs: Date.now() - started };
  }

  const extract = extractTranscript(jsonl, sessionId || undefined);
  const sid = extract.sessionId || sessionId || `anon-${started}`;

  // Silent when empty: no final summary OR zero tool calls.
  if (!extract.finalAssistantText.trim() || extract.toolCallCount === 0) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "empty",
      sessionRef: sid,
      injected: false,
    });
    return { captured: false, skippedReason: "empty-session", sessionId: sid, durationMs: Date.now() - started };
  }

  if (hasCapturedSession(home, sid)) {
    return { captured: false, skippedReason: "already-captured", sessionId: sid, durationMs: Date.now() - started };
  }

  // Ensure worklog topic exists.
  const notePath = topicNotePath(home, WORKLOG_TOPIC_ID);
  let currentText = await readText(notePath);
  if (currentText === null) {
    try {
      await createTopic(home, WORKLOG_TOPIC_ID, WORKLOG_TITLE, { force: true });
    } catch {
      // Race: already created
    }
    currentText = (await readText(notePath)) ?? "";
  }
  const current = parseNote(currentText, WORKLOG_TOPIC_ID);
  if (!current) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "error",
      sessionRef: sid,
      injected: false,
    });
    return { captured: false, skippedReason: "error", sessionId: sid, durationMs: Date.now() - started };
  }

  const { config } = loadConfig(storePaths(home).config);
  const date = new Date(started).toISOString().slice(0, 10);
  const bullets = bulletsFromSummary(extract.finalAssistantText, 6);
  if (bullets.length < 3 && extract.finalAssistantText.trim()) {
    // pad with truncated summary lines so we have at least something useful
    while (bullets.length < 3 && bullets.length < 6) {
      const extra = extract.finalAssistantText.trim().slice(bullets.length * 80, bullets.length * 80 + 80);
      if (!extra) break;
      bullets.push(extra.trim() + (extra.length >= 80 ? "…" : ""));
    }
  }
  const stats = `Tools: ${extract.toolCallCount} · bash: ${extract.bashCount} · fimemory_log: ${extract.gestaltLogCount}`;
  const newBody = buildWorklogBody(
    current.body,
    {
      date,
      sessionId: sid.slice(0, 36),
      bullets: bullets.slice(0, 6),
      files: extract.filesTouched,
      stats,
    },
    config.noteTokenCap,
  );

  // Respect the wall budget: never start a store write after the cap.
  if (Date.now() - started > Math.max(50, budgetMs - 20)) {
    recordShimAudit(home, {
      durationMs: Date.now() - started,
      skippedReason: "budget",
      sessionRef: sid,
      injected: false,
    });
    return { captured: false, skippedReason: "budget", sessionId: sid, durationMs: Date.now() - started };
  }

  // Propose via real updateTopic — base frontmatter preserved (task 2).
  const proposed = serializeNote({ ...current, body: newBody });
  const { seq } = await updateTopic(home, WORKLOG_TOPIC_ID, proposed, {
    proposer: CAPTURE_PROPOSER,
  });

  markSessionCaptured(home, sid, seq, started);
  recordShimAudit(home, {
    durationMs: Date.now() - started,
    skippedReason: null,
    sessionRef: sid,
    tokens: countTokens(nonOwnerBody(newBody)),
    topics: [WORKLOG_TOPIC_ID],
    injected: true,
  });

  return {
    captured: true,
    seq,
    sessionId: sid,
    durationMs: Date.now() - started,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Doctor-facing summary of capture health. */
export function captureHealth(home: string): {
  lastCaptureAt: string | null;
  lastCaptureSessionId: string | null;
  lastCaptureSeq: number | null;
  capturedSessionCount: number;
  lastSkippedReason: string | null;
} {
  const audit = readShimAudit(home);
  return {
    lastCaptureAt: audit?.lastCaptureAt ?? null,
    lastCaptureSessionId: audit?.lastCaptureSessionId ?? null,
    lastCaptureSeq: audit?.lastCaptureSeq ?? null,
    capturedSessionCount: audit?.capturedSessionIds?.length ?? 0,
    lastSkippedReason: audit?.lastSkippedReason ?? null,
  };
}
