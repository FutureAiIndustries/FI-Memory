import * as yaml from "js-yaml";

/**
 * Strip a leading UTF-8 BOM and normalize CRLF/CR to LF. A note re-saved by
 * PowerShell `Set-Content`, git autocrlf, or a BOM-writing editor must still
 * parse — invariant 1 ("tolerate hand edits") on the first-class platform.
 */
export function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, "\n");
}

/**
 * Split a `---`-fenced frontmatter document into its YAML block and body.
 * Canonical form is `---\n<yaml>\n---\n<body>` (LF). Returns null if there is
 * no well-formed frontmatter (caller treats that as corrupt, per SPEC §1).
 */
export interface SplitDoc {
  yaml: string;
  body: string;
}

const FENCE = "---";

export function splitFrontmatter(text: string): SplitDoc | null {
  text = normalizeText(text);
  if (!text.startsWith(FENCE + "\n")) return null;
  const afterOpen = text.slice(FENCE.length + 1);
  const idx = afterOpen.indexOf("\n" + FENCE);
  if (idx === -1) return null;
  const yamlBlock = afterOpen.slice(0, idx);
  const afterFence = afterOpen.slice(idx + 1 + FENCE.length); // past "\n---"
  const body = afterFence.startsWith("\n") ? afterFence.slice(1) : afterFence;
  return { yaml: yamlBlock, body };
}

/**
 * Parse a YAML frontmatter block into a plain object, tolerating hand edits
 * (invariant 1). Uses JSON_SCHEMA so ISO timestamps stay strings (not Dates)
 * and only JSON-ish scalars are produced. Returns null on any parse failure or
 * non-object result.
 */
export function parseYaml(text: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    return null;
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

// ---- deterministic serialization primitives ----

/** Double-quoted YAML scalar with backslash/quote escaping. */
export function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** A plain scalar if it's a safe slug-ish token, else quoted. */
export function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? s : yamlQuote(s);
}

/** Inline flow array: `[a, b, c]` (empty → `[]`). */
export function yamlInlineArray(items: string[]): string {
  return "[" + items.map(yamlScalar).join(", ") + "]";
}

// ---- tolerant field coercions ----

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
