import path from "node:path";

import { BIN } from "./brand.js";
import { resolveHome } from "./paths.js";

/**
 * The ` --home <path>` a printed command needs, or "" when it needs none.
 *
 * WHY THIS IS CENTRAL AND NOT INLINE AT EACH CALL SITE
 *
 * Every printed follow-up command in this codebase used to be built bare —
 * `review approve 3 --machine f3b40cc2` and friends — which is correct only when
 * the store being talked about is the one a bare invocation would find. The
 * two-machine gate on 2026-08-18 caught what that means in practice: `pull --home B`
 * printed an approve command that, pasted verbatim, applies a real edit to store
 * A. It does not error. It succeeds, against the wrong memory, having done
 * exactly what the user was told to do.
 *
 * A silent success on the wrong store is worse than a failure, and six separate
 * sites had the same bug, so the fix belongs in one place that all of them call.
 *
 * Comparing against `resolveHome` rather than tracking "was --home passed?" keeps
 * it honest in the case that actually matters: if GESTALT_HOME already points
 * here, a bare command DOES work, and printing the flag would be noise.
 */
export function homeFlagFor(home: string, env: NodeJS.ProcessEnv = process.env): string {
  let bare: string;
  try {
    bare = resolveHome({ env });
  } catch {
    // Can't tell what a bare command would resolve to — print the flag. A
    // redundant --home is harmless; a missing one edits the wrong store.
    return ` --home ${shellQuote(home)}`;
  }
  return path.resolve(bare) === path.resolve(home) ? "" : ` --home ${shellQuote(home)}`;
}

/**
 * A complete, copy-pasteable command: the binary, the arguments, and the --home
 * that makes it land where the caller meant.
 *
 * `rest` is everything after the binary name, e.g. `review approve 3 --machine x`.
 */
export function followUp(home: string, rest: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${BIN} ${rest}${homeFlagFor(home, env)}`;
}

/**
 * Wrap a path so a shell hands it back byte for byte.
 *
 * SINGLE quotes, not double. Double quotes look adequate on a Windows path and
 * are wrong in three ways the Mac proved empirically on 2026-08-18 by running
 * them rather than reading them:
 *
 *   \hostshare  bash collapses the leading \ to  inside double quotes, so a
 *                 store on a UNC path resolves somewhere else entirely. This
 *                 fleet runs on UNC paths.
 *   /a/my$store   $store EXPANDS — the same silent-wrong-store failure this
 *                 whole module exists to prevent, reintroduced one layer down.
 *   /a/`cmd`/b     a backtick COMMAND-SUBSTITUTES. We print this line and tell
 *                 the reader to paste it, so a directory name would be running
 *                 code on their machine. That one is a security bug.
 *
 * Double quotes are no safer in PowerShell: $ expands there too and backtick is
 * its escape character. Single quotes are literal in bash, sh, zsh AND
 * PowerShell, which is the whole set we can be pasted into.
 *
 * The one genuine divergence is an embedded single quote, where the escape
 * differs by shell — PowerShell doubles it, POSIX closes/escapes/reopens — so
 * only that case is platform-aware.
 *
 * $ and backtick are in the trigger class deliberately: a path containing only
 * a $ has no whitespace and would otherwise print BARE, which expands even more
 * readily than the quoted form.
 */
export function shellQuote(p: string): string {
  // ALLOWLIST, not a denylist. Two denylists leaked in a row — the second
  // missed & (legal in a filename, reserved in PowerShell), and the semicolon
  // case had only ever passed because that path also contained a space.
  // ; ( ) | < > * ? [ ] { } ! # ~ ^ = @ , & all mean something to one shell or
  // the other, so enumerating them is a losing game. Leave bare only what is
  // inert in both; quote everything else. Over-quoting is invisible and safe.
  //
  // The `+` matters: an empty home fails the allowlist and gets quoted rather
  // than vanishing out of the command line.
  if (/^[A-Za-z0-9_.:\/-]+$/.test(p)) return p;

  // An embedded single quote is the only case where the two shells disagree,
  // and DOUBLE quotes close most of it — a form literal in BOTH. Inside bash
  // double quotes only $ ` " \\ and newline are special, and a backslash only
  // when it precedes one of those; inside PowerShell double quotes only $ and
  // backtick are, and a backslash is not an escape at all. Rule out $, `, ",
  // a doubled backslash, and a TRAILING backslash (which would escape the
  // closing quote in bash) and the same bytes survive both shells.
  //
  // This is what covers a Windows user in Git Bash with o'brien in their path,
  // whom the platform branch below would otherwise hand an unparseable line.
  const literalInBothWhenDoubleQuoted =
    !/[$`"]/.test(p) && !p.includes("\\\\") && !p.endsWith("\\");
  if (p.includes("'") && literalInBothWhenDoubleQuoted) return `"${p}"`;

  // Everything else: single quotes, literal in bash, sh, zsh and PowerShell.
  // Only the escape for an embedded quote diverges, and by here we know the
  // path has one AND something that ruled out the shared form — the genuinely
  // impossible combination. Nothing tells us the target shell, so: platform.
  return process.platform === "win32"
    ? `'${p.replace(/'/g, "''")}'`
    : `'${p.replace(/'/g, "'\\''")}'`;
}
