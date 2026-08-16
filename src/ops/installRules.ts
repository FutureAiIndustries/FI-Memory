import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BIN } from "../brand.js";
import { GestaltError } from "../errors.js";
import { fsPath } from "../paths.js";
import { writeFileAtomicPlain } from "../store/atomic.js";

/**
 * install-rules / uninstall-rules — idempotent, marker-delimited install of the
 * MEASURED rule block into a host's memory/rules file.
 *
 * Two layers:
 *   - `installRules` / `uninstallRules` — ONE file (default `~/.claude/CLAUDE.md`,
 *     or whatever `--file` names). This is where the safety contract lives.
 *   - `installRulesAll` / `uninstallRulesAll` — the host REGISTRY below, in the
 *     same spirit as installMcp's: write to every host detected on this machine
 *     (Claude Code, Codex, Gemini, Grok, Windsurf), or just the ones named.
 *     Every host goes through the single-file writer, so no host gets a weaker
 *     guarantee than Claude Code had.
 *
 * The block BODY is the §2.5 canonical rule block from
 * SQUIRL-INSTALL-BUILD-GUIDE.md, VERBATIM — the addendum freezes its wording
 * because it is the exact text the adversarial initiation battery scored.
 * Rephrasing it here would invalidate every measurement made against it
 * ("do not de-name tools in the block"; tool ids are mandatory in the body).
 * If the block ever changes, the guide changes first and the battery re-runs.
 *
 * Markers are stable so reinstall replaces exactly its own block and uninstall
 * removes it cleanly — text OUTSIDE the markers is never touched. The legacy
 * marker spellings (`<!-- memory-runtime:begin -->`, `<!-- squirl:begin -->`)
 * are recognized for replace/uninstall per the guide (§2.5), so an older
 * install upgrades in place instead of duplicating.
 *
 * Written ≠ loaded (addendum §2.3): a host reads its rules file at session
 * start, so a block written now is only LOADED next session. The CLI prints
 * that caveat; `fimemory doctor` reports the same distinction.
 */

export const RULES_MARKER_BEGIN = "<!-- fimemory:rules v1 -->";
export const RULES_MARKER_END = "<!-- /fimemory:rules v1 -->";

// Legacy delimiters (guide §2.5): accepted for replace/uninstall only — new
// installs always write the current markers.
const LEGACY_BEGIN = /<!--\s*(?:memory-runtime|squirl):begin\b[^>]*-->/;
const LEGACY_END = /<!--\s*(?:memory-runtime|squirl):end\s*-->/;

/** Product mode for the rule block (guide §0.2c / §2.5b). */
export type RulesMode = "rules" | "shim";

/** The §2.5 rule-block body, VERBATIM from SQUIRL-INSTALL-BUILD-GUIDE.md
 * (heading "Shared memory store"). Do not edit without a guide change + a
 * battery re-run — see the module comment. Used when product mode = rules. */
export const RULES_BODY = `## Shared memory store

A local memory store is connected through the \`fimemory\` MCP server (tool names below).
It holds curated notes and typed changelogs about this user's projects, decisions,
and history — across every project, not just this directory.

**Before answering anything about a project, product, decision, plan, or past
work — including questions that never mention the store, "fimemory", or this
product — call \`fimemory_search\` first, then \`fimemory_get\` on the one to three
topics that matter.** Do this unprompted, every time, before you reason from
your own assumptions. If the search returns nothing, say so and continue; a
miss is cheap, a confidently wrong answer is not.

The store is the source of truth for what has already been decided. Your
recollection is not, and neither is the current working directory.

**After learning something worth keeping** — a decision, a gotcha, a convention,
a superseded plan — append it with \`fimemory_log\`.`;

/**
 * §2.5b rule-block body when product mode is **shim** (guide §2.5b).
 * Avoids double-pay: the hook already injects hits, so do not instruct
 * "always call fimemory_search first".
 */
export const RULES_BODY_SHIM = `## Shared memory store

A local memory store is connected through the \`fimemory\` MCP server.
**Relevant store context may already be present in this turn** (injected by the
host retrieval hook). Prefer that context when it answers the question — it is
ALREADY-RETRIEVED and AUTHORITATIVE for this prompt.

Call \`fimemory_search\` / \`fimemory_get\` **only if** you need more than what was
provided, or if no store context appears above. Do not re-search by default.

**After learning something worth keeping**, append it with \`fimemory_log\`.`;

/** The full block as written to disk: begin marker, body for mode, end marker. */
export function rulesBlock(mode: RulesMode = "rules"): string {
  const body = mode === "shim" ? RULES_BODY_SHIM : RULES_BODY;
  return `${RULES_MARKER_BEGIN}\n${body}\n${RULES_MARKER_END}`;
}

/** Default target: the Claude global memory file. Overridable for tests and
 * for other hosts' rules files. */
export function defaultRulesPath(): string {
  return path.join(homedir(), ".claude", "CLAUDE.md");
}

/* ─────────────────────────── host registry ──────────────────────────────
 *
 * `install-mcp` has always known five hosts' config files precisely; this is
 * the same idea for RULES files, so a Codex / Gemini / Grok / Windsurf user
 * gets on first run what the owner previously had to hand-author.
 *
 * PROVENANCE, per entry — stated honestly rather than as one blanket claim,
 * because a wrong path here still reports `installed` and prints "takes effect
 * in the NEXT session" for a file the host never reads:
 *
 *   claude-code  ~/.claude/CLAUDE.md
 *                  confirmed on the owner's disk (file exists, carries a block).
 *   codex        $CODEX_HOME|~/.codex/AGENTS.md
 *                  directory confirmed on the owner's disk; AGENTS.md is the
 *                  vendor-documented global instructions filename.
 *   gemini       $GEMINI_CLI_HOME|~/.gemini/GEMINI.md
 *                  directory + settings.json confirmed on the owner's disk;
 *                  GEMINI.md is the vendor default, overridable via
 *                  `contextFileName` (read below).
 *   grok         $GROK_HOME|~/.grok/AGENTS.md
 *                  documented by ~/.grok/README.md (§AGENTS.md) on the owner's
 *                  disk. NOTE: ~/.grok/GROK.md exists there and is NOT read by
 *                  Grok CLI — that is the note `hostNotes` emits.
 *   windsurf     ~/.codeium/windsurf/memories/global_rules.md
 *                  VENDOR DOC ONLY — Windsurf is not installed on any machine
 *                  we have checked, so this path is unverified on disk.
 *
 * The two Codex behaviors below (`AGENTS.override.md` shadowing, the 32 KiB
 * cap) are likewise vendor-doc-only: they are surfaced as advisory notes, and
 * nothing depends on them being exact.
 *
 * Two known hosts get NO rules file from us and are registered as such rather
 * than silently missing, so `install-rules cursor` explains itself instead of
 * failing as an unknown name. NEITHER is installed on any machine we have
 * checked, so both entries say UNVERIFIED rather than asserting a vendor limit
 * (the rule after 2026-07-31: never state another tool's limit from memory):
 *
 *   cursor          We write no Cursor rules file. UNVERIFIED whether Cursor
 *                   loads `~/.cursor/rules` — not installed on any machine we
 *                   have checked, and no Cursor doc or binary is on this disk.
 *                   Third-party evidence points the OTHER way from the claim
 *                   this code used to make: Grok's own
 *                   ~/.grok/docs/user-guide/12-project-rules.md:38 lists
 *                   `~/.cursor/rules/` as a rules DIRECTORY it scans.
 *   claude-desktop  UNVERIFIED — not installed on any machine we have checked.
 *                   The only Claude Desktop file this package knows of is
 *                   claude_desktop_config.json, which `install-mcp` writes.
 *
 * SHARED FILES. A rules file is not private to the host that owns the path.
 * `alsoReadBy` records, as DATA with a citation, which other hosts load the
 * same file — see the field's own comment for why that decides which BODY may
 * be written there.
 *
 * GOTCHAS these entries carry as notes at install time (they decide whether a
 * written block is ever READ):
 *   - Codex prefers `AGENTS.override.md` at the same level and uses only the
 *     first NON-EMPTY file, so an override would shadow our write.
 *   - Grok CLI never reads `GROK.md` — the filenames it scans are AGENTS.md /
 *     CLAUDE.md and friends. A hand-written ~/.grok/GROK.md is dead weight.
 *   - Windsurf caps global_rules.md at 6,000 chars, Grok at 10,000 per file.
 */

export type RulesHostId =
  | "claude-code"
  | "codex"
  | "gemini"
  | "grok"
  | "windsurf"
  | "cursor"
  | "claude-desktop";

export interface RulesHost {
  id: RulesHostId;
  label: string;
  /** The host's GLOBAL rules file — `null` when the host has none at all. */
  file: string | null;
  /** Directory whose existence means "this host is installed on this machine".
   * Detection is deliberately the DIRECTORY, not the rules file: an installed
   * Gemini with no GEMINI.md must still get one created. */
  detectDir: string | null;
  /**
   * When true, the rules FILE itself must already exist for the host to count
   * as installed. No shipped host sets this: for all five writable hosts the
   * config directory is unambiguous, so requiring the file would break the
   * create-it-for-you case above. The field exists because detection and file
   * presence are different questions, and a host whose directory is shared
   * with unrelated tools would need it.
   */
  requireFile: boolean;
  /** How the file is parsed by the host. Only `markdown` can carry an appended
   * marker block; `none` means there is nothing to write. */
  format: "markdown" | "mdc" | "none";
  /** Host-imposed size cap on the file, in characters (0/undefined = none).
   * Exceeding it truncates silently INSIDE the host, so we warn instead. */
  maxChars?: number;
  /**
   * True when this host actually RUNS the FIMemory retrieval hook, i.e. when
   * the §2.5b `shim` body ("context may already be injected — do not re-search
   * by default") is a TRUE statement here. A host that does not run it gets the
   * §2.5 search-first body even under `--mode shim`; writing the shim body
   * there would suppress the very `fimemory_search` call this feature exists to
   * cause, for an injection that is never coming.
   *
   * This flag is about OUR HOOK EXECUTING, not about what a host is capable of.
   * See `hookNote` for the per-host evidence — and note that the blanket claim
   * this code used to make ("hooks are Claude Code's only") was CHECKED on
   * 2026-07-31 and is FALSE.
   */
  supportsHook: boolean;
  /**
   * WHY, in this host's own terms, with the source that was actually read.
   * Rendered by `installRulesAll` whenever a host is downgraded off the shim
   * body, and by the CLI in `--list-hosts`.
   *
   * REQUIRED, and required to be honest, because of a pattern that bit three
   * times in one day (2026-07-31): a platform limit asserted in a code comment,
   * repeated into the public README, never checked against the vendor's own
   * documentation. Every note here either cites a file on this disk or says
   * UNVERIFIED. It must never state a limit we have not checked.
   */
  hookNote: string;
  /**
   * ONE CLAUSE of `hookNote`, for the line a stranger reads during `setup`.
   *
   * REQUIRED so a new host cannot skip it. The full notes carry version pins,
   * doc line numbers and the experiment that settled them, which is exactly
   * right for `--list-hosts` and exactly wrong for an install screen: five
   * hosts' worth of citation is the wall of output `setup` exists to avoid, and
   * output nobody reads is its own kind of silence. The short form must still
   * be TRUE on its own and must name where the evidence is.
   */
  hookNoteShort: string;
  /**
   * Other hosts that ALSO READ this host's rules file, as data with a citation
   * in the registry entry.
   *
   * WHY THIS IS A FIELD AND NOT A COMMENT. `supportsHook` used to be read as
   * "this host runs our hook, therefore the file we write for it may carry the
   * §2.5b shim body". That reasoning is only sound if a rules file is private
   * to its own host, and it is NOT: Grok CLI reads ~/.claude/CLAUDE.md — the
   * exact file we write the shim body into. On a Claude Code + Grok box (the
   * launch scope) the shim body therefore reached Grok, telling it "context may
   * already be present … do not re-search by default" for an injection that
   * never arrives there. Writing the search-first block to ~/.grok/AGENTS.md
   * does not undo it; Grok loads BOTH files and the two contradict each other.
   *
   * So the body is chosen per FILE, not per host: a file any DETECTED
   * non-hook-running host also reads stays on the unconditional search-first
   * body. Recording it here means the next host added cannot re-open the hole
   * by editing one flag.
   */
  alsoReadBy?: RulesHostId[];
  /** Why nothing can be written, when `file` is null. */
  unsupported?: string;
}

export interface RulesRegistryOptions {
  /** Base home directory. Default `os.homedir()` — injectable so tests never
   * touch the real one. */
  homeDir?: string;
  /** Environment consulted for host-home overrides. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (Array.isArray(v)) {
    for (const item of v) if (typeof item === "string" && item.trim() !== "") return item;
  }
  return undefined;
}

/**
 * Gemini's context filename is user-overridable (`contextFileName` in
 * `~/.gemini/settings.json`), so the default GEMINI.md is a guess until that
 * file says otherwise — writing GEMINI.md to a user who renamed it would
 * produce a file the CLI never reads. Unreadable/invalid settings fall back to
 * the documented default.
 */
export function geminiContextFile(geminiDir: string): { name: string; rejected?: string } {
  try {
    const raw = readFileSync(fsPath(path.join(geminiDir, "settings.json")), "utf8");
    const parsed = JSON.parse(raw) as {
      contextFileName?: unknown;
      context?: { fileName?: unknown } | null;
    };
    const name =
      firstString(parsed.contextFileName) ?? firstString(parsed.context?.fileName);
    if (name !== undefined) {
      // This value becomes a WRITE target, and settings.json is a file we do
      // not own: user-editable, team-synced, frequently checked into a dotfiles
      // repo. Only a BARE FILENAME is accepted. Anything with a separator (or
      // `.` / `..`) escapes ~/.gemini once joined — `path.join(dir, "../../.bashrc")`
      // lands two directories up, `"."` resolves to the directory itself — and
      // `installRules` would then mkdir + append the block there, with
      // `uninstall-rules` later rewriting that same foreign file wholesale.
      if (name !== "." && name !== ".." && path.basename(name) === name) return { name };
      return {
        name: "GEMINI.md",
        rejected:
          `~/.gemini/settings.json sets contextFileName to ${JSON.stringify(name)}, which is not a bare filename — ` +
          "it would place the rule block outside the Gemini config directory, so GEMINI.md was used instead. " +
          "Rename it to a plain filename if that value was intentional.",
      };
    }
  } catch {
    // No settings.json, or not JSON — the documented default stands.
  }
  return { name: "GEMINI.md" };
}

/** Just the filename — see `geminiContextFile` for the validation contract. */
export function geminiContextFileName(geminiDir: string): string {
  return geminiContextFile(geminiDir).name;
}

/** The known hosts and where each keeps its GLOBAL rules file. */
export function rulesHosts(opts: RulesRegistryOptions = {}): RulesHost[] {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const under = (v: string | undefined, fallback: string): string =>
    v && v.trim() !== "" ? path.resolve(v) : path.join(home, fallback);

  const claudeDir = path.join(home, ".claude");
  const codexDir = under(env["CODEX_HOME"], ".codex");
  const geminiDir = under(env["GEMINI_CLI_HOME"], ".gemini");
  const grokDir = under(env["GROK_HOME"], ".grok");
  const windsurfDir = path.join(home, ".codeium", "windsurf");

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: path.join(claudeDir, "CLAUDE.md"),
      detectDir: claudeDir,
      requireFile: false,
      format: "markdown",
      // The only host `installHooks` writes a retrieval hook INTO, and the only
      // one confirmed to execute it (the handler carries `args`, which Claude
      // Code passes through — see grok's note for why that word matters).
      supportsHook: true,
      // Grok CLI reads THIS FILE too. Verified three ways on this disk,
      // 2026-07-31/08-01, grok 0.2.117:
      //   1. ~/.grok/docs/user-guide/12-project-rules.md:26 — "When Claude
      //      compatibility is enabled (the default), Grok also scans your
      //      home-level `~/.claude/` directory for these filenames", and the
      //      filename list at :15-25 includes CLAUDE.md.
      //   2. ~/.grok/docs/user-guide/05-configuration.md:347 — `[compat.claude]
      //      agents = true  # scan ~/.claude/ and <dir>/.claude/CLAUDE*.md`,
      //      under "Every cell defaults to `true`" (:333).
      //   3. FIRST-HAND: `grok inspect --json` on the owner's real home listed
      //      projectInstructions [{ path: "…\\.claude/CLAUDE.md", scope:
      //      "global", fileType: "agents_md" }], with externalCompat vendor
      //      claude / surface agents / enabled true.
      // Consequence, and the reason this is data: while ~/.grok is present, this
      // file may NOT carry the shim body. See `alsoReadBy`.
      alsoReadBy: ["grok"],
      hookNoteShort: "runs the retrieval hook (~/.claude/settings.json).",
      hookNote:
        "runs the retrieval hook — this is the host `install-hooks` writes (~/.claude/settings.json).",
    },
    {
      id: "codex",
      label: "Codex CLI",
      file: path.join(codexDir, "AGENTS.md"),
      detectDir: codexDir,
      requireFile: false,
      format: "markdown",
      maxChars: 32 * 1024,
      // Codex CLI DOES have a hook system — checked in its own shipped binary
      // rather than assumed. `install-hooks` still writes no Codex config, so
      // OUR hook does not run there; that is the only claim made.
      //
      // Read on this disk, 2026-08-01, @openai/codex 0.145.0
      // (…/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/
      //  x86_64-pc-windows-msvc/bin/codex.exe):
      //   - the `HookEventName` string table enumerates pre_tool_use,
      //     permission_request, post_tool_use, pre_compact, post_compact,
      //     session_start, session_end, user_prompt_submit, subagent_start,
      //     subagent_stop, stop;
      //   - the binary carries the Rust source paths hooks\src\events\
      //     user_prompt_submit.rs, session_start.rs, pre_tool_use.rs,
      //     hooks\src\engine\{discovery,dispatcher,command_runner}.rs;
      //   - `hooks/hooks.json` appears next to `core-plugins\src\loader.rs`,
      //     and `additional_context` / `additional_context_limit` are both in
      //     the binary.
      // NOT verified: the handler schema (whether it has an `args` field), and
      // whether a user_prompt_submit hook's stdout is injected. Until someone
      // runs the experiment, no support claim is made in either direction.
      // RESOLVED 2026-08-01. The old note said the handler schema and the
      // stdout path were UNVERIFIED. Both are now read, and the answer is that
      // the channel exists and already speaks our exact wire format:
      // `UserPromptSubmit` fires before the model processes input and the hook
      // returns `{hookSpecificOutput:{hookEventName, additionalContext}}`,
      // which is byte-identical to what cli.ts:1905-1912 already emits.
      // Confirmed first-hand in codex.exe 0.145.0 on this disk — the field run
      // `command commandWindows timeout async statusMessage
      // additionalContextLimit` appears verbatim in the string table, with NO
      // `args` field, which is the one thing that stops us writing it today.
      // Docs: developers.openai.com/codex/hooks.
      supportsHook: false,
      hookNoteShort:
        "we write no Codex hook config, so our hook does not run here. The channel EXISTS and takes our exact output " +
        "(`UserPromptSubmit` + `hookSpecificOutput.additionalContext`, codex 0.145.0). Not written yet, not unsupported.",
      hookNote:
        "`install-hooks` writes no Codex config, so our retrieval hook does not run here. That is a gap in our installer, " +
        "not a limit of Codex: `UserPromptSubmit` fires before the model processes input and takes " +
        "`{hookSpecificOutput:{hookEventName, additionalContext}}`, byte-identical to what our handler already emits, " +
        "with config at ~/.codex/hooks.json (developers.openai.com/codex/hooks; field run confirmed first-hand in " +
        "codex.exe 0.145.0 on disk, 2026-08-01). The blocker is shape, not capability: our handler puts its invocation " +
        "in an `args` array and Codex has no `args` field, so wiring it needs a per-host builder. " +
        "Deliberately deferred behind openai/codex#16933 (OPEN): Codex currently renders additionalContext as a VISIBLE " +
        "developer message in the transcript, so shipping this today would paste store text into every turn.",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      file: path.join(geminiDir, geminiContextFileName(geminiDir)),
      detectDir: geminiDir,
      requireFile: false,
      format: "markdown",
      // Gemini CLI DOES have a hook system, and ships a first-party MIGRATION
      // of the very file `install-hooks` writes. Read on this disk, 2026-08-01,
      // @google/gemini-cli 0.52.0
      // (bundle/gemini-6K6USV55.js, from packages/cli/src/commands/hooks/migrate.ts):
      //   - `EVENT_MAPPING = { PreToolUse: "BeforeTool", PostToolUse:
      //     "AfterTool", UserPromptSubmit: "BeforeAgent", Stop: "AfterAgent",
      //     SessionStart: "SessionStart", SessionEnd: "SessionEnd",
      //     PreCompact: "PreCompress", Notification: "Notification" }` — so
      //     Gemini has a per-prompt event (BeforeAgent);
      //   - `handleMigrateFromClaude()` reads `<cwd>/.claude/settings.json`
      //     (and settings.local.json) and imports its hooks;
      //   - `migrateClaudeHook()` copies ONLY `command`, `type` and `timeout`.
      //     It DROPS `args` — the same gap that makes our handler unrunnable
      //     under Grok. A user who runs `gemini hooks migrate` in a repo that
      //     carries .claude/settings.json would import our two handlers with
      //     the invocation stripped, i.e. a node process that dies immediately.
      // `install-hooks` writes no Gemini config, so nothing of ours runs there
      // unless the user runs that migration themselves.
      supportsHook: false,
      hookNoteShort:
        "we write no Gemini hook config, so our hook does not run here. Gemini DOES have hooks, and its own `gemini hooks migrate` " +
        "would import ours with `args` stripped (gemini-cli 0.52.0) — do not run it against our handlers. `install-rules --list-hosts` has the evidence.",
      hookNote:
        "`install-hooks` writes no Gemini config, so our retrieval hook does not run here. That is a gap in our " +
        "installer, not a limit of Gemini, and of every host we do not yet write it is the closest to working: " +
        "`BeforeAgent` fires after a prompt is submitted and before planning, the injection field is " +
        "`hookSpecificOutput.additionalContext`, and its config nesting (`hooks.<Event>[].hooks[]`) is identical to " +
        "Claude's. Read first-hand in @google/gemini-cli 0.52.0 on disk (2026-08-01): its `createBaseInput` passes " +
        "`{session_id, transcript_path, cwd, hook_event_name, timestamp}`, which is exactly the set our handler " +
        "already parses, and `getAdditionalContext()` reads our field with no event-name validation. " +
        "Two real caveats. Gemini runs `command` as ONE shell string and has no `args` field, where our invocation " +
        "lives, so wiring it needs a per-host builder. And its hooks are gated on `isTrustedFolder()`, which nobody " +
        "has tested live, so no support claim until someone does. " +
        "Also: do NOT run `gemini hooks migrate` against a directory carrying our handlers — it copies only " +
        "`command`/`type`/`timeout` and drops `args`, producing a handler that spawns a bare interpreter and exits.",
    },
    {
      id: "grok",
      label: "Grok CLI",
      file: path.join(grokDir, "AGENTS.md"),
      detectDir: grokDir,
      requireFile: false,
      format: "markdown",
      maxChars: 10_000,
      // FALSE, and verified false: "hooks are Claude Code only". Grok CLI DOES
      // load our handlers. It still cannot RUN them, for a different reason —
      // which is why the flag stays false and the note carries the evidence.
      //
      // Read first-hand on this disk, 2026-07-31, grok 0.2.117:
      //   ~/.grok/docs/user-guide/10-hooks.md "Hook Locations" lists
      //     `~/.claude/settings.json` as a Global, always-trusted hook source
      //     ("Claude Code compatibility"), and 05-configuration.md ships
      //     `[compat.claude] hooks = true  # scan ~/.claude/settings.json for
      //     hooks` under "Every cell defaults to `true`".
      //   `grok inspect --json` on a real home with both tools installed
      //     reports our two handlers (session_start, user_prompt_submit)
      //     already loaded, sourced from the user's `~/.claude`.
      // TWO INDEPENDENT BLOCKERS, and the order matters. The second one alone
      // would be enough, so a maintainer who "fixes" the first must not flip
      // this flag.
      //
      //   (1) PRIMARY — STDOUT IS DISCARDED. Grok runs the UserPromptSubmit
      //       hook and throws its stdout away, so there is no channel by which
      //       an injection could arrive. Established EXPERIMENTALLY, 2026-07-31,
      //       against four stdout shapes (Claude's `hookSpecificOutput`, a
      //       top-level `additionalContext`, plain text, `systemMessage`); each
      //       was confirmed to have FIRED via a marker file it wrote, each
      //       yielded NO injected context, against a positive control that
      //       proved the harness could surface injected context at all.
      //       RESIDUAL CAVEAT, stated rather than hidden: measured in headless
      //       `-p` mode; the interactive TUI was not measured.
      //       The shipped docs do NOT settle this on their own, which is why
      //       the experiment is the authority: 10-hooks.md:103 says only
      //       `PreToolUse`/`Stop`/`SubagentStop` can decide, and "every other
      //       event is passive"; the "Passive Hooks" section (~:304) says "For
      //       events like `SessionStart` or `PostToolUse`, stdout is ignored" —
      //       naming examples, not UserPromptSubmit, hence the measurement.
      //   (2) SECONDARY — NO `args` FIELD. 10-hooks.md:194 ("Hooks in Config
      //       Files") enumerates the handler fields as `type`, `command`,
      //       `url`, `timeout`, `env`. NOT "Key Fields" (:150-156), which lists
      //       only event/matcher/type/command/timeout — a maintainer sent there
      //       to re-verify finds a list that does not contain the claim and
      //       reasonably concludes the claim is stale.
      //       There is no `args`. `installHooks` puts the ENTIRE invocation in
      //       `args` (cliPath, `hook-retrieve`, `--home`, …), so Grok spawns
      //       bare node.exe with argv empty; it reads the event JSON as a
      //       script and dies on a SyntaxError. Confirmed by an args-probe hook
      //       under a scratch GROK_HOME, which logged `argv: []`.
      //       This one LOOKS fixable — 10-hooks.md:155 says `command` is "Path
      //       to executable … or inline shell command", so collapsing the
      //       invocation into one `command` string would make the hook execute.
      //       It would still inject nothing, because of (1).
      //
      // Net: Grok fails open, nothing is blocked, and the store is never read —
      // so the shim body ("context may already be injected") would be a lie.
      // Grok also reads ~/.claude/CLAUDE.md, so that file cannot carry the shim
      // body either while Grok is installed — see claude-code's `alsoReadBy`.
      supportsHook: false,
      hookNoteShort:
        "Grok DOES load our handlers, but it discards a UserPromptSubmit hook's stdout and drops the handler's `args`, so our hook " +
        "cannot inject there (grok 0.2.117). Nothing is blocked; its scrollback logs a hook failure per prompt. " +
        "`install-rules --list-hosts` has the evidence.",
      hookNote:
        "Grok CLI DOES load these handlers (it scans ~/.claude/settings.json by default — [compat.claude] hooks = true), " +
        "and it cannot deliver an injection for two independent reasons. PRIMARY: Grok runs the UserPromptSubmit hook and " +
        "DISCARDS its stdout — measured 2026-07-31 against four output shapes (hookSpecificOutput, top-level " +
        "additionalContext, plain text, systemMessage), each confirmed to have fired, each yielding nothing, against a " +
        "positive control (headless `-p` mode; the interactive TUI was not measured; 10-hooks.md:103 and its Passive Hooks " +
        "section leave this ambiguous, so the experiment is the authority). SECONDARY: its handler format has no `args` " +
        "field and our whole invocation lives in `args`, so the process it spawns exits without reading the store. " +
        "Grok fails open, so nothing is blocked — but 10-hooks.md:156 says every hook failure is RECORDED for the UI " +
        "scrollback, so expect a hook-failure line on every Grok prompt. To silence it, set `[compat.claude] hooks = false` " +
        "in ~/.grok/config.toml (05-configuration.md:344-350) — do NOT delete the handlers from ~/.claude/settings.json, " +
        "which is the file Claude Code actually uses. Verified on grok 0.2.117, 2026-07-31.",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      file: path.join(windsurfDir, "memories", "global_rules.md"),
      detectDir: windsurfDir,
      requireFile: false,
      format: "markdown",
      maxChars: 6_000,
      supportsHook: false,
      // RESOLVED 2026-08-01, and the answer is a ceiling rather than a gap.
      // The old note guessed "whether Windsurf has hooks at all is UNVERIFIED".
      // It has them, including a user-global ~/.codeium/windsurf/hooks.json,
      // and `pre_user_prompt` is the right event — but it is allow/block only:
      // exit 0 proceeds, exit 2 blocks with stderr shown to the USER, anything
      // else proceeds. The handler is {command, powershell, show_output,
      // working_directory}: no field carries text into the prompt, and the docs
      // state that `show_output` does not even apply to this hook. Structurally
      // the same ceiling as Cursor. Source: docs.windsurf.com/windsurf/cascade/hooks.
      hookNoteShort:
        "Windsurf hooks exist (~/.codeium/windsurf/hooks.json) but `pre_user_prompt` is allow/block only, with no field " +
        "that adds text to a prompt — so the hand-off can never run here. Vendor limit, not a to-do.",
      hookNote:
        "`install-hooks` writes no Windsurf config, and could not help if it did. Windsurf does have hooks, at three " +
        "merged levels including a user-global ~/.codeium/windsurf/hooks.json, and `pre_user_prompt` is the right " +
        "moment — but that event is allow/block only: exit 0 proceeds, exit 2 blocks and shows stderr to the user, any " +
        "other code proceeds. Its handler is {command, powershell, show_output, working_directory}, no field carries " +
        "text into the prompt, and the docs note `show_output` does not apply to this hook at all " +
        "(docs.windsurf.com/windsurf/cascade/hooks). So Windsurf has the same ceiling as Cursor: MCP tools plus the " +
        "rule block, and no hand-off, ever. Recorded so nobody re-opens it as a bug.",
    },
    {
      id: "cursor",
      label: "Cursor",
      file: null,
      detectDir: path.join(home, ".cursor"),
      requireFile: false,
      format: "mdc",
      supportsHook: false,
      // VERIFIED 2026-08-01 against cursor.com/docs/hooks, replacing a
      // "reportedly / have not tested" note. Cursor's hook system is real and
      // user-level (~/.cursor/hooks.json, `version` + `hooks`), and it does
      // have a prompt-time event — but `beforeSubmitPrompt` returns only
      // `{ continue: bool, user_message: string }`, and `user_message` is what
      // is shown to the USER when a prompt is BLOCKED. There is no field that
      // adds context to the outgoing prompt.
      //
      // So Cursor is structurally the same as Grok: hooks load and run, and
      // there is no injection channel. `--mode shim` can never be honoured
      // here, and no work on our side changes that. This is a vendor ceiling,
      // recorded so nobody re-opens it as a bug.
      hookNoteShort:
        "Cursor hooks exist (~/.cursor/hooks.json) but `beforeSubmitPrompt` returns only continue/user_message, with no field that adds context to a prompt — so retrieval injection is impossible here. Use the MCP tools plus a rule.",
      hookNote:
        "`install-hooks` writes no Cursor config, and could not help if it did. " +
        "Cursor documents a user-level hooks file (~/.cursor/hooks.json) and a prompt-time `beforeSubmitPrompt` event, but that event's output is " +
        "`{ continue, user_message }` and `user_message` is only displayed when a prompt is BLOCKED (cursor.com/docs/hooks). " +
        "No hook field injects context into the prompt, so Cursor cannot receive the retrieval shim. The rule block below is what makes the model reach for the tools.",
      // VERIFIED 2026-08-01 against cursor.com/docs/rules. The earlier note was
      // right to refuse to guess; the answer is now read from the vendor.
      //
      // Cursor has four rule types: Project Rules (`.cursor/rules/*.mdc`,
      // per-repo, version-controlled), User Rules (global, but entered in
      // Customize -> Rules in the app, NOT a file on disk), Team Rules
      // (dashboard, paid plans), and AGENTS.md (project-root markdown).
      //
      // Every global surface is either the app UI or a paid dashboard, so there
      // is genuinely NO user-level file to write — `file: null` is correct and
      // is a vendor fact rather than an admission of ignorance. What we CAN
      // write is a project rule, and `installRules` emits the required
      // frontmatter for any target ending in `.mdc` (see MDC_FRONTMATTER):
      // `alwaysApply: true` is what makes it unconditional, and a plain `.md`
      // in that directory is ignored outright.
      unsupported:
        "Cursor has no user-level rules FILE — its global User Rules are entered in the app under Customize -> Rules, not stored on disk (cursor.com/docs/rules). " +
        "Two ways to wire it, both verified:\n" +
        `      per project (automatic):  ${BIN} install-rules --file .cursor/rules/fimemory.mdc   (run from the project root; the required alwaysApply frontmatter is written for you)\n` +
        `      globally (one paste):     ${BIN} install-rules --print   then paste it into Cursor -> Customize -> Rules\n` +
        "    Cursor also reads a project-root AGENTS.md, so `--file AGENTS.md` works if you would rather keep one file for every tool.",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      file: null,
      detectDir: null,
      requireFile: false,
      format: "none",
      supportsHook: false,
      // PARTLY RESOLVED 2026-08-01. The settings.json route is closed by the
      // vendor: anthropics/claude-code#63360 asked for Claude Code hooks in
      // Cowork and was CLOSED AS NOT PLANNED, with the reporter verifying
      // across two fresh chats that UserPromptSubmit never fired — root cause
      // being that Cowork runs in a Linux sandbox VM while the hooks live on
      // the host. One route is still genuinely unread: Claude Desktop installs
      // plugins, and a plugin's `hooks/` directory holds "hook definitions that
      // run on agent lifecycle events", but the docs do not enumerate the
      // events. We already ship exactly that plugin, so the experiment is
      // cheap — until someone runs it, it stays UNVERIFIED.
      hookNoteShort:
        "our hook cannot reach Claude Desktop through settings.json: that route is closed by the vendor " +
        "(anthropics/claude-code#63360, not planned). Whether a PLUGIN-delivered hook fires there is UNVERIFIED.",
      hookNote:
        "`install-hooks` writes no Claude Desktop config, and the route it would write is closed. Claude Code hooks in " +
        "~/.claude/settings.json do not fire in Cowork: anthropics/claude-code#63360 is CLOSED AS NOT PLANNED, and the " +
        "reporter verified across two fresh chats that UserPromptSubmit never fired, because Cowork runs in a Linux " +
        "sandbox VM while the hooks live on the host. " +
        "One route remains UNVERIFIED rather than closed: Claude Desktop installs plugins, and a plugin's `hooks/` " +
        "directory is documented as holding hook definitions that run on agent lifecycle events, without the events " +
        "being enumerated. We already ship that plugin, so it is a cheap experiment nobody has run. No claim either way.",
      // Same downgrade as cursor: "instructions are entered in the app, under
      // Projects and Styles" was asserted from memory, not read anywhere.
      unsupported:
        "we write no rules file for Claude Desktop. Whether it has an on-disk rules file at all is UNVERIFIED — " +
        "it is not installed on any machine we have checked. " +
        `The one Claude Desktop file this package knows of is claude_desktop_config.json, which \`${BIN} install-mcp\` writes; ` +
        "if you find the file its instructions live in, `--file <path>` writes the same block there.",
    },
  ];
}

/** Every host id the registry knows, for usage messages. Kept as a literal so
 * naming a host costs no filesystem work at import; a test pins it to
 * `rulesHosts()` so the two cannot drift. */
export const RULES_HOST_IDS: RulesHostId[] = [
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "windsurf",
  "cursor",
  "claude-desktop",
];

/**
 * The subset that can actually be WRITTEN (`file !== null`).
 *
 * "Name a host" suggestions must come from here, not from `RULES_HOST_IDS`:
 * offering `cursor` right after explaining that Cursor has no rules file tells
 * the user to re-run the command that just refused. Pinned to the registry by
 * the same drift test as `RULES_HOST_IDS`.
 */
export const RULES_WRITABLE_HOST_IDS: RulesHostId[] = [
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "windsurf",
];

/** True when this host looks installed on this machine (see `detectDir`). */
export function rulesHostDetected(host: RulesHost): boolean {
  if (host.requireFile) return host.file !== null && existsSync(fsPath(host.file));
  return host.detectDir !== null && existsSync(fsPath(host.detectDir));
}

/** The hosts `install-rules` writes to when given no names: detected, writable. */
export function detectRulesHosts(hosts: RulesHost[] = rulesHosts()): RulesHost[] {
  return hosts.filter((h) => h.file !== null && rulesHostDetected(h));
}

function nonEmptyFile(file: string): boolean {
  try {
    return statSync(fsPath(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Per-host truths worth saying out loud AFTER a successful write — each one is
 * a way a correctly written block still never reaches the model.
 */
function hostNotes(host: RulesHost): string[] {
  const notes: string[] = [];
  const dir = host.detectDir;
  if (host.id === "codex" && dir && nonEmptyFile(path.join(dir, "AGENTS.override.md"))) {
    notes.push(
      `${path.join(dir, "AGENTS.override.md")} exists and is not empty — Codex reads the override INSTEAD of AGENTS.md, ` +
        "so the block written here will not load until you move that file or copy the block into it.",
    );
  }
  if (host.id === "windsurf") {
    // The one shipped path with no source we can check (see the registry's
    // provenance block). A wrong path here still reports `installed` and prints
    // "takes effect in the NEXT session", so the user would have a success line
    // for a file nothing reads and no way to notice. Say it instead.
    notes.push(
      "Windsurf's global-rules path is vendor-documented but unverified by us — if Windsurf keeps ignoring the store, " +
        "check Settings → Memories for the real file location and re-run with `--file <path>`.",
    );
  }
  if (host.id === "gemini" && dir) {
    const rejected = geminiContextFile(dir).rejected;
    if (rejected) notes.push(rejected);
  }
  if (host.id === "grok" && dir && existsSync(fsPath(path.join(dir, "GROK.md")))) {
    notes.push(
      `${path.join(dir, "GROK.md")} exists, but Grok CLI never reads that filename (it scans AGENTS.md / CLAUDE.md and friends) — ` +
        "the block went to AGENTS.md; GROK.md can be deleted.",
    );
  }
  if (host.file && host.maxChars) {
    let size: number;
    try {
      size = readFileSync(fsPath(host.file), "utf8").length;
    } catch {
      size = 0; // unreadable right after a successful write — nothing to warn about
    }
    if (size > host.maxChars) {
      notes.push(
        `${host.label} caps this file at ${host.maxChars.toLocaleString()} characters and it is now ${size.toLocaleString()} — ` +
          "trim your own rules or the block may be cut off.",
      );
    }
  }
  return notes;
}

/** True if `text` contains an installed rule block (current or legacy markers) —
 * the WRITTEN check doctor's marker scan uses. */
export function rulesBlockWritten(text: string): boolean {
  return text.includes(RULES_MARKER_BEGIN) || LEGACY_BEGIN.test(text);
}

/**
 * WHICH BODY a file carries — `null` when it carries no block at all, `unknown`
 * when a block is present but is neither shipped body (hand-edited, or written
 * by an older version).
 *
 * doctor used to scan only for the MARKER, which cannot tell a correct install
 * from the one that actually shipped: the §2.5b shim body in a file a non-hook
 * host also reads is strictly worse than installing nothing, and a marker scan
 * reports it Healthy. Detection is by a sentence unique to each body rather
 * than a byte comparison, so a block with a trailing-whitespace difference is
 * still classified instead of silently becoming `unknown`.
 */
export function rulesBlockBody(text: string): RulesMode | "unknown" | null {
  if (!rulesBlockWritten(text)) return null;
  if (text.includes("**Relevant store context may already be present in this turn**")) return "shim";
  if (text.includes("call `fimemory_search` first")) return "rules";
  // A block written before the 2026-08-06 tool-id rename. Classified, not
  // ignored: the alternative is `unknown`, and a stale block is a SPECIFIC,
  // actionable state rather than an unrecognisable one. See namesLegacyTools.
  if (text.includes("call `gestalt_search` first")) return "rules";
  return "unknown";
}

/**
 * True when an installed rules block still names the pre-rename `gestalt_*`
 * tool ids.
 *
 * This is the one genuinely dangerous moment in the tool-id rename, and it is
 * invisible without a check. Upgrading the package changes the tools the MCP
 * server EXPOSES, but it does not touch a rules file already on disk. Until
 * `install-rules` runs again, that file instructs the model to call
 * `gestalt_search` — a tool that no longer exists. The model does not fall back
 * to searching some other way; it is told to call a specific tool, the call
 * fails, and the store goes quiet. Nothing errors loudly, so the failure looks
 * like "memory just stopped being useful", which is the hardest kind to
 * diagnose and exactly what `doctor` exists to name.
 */
export function namesLegacyTools(text: string): boolean {
  return text.includes("gestalt_search") || text.includes("gestalt_get") || text.includes("gestalt_log");
}

interface BlockSpan {
  start: number;
  /** Exclusive end — one past the end marker. */
  end: number;
}

/** Locate our block (current markers first, then legacy). Throws E_SCHEMA on a
 * begin marker without its end marker — guessing where a damaged block ends
 * risks eating the user's own text, the one thing this op must never do. */
function findBlock(text: string, file: string): BlockSpan | null {
  const damaged = (which: string): GestaltError =>
    new GestaltError(
      "E_SCHEMA",
      `${file} has a ${which} begin marker but no matching end marker.`,
      "The block is damaged — fix or remove the markers by hand, then re-run.",
    );
  const begin = text.indexOf(RULES_MARKER_BEGIN);
  if (begin !== -1) {
    const end = text.indexOf(RULES_MARKER_END, begin);
    if (end === -1) throw damaged("fimemory:rules");
    return { start: begin, end: end + RULES_MARKER_END.length };
  }
  const legacyBegin = LEGACY_BEGIN.exec(text);
  if (legacyBegin) {
    LEGACY_END.lastIndex = 0;
    const legacyEnd = LEGACY_END.exec(text.slice(legacyBegin.index));
    if (!legacyEnd) throw damaged("legacy (memory-runtime/squirl)");
    return {
      start: legacyBegin.index,
      end: legacyBegin.index + legacyEnd.index + legacyEnd[0].length,
    };
  }
  return null;
}

export interface InstallRulesOptions {
  /** Target rules file. Default: `~/.claude/CLAUDE.md`. */
  file?: string;
  /**
   * Product mode (guide §0.2c). `rules` = §2.5 search-first (Arm A / F0).
   * `shim` = §2.5b prefer-injected-context (install with the retrieval hook).
   */
  mode?: RulesMode;
}

export interface InstallRulesResult {
  path: string;
  /** `installed` = block appended to a file that had none (file created if
   * absent); `replaced` = an existing block (ours or legacy) swapped in place;
   * `unchanged` = the block on disk is already byte-identical and NOTHING was
   * written (the file's mtime is not even touched). */
  action: "installed" | "replaced" | "unchanged";
  /** Which body was written. */
  mode: RulesMode;
  /** The written-vs-loaded caveat callers must surface: a written block is only
   * loaded next session. */
  caveat: string;
}

const WRITTEN_NOT_LOADED =
  "Written, not yet loaded — the host reads its rules file at session start, so this block takes effect in the NEXT session.";

/**
 * Cursor's project rules are `.mdc` files with YAML frontmatter, and the
 * frontmatter is what decides whether the rule is ever applied — a rule whose
 * `alwaysApply` is false is only pulled in when the model asks for it by
 * description, which is exactly the "has the tools, never opens them" failure
 * this block exists to prevent. So a `.mdc` we CREATE gets the frontmatter that
 * makes it unconditional.
 *
 * Cited, not remembered (the rule after 2026-07-31): cursor.com/docs/rules —
 * "Each project rule is an `.mdc` file with frontmatter specifying
 * `description`, `globs`, and `alwaysApply`. Plain `.md` files in
 * `.cursor/rules` are ignored by the rules system."
 *
 * Keyed off the EXTENSION rather than a host id because `installRules` is given
 * a path, not a host, and because the extension is precisely what Cursor itself
 * keys off. Frontmatter must be the first bytes in the file, so it is written
 * ahead of the marker block; on every later install it sits OUTSIDE the markers
 * and the replace path preserves it byte-for-byte like any other user text.
 */
const MDC_FRONTMATTER = `---
description: "Check the shared memory store before answering"
alwaysApply: true
---
`;

/**
 * Resolve the path we actually WRITE to.
 *
 * `writeFileAtomicPlain` is temp-file + rename, and a rename replaces the
 * DIRECTORY ENTRY — so writing straight to a symlink deletes the link and
 * leaves a regular file in its place, silently. Symlinking ~/.claude/CLAUDE.md
 * or ~/.codex/AGENTS.md into a dotfiles repo is a normal setup for exactly the
 * multi-tool users this feature targets, and the sweep would break up to five
 * of them in one unprompted command. Resolving first makes the bytes land on
 * the link's TARGET, so the link survives.
 *
 * A path that does not exist yet (or cannot be resolved) is returned as given —
 * there is no link to preserve.
 */
function writeTargetOf(file: string): string {
  try {
    return realpathSync(fsPath(file));
  } catch {
    return file;
  }
}

/**
 * Read a rules file WITHOUT lossy transcoding.
 *
 * The whole decoded string is written back on every install/uninstall, so a
 * `readFileSync(f, "utf8")` round trip permanently rewrites content OUTSIDE our
 * markers on any file that is not valid UTF-8: a cp1252 byte (what PowerShell
 * 5.1 `Set-Content` writes) comes back as U+FFFD, and a UTF-16LE file (what
 * PowerShell 5.1 `>` / `Out-File` produce) is mangled beyond recovery. These
 * are other tools' files and we take no backup, so a non-UTF-8 file is refused
 * and left exactly as found.
 */
function readRulesFile(file: string): string {
  const raw = readFileSync(fsPath(file));
  const refuse = (why: string): GestaltError =>
    new GestaltError(
      "E_SCHEMA",
      `${file} is not UTF-8 (${why}), and rewriting it would corrupt the text outside the rule block.`,
      "Re-save the file as UTF-8 (PowerShell: `Set-Content -Encoding utf8`), then re-run.",
    );
  if (raw.length >= 2) {
    const b0 = raw[0]!;
    const b1 = raw[1]!;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      throw refuse("it starts with a UTF-16 byte-order mark");
    }
  }
  // BOM-less UTF-16 survives a UTF-8 round trip byte-for-byte when the text is
  // ASCII (the padding NULs are themselves valid UTF-8), so the equality check
  // below would let it through and we would append a UTF-8 block the host reads
  // as garbage. A text rules file never contains a NUL.
  if (raw.includes(0)) throw refuse("it contains NUL bytes, so it is not a UTF-8 text file");
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    throw refuse("it contains bytes that are not valid UTF-8");
  }
  return text;
}

/** Install (or idempotently replace) the rule block. Touches nothing outside
 * the markers; a reinstall over an identical block writes nothing at all. */
export async function installRules(
  opts: InstallRulesOptions = {},
): Promise<InstallRulesResult> {
  const named = path.resolve(opts.file ?? defaultRulesPath());
  const mode: RulesMode = opts.mode === "shim" ? "shim" : "rules";
  const file = writeTargetOf(named);
  const existing = existsSync(fsPath(file)) ? readRulesFile(file) : null;
  const block = rulesBlock(mode);

  if (existing === null) {
    mkdirSync(path.dirname(fsPath(file)), { recursive: true });
    const preamble = file.toLowerCase().endsWith(".mdc") ? MDC_FRONTMATTER + "\n" : "";
    await writeFileAtomicPlain(file, preamble + block + "\n");
    return { path: file, action: "installed", mode, caveat: WRITTEN_NOT_LOADED };
  }

  const span = findBlock(existing, file);
  let updated: string;
  let action: InstallRulesResult["action"];
  if (span) {
    updated = existing.slice(0, span.start) + block + existing.slice(span.end);
    action = "replaced";
  } else {
    // Append-only: the user's own text is preserved byte-for-byte; we add at
    // most a blank-line separator before our block.
    const sep = existing === "" || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
    updated = existing + sep + block + "\n";
    action = "installed";
  }
  // Already current: say so and do not write. "Written now" and "already up to
  // date" are different answers to the question the user is asking (did my
  // shim block survive? did this run change anything?), and a no-op rewrite
  // churns every host file's mtime on every run.
  if (updated === existing) {
    return { path: file, action: "unchanged", mode, caveat: WRITTEN_NOT_LOADED };
  }
  await writeFileAtomicPlain(file, updated);
  return { path: file, action, mode, caveat: WRITTEN_NOT_LOADED };
}

export interface UninstallRulesResult {
  path: string;
  /** `removed` = a block (ours or legacy) was deleted; `absent` = no block, no
   * file change (and a missing file is never created). */
  action: "removed" | "absent";
}

/** Remove the rule block cleanly. Only the marker span (plus the seam's excess
 * blank lines) is touched — the user's own text survives byte-for-byte. */
export async function uninstallRules(
  opts: InstallRulesOptions = {},
): Promise<UninstallRulesResult> {
  const named = path.resolve(opts.file ?? defaultRulesPath());
  if (!existsSync(fsPath(named))) return { path: named, action: "absent" };
  const file = writeTargetOf(named);
  const existing = readRulesFile(file);
  const span = findBlock(existing, file);
  if (!span) return { path: file, action: "absent" };

  const before = existing.slice(0, span.start);
  const after = existing.slice(span.end);
  // Collapse only the whitespace seam the removal leaves behind: the install
  // separator (blank line before) and the block's trailing newline. Non-blank
  // text on either side is untouched.
  let joined: string;
  if (before.trim() === "" && after.trim() === "") {
    joined = "";
  } else if (before.trim() === "") {
    joined = after.replace(/^\n+/, "");
  } else if (after.trim() === "") {
    joined = before.replace(/\n+$/, "\n");
  } else {
    // Text on BOTH sides: the block sits between two paragraphs, which is what
    // a hand-placed block looks like. The seam is the newline run on each side;
    // the block consumed one of them, so keep the WIDER of the two and drop the
    // rest. That collapses the blank line install added without SYNTHESIZING one
    // the user never had — the old `\n+$ → "\n\n"` turned `A\n<block>\nB` into
    // `A\n\nB`, contradicting the "text outside the markers was not touched"
    // line the CLI prints for this very command.
    const nb = /\n*$/.exec(before)![0].length;
    const na = /^\n*/.exec(after)![0].length;
    joined =
      before.slice(0, before.length - nb) +
      "\n".repeat(Math.max(nb, na)) +
      after.slice(na);
  }
  await writeFileAtomicPlain(file, joined);
  return { path: file, action: "removed" };
}

/* ────────────────────── multi-host install / uninstall ───────────────────
 *
 * Every host goes through the SAME single-file writer above, so the safety
 * contract is identical on all of them: marker-delimited, insert-never-clobber,
 * legacy markers upgraded in place, idempotent, and text outside the markers
 * untouched. This layer only decides WHICH files, and reports per host.
 */

/** What happened for one host. `failed` = that host's file was left alone
 * because it is damaged (begin marker without end); other hosts still ran. */
export type RulesHostAction =
  | "installed"
  | "replaced"
  | "unchanged"
  | "removed"
  | "absent"
  | "skipped"
  | "failed";

export interface RulesHostOutcome {
  /** Registry id, or `custom` for a `--file` target. */
  host: string;
  label: string;
  /** The file acted on — null when there was nothing to act on. */
  path: string | null;
  action: RulesHostAction;
  /** Which body this host actually got. Per host, not product-wide: a host with
   * no retrieval hook is downgraded from `shim` to `rules` (see below), so one
   * global `(mode=…)` claim would be false for it. Absent on uninstall. */
  mode?: RulesMode;
  /** Why it was skipped, or why it failed. */
  reason?: string;
  /** Host truths that decide whether a WRITTEN block is ever READ. */
  notes: string[];
}

export interface InstallRulesAllOptions extends RulesRegistryOptions {
  /** Host ids to target. Omitted = every DETECTED host. Named hosts are
   * written even when undetected: naming one is the explicit ask. */
  hosts?: string[];
  /** Escape hatch, unchanged: one exact file, registry bypassed entirely. */
  file?: string;
  mode?: RulesMode;
  /** Injectable registry (tests). Default `rulesHosts(opts)`. */
  registry?: RulesHost[];
}

export interface InstallRulesAllResult {
  mode: RulesMode;
  results: RulesHostOutcome[];
  /** Written ≠ loaded — same caveat as the single-host result. */
  caveat: string;
}

export interface UninstallRulesAllResult {
  results: RulesHostOutcome[];
}

const CUSTOM_LABEL = "custom file";

/** Resolve requested ids against the registry, preserving registry order for
 * the default run and caller order for an explicit one. */
function selectHosts(
  registry: RulesHost[],
  requested: string[] | undefined,
  fallback: (h: RulesHost) => boolean,
): { targets: Array<{ host: RulesHost; explicit: boolean }>; unknown: RulesHostOutcome[] } {
  if (!requested || requested.length === 0) {
    return { targets: registry.filter(fallback).map((host) => ({ host, explicit: false })), unknown: [] };
  }
  const byId = new Map(registry.map((h) => [h.id as string, h]));
  const targets: Array<{ host: RulesHost; explicit: boolean }> = [];
  const unknown: RulesHostOutcome[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim().toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const host = byId.get(id);
    if (!host) {
      unknown.push({
        host: id,
        label: id,
        path: null,
        action: "skipped",
        reason: `unknown host — known: ${RULES_HOST_IDS.join(", ")} (or use --file for anything else)`,
        notes: [],
      });
      continue;
    }
    targets.push({ host, explicit: true });
  }
  return { targets, unknown };
}

/**
 * Install the rule block into every DETECTED host (or the named ones).
 *
 * Detection is the host's DIRECTORY, not its rules file: an installed Gemini
 * with no GEMINI.md gets one created; a machine with no ~/.grok is left alone.
 */
export async function installRulesAll(
  opts: InstallRulesAllOptions = {},
): Promise<InstallRulesAllResult> {
  const mode: RulesMode = opts.mode === "shim" ? "shim" : "rules";

  if (opts.file !== undefined) {
    const r = await installRules({ file: opts.file, mode });
    return {
      mode,
      caveat: r.caveat,
      results: [
        { host: "custom", label: CUSTOM_LABEL, path: r.path, action: r.action, mode: r.mode, notes: [] },
      ],
    };
  }

  const registry = opts.registry ?? rulesHosts(opts);
  // Default sweep considers every host that HAS a global rules file; the
  // detection check below turns the uninstalled ones into reported skips
  // rather than silence, so the run says what it did about each host.
  //
  // …and every host that is INSTALLED HERE but has no global rules file, which
  // until 2026-08-01 was the one case that stayed silent. Found by walking the
  // tester path on a scratch home: Cursor took the MCP server, then never
  // appeared in the rules step at all, so a Cursor user finished `setup`
  // believing they were done and quietly got the weaker product (tools present,
  // nothing telling the model to open them). The host carries the two routes
  // that DO work in `unsupported`; the filter was hiding it.
  //
  // Detection is what keeps this from becoming noise: a machine with no
  // ~/.cursor still hears nothing about Cursor. Claude Desktop has a null
  // detectDir, so it is never detected and stays silent unless named — which is
  // correct, because we genuinely do not know where its instructions live.
  const { targets, unknown } = selectHosts(
    registry,
    opts.hosts,
    (h) => h.file !== null || rulesHostDetected(h),
  );
  const results: RulesHostOutcome[] = [...unknown];

  for (const { host, explicit } of targets) {
    const base = { host: host.id as string, label: host.label, notes: [] as string[] };
    if (host.file === null) {
      results.push({ ...base, path: null, action: "skipped", reason: host.unsupported ?? "no rules file on this host." });
      continue;
    }
    if (!explicit && !rulesHostDetected(host)) {
      results.push({
        ...base,
        path: host.file,
        action: "skipped",
        reason: `not detected — ${host.detectDir ?? "its config directory"} not found.`,
      });
      continue;
    }
    const notes: string[] = [];
    if (explicit && host.detectDir && !existsSync(fsPath(host.detectDir))) {
      notes.push(`${host.detectDir} did not exist — created it because you named this host.`);
    }
    // Per-host mode. The §2.5b shim body says "context may already be present,
    // injected by the host retrieval hook — do not re-search by default". That
    // is only TRUE where our hook actually RUNS. Sending it anywhere else would
    // suppress the `fimemory_search` call this feature exists to cause, for an
    // injection that is never coming — and report it green.
    //
    // The REASON is per host and comes from `hookNote`, never from a blanket
    // "hooks are Claude Code's only": that sentence was checked on 2026-07-31
    // against Grok's own shipped docs and is FALSE (Grok scans
    // ~/.claude/settings.json by default and had our handlers loaded). The
    // right claim is narrow and about us — our hook does not run there — with
    // the evidence, or the word UNVERIFIED, attached.
    //
    // And the question is about the FILE, not the host: `alsoReadBy` records
    // which other hosts load this same file. Grok CLI reads
    // ~/.claude/CLAUDE.md, so on a Claude Code + Grok box the shim body written
    // "for Claude Code" was reaching Grok too, telling it not to search for an
    // injection that never arrives there — and writing the search-first block
    // to ~/.grok/AGENTS.md does not undo it, because Grok loads both.
    const sharers = (host.alsoReadBy ?? [])
      .map((id) => registry.find((h) => h.id === id))
      .filter((h): h is RulesHost => h !== undefined && !h.supportsHook && rulesHostDetected(h));
    const hostMode: RulesMode =
      mode === "shim" && (!host.supportsHook || sharers.length > 0) ? "rules" : mode;
    if (hostMode !== mode) {
      // Stated as INTENT, not as an action. This array is also attached to the
      // `failed` outcome below, where nothing was written at all — a note that
      // says "wrote the search-first block" directly under "FAILED — EISDIR"
      // makes the reader open the file to find out which sentence is true.
      if (!host.supportsHook) {
        notes.push(
          `search-first block applies here, not the shim block — ${host.hookNoteShort}`,
        );
      }
      for (const s of sharers) {
        notes.push(
          `search-first block applies to this FILE because ${s.label} also reads it, and ${s.hookNoteShort}`,
        );
      }
    }
    try {
      const r = await installRules({ file: host.file, mode: hostMode });
      results.push({
        ...base,
        path: r.path,
        action: r.action,
        mode: r.mode,
        notes: [...notes, ...hostNotes(host)],
      });
    } catch (err) {
      // EVERY failure is this host's failure, never the sweep's. A rethrow here
      // discarded the results already collected (registry order means Claude
      // Code had usually been written), escaped `main`, and printed a raw Node
      // stack — "some written, some not, reported as neither". Real non-
      // GestaltError triggers: EACCES/EISDIR/ENOTDIR on read, EPERM on open.
      results.push({
        ...base,
        path: host.file,
        action: "failed",
        reason:
          err instanceof GestaltError
            ? `${err.message} ${err.hint}`
            : err instanceof Error
              ? err.message
              : String(err),
        notes,
      });
      continue;
    }
  }
  return { mode, results, caveat: WRITTEN_NOT_LOADED };
}

/**
 * Remove the block from every host that has one (or the named ones). An exit
 * that only works on one host is not an exit — so the default sweep ignores
 * detection entirely and visits every host's rules file: a file left behind by
 * a host that has since been uninstalled still gets cleaned, and a file that
 * was never there is reported `absent` and never created.
 */
export async function uninstallRulesAll(
  opts: InstallRulesAllOptions = {},
): Promise<UninstallRulesAllResult> {
  if (opts.file !== undefined) {
    const r = await uninstallRules({ file: opts.file });
    return { results: [{ host: "custom", label: CUSTOM_LABEL, path: r.path, action: r.action, notes: [] }] };
  }

  const registry = opts.registry ?? rulesHosts(opts);
  const { targets, unknown } = selectHosts(registry, opts.hosts, (h) => h.file !== null);
  const results: RulesHostOutcome[] = [...unknown];

  for (const { host } of targets) {
    const base = { host: host.id as string, label: host.label, notes: [] as string[] };
    if (host.file === null) {
      results.push({ ...base, path: null, action: "skipped", reason: host.unsupported ?? "no rules file on this host." });
      continue;
    }
    try {
      const r = await uninstallRules({ file: host.file });
      results.push({ ...base, path: r.path, action: r.action });
    } catch (err) {
      // Same contract as installRulesAll: one host's unreadable/undeletable
      // file must not abort the sweep or discard the hosts already cleaned.
      results.push({
        ...base,
        path: host.file,
        action: "failed",
        reason:
          err instanceof GestaltError
            ? `${err.message} ${err.hint}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
      continue;
    }
  }
  return { results };
}
