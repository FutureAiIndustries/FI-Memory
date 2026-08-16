import {
  asString,
  asStringArray,
  parseYaml,
  splitFrontmatter,
  yamlInlineArray,
  yamlQuote,
} from "./frontmatter.js";

/** A parsed topic note (SPEC §3). `mergedInto` marks a merge tombstone (§2). */
export interface TopicNote {
  id: string;
  title: string;
  aliases: string[];
  tags: string[];
  projects: string[];
  updated: string | null;
  compactedThrough: string | null;
  mergedInto: string | null;
  body: string;
}

/**
 * Parse a topic note, tolerating hand edits (invariant 1). Returns null only
 * when the file has no usable frontmatter or no id — the caller then skips it
 * with a warning rather than crashing (SPEC §1).
 */
export function parseNote(text: string, fallbackId?: string): TopicNote | null {
  const split = splitFrontmatter(text);
  if (!split) return null;
  const data = parseYaml(split.yaml);
  if (!data) return null;

  const id = asString(data["id"]) ?? fallbackId ?? null;
  if (id === null) return null;

  return {
    id,
    title: asString(data["title"]) ?? id,
    aliases: asStringArray(data["aliases"]),
    tags: asStringArray(data["tags"]),
    projects: asStringArray(data["projects"]),
    updated: asString(data["updated"]),
    compactedThrough: asString(data["compactedThrough"]),
    mergedInto: asString(data["mergedInto"]),
    body: split.body,
  };
}

export function isTombstone(note: TopicNote): boolean {
  return note.mergedInto !== null;
}

/** Serialize a note in canonical form (stable field order; matches B0's example). */
export function serializeNote(note: TopicNote): string {
  const fm = [
    "---",
    `id: ${note.id}`,
    `title: ${yamlQuote(note.title)}`,
    `aliases: ${yamlInlineArray(note.aliases)}`,
    `tags: ${yamlInlineArray(note.tags)}`,
    `projects: ${yamlInlineArray(note.projects)}`,
    `updated: ${note.updated ?? "null"}`,
    `compactedThrough: ${note.compactedThrough ?? "null"}`,
  ];
  if (note.mergedInto !== null) fm.push(`mergedInto: ${note.mergedInto}`);
  fm.push("---");
  // Canonical notes always end with a newline, so a proposal's fenced New block
  // round-trips to the exact bytes newHash was taken over (Gate #1 #1).
  const body = note.body.endsWith("\n") ? note.body : note.body + "\n";
  return fm.join("\n") + "\n" + body;
}

/**
 * The placeholder sentence every fresh note body carries. Exported so the
 * content-readiness check (ops/contentReadiness.ts) tests against the SAME
 * string this writer emits — the writer/checker-cannot-drift rule doctor
 * already applies to host config paths. A note still containing this line has
 * never been curated.
 */
export const NOTE_TEMPLATE_MARKER =
  "Newly created — write the curated, present-tense summary here.";

/** A fresh note skeleton for `create` — includes the `## Owner notes` stub (SPEC §5.1). */
export function skeletonNote(id: string, title: string, updated: string): TopicNote {
  return {
    id,
    title,
    aliases: [],
    tags: [],
    projects: [],
    updated,
    compactedThrough: null,
    mergedInto: null,
    body: `\n${title}\n\n${NOTE_TEMPLATE_MARKER}\n\n## Owner notes\n`,
  };
}

/** The one-line body a note gets when it becomes a merge tombstone (SPEC §2). */
export function tombstoneBody(winner: string): string {
  return `\nMerged into [[${winner}]]. See that topic.\n`;
}
