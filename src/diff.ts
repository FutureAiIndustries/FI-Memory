/**
 * Minimal unified-diff renderer for a *pure insertion* (the New note equals the
 * Old note with one contiguous block added). That is exactly the shape of the
 * `init` example proposal, so this stays small and dependency-free.
 *
 * The Diff section of a proposal is informational only (SPEC §5.6) — a general
 * line diff for arbitrary `update` edits is a later block's concern.
 */
export function insertionDiff(
  oldText: string,
  newText: string,
  fromLabel: string,
  toLabel: string,
): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const contextBefore = prefix > 0 ? a[prefix - 1] : undefined;
  const contextAfter = suffix > 0 ? a[a.length - suffix] : undefined;

  const out: string[] = [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${prefix + 1} +${prefix + 1} @@`,
  ];
  if (contextBefore !== undefined) out.push(" " + contextBefore);
  for (const line of removed) out.push("-" + line);
  for (const line of added) out.push("+" + line);
  if (contextAfter !== undefined) out.push(" " + contextAfter);
  return out.join("\n") + "\n";
}
