import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `supporters` — print the SUPPORTERS.md that ships inside the package.
 *
 * WHY A SEPARATE FILE, AND NEVER LICENSE.md (owner decision, 2026-07-30):
 * LICENSE.md is a legal instrument, and tooling parses it to detect which
 * terms apply to the project. Appending a growing list of names to it corrupts
 * that detection, and it would mean editing the licence text on every sale.
 * Credit is opt-in — by real name, by handle, or not at all.
 *
 * A name in that file confers NO software capability. There is no licence-key,
 * entitlement, tier, activation, quota or paywall check anywhere in this
 * runtime, so nothing here reads the list to decide what the caller may do.
 * It is a credit file, and this command is a reader for it.
 *
 * The file is resolved relative to THIS MODULE, not the cwd, because the
 * promise is that the name ships with the software: `src/ops/` (tsx) and
 * `dist/ops/` (built) are both two levels below the package root, so the same
 * resolution is correct in the private repo and in an installed package. This
 * is the same trick `--version` uses in cli.ts to find its own package.json.
 */

/** Basename of the shipped credit file — one spelling, used by every caller. */
export const SUPPORTERS_FILE = "SUPPORTERS.md";

export interface SupportersResult {
  /** Absolute path we looked at, so a missing file is diagnosable, not a mystery. */
  path: string;
  present: boolean;
  /** The file's bytes, verbatim. Empty string when absent. */
  text: string;
  /** errno code when the read failed for a reason other than "not there". */
  reason?: string;
}

/** Where the packaged credit file lives, relative to this module. */
export function supportersPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    SUPPORTERS_FILE,
  );
}

/**
 * Read the credit file. NEVER throws: a credit file that is missing or locked
 * is a packaging or filesystem fault, not the user's problem, and it must not
 * turn a "who is thanked here" question into a crash. Absent and unreadable
 * stay distinguishable (`reason`) so a packaging regression is still visible
 * instead of being silently reported as an empty list.
 */
export function readSupporters(file: string = supportersPath()): SupportersResult {
  try {
    return { path: file, present: true, text: readFileSync(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return { path: file, present: false, text: "" };
    }
    return { path: file, present: false, text: "", reason: code ?? "unknown error" };
  }
}
