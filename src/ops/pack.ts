import type { Warning } from "../errors.js";
import { get } from "./get.js";

export interface PackOptions {
  logTail?: number;
  /** e.g. "grok", "chatgpt" — tunes the report-back footer wording. */
  for?: string;
}

/**
 * A budgeted brief for pasting into a web chat (SPEC §5.1): same read budget as
 * `get`, formatted for humans/agents, plus a report-back footer telling the
 * other tool how to send its learnings back for `ingest`.
 */
export async function pack(
  home: string,
  ids: string[],
  opts: PackOptions = {},
): Promise<{ text: string; warnings: Warning[] }> {
  const result = await get(home, ids, { logTail: opts.logTail ?? 10 });

  const parts: string[] = [`# FIMemory brief — ${result.topics.length} topic(s)`];
  for (const t of result.topics) {
    parts.push("", `## ${t.summary}`, t.body.trim());
    if (t.logTail) parts.push("", "Recent log:", t.logTail);
  }
  parts.push("", reportFooter(opts.for));

  return { text: parts.join("\n") + "\n", warnings: result.warnings };
}

function reportFooter(forWhom?: string): string {
  const who = forWhom ? ` ${forWhom},` : "";
  return [
    "————————————————————————————————————————",
    `When you're done${who} paste what you learned back and run \`gestalt ingest\` — one block, one entry per line:`,
    "",
    "```gestalt-log",
    "### <topic-id> | decision | <project> | <your-name>",
    "One-line summary of what changed.",
    "```",
    "",
    "(entry types: decision · pattern · gotcha · convention · supersede)",
  ].join("\n");
}
