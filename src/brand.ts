/**
 * The one place the product's user-facing names live.
 *
 * Found 2026-07-28 by the first ever cold install: the package ships as
 * `fimemory`, but ~90 user-facing strings still told the reader to run
 * `gestalt <verb>`. A stranger who follows the CLI's own success message
 * types a command they do not have. Every hint, error remedy and "try this"
 * line must be built from BIN so the shipped binary and the advice agree.
 *
 * SUPERSEDED 2026-08-06 (owner ruling, ahead of the free public launch): the
 * four names below WERE deliberately left as `gestalt`, on the argument that
 * they are plumbing rather than user commands. That argument held only while
 * the population who depended on them was Eric and two of his own machines.
 * The moment this publishes, every one of them becomes a public contract that
 * cannot be changed without breaking strangers, so they get renamed now, while
 * the cost is a migration path instead of somebody else's install.
 *
 * Each one keeps a LEGACY alias, and the aliases are not symmetrical:
 *
 *   - The store directory and the env vars are READ through their legacy names
 *     forever, because an existing store on disk is not ours to invalidate.
 *   - The MCP server key is WRITTEN as the new name, but uninstall must still
 *     FIND the old one. Miss that and every entry a previous version wrote
 *     becomes unremovable by our own tooling, in seven config files we told
 *     people we would clean up.
 *
 * The one real cost — a stale eval baseline (the 14/15 at 39%-less-cost
 * measurement was taken 2026-07-26 with the OLD `gestalt_*` ids in the rules
 * block) — was RE-MEASURED the same night the rename landed. 2026-08-07,
 * docs/squirl/records/AB-RENAME-2026-08-07.md: a 15-probe A/B on the live
 * store, both arms built from the same commit and differing ONLY in this
 * naming surface. The new names scored equal or better on every axis measured
 * (10/10 vs 8/10 on facts still findable; −13% cost, −17% turns, −36% wall
 * clock; the five shared misses were store drift, identical across arms). The
 * rename cost no retrieval quality. The old 14/15 sentence is retired as a
 * current claim: cite it with its 2026-07-26 date wherever it still appears.
 */

/** The installed executable. Every command example must be built from this. */
export const BIN = "fimemory";

/** Display name for prose and headings. */
export const PRODUCT = "FIMemory";

/**
 * MCP tool id prefix — `fimemory_search`, `fimemory_get`, and friends.
 * Tool ids are what the rules block tells a model to call, so this string and
 * the rules text must never drift apart.
 */
export const TOOL_PREFIX = "fimemory";

/** The tool prefix shipped before 2026-08-06. Read-only compatibility. */
export const LEGACY_TOOL_PREFIX = "gestalt";

/** The MCP server key written into host config files. */
export const MCP_SERVER_KEY = "fimemory";

/**
 * The server key every previous version wrote. `install-mcp` never writes this
 * again, but `uninstall-mcp` and `doctor` MUST still look for it, or an entry
 * written by an older build is invisible to the tool that promises to remove it.
 */
export const LEGACY_MCP_SERVER_KEY = "gestalt";

/** Store directory name under the user's home: `~/.fimemory`. */
export const STORE_DIRNAME = ".fimemory";

/** The store directory previous versions created. Still opened when present. */
export const LEGACY_STORE_DIRNAME = ".gestalt";

/** Environment variable prefix: `FIMEMORY_HOME`, `FIMEMORY_PASSPHRASE`. */
export const ENV_PREFIX = "FIMEMORY";

/** The env prefix previous versions used. Still honoured as a fallback. */
export const LEGACY_ENV_PREFIX = "GESTALT";

/**
 * Read one of our environment variables by its unprefixed suffix
 * (`HOME`, `PASSPHRASE`, …), preferring the new name and falling back to the
 * legacy one.
 *
 * Precedence is new-then-legacy rather than legacy-then-new on purpose: a user
 * who has set BOTH is mid-migration, and the name they set most recently is
 * the new one. Empty and whitespace-only values are treated as unset at this
 * boundary, so a stray `FIMEMORY_PASSPHRASE=` cannot shadow a working
 * `GESTALT_PASSPHRASE` and lock somebody out of their own store.
 */
export function readEnv(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const preferred = env[`${ENV_PREFIX}_${suffix}`]?.trim();
  if (preferred) return preferred;
  const legacy = env[`${LEGACY_ENV_PREFIX}_${suffix}`]?.trim();
  if (legacy) return legacy;
  return undefined;
}

/** `fimemory search "…"` — a command example, always correct by construction. */
export function cmd(rest: string): string {
  return `${BIN} ${rest}`;
}

/**
 * A RUNNABLE "set the passphrase, then run `<rest>`" example for this platform.
 *
 * Same class of defect as the `gestalt` → `fimemory` rename this module exists
 * for — advice that does not run — and found the same way, by a cold install.
 * The hint printed after `init --encrypted` was:
 *
 *     GESTALT_PASSPHRASE=... fimemory get gestalt-example
 *
 * That is POSIX `env`-prefix syntax. It is a PARSER ERROR in both shells a
 * Windows user actually has:
 *
 *   PowerShell  →  GESTALT_PASSPHRASE=... : The term 'GESTALT_PASSPHRASE=...'
 *                  is not recognized as the name of a cmdlet…
 *   cmd.exe     →  'GESTALT_PASSPHRASE=...' is not recognized as an internal
 *                  or external command…
 *
 * Windows is the ONLY platform this build is verified on, so the one hint an
 * encrypted-store user is guaranteed to see was guaranteed to fail for them.
 * There is no single line that runs in PowerShell, cmd.exe AND a POSIX shell,
 * so branch on the platform and print what actually works there.
 *
 * Returns the lines to print, in order; the caller owns the indentation.
 */
export function passphraseExample(
  rest: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    // Both shells, labelled — a Windows user cannot be assumed to know which
    // one they are in, and picking one silently breaks the other half of them.
    //
    // The PLACEHOLDER matters as much as the syntax. `<your passphrase>` looks
    // like the obvious way to write a fill-in-the-blank, and it is a second
    // parser error in cmd.exe, where `<` and `>` are redirection operators:
    //   set GESTALT_PASSPHRASE=<your passphrase>   →  ">& was unexpected at
    //                                                  this time."
    // (Checked, not assumed, 2026-07-31.) So no angle brackets here, and the
    // cmd.exe form quotes the whole NAME=VALUE — the canonical idiom, which is
    // also what makes a passphrase containing spaces survive.
    return [
      `$env:GESTALT_PASSPHRASE = 'your passphrase here'   # PowerShell`,
      `set "GESTALT_PASSPHRASE=your passphrase here"      # cmd.exe`,
      `${BIN} ${rest}`,
    ];
  }
  // POSIX: the env-prefix form is correct AND keeps the passphrase out of the
  // shell's persistent environment, so it stays a one-liner.
  return [`GESTALT_PASSPHRASE='your passphrase here' ${BIN} ${rest}`];
}
