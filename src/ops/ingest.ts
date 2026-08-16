import type { Clock } from "../clock.js";
import { GestaltError } from "../errors.js";
import { appendLog } from "./logOp.js";

export interface IngestLine {
  topic: string;
  ok: boolean;
  message: string;
}

export interface IngestResult {
  landed: number;
  rejected: number;
  lines: IngestLine[];
}

interface IngestEntry {
  topic: string;
  type: string;
  project: string;
  agent: string;
  summary: string;
  body?: string;
  reported?: string | null;
  refs?: string[];
}

/**
 * File what a session learned (SPEC §5.1): scan the pasted text for **every**
 * ` ```gestalt-log ` fenced block, validate each entry, and append the valid
 * ones (server timestamps assigned, `reported:` preserved). Unknown topics are
 * rejected per-entry (never auto-created). Partial success is normal and
 * reported line-by-line.
 */
export async function ingest(
  home: string,
  text: string,
  opts: { now?: Clock } = {},
): Promise<IngestResult> {
  const lines: IngestLine[] = [];
  let landed = 0;
  let rejected = 0;

  for (const e of parseIngest(text)) {
    try {
      await appendLog(
        home,
        e.topic,
        {
          type: e.type,
          project: e.project,
          agent: e.agent,
          summary: e.summary,
          ...(e.body !== undefined ? { body: e.body } : {}),
          ...(e.reported ? { reported: e.reported } : {}),
          ...(e.refs && e.refs.length > 0 ? { refs: e.refs } : {}),
        },
        opts.now ? { now: opts.now } : {},
      );
      landed++;
      lines.push({ topic: e.topic, ok: true, message: `filed a ${e.type} on "${e.topic}"` });
    } catch (err) {
      rejected++;
      const message =
        err instanceof GestaltError ? `${err.message} → ${err.hint}` : String(err);
      lines.push({ topic: e.topic, ok: false, message });
    }
  }

  return { landed, rejected, lines };
}

const BLOCK_RE = /```gestalt-log\r?\n([\s\S]*?)```/g;

function parseIngest(text: string): IngestEntry[] {
  const out: IngestEntry[] = [];
  let block: RegExpExecArray | null;
  while ((block = BLOCK_RE.exec(text)) !== null) {
    for (const chunk of block[1]!.split(/\n(?=### )/)) {
      const entry = parseEntry(chunk.trim());
      if (entry) out.push(entry);
    }
  }
  return out;
}

function parseEntry(chunk: string): IngestEntry | null {
  if (!chunk.startsWith("### ")) return null;
  const nl = chunk.indexOf("\n");
  const header = (nl === -1 ? chunk : chunk.slice(0, nl)).slice(4);
  const rest = nl === -1 ? "" : chunk.slice(nl + 1);

  const parts = header.split(" | ");
  if (parts.length < 4) return null;

  let reported: string | null = null;
  let refs: string[] | null = null;
  for (const extra of parts.slice(4)) {
    if (extra.startsWith("reported:")) reported = extra.slice(9);
    else if (extra.startsWith("refs:")) refs = extra.slice(5).split(",").filter(Boolean);
  }

  const restLines = rest.split("\n");
  const body = restLines.slice(1).join("\n").trim();
  return {
    topic: parts[0]!,
    type: parts[1]!,
    project: parts[2]!,
    agent: parts[3]!,
    summary: restLines[0] ?? "",
    ...(body.length > 0 ? { body } : {}),
    reported,
    ...(refs && refs.length > 0 ? { refs } : {}),
  };
}
