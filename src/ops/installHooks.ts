import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GestaltError } from "../errors.js";
import { fsPath } from "../paths.js";
import { writeFileAtomicPlain } from "../store/atomic.js";
import { assignsDottedKey, defaultHostConfigFiles, readTomlForEdit } from "./installMcp.js";
import type { TomlEditView, TomlSection } from "./installMcp.js";

/**
 * Claude Code hooks installer for the L1 retrieval shim (F-struct).
 *
 * Merges SessionStart + UserPromptSubmit handlers into
 * `~/.claude/settings.json` without clobbering unrelated hooks. Each handler
 * is tagged with `--shim-id fimemory-v1` so uninstall/doctor can recognize
 * our entries and leave everything else alone.
 *
 * Optional session-end capture (`--capture`): SessionEnd (and Stop fallback)
 * → `hook-capture` — opt-in only, never default in v1 (SESSION-CAPTURE-SPEC).
 *
 * Protocol (pinned Claude Code ≥2.1.x, docs 2026):
 *   - stdin: JSON including `prompt` / `session_id` / `hook_event_name`
 *   - stdout: JSON `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 *     OR empty (no inject)
 *   - exit 0 always from our handler (fail-open); never exit 2
 *   - host timeout set to 1s as a backstop; our process self-caps at 300ms
 *     (retrieve) / 500ms (capture)
 */

export const SHIM_ID = "fimemory-v1";
export const SHIM_MARKER_ARG = "--shim-id";
export const CAPTURE_BUDGET_MS_HOOK = 500;

export interface InstallHooksOptions {
  /** Store home the hook will read. */
  home: string;
  /** Claude settings.json path. Default: ~/.claude/settings.json */
  settingsPath?: string;
  /**
   * Absolute path to the runtime CLI entry (dist/cli.js or src/cli.ts via tsx).
   * Default: this package's dist/cli.js resolved from import.meta.
   */
  cliPath?: string;
  /** Node executable. Default: process.execPath */
  nodePath?: string;
  /** Internal hook budget ms (passed through). Default 300. */
  budgetMs?: number;
  /**
   * Opt-in session-end capture (SESSION-CAPTURE-SPEC v1). Installs SessionEnd
   * + Stop handlers for `hook-capture`. Never on by default.
   */
  capture?: boolean;
}

export type ShimHookEvent = "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop";

export interface InstallHooksResult {
  path: string;
  action: "installed" | "replaced" | "unchanged";
  events: ShimHookEvent[];
  command: string;
  args: string[];
  capture: boolean;
}

export interface UninstallHooksResult {
  path: string;
  action: "removed" | "absent";
  removed: number;
}

export interface ShimHookCheck {
  settingsPath: string;
  settingsPresent: boolean;
  /** At least one of our hook handlers is present. */
  written: boolean;
  /** True when written AND the command executable + cliPath resolve on disk. */
  resolvable: boolean;
  /** UserPromptSubmit handler present. */
  userPromptSubmit: boolean;
  /** SessionStart handler present. */
  sessionStart: boolean;
  /** SessionEnd or Stop capture handler present. */
  capture: boolean;
  /** Resolved command from the first matching handler, if any. */
  command?: string;
  args?: string[];
  note: string;
}

interface HookHandler {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
  [k: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [k: string]: unknown;
}

type HooksMap = Record<string, MatcherGroup[]>;

function defaultSettingsPath(): string {
  return path.join(homedir(), ".claude", "settings.json");
}

/** Resolve the built CLI entry next to this package's dist/. */
export function defaultCliPath(): string {
  // ops/installHooks.js → dist/ops → dist/cli.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "cli.js");
}

export function isShimHandler(h: HookHandler): boolean {
  if (!Array.isArray(h.args)) return false;
  const i = h.args.indexOf(SHIM_MARKER_ARG);
  return i !== -1 && h.args[i + 1] === SHIM_ID;
}

function buildHandler(opts: {
  nodePath: string;
  cliPath: string;
  home: string;
  budgetMs: number;
  sessionStart: boolean;
}): HookHandler {
  const args = [
    opts.cliPath,
    "hook-retrieve",
    SHIM_MARKER_ARG,
    SHIM_ID,
    "--home",
    opts.home,
    "--budget-ms",
    String(opts.budgetMs),
  ];
  if (opts.sessionStart) args.push("--session-start");
  return {
    type: "command",
    command: opts.nodePath,
    args,
    // Host-side backstop (seconds). Our process self-caps at budgetMs.
    timeout: 1,
    statusMessage: "Loading memory…",
  };
}

function buildCaptureHandler(opts: {
  nodePath: string;
  cliPath: string;
  home: string;
  budgetMs: number;
}): HookHandler {
  return {
    type: "command",
    command: opts.nodePath,
    args: [
      opts.cliPath,
      "hook-capture",
      SHIM_MARKER_ARG,
      SHIM_ID,
      "--home",
      opts.home,
      "--budget-ms",
      String(opts.budgetMs),
    ],
    // Host backstop 1s; process self-caps at 500ms.
    timeout: 1,
    statusMessage: "Capturing session…",
  };
}

function isCaptureHandler(h: HookHandler): boolean {
  return isShimHandler(h) && Array.isArray(h.args) && h.args.includes("hook-capture");
}

function stripShimHandlers(groups: MatcherGroup[] | undefined): MatcherGroup[] {
  if (!groups) return [];
  const out: MatcherGroup[] = [];
  for (const g of groups) {
    const hooks = (g.hooks ?? []).filter((h) => !isShimHandler(h));
    if (hooks.length === 0 && (g.hooks?.length ?? 0) > 0 && Object.keys(g).every((k) => k === "hooks" || k === "matcher")) {
      // Group existed only for our handlers — drop the whole group.
      continue;
    }
    if (hooks.length !== (g.hooks?.length ?? 0)) {
      out.push({ ...g, hooks });
    } else {
      out.push(g);
    }
  }
  return out;
}

function upsertShimGroup(
  groups: MatcherGroup[] | undefined,
  handler: HookHandler,
): { groups: MatcherGroup[]; action: "installed" | "replaced" | "unchanged" } {
  // Detect prior shim handlers BEFORE stripping so reinstall can be unchanged.
  const prior = (groups ?? []).flatMap((g) => (g.hooks ?? []).filter(isShimHandler));
  const alreadyIdentical =
    prior.length === 1 && JSON.stringify(prior[0]) === JSON.stringify(handler);

  const cleaned = stripShimHandlers(groups);
  // Prefer a matcher-less group (UserPromptSubmit has no matcher support).
  const bareIdx = cleaned.findIndex((g) => !g.matcher || g.matcher === "" || g.matcher === "*");
  if (bareIdx === -1) {
    return {
      groups: [...cleaned, { hooks: [handler] }],
      action: alreadyIdentical ? "unchanged" : prior.length > 0 ? "replaced" : "installed",
    };
  }
  const g = cleaned[bareIdx]!;
  const hooks = [...(g.hooks ?? []), handler];
  const next = cleaned.slice();
  next[bareIdx] = { ...g, hooks };
  if (alreadyIdentical) {
    // Restore original groups byte-stable when nothing changed.
    return { groups: groups ?? next, action: "unchanged" };
  }
  return {
    groups: next,
    action: prior.length > 0 ? "replaced" : "installed",
  };
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(fsPath(file))) return {};
  try {
    const raw = readFileSync(fsPath(file), "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new GestaltError(
        "E_SCHEMA",
        `${file} is not a JSON object.`,
        "Fix or remove the file, then re-run install-hooks.",
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof GestaltError) throw err;
    throw new GestaltError(
      "E_SCHEMA",
      `${file} is not valid JSON.`,
      "Fix or remove the file, then re-run install-hooks.",
    );
  }
}

/** Install (or replace) the fimemory shim hooks into Claude Code settings. */
export async function installHooks(
  opts: InstallHooksOptions,
): Promise<InstallHooksResult> {
  const settingsPath = path.resolve(opts.settingsPath ?? defaultSettingsPath());
  const cliPath = path.resolve(opts.cliPath ?? defaultCliPath());
  const nodePath = opts.nodePath ?? process.execPath;
  const budgetMs = opts.budgetMs ?? 300;
  const home = path.resolve(opts.home);
  const capture = Boolean(opts.capture);

  const doc = readSettings(settingsPath);
  const hooks = (typeof doc["hooks"] === "object" && doc["hooks"] !== null
    ? { ...(doc["hooks"] as HooksMap) }
    : {}) as HooksMap;

  const upsHandler = buildHandler({ nodePath, cliPath, home, budgetMs, sessionStart: false });
  const ssHandler = buildHandler({ nodePath, cliPath, home, budgetMs, sessionStart: true });

  const ups = upsertShimGroup(hooks["UserPromptSubmit"], upsHandler);
  const ss = upsertShimGroup(hooks["SessionStart"], ssHandler);

  hooks["UserPromptSubmit"] = ups.groups;
  hooks["SessionStart"] = ss.groups;

  const events: ShimHookEvent[] = ["UserPromptSubmit", "SessionStart"];
  let capAction: InstallHooksResult["action"] = "unchanged";

  if (capture) {
    const capHandler = buildCaptureHandler({
      nodePath,
      cliPath,
      home,
      budgetMs: CAPTURE_BUDGET_MS_HOOK,
    });
    // SessionEnd primary; Stop as fallback host event.
    const se = upsertShimGroup(hooks["SessionEnd"], capHandler);
    const st = upsertShimGroup(hooks["Stop"], capHandler);
    hooks["SessionEnd"] = se.groups;
    hooks["Stop"] = st.groups;
    events.push("SessionEnd", "Stop");
    capAction =
      se.action === "unchanged" && st.action === "unchanged"
        ? "unchanged"
        : se.action === "installed" || st.action === "installed"
          ? "installed"
          : "replaced";
  }

  const action: InstallHooksResult["action"] =
    ups.action === "unchanged" && ss.action === "unchanged" && capAction === "unchanged"
      ? "unchanged"
      : ups.action === "installed" || ss.action === "installed" || capAction === "installed"
        ? "installed"
        : "replaced";

  if (action !== "unchanged") {
    const next = { ...doc, hooks };
    mkdirSync(path.dirname(fsPath(settingsPath)), { recursive: true });
    await writeFileAtomicPlain(settingsPath, JSON.stringify(next, null, 2) + "\n");
  }

  return {
    path: settingsPath,
    action,
    events,
    command: nodePath,
    args: upsHandler.args as string[],
    capture,
  };
}

/** Remove only our shim handlers; leave every other hook intact. */
export async function uninstallHooks(
  opts: { settingsPath?: string } = {},
): Promise<UninstallHooksResult> {
  const settingsPath = path.resolve(opts.settingsPath ?? defaultSettingsPath());
  if (!existsSync(fsPath(settingsPath))) {
    return { path: settingsPath, action: "absent", removed: 0 };
  }
  const doc = readSettings(settingsPath);
  const hooksIn = doc["hooks"];
  if (typeof hooksIn !== "object" || hooksIn === null) {
    return { path: settingsPath, action: "absent", removed: 0 };
  }
  const hooks = { ...(hooksIn as HooksMap) };
  let removed = 0;
  for (const event of ["UserPromptSubmit", "SessionStart", "SessionEnd", "Stop"] as const) {
    const before = JSON.stringify(hooks[event] ?? []);
    const cleaned = stripShimHandlers(hooks[event]);
    // Count removed handlers.
    const beforeCount = (hooks[event] ?? []).reduce(
      (n, g) => n + (g.hooks ?? []).filter(isShimHandler).length,
      0,
    );
    removed += beforeCount;
    if (cleaned.length === 0) delete hooks[event];
    else hooks[event] = cleaned;
    void before;
  }
  if (removed === 0) return { path: settingsPath, action: "absent", removed: 0 };

  const next = { ...doc };
  if (Object.keys(hooks).length === 0) delete next["hooks"];
  else next["hooks"] = hooks;
  await writeFileAtomicPlain(settingsPath, JSON.stringify(next, null, 2) + "\n");
  return { path: settingsPath, action: "removed", removed };
}

/** Read-only doctor check of the shim hooks surface. */
export function checkShimHooks(opts: {
  settingsPath?: string;
  /** When set, also verify handlers point at this home. */
  home?: string;
}): ShimHookCheck {
  const settingsPath = path.resolve(opts.settingsPath ?? defaultSettingsPath());
  if (!existsSync(fsPath(settingsPath))) {
    return {
      settingsPath,
      settingsPresent: false,
      written: false,
      resolvable: false,
      userPromptSubmit: false,
      sessionStart: false,
      capture: false,
      note: "Claude settings.json not found — shim hooks not installed.",
    };
  }
  let doc: Record<string, unknown>;
  try {
    doc = readSettings(settingsPath);
  } catch {
    return {
      settingsPath,
      settingsPresent: true,
      written: false,
      resolvable: false,
      userPromptSubmit: false,
      sessionStart: false,
      capture: false,
      note: "settings.json unreadable or invalid JSON.",
    };
  }
  const hooks = (doc["hooks"] ?? {}) as HooksMap;
  const find = (event: string, pred: (h: HookHandler) => boolean = isShimHandler): HookHandler | undefined => {
    for (const g of hooks[event] ?? []) {
      for (const h of g.hooks ?? []) {
        if (pred(h)) return h;
      }
    }
    return undefined;
  };
  const ups = find("UserPromptSubmit");
  const ss = find("SessionStart");
  const se = find("SessionEnd", isCaptureHandler) ?? find("Stop", isCaptureHandler);
  const written = Boolean(ups || ss || se);
  const sample = ups ?? ss ?? se;
  let resolvable = false;
  if (sample?.command && Array.isArray(sample.args) && sample.args[0]) {
    const cmdOk =
      sample.command === "node" ||
      sample.command === process.execPath ||
      existsSync(sample.command);
    const cliOk = existsSync(sample.args[0]!);
    resolvable = cmdOk && cliOk;
  }
  let note: string;
  if (!written) {
    note = "no fimemory shim handlers in hooks.";
  } else if (!resolvable) {
    note = "shim handlers present but command/cli path does not resolve — orphaned hooks.";
  } else {
    note = se
      ? "shim hooks written and resolvable (retrieve + session-end capture)."
      : "shim hooks written and resolvable (UserPromptSubmit + SessionStart).";
  }
  return {
    settingsPath,
    settingsPresent: true,
    written,
    resolvable,
    userPromptSubmit: Boolean(ups),
    sessionStart: Boolean(ss),
    capture: Boolean(se),
    ...(sample?.command ? { command: sample.command } : {}),
    ...(sample?.args ? { args: sample.args } : {}),
    note,
  };
}

/* ════════════════════ Grok's Claude-compat hook scanning ════════════════════
 *
 * WHAT WE DID, stated first because it is our mess.
 *
 * `installHooks` writes two handlers into ~/.claude/settings.json shaped
 * `{ type, command: <process.execPath>, args: [<cli.js>, "hook-retrieve", …] }`. Grok
 * CLI scans that file for hooks BY DEFAULT — its Hook Locations table lists
 * ~/.claude/settings.json as a global, always-trusted source, and
 * `[compat.claude] hooks = true` is one of the compat cells that "every cell
 * defaults to true" covers. So on a machine with both tools, our install makes
 * Grok load two handlers it will then run on every prompt.
 *
 * Grok's handler schema is `type` / `command` / `timeout` / `url` / `env`
 * (10-hooks.md:194). There is no `args`. It therefore drops the array and
 * spawns the bare interpreter — `process.execPath`, i.e. `node` (`node.exe` on
 * the Windows box this was observed on) — which reads the hook event JSON
 * arriving on stdin as JavaScript and exits with `SyntaxError: Unexpected
 * token ':'`. Grok fails open, so nothing is BLOCKED and Claude Code is
 * unaffected. It is not, however, silent: 10-hooks.md:156 says every hook
 * failure "is recorded for the UI scrollback", so the honest description is one
 * dead process AND one hook-failure line per Grok prompt — which is what
 * installRules.ts already tells the user to expect, and these two surfaces must
 * not say opposite things.
 *
 * AND MAKING IT RUN WOULD BE WORSE, which is why this file offers an opt-out
 * and not a Grok-shaped handler. Grok discards a UserPromptSubmit hook's
 * stdout: four output shapes were tested, each confirmed to have FIRED via a
 * marker file, each returning no injected context, against a positive control
 * that proved the harness could surface injection at all. RESIDUAL CAVEAT,
 * carried verbatim from the measurement at installRules.ts and not quietly
 * dropped on the way here: that was measured in headless `-p` mode; the
 * interactive TUI was NOT measured. So what is established is that grok 0.2.117
 * surfaces no prompt-time injection from this hook in the mode we measured —
 * not that no channel exists anywhere in the product. On that evidence a
 * handler that ran correctly would do the full retrieval — unlock, search,
 * get — and throw the result away. Crashing in 20ms is the cheaper failure.
 *
 * WHY THIS IS A VERB AND NOT A DEFAULT.
 *
 * The documented remedy is `[compat.claude] hooks = false` in
 * ~/.grok/config.toml. That flag is GLOBAL to Grok: one per-vendor switch turns
 * off EVERY Claude hook source Grok reads (10-hooks.md:76) — the global
 * ~/.claude/settings.json and settings.local.json (10-hooks.md:66) AND
 * per-project <project>/.claude/settings.json and settings.local.json
 * (10-hooks.md:69) — not just ours. On a machine whose ~/.claude/settings.json
 * holds only our handlers it costs nothing today — but the day the owner adds a
 * Claude hook he wants Grok to honour, in his home config or in a repo, we
 * would have silently blocked it, in a file we do not own, from a command he
 * ran for an unrelated reason.
 *
 * AND config.toml IS ONLY ONE LAYER. 05-configuration.md:360: "Each cell can be
 * set via environment variable or `config.toml` … Resolution: env var >
 * config.toml > default (on)", and :376 puts requirements.toml above the user's
 * config as well. So writing this line is not the same as knowing the cell
 * resolved to false. When an environment variable for this cell is present the
 * reader below reports `unknown` rather than an all-clear, and points at
 * `grok inspect`, which reports the resolved cells (05-configuration.md:362).
 *
 * This package has a line about that: Cursor is refused rather than written a
 * file that would not load; file permissions are preserved rather than forced;
 * TOML sections are substituted in place rather than reordered. Writing a
 * global behaviour flag into someone's Grok config as a side effect of
 * `install-hooks` would break it. Doing nothing would leave a defect we caused.
 *
 * So the action is EXPLICIT in both directions and silent in neither:
 *   - `install-hooks` and `doctor` DETECT and SAY what Grok will do, as a fact
 *     about Grok with a citation, not as a defect claim;
 *   - `fimemory grok-compat` reports the state and writes nothing;
 *   - `fimemory grok-compat --off` applies the flag, having printed what it
 *     costs, and `--on` is its exact inverse;
 *   - the line we write carries a marker comment saying what it is and that
 *     deleting it restores the default, so the back-out survives this CLI
 *     being uninstalled.
 *
 * The write goes through `readTomlForEdit` — the same hardened reader
 * `install-mcp` uses on this same file — so every sibling section, including
 * the API-key-bearing ones, stays byte-identical and a malformed file is
 * refused rather than rewritten.
 *
 * EVIDENCE, so the next person does not re-derive it. Line numbers are as
 * shipped in grok 0.2.117's docs and were re-read on 2026-08-01:
 *   10-hooks.md:66,69 — Hook Locations: global `~/.claude/settings.json` (and
 *     `settings.local.json`) and project `<project>/.claude/settings.json` (and
 *     `settings.local.json`), "Claude Code compatibility", "configurable".
 *   10-hooks.md:76 — "The compatible vendor hook sources are scanned by
 *     default. To disable scanning for a specific vendor, set
 *     `[compat.<vendor>] hooks = false` … or the corresponding environment
 *     variable."
 *   10-hooks.md:156 — fail-open: "the failure is recorded for the UI scrollback
 *     but the tool call is not blocked".
 *   10-hooks.md:194 — "The handler fields (`type`, `command`, `url`, `timeout`,
 *     `env`)". THIS is the enumeration, not the "Key Fields" list at :150-156,
 *     which names only event/matcher/type/command/timeout. Citing "Key Fields"
 *     for the five-field schema sends the next maintainer to a list that does
 *     not contain the claim.
 *   05-configuration.md:344-350 — `[compat.claude]`, `hooks = true  # scan
 *     ~/.claude/settings.json for hooks`, under "Every cell defaults to `true`".
 *   05-configuration.md:360 — "Resolution: env var > config.toml > default
 *     (on)"; :362 — `grok inspect` reports the resolved cells; :376 —
 *     requirements.toml outranks the user's config.toml.
 *   The env-var NAME for this cell is not in the shipped docs (the
 *     environment-variables reference they point at is not included). It is
 *     INFERRED from the documented siblings `GROK_CLAUDE_MCPS_ENABLED`
 *     (07-mcp-servers.md:224) and `GROK_CLAUDE_SKILLS_ENABLED`
 *     (08-skills.md:35). Treated as a signal to say "unknown", never as a
 *     verified fact.
 *   `grok inspect --json` on the owner's real home lists both of our handlers
 *     as loaded.
 *   Verified against grok 0.2.117 on 2026-07-31 / 2026-08-01.
 */

/** The dotted key we set. Written out here so every message can quote it. */
export const GROK_COMPAT_KEY = "[compat.claude] hooks";

/**
 * Provenance tag: this value was last written by us. `doctor` uses it to keep
 * restating the cost of a global flag WE set, and to stay quiet about one the
 * user set himself.
 *
 * It says nothing about whether the LINE is ours — that is
 * `GROK_COMPAT_ADDED_MARKER`, and the distinction is load-bearing: `--on`
 * DELETES a line we authored and only FLIPS a line the user authored. Stamping
 * one marker onto both is how a reversal ends up deleting a line the user
 * wrote.
 */
export const GROK_COMPAT_MARKER = "# fimemory:";

/** Present only on a line THIS WRITER CREATED. `--on` removes such a line
 * outright; anything else it finds, it flips back and leaves in place. */
const GROK_COMPAT_ADDED_MARKER = `${GROK_COMPAT_MARKER} line added by`;

/** The trailing comment on a `hooks = false` line WE added. It names the
 * reason and the one-line back-out, so the opt-out is reversible by hand even
 * if this CLI is never run again. */
const GROK_COMPAT_COMMENT =
  `  ${GROK_COMPAT_ADDED_MARKER} \`fimemory grok-compat --off\` to stop Grok loading Claude's hooks ` +
  `(it drops their args and spawns a process that dies). ` +
  `Delete this line to restore Grok's default, or run \`fimemory grok-compat --on\`.`;

/**
 * Appended when we change the value on a line the USER wrote.
 *
 * Two things go wrong without it. The file is left saying
 * `hooks = false  # I turned this on deliberately` — a comment flatly
 * contradicting the value it annotates, in a file we do not own. And a global
 * flag WE set becomes invisible to `doctor`, which keys its standing
 * cost-reminder off provenance — so the user's later Claude hook is ignored by
 * Grok and the one tool that could explain it says nothing.
 *
 * `--on` strips exactly this suffix and flips the token back, so applying and
 * undoing still returns the user's line to its original bytes.
 */
const GROK_COMPAT_FLIP_COMMENT =
  `  ${GROK_COMPAT_MARKER} value changed to false by \`fimemory grok-compat --off\` ` +
  `(any comment before this note predates that change); \`--on\` sets it back to true and removes this note.`;

/** The env var that would outrank config.toml for this cell. NOT documented by
 * name — inferred from `GROK_CLAUDE_MCPS_ENABLED` (07-mcp-servers.md:224) and
 * `GROK_CLAUDE_SKILLS_ENABLED` (08-skills.md:35). Used only to downgrade our
 * answer to "unknown", never to assert what Grok resolved. */
export const GROK_COMPAT_ENV_VAR = "GROK_CLAUDE_HOOKS_ENABLED";

/** What Grok does with our handlers, as a fact about Grok, with citations. */
export const GROK_HOOKS_BEHAVIOUR =
  "Grok CLI scans ~/.claude/settings.json for hooks by default, so it loads the two handlers install-hooks writes there. " +
  "Its handler schema is type/command/timeout/url/env — there is no `args` field (10-hooks.md:194) — so it drops our args " +
  "array and spawns the bare interpreter (`node`; `node.exe` on Windows), which reads the hook event JSON on stdin as " +
  "JavaScript and exits on a SyntaxError (`Unexpected token ':'`, observed on Windows). Grok fails open, so nothing is " +
  "blocked and Claude Code is unaffected — but hook failures are NOT invisible: 10-hooks.md:156 says the failure \"is " +
  "recorded for the UI scrollback\", so expect a hook-failure line as well as one dead process on every Grok prompt. " +
  "Making it run would not help: Grok discards a UserPromptSubmit hook's stdout (measured against four output shapes, each " +
  "confirmed to have fired, each yielding no injected context — measured in headless `-p` mode; the interactive TUI was " +
  "NOT measured), so a working handler would do the full retrieval and throw the answer away. Documented in " +
  "~/.grok/docs/user-guide/10-hooks.md (\"Hook Locations\" :66,69 for the scanning, :194 for the handler fields, :156 for " +
  "fail-open) and 05-configuration.md:344-350 ([compat.claude] hooks = true, \"Every cell defaults to true\"). " +
  "Verified on grok 0.2.117, 2026-07-31/08-01.";

/** The price of the remedy. Printed WHERE THE USER DECIDES, every time. */
export const GROK_COMPAT_COST =
  `Setting ${GROK_COMPAT_KEY} = false is GLOBAL to Grok: it stops Grok scanning Claude's hook sources ` +
  "ENTIRELY, not only ours. One per-vendor switch covers all of them (10-hooks.md:76): the global " +
  "~/.claude/settings.json AND ~/.claude/settings.local.json (10-hooks.md:66), and per-project " +
  "<project>/.claude/settings.json and settings.local.json (10-hooks.md:69). Any Claude hook you add later that you WANT " +
  "Grok to honour — in your home config or in a repo — will be silently ignored while this is set. It is also only one " +
  "layer: Grok resolves env var > config.toml > default (05-configuration.md:360), and requirements.toml outranks your " +
  `config.toml too (:376), so a ${GROK_COMPAT_ENV_VAR}-style variable or an org-managed layer can override this line — ` +
  "`grok inspect` reports the cells as actually resolved (05-configuration.md:362). It changes a file this package does " +
  "not own, so it is opt-in, it is one line, and it is reversible.";

/** One line for `install-hooks` to print at the moment it creates the problem. */
export const GROK_COMPAT_OFFER =
  "Run `fimemory grok-compat` to see the state (writes nothing), or `fimemory grok-compat --off` to stop it — " +
  "read the cost first, the flag is global to Grok.";

/** `on` = Grok scans Claude's settings for hooks (its default, and the value we
 * report when the key is simply absent); `off` = the opt-out is in force;
 * `unknown` = the key is there with a value this reader will not guess at. */
export type GrokCompatHooks = "on" | "off" | "unknown";

export interface GrokCompatOptions {
  /** Injectable ~/.grok/config.toml (tests MUST use this — never the real one). */
  configPath?: string;
  /** User home used to derive the default config path (tests). */
  userHome?: string;
  /** Environment consulted for $GROK_HOME (tests). */
  env?: NodeJS.ProcessEnv;
  /** Claude settings.json to check for OUR handlers. Default: the real one. */
  settingsPath?: string;
  /** Skip the settings.json read when the caller already did it (doctor). */
  shimHooksPresent?: boolean;
}

export interface GrokCompatState {
  configPath: string;
  /** Grok's config DIRECTORY exists — the house rule for "installed here". */
  installed: boolean;
  configPresent: boolean;
  hooks: GrokCompatHooks;
  /** How `hooks` was decided, in one clause. */
  reason: string;
  /** The value carries our marker comment, i.e. this CLI set it. */
  ours: boolean;
  /**
   * An environment variable for this cell is set. Grok resolves env var >
   * config.toml (05-configuration.md:360), so whatever the file says, this
   * machine's answer may come from somewhere we cannot edit or verify.
   */
  envOverride: { name: string; value: string } | null;
  /**
   * `grok-compat --off` would REFUSE this config (its shape is one this writer
   * will not edit). Kept on the state so the messages can say so instead of
   * offering a command that exits 1.
   */
  optOutRefused: boolean;
  /** Our shim handlers are in Claude's settings.json today. */
  shimHooksPresent: boolean;
  /**
   * The live waste: Grok is here, it is still scanning Claude's settings, and
   * our handlers are in there for it to load and fail to run.
   */
  dyingProcess: boolean;
  note: string;
}

export interface GrokCompatWriteResult {
  configPath: string;
  /**
   * `set` wrote the opt-out; `restored` took it back out; `unchanged` means the
   * file already said this and was not touched (not even its mtime); `refused`
   * means the file's shape was not understood and nothing was written;
   * `absent` means Grok is not installed here.
   */
  action: "set" | "restored" | "unchanged" | "refused" | "absent";
  hooks: GrokCompatHooks;
  note: string;
  /** How to undo what just happened, verbatim. Present on `set`/`restored`. */
  reverse?: string;
}

/** Grok's config.toml, from the SAME registry `install-mcp` writes and `doctor`
 * reads — including its `$GROK_HOME` handling — so the three cannot drift. */
export function grokConfigPath(opts: GrokCompatOptions = {}): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  const grok = defaultHostConfigFiles({
    ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }).find((h) => h.target === "grok");
  return grok!.file;
}

/** Where the `hooks` key is (or is not) inside `[compat.claude]`, or why we
 * will not touch this file. Shared by the reader and the writer so they cannot
 * disagree about the same bytes. */
type CompatLocation =
  | { kind: "refuse"; why: string }
  | { kind: "no-section" }
  | { kind: "no-key"; section: TomlSection }
  | {
      kind: "key";
      section: TomlSection;
      /** Index into the section block's lines (0 is the header). */
      lineIndex: number;
      indent: string;
      /** `hooks = ` including quoting and spacing, verbatim. */
      lhs: string;
      /** `true` / `false`, or null when the value is not a bare boolean. */
      value: "true" | "false" | null;
      /** Everything after the value, verbatim (comment, trailing \r). */
      rest: string;
    };

// `[^\n]` and not `.`: the section blocks are split on "\n", so on a CRLF file
// every line ends in a bare `\r`, and JS `.` excludes `\r` as a line terminator.
// With `.` this pattern silently failed to match on every CRLF config — i.e. on
// the platform where ~/.grok/config.toml is most likely to have CRLF at all.
const HOOKS_LHS = /^([ \t]*)((?:hooks|"hooks"|'hooks')[ \t]*=[ \t]*)([^\n]*)$/;
const HOOKS_DOTTED = /^[ \t]*(?:hooks|"hooks"|'hooks')[ \t]*\./;

function locateCompatHooks(view: TomlEditView): CompatLocation {
  const preamble = view.text.slice(0, view.preamble);
  // `compat = { … }` / `compat.claude = { … }` / `compat.claude.hooks = true`
  // at top level: TOML will not let a [compat.claude] table extend or redefine
  // any of those, and defining the key twice costs the host the WHOLE file.
  if (assignsDottedKey(preamble, ["compat"])) {
    return {
      kind: "refuse",
      why: "this config assigns `compat` as an inline key at top level, which TOML does not allow a [compat.claude] table to extend.",
    };
  }
  const compatTable = view.sections.find((s) => s.key.length === 1 && s.key[0] === "compat");
  if (compatTable && assignsDottedKey(view.text.slice(compatTable.start, compatTable.end), ["claude"])) {
    return {
      kind: "refuse",
      why: "this config declares `claude` as an inline key under [compat], so adding a [compat.claude] table would define it twice.",
    };
  }
  const ours = view.sections.filter((s) => s.key.length === 2 && s.key[0] === "compat" && s.key[1] === "claude");
  if (ours.some((s) => s.arrayOfTables)) {
    return { kind: "refuse", why: "[[compat.claude]] is an array of tables here, which is not a shape Grok or this writer produces." };
  }
  if (ours.length > 1) {
    return { kind: "refuse", why: "[compat.claude] appears more than once, so which one is authoritative is ambiguous." };
  }
  const section = ours[0];
  if (!section) return { kind: "no-section" };

  const lines = view.text.slice(section.start, section.end).split("\n");
  const hits: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("#")) continue;
    if (HOOKS_DOTTED.test(line)) {
      return { kind: "refuse", why: "`hooks` is a dotted key inside [compat.claude] here, which is not a shape this writer edits." };
    }
    if (HOOKS_LHS.test(line)) hits.push(i);
  }
  if (hits.length > 1) {
    return { kind: "refuse", why: "`hooks` is assigned more than once inside [compat.claude], so which one wins is ambiguous." };
  }
  const at = hits[0];
  if (at === undefined) return { kind: "no-key", section };

  const m = HOOKS_LHS.exec(lines[at]!)!;
  const tail = m[3]!;
  const vm = /^(true|false)/.exec(tail);
  return {
    kind: "key",
    section,
    lineIndex: at,
    indent: m[1]!,
    lhs: m[2]!,
    value: vm ? (vm[1] as "true" | "false") : null,
    rest: vm ? tail.slice(vm[1]!.length) : tail,
  };
}

/**
 * READ-ONLY. What Grok will do with our hooks on this machine right now.
 *
 * Never throws and never writes: an unreadable or unparseable config reports
 * `unknown` and says so, because "we could not tell" is a legitimate answer and
 * guessing here would be the same mistake as writing without asking.
 */
export function readGrokCompat(opts: GrokCompatOptions = {}): GrokCompatState {
  const configPath = grokConfigPath(opts);
  const installed = existsSync(fsPath(path.dirname(configPath)));
  const shimHooksPresent =
    opts.shimHooksPresent ??
    checkShimHooks(opts.settingsPath ? { settingsPath: opts.settingsPath } : {}).written;
  const envOverride = readGrokCompatEnv(opts.env ?? process.env);

  const base = { configPath, installed, shimHooksPresent, envOverride };
  if (!installed) {
    return {
      ...base,
      configPresent: false,
      hooks: "unknown",
      reason: `no ${path.dirname(configPath)} directory`,
      ours: false,
      optOutRefused: false,
      dyingProcess: false,
      note: "Grok CLI is not installed here — nothing loads our hooks but Claude Code.",
    };
  }

  let hooks: GrokCompatHooks;
  let reason: string;
  let ours = false;
  // Set when the file's SHAPE is why we cannot answer — which is exactly when
  // `--off` would refuse it, so the messages can stop offering that command.
  let optOutRefused = false;
  const configPresent = existsSync(fsPath(configPath));
  if (!configPresent) {
    hooks = "on";
    reason = "no config.toml, and Grok's compat cells default to on";
  } else {
    // `existsSync` proves a path exists, not that it is a readable regular
    // file: EACCES, a sharing violation from Grok's own writer (it takes
    // `.config-init.lock` / `managed_config.lock` around this file), or a
    // DIRECTORY named config.toml all throw here. This function is documented
    // "never throws", and `doctor` — whose entire job is to report rather than
    // die — calls it unguarded, so a throw took the whole report down,
    // including findings with nothing to do with Grok. Degrade to `unknown`
    // with a reason, exactly as `checkShimHooks` does one screen up.
    let raw: Buffer;
    try {
      raw = readFileSync(fsPath(configPath));
    } catch (err) {
      return {
        ...base,
        configPresent: true,
        hooks: "unknown",
        reason: `config.toml exists but could not be read (${(err as Error)?.message ?? "unknown error"})`,
        ours: false,
        optOutRefused: true,
        dyingProcess: shimHooksPresent,
        note: grokCompatNote({
          configPath,
          hooks: "unknown",
          reason: `config.toml exists but could not be read (${(err as Error)?.message ?? "unknown error"})`,
          dyingProcess: shimHooksPresent,
          shimHooksPresent,
          optOutRefused: true,
          envOverride,
        }),
      };
    }
    const read = readTomlForEdit(raw);
    if (!read.ok) {
      hooks = "unknown";
      reason = read.why;
      optOutRefused = true;
    } else {
      const loc = locateCompatHooks(read.view);
      if (loc.kind === "refuse") {
        hooks = "unknown";
        reason = loc.why;
        optOutRefused = true;
      } else if (loc.kind === "no-section") {
        hooks = "on";
        reason = "no [compat.claude] section, and Grok's compat cells default to on";
      } else if (loc.kind === "no-key") {
        hooks = "on";
        reason = "[compat.claude] has no `hooks` key, and Grok's compat cells default to on";
      } else if (loc.value === null) {
        hooks = "unknown";
        reason = "`hooks` under [compat.claude] is not a bare true/false";
        optOutRefused = true;
      } else {
        hooks = loc.value === "false" ? "off" : "on";
        ours = loc.rest.includes(GROK_COMPAT_MARKER);
        reason = `${GROK_COMPAT_KEY} = ${loc.value}${ours ? " (set by fimemory)" : ""}`;
      }
    }
  }

  // THE LAYER ABOVE THE FILE. Grok resolves env var > config.toml > default
  // (05-configuration.md:360), so config.toml alone cannot settle this. When a
  // variable for the cell is present and does not plainly agree with the file,
  // the honest answer is `unknown` — reporting "off" because we wrote a line an
  // env var outranks would be the all-clear-we-cannot-back-up this reader
  // exists to refuse.
  if (envOverride) {
    const says = /^(false|0|off|no)$/i.test(envOverride.value)
      ? "off"
      : /^(true|1|on|yes)$/i.test(envOverride.value)
        ? "on"
        : null;
    if (says !== hooks) {
      hooks = "unknown";
      reason =
        `${envOverride.name}=${envOverride.value} is set in this environment, and Grok resolves env var > config.toml ` +
        `> default (05-configuration.md:360), so it may outrank ${reason} — run \`grok inspect\` for the resolved cell`;
    }
  }

  // `unknown` counts as scanning. Grok's default is on, so the safe reading of
  // "we could not tell" is that the handlers are still being loaded — an
  // all-clear we cannot back up is the one answer that would leave the waste
  // running while telling the user it had stopped. What it does NOT license is
  // narrating a guess as an observation, which is what `grokCompatNote` keeps
  // separate: the default stays conservative, the sentence stays hedged.
  const dyingProcess = hooks !== "off" && shimHooksPresent;
  return {
    ...base,
    configPresent,
    hooks,
    reason,
    ours,
    optOutRefused,
    dyingProcess,
    note: grokCompatNote({ configPath, hooks, reason, dyingProcess, shimHooksPresent, optOutRefused, envOverride }),
  };
}

/** The env var for this cell, if it is set to anything. Name is INFERRED (see
 * `GROK_COMPAT_ENV_VAR`), so its presence downgrades our answer rather than
 * deciding it. */
function readGrokCompatEnv(env: NodeJS.ProcessEnv): { name: string; value: string } | null {
  const value = env[GROK_COMPAT_ENV_VAR];
  return value === undefined || value === "" ? null : { name: GROK_COMPAT_ENV_VAR, value };
}

/**
 * The one sentence the user reads about their own machine.
 *
 * Split out from the state so that CONSERVATIVE DEFAULTING and CONFIDENT
 * NARRATION cannot be the same decision. `hooks === "unknown"` is folded into
 * `dyingProcess` on purpose — assuming Grok's documented default is the safe
 * bet — but the wording that came with it asserted "Grok is … still scanning
 * (<reason>)" while the interpolated reason was an admission that we could not
 * read the file. A user who had already written `compat.claude.hooks = false`
 * as a dotted key was told, as fact, that his machine was spawning a dead
 * process per prompt, and then offered a command that refuses and exits 1.
 */
function grokCompatNote(s: {
  configPath: string;
  hooks: GrokCompatHooks;
  reason: string;
  dyingProcess: boolean;
  shimHooksPresent: boolean;
  optOutRefused: boolean;
  envOverride: { name: string; value: string } | null;
}): string {
  const byHand =
    ` \`fimemory grok-compat --off\` will REFUSE ${s.configPath} rather than rewrite a shape it does not understand — ` +
    `check with \`grok inspect\` and set ${GROK_COMPAT_KEY} = false by hand if it is scanning.`;
  if (s.hooks === "unknown") {
    const head =
      `Grok is installed here, but we could not tell whether it is scanning Claude's settings for hooks: ${s.reason}. ` +
      "Grok's default is to scan, so assume it is loading them";
    if (s.dyingProcess) {
      return (
        `${head} — which would mean it drops their \`args\` and spawns a process that dies, on every Grok prompt.` +
        (s.optOutRefused ? byHand : "")
      );
    }
    return `${head}. No fimemory handlers are in Claude's settings for it to load.${s.optOutRefused ? byHand : ""}`;
  }
  const envSuffix = s.envOverride
    ? ` (${s.envOverride.name}=${s.envOverride.value} agrees with the file; env wins either way — 05-configuration.md:360)`
    : "";
  if (s.dyingProcess) {
    return (
      `Grok is installed and still scanning Claude's settings (${s.reason}), and our handlers are in there — ` +
      "Grok loads them, drops their `args`, and spawns a process that dies, on every Grok prompt."
    );
  }
  if (s.hooks === "off") {
    return (
      `Grok is installed and NOT scanning Claude's settings for hooks (${s.reason})${envSuffix} — ` +
      "our handlers are invisible to it, and so is every other Claude hook."
    );
  }
  return s.shimHooksPresent
    ? `Grok is installed (${s.reason}).`
    : `Grok is installed (${s.reason}), and no fimemory handlers are in Claude's settings for it to load.`;
}

/**
 * Apply (`scan: false`) or undo (`scan: true`) Grok's Claude-compat hook
 * scanning opt-out, by editing exactly one key in ~/.grok/config.toml.
 *
 * The whole file goes through `readTomlForEdit`, so this inherits install-mcp's
 * refusal contract verbatim: a config that is not valid UTF-8, or whose table
 * structure is not confidently understood, is LEFT ALONE and reported. Every
 * block that is not `[compat.claude]` is copied byte-for-byte, in place.
 *
 * Inside `[compat.claude]` the edit is deliberately smaller than install-mcp's
 * (which replaces its whole table): this table is the USER'S — it may already
 * carry `agents`, `commands`, `mcp` — so only the `hooks` key is touched, and
 * when the key already exists only its value TOKEN is rewritten, leaving any
 * comment the user put on that line intact and appending our own note after it
 * rather than over it.
 *
 * TWO KINDS OF LINE, and everything below turns on the difference:
 *   - a line THIS WRITER CREATED carries `GROK_COMPAT_ADDED_MARKER`, and `--on`
 *     deletes it outright (and the section, if it was alone in it);
 *   - a line the USER wrote is only ever value-flipped, never deleted, and
 *     `--on` flips it back and strips the note we appended.
 * Collapsing those two onto one marker is how `--on` came to delete a
 * `hooks = true` the user had written himself.
 *
 * And a value that is ALREADY what we want is not written at all — not even
 * reserialized. The mtime of a config holding live API keys is not ours to
 * churn for a state change that did not happen.
 */
export async function setGrokCompatHooks(
  opts: GrokCompatOptions & { scan: boolean },
): Promise<GrokCompatWriteResult> {
  const configPath = grokConfigPath(opts);
  const scan = opts.scan;
  const reverseHint = scan
    ? "Run `fimemory grok-compat --off` to apply it again."
    : "Run `fimemory grok-compat --on` to undo this, or delete the marked `hooks = false` line from the file.";

  // Writing the file is not the same as knowing the cell resolved. Grok:
  // "Resolution: env var > config.toml > default (on)" (05-configuration.md:360).
  // If a variable for this cell is set, say so at the moment we report success
  // — a green "hook scanning is OFF" over the top of an env var that turned it
  // back on is exactly the all-clear-we-cannot-back-up this whole path refuses
  // to give.
  const envOverride = readGrokCompatEnv(opts.env ?? process.env);
  const envCaveat = envOverride
    ? ` NOTE: ${envOverride.name}=${envOverride.value} is set in this environment. Grok resolves env var > config.toml ` +
      "> default (05-configuration.md:360), so this file may not be what decides the cell — `grok inspect` reports it " +
      "as actually resolved."
    : "";
  /** Downgrade a claimed result to `unknown` when an env layer we cannot read outranks it. */
  const claim = (h: GrokCompatHooks): GrokCompatHooks => {
    if (!envOverride) return h;
    const says = /^(false|0|off|no)$/i.test(envOverride.value)
      ? "off"
      : /^(true|1|on|yes)$/i.test(envOverride.value)
        ? "on"
        : null;
    return says === h ? h : "unknown";
  };

  const dir = path.dirname(configPath);
  if (!existsSync(fsPath(dir))) {
    return {
      configPath,
      action: "absent",
      hooks: "unknown",
      note: `${dir} not found — Grok CLI is not installed here, so there is nothing to change.`,
    };
  }

  // No config file yet. Turning the flag OFF creates one holding just this
  // section; turning it ON has nothing to undo (the default is already on).
  if (!existsSync(fsPath(configPath))) {
    if (scan) {
      return {
        configPath,
        action: "unchanged",
        hooks: "on",
        note: `no ${path.basename(configPath)} — Grok's Claude-compat hook scanning is already at its default (on).`,
      };
    }
    await writeFileAtomicPlain(configPath, `[compat.claude]\nhooks = false${GROK_COMPAT_COMMENT}\n`);
    return {
      configPath,
      action: "set",
      hooks: claim("off"),
      note: `created ${path.basename(configPath)} with ${GROK_COMPAT_KEY} = false.${envCaveat}`,
      reverse: reverseHint,
    };
  }

  // Same guard as the reader, for the same reason: `existsSync` is not proof
  // that a read will succeed (EACCES, a directory named config.toml, or a
  // sharing violation while Grok holds its own config open on Windows). A
  // throw here would surface as a raw fs stack from a command whose contract
  // is "refuse loudly and leave the file alone".
  let rawConfig: Buffer;
  try {
    rawConfig = readFileSync(fsPath(configPath));
  } catch (err) {
    return {
      configPath,
      action: "refused",
      hooks: "unknown",
      note:
        `left unchanged — ${path.basename(configPath)} exists but could not be read ` +
        `(${(err as Error)?.message ?? "unknown error"}). Set ${GROK_COMPAT_KEY} by hand.`,
    };
  }
  const read = readTomlForEdit(rawConfig);
  if (!read.ok) {
    return {
      configPath,
      action: "refused",
      hooks: "unknown",
      note: `left unchanged — ${read.why} Set ${GROK_COMPAT_KEY} by hand.`,
    };
  }
  const view = read.view;
  const loc = locateCompatHooks(view);
  if (loc.kind === "refuse") {
    return {
      configPath,
      action: "refused",
      hooks: "unknown",
      note: `left unchanged — ${loc.why} Set ${GROK_COMPAT_KEY} by hand.`,
    };
  }

  // Nothing of ours in the file and nothing asked for: the default is already
  // what the caller wants. Return BEFORE any write so the file is not even
  // reserialized — churning the mtime of a config holding API keys for no
  // change is still touching it.
  if (scan && loc.kind !== "key") {
    return {
      configPath,
      action: "unchanged",
      hooks: "on",
      note: `${GROK_COMPAT_KEY} is not set here — Grok is already at its default (scanning on).`,
    };
  }

  // The mirror of the above, and the one that was missing: the key is already
  // `false`, so `--off` has nothing to change. Return BEFORE `lines` is touched
  // — the old code fell through, restamped a bare line with our marker, and
  // wrote the file while its own note said "hooks was already false". That
  // reserialized a config holding API keys for no state change, and claimed a
  // line the user had written as ours (`doctor` then reported the user's own
  // setting as "set by fimemory", and `--on` deleted it).
  if (!scan && loc.kind === "key" && loc.value === "false") {
    const alreadyOurs = loc.rest.includes(GROK_COMPAT_MARKER);
    return {
      configPath,
      action: "unchanged",
      hooks: claim("off"),
      note:
        `${GROK_COMPAT_KEY} is already false${alreadyOurs ? " (set by fimemory earlier)" : " — you set it yourself"}, ` +
        `so nothing was written and the file was not touched.${envCaveat}`,
      ...(alreadyOurs ? { reverse: reverseHint } : {}),
    };
  }

  const eol = view.eol;
  let updated: string;
  let action: GrokCompatWriteResult["action"];
  let hooks: GrokCompatHooks;
  let note: string;

  if (loc.kind === "no-section") {
    // Append a new [compat.claude]. Same separator rule as install-mcp's
    // append path, so a file ending in one newline gains exactly one blank
    // line and a file already ending in a blank line gains none.
    const section = [`[compat.claude]`, `hooks = false${GROK_COMPAT_COMMENT}`].join(eol);
    const base = view.text;
    const sep = base === "" ? "" : base.endsWith(eol + eol) ? "" : base.endsWith("\n") ? eol : eol + eol;
    updated = base + sep + section + eol;
    action = "set";
    hooks = "off";
    note = `added a [compat.claude] section with hooks = false (every other section untouched).`;
  } else {
    const section = loc.section;
    const lines = view.text.slice(section.start, section.end).split("\n");

    if (loc.kind === "no-key") {
      // Insert immediately after the header, matching the indentation the
      // table's own keys use, so the section reads as one block.
      const indent = /^([ \t]*)\S/.exec(lines.slice(1).find((l) => l.trim() !== "" && !l.trimStart().startsWith("#")) ?? "")?.[1] ?? "";
      // The block was split on "\n", so on a CRLF file every EXISTING line
      // still carries its own trailing \r and the rejoin puts back only the
      // \n. A line built without that \r is one LF-terminated line in an
      // otherwise CRLF file we do not own — a whole-line diff in a dotfiles
      // repo, and a whole-FILE diff the next time an editor with "normalize on
      // save" touches the sections holding API keys. The append path already
      // joins on `view.eol` and the flip path already preserves `cr`; this was
      // the one branch that did neither.
      const insertCr = eol === "\r\n" ? "\r" : "";
      lines.splice(1, 0, `${indent}hooks = false${GROK_COMPAT_COMMENT}${insertCr}`);
      action = "set";
      hooks = "off";
      note = "added hooks = false to the existing [compat.claude] section (nothing else in it changed).";
    } else if (loc.value === null) {
      return {
        configPath,
        action: "refused",
        hooks: "unknown",
        note:
          `left unchanged — \`hooks\` under [compat.claude] is not a bare true/false, so this writer will not ` +
          `overwrite it. Set ${GROK_COMPAT_KEY} by hand.`,
      };
    } else if (scan) {
      // RESTORE. A line WE CREATED (`GROK_COMPAT_ADDED_MARKER`) is removed
      // outright; anything else — including a line whose VALUE we flipped and
      // tagged — is flipped back and left exactly where the user wrote it.
      //
      // The test that matters: `[compat.claude]\nhooks = true\n` → `--off` →
      // `--on` must return those bytes. Matching on the weaker
      // `GROK_COMPAT_MARKER` here deleted the user's line instead.
      if (loc.rest.includes(GROK_COMPAT_ADDED_MARKER)) {
        lines.splice(loc.lineIndex, 1);
        const bodyLeft = lines.slice(1).some((l) => l.trim() !== "");
        if (!bodyLeft) {
          // The section held nothing but our line, so it goes too, along with
          // the blank-line seam it owned. RESIDUAL, stated not hidden: a
          // [compat.claude] that was already empty before we wrote into it is
          // indistinguishable from one we created, and is removed here. An
          // empty TOML table declares no keys, so Grok reads the same defaults
          // either way.
          lines.length = 0;
        }
        hooks = "on";
        note = bodyLeft
          ? "removed the fimemory hooks = false line from [compat.claude] (the rest of the section untouched)."
          : "removed the fimemory [compat.claude] hooks = false line, and the section it was alone in.";
      } else {
        // Their line. Flip the token back and take OUR note off it, so undoing
        // returns the line to the bytes they wrote — comment, spacing and all.
        const cr = loc.rest.endsWith("\r") ? "\r" : "";
        const restBody = cr ? loc.rest.slice(0, -1) : loc.rest;
        const cleaned = restBody.endsWith(GROK_COMPAT_FLIP_COMMENT)
          ? restBody.slice(0, -GROK_COMPAT_FLIP_COMMENT.length)
          : restBody;
        lines[loc.lineIndex] = `${loc.indent}${loc.lhs}true${cleaned}${cr}`;
        hooks = "on";
        note = "set [compat.claude] hooks back to true (your line, your comment, only the value changed).";
      }
      action = "restored";
    } else {
      // APPLY over an existing key: rewrite the value token only, never the
      // line. A comment the user wrote is preserved verbatim and our note is
      // appended AFTER it, not pasted over it — because leaving the file
      // saying `hooks = false  # I turned this on deliberately` is a comment
      // contradicting its own value in a file we do not own, and because a
      // global flag WE set must not become invisible to `doctor` (which keys
      // its standing cost-reminder off `GROK_COMPAT_MARKER`).
      //
      // The note deliberately does NOT carry `GROK_COMPAT_ADDED_MARKER`: this
      // line is the user's, so `--on` flips it, it does not delete it.
      const cr = loc.rest.endsWith("\r") ? "\r" : "";
      const restBody = cr ? loc.rest.slice(0, -1) : loc.rest;
      const hadComment = restBody.trim() !== "";
      const rest = restBody.includes(GROK_COMPAT_MARKER) ? restBody : restBody + GROK_COMPAT_FLIP_COMMENT;
      lines[loc.lineIndex] = `${loc.indent}${loc.lhs}false${rest}${cr}`;
      action = "set";
      hooks = "off";
      note =
        "set [compat.claude] hooks = false — your line stays where you wrote it" +
        `${hadComment ? ", your comment is untouched," : ","} and a note recording the change is appended after it ` +
        "(`--on` removes the note and puts the value back).";
    }

    // Reassemble from the tiled blocks: everything that is not [compat.claude]
    // is copied byte-for-byte, and our section is substituted AT ITS OWN
    // POSITION — it does not migrate to the end of the file.
    const pieces: string[] = [view.text.slice(0, view.preamble)];
    for (const s of view.sections) {
      pieces.push(s === section ? lines.join("\n") : view.text.slice(s.start, s.end));
    }
    updated = pieces.join("");

    // Our section was appended at the END of the file, so dropping it can leave
    // behind the blank-line separator the append added. Exactly the rule
    // `removeTomlConfig` applies for the same reason, and with the same bound:
    // the append adds a separator ONLY when the file did not already end in a
    // blank line, so the only trailing run it can produce is EXACTLY TWO
    // newlines. A longer run was the user's own and belongs to the preceding
    // block. Without this, "apply then undo returns the file to its bytes" is
    // false by one blank line in a version-controlled dotfile.
    //
    // Residual, stated rather than papered over: a file that ALREADY ended in
    // exactly two newlines got no separator, and after removal is
    // indistinguishable from one that did. Two collapses to one, because a
    // config ending in a single newline is overwhelmingly the common input.
    const droppedLast = lines.length === 0 && view.sections[view.sections.length - 1] === section;
    if (droppedLast && updated !== "") {
      const tail = /(?:\r?\n)*$/.exec(updated)![0];
      if ((tail === "" ? 0 : tail.split(/\r?\n/).length - 1) === 2) {
        updated = updated.replace(/(?:\r?\n)+$/, eol);
      }
    }
  }

  if (updated === view.text) {
    return {
      configPath,
      action: "unchanged",
      hooks,
      note: `${GROK_COMPAT_KEY} is already ${scan ? "true (Grok's default)" : "false"} — nothing written.`,
    };
  }

  // `--on` emptied the file completely: every byte in it was the section we
  // created, so this config.toml is one WE brought into existence and undoing
  // means it should not exist. Leaving a zero-byte config.toml behind is not
  // "the exact inverse" — it is a file the user never had, in a directory
  // another tool scans. Bounded deliberately: only when the result is empty of
  // everything, only on a restore, and never when a BOM or any other byte
  // survives (that content was not ours to remove, so the file stays).
  if (scan && updated === "" && view.bom === "") {
    try {
      rmSync(fsPath(configPath), { force: true });
      return {
        configPath,
        action: "restored",
        hooks: claim("on"),
        note:
          `${note} That left ${path.basename(configPath)} holding nothing at all — it was created by ` +
          "`grok-compat --off` and held only that section, so it was removed rather than left as an empty file." +
          envCaveat,
        reverse: reverseHint,
      };
    } catch {
      // Could not unlink (locked, read-only dir). Fall through and write the
      // empty file: an empty config.toml is inert to Grok, and failing the
      // whole restore over a cleanup detail would be worse than a stray file.
    }
  }
  await writeFileAtomicPlain(configPath, view.bom + updated);
  return { configPath, action, hooks: claim(hooks), note: `${note}${envCaveat}`, reverse: reverseHint };
}
