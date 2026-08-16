import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_MCP_SERVER_KEY, MCP_SERVER_KEY } from "../brand.js";
import type { Warning } from "../errors.js";
import { fsPath, resolveHome } from "../paths.js";
import { writeFileAtomicPlain } from "../store/atomic.js";

export interface ServerEntry {
  command: string;
  args: string[];
  /** Optional environment block written into the host config VERBATIM — see
   * `InstallMcpOptions.env`. Absent unless the user explicitly asked for it. */
  env?: Record<string, string>;
}

/** How the running CLI got onto this disk (Phase C, install guide §3). */
export type ExecutionKind = "installed" | "dev";

export interface ExecutionContext {
  kind: ExecutionKind;
  /** Absolute path of the cli.js this process would launch. */
  cliPath: string;
  /** Absolute path to the installed bin script, when one resolved (POSIX only —
   * on Windows the npm bin is a `.cmd` shim that adds a cmd.exe layer, so the
   * resolved installed form there is `node + <installed cli.js>` instead). */
  binPath?: string;
}

/** Injectables for `detectExecutionContext` so tests never depend on where the
 * suite itself happens to run from. */
export interface DetectContextOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** Read a package.json's text; used to learn the installed bin name. */
  readFile?: (p: string) => string;
}

/**
 * Classify the launch path (Phase C of the install guide): an `npm i`-installed
 * package (cli.js lives under a `node_modules` tree — local or global prefix)
 * vs a dev checkout (`runtime/dist/cli.js` in a working copy). For installed
 * packages, try to resolve the bin script npm placed on disk:
 *
 *   - local install:   `<...>/node_modules/.bin/<bin>`
 *   - global (POSIX):  `<prefix>/bin/<bin>`   (cli at `<prefix>/lib/node_modules/<pkg>/…`)
 *   - global (win32):  no binPath by design — npm's shim is `<prefix>\<bin>.cmd`,
 *     and a `.cmd` command adds a shell layer between host and server
 *     (EXECUTION-ADDENDUM §3.5); `node + cli.js` IS the resolved form there.
 *
 * The bin NAME comes from the installed package's own package.json (first `bin`
 * key), so the export-repo rename (`gestalt` → `fimemory`) needs no code change
 * here. `npx -y` stays rejected as a default everywhere (guide Phase C).
 */
export function detectExecutionContext(
  cliPath: string,
  opts: DetectContextOptions = {},
): ExecutionContext {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p: string) => existsSync(fsPath(p)));
  const readFile = opts.readFile ?? ((p: string) => readFileSync(fsPath(p), "utf8"));

  // Normalize (not resolve): an already-absolute path must stay as given —
  // resolve() would prepend a drive letter to a POSIX-style path on Windows,
  // which matters to the platform-injected unit tests.
  const resolved = path.isAbsolute(cliPath) ? path.normalize(cliPath) : path.resolve(cliPath);
  const segs = resolved.split(/[\\/]/);
  const nmIdx = segs.lastIndexOf("node_modules");
  if (nmIdx === -1) return { kind: "dev", cliPath: resolved };

  // Package dir: node_modules/<name> or node_modules/@scope/<name>.
  const scoped = segs[nmIdx + 1]?.startsWith("@") === true;
  const pkgDirSegs = segs.slice(0, nmIdx + (scoped ? 3 : 2));
  const pkgDir = pkgDirSegs.join(path.sep);
  const nmDir = segs.slice(0, nmIdx + 1).join(path.sep);

  let binName: string | undefined;
  try {
    const pkg = JSON.parse(readFile(path.join(pkgDir, "package.json"))) as {
      bin?: Record<string, string> | string;
      name?: string;
    };
    if (typeof pkg.bin === "string") binName = pkg.name;
    else if (pkg.bin) binName = Object.keys(pkg.bin)[0];
  } catch {
    // No readable package.json — fall through to node + cli.js.
  }

  if (binName && platform !== "win32") {
    const candidates = [
      path.join(nmDir, ".bin", binName), // local install
      path.join(path.dirname(path.dirname(nmDir)), "bin", binName), // global: <prefix>/lib/node_modules → <prefix>/bin
    ];
    for (const candidate of candidates) {
      if (exists(candidate)) return { kind: "installed", cliPath: resolved, binPath: candidate };
    }
  }
  return { kind: "installed", cliPath: resolved };
}

export type InstallTarget =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "gemini"
  | "grok"
  | "windsurf";

export const INSTALL_TARGETS: InstallTarget[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "gemini",
  "grok",
  "windsurf",
];

export interface InstallMcpOptions {
  targets?: string[]; // default: all known targets
  home?: string; // store home to pin into the server entry; default resolveHome()
  cliPath?: string; // injectable for tests
  /**
   * OPTIONAL env block (`--env KEY=VALUE`, repeatable). Values are written into
   * the host config file IN PLAIN TEXT — that is the user's explicit choice
   * (encrypted-store users may want GESTALT_PASSPHRASE available to the host
   * app). The default writes NO env block and NO secret, ever.
   */
  env?: Record<string, string>;
  /**
   * OPTIONAL passthrough keys (`--env-passthrough KEY`, repeatable): copy the
   * key's CURRENT value from this process's environment into the env block —
   * same plaintext-by-explicit-choice contract as `env`. A key that is not set
   * is skipped with a warning, never written empty.
   */
  envPassthrough?: string[];
  processEnv?: NodeJS.ProcessEnv; // injectable for tests
  detect?: DetectContextOptions; // injectable for tests
  /** Override the PATH scan for the `claude` binary (tests must be able to
   * assert both arms on one machine, whatever that machine's PATH holds). */
  claudeCliDetected?: boolean;
  /** Display path for the claude-code manual fallback (~/.claude.json). Never
   * written by this op — Claude Code owns that file — but tests must be able
   * to keep the printed path inside the sandbox like every sibling path. */
  claudeCodeConfigPath?: string;
  // Injectable config paths for tests (never touch real client configs in CI):
  desktopConfigPath?: string;
  cursorConfigPath?: string;
  codexConfigPath?: string;
  geminiConfigPath?: string;
  grokConfigPath?: string;
  windsurfConfigPath?: string;
}

export interface WriterResult {
  target: InstallTarget;
  path: string;
  wrote: boolean;
  note: string;
  /**
   * True when the config ALREADY said exactly this and nothing was written —
   * the second run of an idempotent install. Distinct from `wrote: false`
   * meaning "could not / would not write", which is the other reason a writer
   * reports no write; callers render this one as success, not as a problem.
   */
  unchanged?: boolean;
}

export interface InstallMcpResult {
  serverEntry: ServerEntry;
  snippet: string;
  writers: WriterResult[];
  claudeCode?: {
    command: string;
    /**
     * Whether a `claude` binary is actually reachable on this machine's PATH.
     * The Mac beta install (2026-08-05, hank-e-d/mac-store BETA-NOTES §3) hit
     * the gap this closes: Claude Code as the VSCode extension or Claude.app
     * installs NO standalone CLI, so the `claude mcp add` line above fails with
     * `command not found: claude` — and that error carries no hint at the real
     * fix. The command is still ALWAYS present (the user may install the CLI
     * later), but when this is false the caller must lead with the manual path.
     */
    cliDetected: boolean;
    /** Where the manual entry goes when the CLI is absent: ~/.claude.json. */
    configPath: string;
    /** Ready-to-paste `mcpServers` block for that file — same entry the CLI
     * command would have registered, so the two paths cannot drift. */
    snippet: string;
  };
  /** How the launch command was chosen (Phase C): resolved installed bin,
   * installed node+cli.js, or the dev-checkout pin (with a warning). */
  context: ExecutionContext;
  warnings: Warning[];
}

function defaultCliPath(): string {
  // dist/ops/installMcp.js → dist/cli.js (built). Run `npm run build` first.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "..", "cli.js");
}

/**
 * Returned INSTEAD of a path when Windows gives us no `APPDATA` to build one
 * from. It is not a path and must never be treated as one: every consumer
 * checks for it (see `installMcp`, `uninstallMcp`) and reports the host as
 * unresolved rather than writing somewhere invented.
 *
 * The old code was `env["APPDATA"] ?? home`, which had two failure modes.
 * `??` only catches `undefined`, so `APPDATA=""` — a service account, a
 * container, a child spawned with a scrubbed environment — produced the
 * RELATIVE path `Claude/claude_desktop_config.json`, and `existsSync` and
 * `writeFileAtomicPlain` resolve a relative path against the PROCESS CWD. So
 * `fimemory setup` run inside a project created `./Claude/claude_desktop_config.json`
 * in that project (possibly a git working tree), reported the desktop install
 * as done, and `doctor` run from anywhere else looked at a different relative
 * path and said it was unconfigured — forever. With
 * `--env-passthrough GESTALT_PASSPHRASE`, which cli.ts documents as the
 * encrypted-store recipe, that stray file holds the passphrase in plaintext.
 * The `undefined` fallback to `home` was wrong too: `<home>\Claude\...` is not
 * where Claude Desktop looks on any platform, so it wrote a file nobody reads.
 */
export const DESKTOP_CONFIG_UNRESOLVED = "(unknown: APPDATA is not set in this environment)";

/**
 * Claude Desktop's config location, per platform.
 *
 * `platform` is a PARAMETER rather than a read of `process.platform` so all
 * three arms can be asserted by the suite on one machine — see
 * test/install-mcp-desktop-path.test.ts. That matters here more than anywhere
 * else in this file: this is the one host location that genuinely differs per
 * OS, and until those tests existed the darwin and linux arms had no assertion
 * anywhere in the tree.
 *
 * PROVENANCE, stated exactly as strongly as it deserves:
 *   - win32 `%APPDATA%\Claude\claude_desktop_config.json` — the only arm with
 *     first-hand support in this project: Windows is the platform every install
 *     here has run on. Note that Claude Desktop is NOT installed on the owner's
 *     machine either, so even this arm is "the documented location", not "a
 *     file we have watched the app read".
 *   - darwin `~/Library/Application Support/Claude/…` — UNVERIFIED. Nobody on
 *     this project owns a Mac and no vendor documentation for this path is on
 *     this disk; it follows Electron's `app.getPath("userData")` convention,
 *     which is an inference. The generated README words the Claude Desktop row
 *     the same way ("Vendor-documented, unverified on disk").
 *   - linux `~/.config/Claude/…` — UNVERIFIED, same reasoning, and Claude
 *     Desktop has no Linux build at the time of writing, so this arm may
 *     describe a file that cannot exist.
 * If one of these is wrong, `install-mcp` writes a config the app never reads
 * and reports it as installed. That is why doctor reads its paths from THIS
 * function: whatever the truth is, both commands are wrong in the same place
 * and the user is not told two different stories.
 */
function defaultDesktopConfigPath(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    // `?.trim() ||`, the idiom every sibling in this codebase already uses
    // (`under()` below, paths.ts, shimAudit.ts): empty and whitespace-only are
    // "not set", not "a path".
    const appData = env["APPDATA"]?.trim();
    return appData
      ? path.join(appData, "Claude", "claude_desktop_config.json")
      : DESKTOP_CONFIG_UNRESOLVED;
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** A TOML bare key, which is also the shape of every real environment-variable
 * name: `A-Za-z0-9_-`. Anything else must not be written into a host config as
 * a raw key (see `addEnv` in `installMcp`). */
function isBareEnvKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/** Always-quoted shell token for the printed one-liner (Gate #2 #18). */
function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** One host's MCP config file, as this module knows it. `kind` says how the
 * gestalt entry is encoded there; `key` is the server-map key for JSON hosts
 * (informational for TOML). */
export interface HostConfigFile {
  target: InstallTarget;
  file: string;
  kind: "json" | "toml";
  key: string;
}

/** Injectables for `defaultHostConfigFiles` — tests (and doctor's `userHome`)
 * must be able to build the registry without reading the real home. */
export interface HostRegistryOptions {
  /** Base home directory. Default `os.homedir()`. */
  homeDir?: string;
  /** Environment consulted for host-home overrides (GROK_HOME, APPDATA).
   * Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Platform whose Claude Desktop convention to use. Default
   * `process.platform`. Injectable so the win32/darwin/linux arms of
   * `defaultDesktopConfigPath` are all assertable from one machine — the darwin
   * arm cannot be verified any other way by this project. */
  platform?: NodeJS.Platform;
}

/**
 * The default config-file locations per host — the single source `installMcp`
 * writes to and `fimemory doctor` reads from (read-only), so the two can never
 * drift. `claude-code` is listed too: install-mcp only PRINTS the `claude mcp
 * add` command for it (the CLI owns that file's schema), but doctor still
 * checks `~/.claude.json` for the resulting user-scope entry.
 *
 * `grok` is a TOML host exactly like `codex`: Grok CLI keeps MCP servers in
 * `~/.grok/config.toml` under `[mcp_servers.<name>]`, the same file format and
 * the same table shape Codex uses (confirmed against ~/.grok/README.md §MCP
 * Servers and a real config on the owner's disk).
 *
 * HOST-HOME OVERRIDES ARE RESOLVED EXACTLY AS `installRules` RESOLVES THEM —
 * `$CODEX_HOME`, `$GEMINI_CLI_HOME`, `$GROK_HOME`. This used to honour only
 * GROK_HOME while the rules registry honoured all three, so on a machine with
 * CODEX_HOME set, `setup` wrote the rule block where Codex reads it and the MCP
 * entry where Codex does not — telling the agent to consult a store it has no
 * server for. doctor builds its registry from THIS function, so it agreed with
 * the wrong location and reported nothing amiss: half-wired and silent.
 * CODEX_HOME is real and resolved by the shipped binary (the string appears 60
 * times in codex.exe 0.145.0, including "CODEX_HOME was resolved without
 * config" and "CODEX_HOME could not be resolved").
 *
 * Claude Desktop's path is platform-dependent as well (see
 * `defaultDesktopConfigPath` — it branches on `process.platform` and reads
 * APPDATA on Windows). Only cursor and windsurf are genuinely fixed.
 */
export function defaultHostConfigFiles(opts: HostRegistryOptions = {}): HostConfigFile[] {
  const home = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const under = (v: string | undefined, fallback: string): string =>
    v && v.trim() !== "" ? path.resolve(v) : path.join(home, fallback);
  return [
    { target: "claude-code", file: path.join(home, ".claude.json"), kind: "json", key: "mcpServers" },
    { target: "claude-desktop", file: defaultDesktopConfigPath(home, env, platform), kind: "json", key: "mcpServers" },
    { target: "cursor", file: path.join(home, ".cursor", "mcp.json"), kind: "json", key: "mcpServers" },
    { target: "codex", file: path.join(under(env["CODEX_HOME"], ".codex"), "config.toml"), kind: "toml", key: "mcp_servers" },
    { target: "gemini", file: path.join(under(env["GEMINI_CLI_HOME"], ".gemini"), "settings.json"), kind: "json", key: "mcpServers" },
    { target: "grok", file: path.join(under(env["GROK_HOME"], ".grok"), "config.toml"), kind: "toml", key: "mcp_servers" },
    { target: "windsurf", file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), kind: "json", key: "mcpServers" },
  ];
}

/**
 * Is a `claude` binary reachable on PATH? A pure PATH-directory scan, no
 * spawning: `which`/`where` would fork a process just to answer a question
 * `existsSync` can, and a spawn inside an installer is one more thing that can
 * hang. On win32 npm/installers ship shims (`claude.cmd`, `claude.exe`,
 * `claude.ps1`), so all three are candidates; POSIX is the bare name.
 *
 * WHY THIS EXISTS: `install-mcp` hands Claude Code users a `claude mcp add`
 * one-liner — but the VSCode extension and Claude.app install no standalone
 * CLI, so on those machines the line fails with `command not found` and no
 * pointer to the real fix. That was the single install-blocking defect of the
 * 2026-08-05 Mac beta (hank-e-d/mac-store, BETA-NOTES §3). Detection is a
 * point-in-time PATH read: it can go stale the moment the user installs the
 * CLI, which is why the command is still printed either way and only the
 * ORDER of the two remedies changes.
 */
export function detectClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => existsSync(fsPath(p)),
): boolean {
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  if (pathVar.trim() === "") return false;
  const names = platform === "win32" ? ["claude.cmd", "claude.exe", "claude.ps1", "claude"] : ["claude"];
  for (const dir of pathVar.split(path.delimiter)) {
    const d = dir.trim();
    if (d === "") continue;
    for (const name of names) {
      if (exists(path.join(d, name))) return true;
    }
  }
  return false;
}

/**
 * Write MCP config so AI clients can launch `fimemory mcp` (SPEC §5.1, rev 6):
 * Claude Desktop, Cursor, OpenAI Codex CLI (TOML), Gemini CLI, Grok CLI (TOML),
 * and Windsurf get config written directly (merged — never clobbering other
 * servers; atomic temp+rename writes); Claude Code gets a ready-to-paste
 * command; everything else gets the generic snippet. The store home is pinned with an explicit
 * `--home` so a custom GESTALT_HOME is honored by the host app (Gate #2 #11).
 *
 * HOST CONFIGS ARE NOT STORE FILES — every write below goes through
 * `writeFileAtomicPlain` (atomic, but codec-free), never `writeFileAtomic`.
 * These files belong to the user's client, which must always be able to read
 * them; the storage codec must never touch them. Previously they were written
 * via `writeFileAtomic`: the codec classifies an unknown path as kind "other",
 * and `isWholeFileEncrypted("other")` is TRUE, so with a key active
 * `install-mcp` encrypted the user's real client config and broke their setup.
 *
 * The fix is here, NOT in the codec: `isWholeFileEncrypted("other") === true` is
 * deliberate and must stay — it is the correct fail-safe for an unrecognized
 * file INSIDE the store (better to seal an unknown store file than to leak it).
 * The bug was routing non-store files through it. Don't "fix" the codec default.
 */
export async function installMcp(opts: InstallMcpOptions = {}): Promise<InstallMcpResult> {
  const cliPath = opts.cliPath ?? defaultCliPath();
  const home = path.resolve(opts.home ?? resolveHome());
  const targets = (opts.targets ?? INSTALL_TARGETS) as InstallTarget[];
  const warnings: Warning[] = [];

  // Phase C launch selection: resolved installed bin > node + installed cli.js
  // > dev-checkout pin (explicit fallback, warned). Never `npx -y` — cold
  // start, network dependency, silent floating latest (guide Phase C).
  const context = detectExecutionContext(cliPath, opts.detect ?? {});
  const serverEntry: ServerEntry =
    context.kind === "installed" && context.binPath
      ? { command: context.binPath, args: ["mcp", "--home", home] }
      : { command: process.execPath, args: [context.cliPath, "mcp", "--home", home] };
  if (context.kind === "dev") {
    warnings.push({
      code: "dev_path_pin",
      message:
        `development pin: host configs will launch this checkout's ${context.cliPath} — ` +
        "moving or rebuilding the checkout breaks the pin. Install the published package for a stable bin path.",
    });
  }

  // Optional env block — plaintext in the host config, by explicit choice only.
  const envBlock: Record<string, string> = {};
  const processEnv = opts.processEnv ?? process.env;
  // A key that is not a TOML bare key is REFUSED, never written: the TOML hosts
  // get `KEY = "value"` written literally, so `MY KEY = "v"` (a shell-quoting
  // slip such as `--env "MY KEY=v"`) is a syntax error that makes the host drop
  // the entire config — every sibling server and every API key in it — while
  // this command reports success. A dotted key (`a.b`) is worse than useless:
  // it silently makes a nested table instead of the variable that was asked for.
  const addEnv = (key: string, value: string, flag: string): void => {
    if (!isBareEnvKey(key)) {
      warnings.push({
        code: "env_key_invalid",
        message: `${flag} ${JSON.stringify(key)}: not a usable environment-variable name (letters, digits, "_" and "-" only) — skipped (nothing written).`,
      });
      return;
    }
    envBlock[key] = value;
  };
  for (const key of opts.envPassthrough ?? []) {
    const value = processEnv[key];
    if (value === undefined || value === "") {
      warnings.push({ code: "env_missing", message: `--env-passthrough ${key}: not set in this environment — skipped (nothing written).` });
    } else {
      addEnv(key, value, "--env-passthrough");
    }
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) addEnv(key, value, "--env");
  if (Object.keys(envBlock).length > 0) {
    serverEntry.env = envBlock;
    warnings.push({
      code: "env_in_config",
      message:
        `env block (${Object.keys(envBlock).join(", ")}) is written into host configs in PLAIN TEXT — ` +
        "your explicit choice; anyone who can read those files can read the values.",
    });
  }

  if (!existsSync(fsPath(cliPath))) {
    warnings.push({ code: "not_built", message: `${cliPath} not found — run \`npm run build\` first so the server is runnable` });
  }
  for (const t of targets) {
    if (!(INSTALL_TARGETS as string[]).includes(t)) {
      warnings.push({ code: "unknown_target", message: `unknown target "${t}" — known: ${INSTALL_TARGETS.join(", ")}` });
    }
  }

  const snippet = JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: serverEntry } }, null, 2);
  const result: InstallMcpResult = { serverEntry, snippet, writers: [], context, warnings };

  const defaults = new Map(defaultHostConfigFiles().map((h) => [h.target, h]));
  const jsonTargets: Array<{ target: InstallTarget; file: string; key: string }> = [
    { target: "claude-desktop", file: opts.desktopConfigPath ?? defaults.get("claude-desktop")!.file, key: "mcpServers" },
    { target: "cursor", file: opts.cursorConfigPath ?? defaults.get("cursor")!.file, key: "mcpServers" },
    { target: "gemini", file: opts.geminiConfigPath ?? defaults.get("gemini")!.file, key: "mcpServers" },
    { target: "windsurf", file: opts.windsurfConfigPath ?? defaults.get("windsurf")!.file, key: "mcpServers" },
  ];
  for (const jt of jsonTargets) {
    if (!targets.includes(jt.target)) continue;
    // An unresolved host location is REPORTED, never guessed at. Falling through
    // here with the sentinel would hand a non-path to `path.dirname`, which
    // answers "." — the process CWD — and that is exactly the bug the sentinel
    // exists to stop. See DESKTOP_CONFIG_UNRESOLVED.
    if (jt.file === DESKTOP_CONFIG_UNRESOLVED) {
      result.writers.push({
        target: jt.target,
        path: jt.file,
        wrote: false,
        note:
          "APPDATA is not set in this environment, so there is no Claude Desktop config " +
          "location to write to. Nothing was written anywhere. Paste the snippet into " +
          "%APPDATA%\\Claude\\claude_desktop_config.json yourself, or re-run with " +
          "APPDATA set.",
      });
      continue;
    }
    result.writers.push(
      await guardWrite(jt.target, jt.file, () => writeJsonConfig(jt.target, jt.file, jt.key, serverEntry)),
    );
  }

  // TOML hosts — same format, same `[mcp_servers.<name>]` table shape, one writer.
  const tomlTargets: Array<{ target: InstallTarget; file: string }> = [
    { target: "codex", file: opts.codexConfigPath ?? defaults.get("codex")!.file },
    { target: "grok", file: opts.grokConfigPath ?? defaults.get("grok")!.file },
  ];
  for (const tt of tomlTargets) {
    if (!targets.includes(tt.target)) continue;
    result.writers.push(await guardWrite(tt.target, tt.file, () => writeTomlConfig(tt.target, tt.file, serverEntry)));
  }

  if (targets.includes("claude-code")) {
    // The env block must ride along here too — Claude Code is configured via
    // this one-liner, not a JSON file we write, so dropping `-e` would silently
    // lose the user's explicit --env choice on the ONE verified host.
    const envFlags = Object.entries(serverEntry.env ?? {})
      .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)} `)
      .join("");
    // The registry knows where the entry lands (~/.claude.json), so the manual
    // fallback names the same file doctor will later scan — writer, checker,
    // and remedy all agree on one path. Injectable like every sibling path, so
    // a sandboxed test never prints (or asserts against) the real home.
    const claudeConfigPath =
      opts.claudeCodeConfigPath ??
      defaultHostConfigFiles().find((h) => h.target === "claude-code")!.file;
    result.claudeCode = {
      command: `claude mcp add ${MCP_SERVER_KEY} -s user ${envFlags}-- ${shellQuote(serverEntry.command)} ${serverEntry.args.map(shellQuote).join(" ")}`,
      cliDetected: opts.claudeCliDetected ?? detectClaudeCli(processEnv),
      configPath: claudeConfigPath,
      // The entry is stamped `"type": "stdio"` in the manual snippet because
      // that is the shape a hand-edited ~/.claude.json needs; the `claude mcp
      // add` path writes it itself.
      snippet: JSON.stringify(
        { mcpServers: { [MCP_SERVER_KEY]: { type: "stdio", ...serverEntry } } },
        null,
        2,
      ),
    };
  }
  return result;
}

/**
 * Run one host's writer and turn a THROWN write failure into that host's
 * result row. `writeFileAtomicPlain` deliberately throws on a read-only target
 * (`E_IO`) and on lock contention (`E_LOCKED` after 30s), and an escaping
 * rejection would abort the whole install before the CLI printed anything: the
 * hosts already written would go unreported and the hosts after it in the loop
 * — grok is ordered after codex — would never even be attempted. The file
 * itself is safe either way (temp+rename), so the right answer is a per-host
 * "could not write", not losing the report.
 */
async function guardWrite(
  target: InstallTarget,
  file: string,
  run: () => Promise<WriterResult>,
): Promise<WriterResult> {
  try {
    return await run();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { target, path: file, wrote: false, note: `left unchanged — the write failed: ${why}` };
  }
}

/** Merge `{ [key]: { gestalt: entry } }` into a JSON host config, atomically + codec-free. */
async function writeJsonConfig(
  target: InstallTarget,
  configPath: string,
  key: string,
  serverEntry: ServerEntry,
): Promise<WriterResult> {
  const dir = path.dirname(configPath);
  if (!existsSync(fsPath(dir))) {
    // Don't create a client's config dir that doesn't exist (app not installed).
    return { target, path: configPath, wrote: false, note: `${target} config folder not found — app not installed? Paste the snippet there yourself.` };
  }

  let config: Record<string, unknown> = {};
  let existing: string | null = null;
  if (existsSync(fsPath(configPath))) {
    try {
      existing = readFileSync(fsPath(configPath), "utf8");
      const parsed: unknown = JSON.parse(existing);
      // `typeof [] === "object"`, so an array used to sail through here: we set
      // `config["mcpServers"]` on the array, `JSON.stringify` dropped it, and
      // this returned `wrote: true, "added the gestalt server"` over a file
      // that had been reformatted and contained no gestalt entry. The user is
      // told the host is configured and it is not — install and dead install
      // look identical, on the install side. `removeJsonConfig` already guards
      // this case; the two must agree about the same file.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      else return { target, path: configPath, wrote: false, note: "existing config is not a JSON object — merge the snippet by hand." };
    } catch {
      return { target, path: configPath, wrote: false, note: "existing config is not valid JSON — merge the snippet by hand." };
    }
  }

  const servers =
    config[key] && typeof config[key] === "object" ? (config[key] as Record<string, unknown>) : {};
  servers[MCP_SERVER_KEY] = serverEntry;
  // MIGRATE, never merely add. A machine upgrading from a build that wrote the
  // legacy key would otherwise carry BOTH entries, pointed at the same store,
  // so the host presents the model two COMPLETE tool sets: doubled tool
  // descriptions in every prompt, and a stale server it is free to call. This
  // is the only place that can clean it up — `install-mcp` is the verb that
  // actually runs on the upgrade path, and a user has no reason to suspect an
  // uninstall is needed for a name they never chose.
  delete servers[LEGACY_MCP_SERVER_KEY];
  config[key] = servers;

  const updated = JSON.stringify(config, null, 2) + "\n";
  // UNCHANGED IS A REAL ANSWER, and this writer had no way to give it. It
  // rewrote the file and reported "added the gestalt server (restart …)" on
  // every run, forever, for all four JSON hosts. The README tells a confused
  // reader that re-running `setup` is the diagnostic — "everything already in
  // place reports unchanged and nothing is rewritten" — so a writer that always
  // says "added" makes the re-run unable to distinguish a working install from
  // a dead one, and churns the mtime of four files this package does not own.
  // The TOML writer has always had this check; this is the same one.
  if (existing !== null && updated === existing) {
    return { target, path: configPath, wrote: false, unchanged: true, note: "already up to date — nothing written." };
  }

  await writeFileAtomicPlain(configPath, updated);
  return { target, path: configPath, wrote: true, note: `added the ${MCP_SERVER_KEY} server (restart ${target} to pick it up).` };
}

/* ─────────────────────────── TOML host configs ───────────────────────────
 *
 * Two hosts keep MCP servers in a TOML file under the SAME table shape:
 *
 *   codex  $CODEX_HOME|~/.codex/config.toml   [mcp_servers.gestalt]
 *   grok   $GROK_HOME|~/.grok/config.toml     [mcp_servers.gestalt]
 *
 * so ONE writer serves both — no second parser, no second section builder.
 *
 * These files are other people's property and routinely hold API keys in
 * sibling sections (`[mcp_servers.<other>.env]`, provider tables). The writer's
 * contract is therefore stricter than "valid TOML comes out":
 *
 *   - only the `[mcp_servers.gestalt]` table (and its sub-tables) is ever
 *     rewritten; every other byte of the file — including comments, key order,
 *     spacing, and `[[array.of.tables]]` blocks — is copied through verbatim,
 *     IN PLACE (our section does not migrate to the end of the file);
 *   - a file whose shape is not confidently understood is REFUSED, not
 *     rewritten: the writer reports `wrote: false` and says what to do, which
 *     is always better than truncating a config that holds credentials;
 *   - a second identical run writes nothing at all (`unchanged`), so the file's
 *     mtime does not churn.
 */

/** One top-level TOML table header and the text it owns: the header line
 * through the line before the next header (or EOF). Blocks tile the file. */
export interface TomlSection {
  /** Dotted key, unquoted: `[mcp_servers."gestalt".env]` → [mcp_servers, gestalt, env]. */
  key: string[];
  /** True for an array-of-tables header, `[[x]]`. */
  arrayOfTables: boolean;
  /** Offset of the header line's first character. */
  start: number;
  /** Exclusive: offset of the next header line, or the end of the text. */
  end: number;
}

/** What a line leaves open at its end, or `invalid` when it cannot be a line of
 * well-formed TOML (an unterminated single-line string).
 *
 * `depth` is the line's NET bracket delta counted outside strings and comments:
 * a value may be an array that spans lines (`args = [` … `]`), and every line
 * between those two belongs to the value, not to the table structure. Without
 * this, a continuation line such as `  ["a", "b"],` is handed to
 * `parseTableHeader`, which reads it as a malformed header and makes the whole
 * scan (and therefore the whole install) fail on a perfectly legal config. */
type LineTail = { open: '"""' | "'''" | null; depth: number } | "invalid";

/**
 * Walk one line that starts OUTSIDE any string: consume comments and strings so
 * a `[` or `#` inside a value is never mistaken for syntax, report a multi-line
 * string left open at end of line, and count the brackets that are real syntax.
 */
function scanLineTail(s: string): LineTail {
  let i = 0;
  let depth = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "#") return { open: null, depth }; // comment runs to end of line
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (s.startsWith(triple, i)) {
        const close = s.indexOf(triple, i + 3);
        if (close === -1) return { open: triple as '"""' | "'''", depth };
        i = close + 3;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        // Escapes exist in basic strings only; literal strings have none.
        if (ch === '"' && s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === ch) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return "invalid";
      i = j;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    i += 1;
  }
  return { open: null, depth };
}

/** Parse a table header line. `undefined` = not a header; `"invalid"` = starts
 * like one but is not well-formed (so the file must not be rewritten). */
function parseTableHeader(
  line: string,
): { key: string[]; arrayOfTables: boolean } | "invalid" | undefined {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== "[") return undefined;
  i += 1;
  let arrayOfTables = false;
  if (line[i] === "[") {
    arrayOfTables = true;
    i += 1;
  }
  const key: string[] = [];
  for (;;) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
    const q = line[i];
    if (q === '"' || q === "'") {
      let part = "";
      i += 1;
      let closed = false;
      while (i < line.length) {
        if (q === '"' && line[i] === "\\") {
          part += line[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (line[i] === q) {
          closed = true;
          i += 1;
          break;
        }
        part += line[i];
        i += 1;
      }
      if (!closed) return "invalid";
      key.push(part);
    } else {
      const start = i;
      while (i < line.length && /[A-Za-z0-9_-]/.test(line[i]!)) i += 1;
      if (i === start) return "invalid";
      key.push(line.slice(start, i));
    }
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
    if (line[i] === ".") {
      i += 1;
      continue;
    }
    if (line[i] === "]") {
      i += 1;
      if (arrayOfTables) {
        if (line[i] !== "]") return "invalid";
        i += 1;
      }
      break;
    }
    return "invalid";
  }
  // Only whitespace or a comment may follow the header on its line.
  const rest = line.slice(i).trim();
  if (rest !== "" && !rest.startsWith("#")) return "invalid";
  return { key, arrayOfTables };
}

/** Split a TOML text into its table blocks. `null` when the text cannot be
 * scanned confidently (malformed header, unterminated string) — the caller
 * must then refuse to write rather than guess where a section ends. */
function scanTomlSections(text: string): { preamble: number; sections: TomlSection[] } | null {
  const sections: TomlSection[] = [];
  const lines = text.split("\n");
  let open: '"""' | "'''" | null = null;
  let depth = 0; // open array brackets carried across lines (see LineTail.depth)
  let offset = 0;
  let preamble = text.length;

  for (const line of lines) {
    const start = offset;
    offset += line.length + 1; // the "\n" this split consumed (last line overshoots by 1)
    if (open) {
      const idx = line.indexOf(open);
      if (idx === -1) continue;
      const tail = scanLineTail(line.slice(idx + 3));
      if (tail === "invalid") return null;
      open = tail.open;
      depth = Math.max(0, depth + tail.depth);
      continue;
    }
    // Only a line at bracket depth 0 can be a table header; inside a multi-line
    // array a leading `[` is a nested array element, not a section.
    if (depth === 0) {
      const header = parseTableHeader(line);
      if (header === "invalid") return null;
      if (header) {
        if (sections.length === 0) preamble = start;
        const prev = sections[sections.length - 1];
        if (prev) prev.end = start;
        sections.push({ ...header, start, end: text.length });
        continue;
      }
    }
    const tail = scanLineTail(line);
    if (tail === "invalid") return null;
    open = tail.open;
    depth = Math.max(0, depth + tail.depth);
  }
  if (open) return null; // unterminated multi-line string — shape not understood
  if (depth !== 0) return null; // unterminated array — section boundaries unknowable
  if (sections.length === 0) preamble = text.length;
  return { preamble, sections };
}

/** The `[mcp_servers.gestalt]` table body (and its sub-tables' bodies), rendered
 * with `eol` line endings. JSON.stringify escapes are valid TOML basic strings. */
function gestaltTomlSection(serverEntry: ServerEntry, eol: string): string {
  const lines = [
    `[mcp_servers.${MCP_SERVER_KEY}]`,
    `command = ${JSON.stringify(serverEntry.command)}`,
    `args = [${serverEntry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  if (serverEntry.env) {
    // Sub-table AFTER the parent's keys (TOML requires it); the sub-table is
    // replaced as part of the same unit on update, so a dropped env block
    // cannot linger with stale values.
    lines.push("", `[mcp_servers.${MCP_SERVER_KEY}.env]`);
    for (const [k, v] of Object.entries(serverEntry.env)) {
      // Belt and braces: `installMcp` already rejects a key that is not a TOML
      // bare key, but a key that reached here anyway must still be QUOTED, not
      // written raw — `A B = "x"` is a syntax error that costs the host the
      // whole file, sibling API keys included.
      lines.push(`${isBareEnvKey(k) ? k : JSON.stringify(k)} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join(eol);
}

/**
 * Decode strictly: a host config that is not valid UTF-8 (cp1252 from
 * PowerShell 5.1 `Set-Content`, or UTF-16 from `Out-File`) would be mangled by
 * a read-modify-write round trip, and these files hold API keys. Same refusal
 * rule `installRules` applies to rules files.
 *
 * A UTF-8 BOM (EF BB BF) is a different case and must be split off, NOT left in
 * the text: it round-trips through UTF-8 cleanly (so the equality check below
 * accepts it), but it decodes to a leading U+FEFF that sits in front of the
 * first `[` of line 1, and `parseTableHeader` skips only space and tab. The
 * file's FIRST table header would therefore be invisible to the scanner — if
 * that header is `[mcp_servers.gestalt]` we would append a SECOND one and
 * report success, and a duplicate table makes the whole config unparseable for
 * the host (every sibling server and its API keys stop loading). UTF-8-with-BOM
 * is the default of PowerShell 5.1 `Out-File`/`>` and of older Notepad, i.e.
 * exactly how a hand-pasted config on this platform tends to be written, so it
 * is stripped here and re-emitted verbatim by the caller.
 */
function decodeUtf8Strict(raw: Buffer): { bom: string; body: string } | null {
  if (raw.length >= 2) {
    const b0 = raw[0]!;
    const b1 = raw[1]!;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return null;
  }
  if (raw.includes(0)) return null;
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) return null;
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", body: text.slice(1) } : { bom: "", body: text };
}

/* ── The shared read-for-edit front door ───────────────────────────────────
 *
 * Everything above this line — the strict UTF-8 decode, the line scanner, the
 * header parser, the section tiler — is the hardened part, and it is hardened
 * because these files hold API keys. It is exported HERE, as one function with
 * one refusal contract, so a second editor of the same file (see
 * `setGrokCompatHooks` in installHooks.ts, which sets `[compat.claude] hooks`
 * in ~/.grok/config.toml) cannot ship a second, softer parser against the same
 * bytes. The writer and remover below now go through it too, so there is
 * exactly one place that decides a TOML host config is safe to rewrite.
 */

/** A TOML host config, decoded and tiled, ready to be edited by substitution. */
export interface TomlEditView {
  /** UTF-8 BOM held aside; re-emit it verbatim in front of any write. */
  bom: string;
  /** The text WITHOUT the BOM. All offsets below index into this. */
  text: string;
  /** Offset of the first table header (== text.length when there are none). */
  preamble: number;
  /** Table blocks, in file order, tiling `text` from `preamble` to the end. */
  sections: TomlSection[];
  /** The file's dominant line ending. */
  eol: "\r\n" | "\n";
}

/** Either a view safe to edit, or the sentence explaining the refusal. Callers
 * append their own "…do it by hand" instruction, since that differs per key. */
export type TomlReadOutcome = { ok: true; view: TomlEditView } | { ok: false; why: string };

/**
 * Decode + scan a TOML host config for editing, or refuse.
 *
 * Refusal is the point: a config whose shape is not confidently understood is
 * left alone rather than rewritten, because "rewrote most of it" on a file
 * holding someone's API keys is far worse than "did not touch it".
 */
export function readTomlForEdit(raw: Buffer): TomlReadOutcome {
  const decoded = decodeUtf8Strict(raw);
  if (decoded === null) {
    return { ok: false, why: "the file is not valid UTF-8, so rewriting it would corrupt the other sections." };
  }
  const { bom, body: text } = decoded;
  const scan = scanTomlSections(text);
  if (scan === null) {
    return { ok: false, why: "the file could not be read as TOML (malformed table header, or an unterminated string)." };
  }
  return {
    ok: true,
    view: { bom, text, preamble: scan.preamble, sections: scan.sections, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  };
}

/**
 * True when a non-comment line in `body` assigns the dotted key `parts` —
 * either directly (`a.b = …`) or as the head of a longer dotted key
 * (`a.b.c = …`). Each part may be bare or quoted.
 *
 * This is the guard that stops us defining a key twice. TOML makes a duplicate
 * key a hard parse error, so the cost of getting it wrong is not our section
 * misbehaving: it is the host dropping the ENTIRE file, every sibling server
 * and every API key in it, while our command reports success.
 */
export function assignsDottedKey(body: string, parts: string[]): boolean {
  const seg = (p: string): string => `(?:${p}|"${p}"|'${p}')`;
  const pattern = new RegExp(`^[ \\t]*${parts.map(seg).join("[ \\t]*\\.[ \\t]*")}[ \\t]*(?:=|\\.)`);
  return body.split("\n").some((l) => !l.trimStart().startsWith("#") && pattern.test(l));
}

/** True when a non-comment line in `body` assigns the `gestalt` key directly
 * (`gestalt = { … }` under `[mcp_servers]`, or a dotted `mcp_servers.gestalt =`
 * at top level). Writing our table alongside that would define the same key
 * twice, which makes the WHOLE file unparseable for the host. */
function assignsGestaltKey(body: string, dotted: boolean): boolean {
  return assignsDottedKey(body, dotted ? ["mcp_servers", "gestalt"] : ["gestalt"]);
}

/** True when a non-comment top-level line assigns the whole `mcp_servers` map
 * as one inline table (`mcp_servers = { … }`). Distinct from the dotted form
 * `mcp_servers.playwright = { … }`, which IS extensible by a sub-table. */
function assignsMcpServersInlineTable(preamble: string): boolean {
  const pattern = /^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=/;
  return preamble.split("\n").some((l) => !l.trimStart().startsWith("#") && pattern.test(l));
}

/**
 * Ours = the `[mcp_servers.<key>]` table itself, or any sub-table of it, under
 * EITHER the current name or the legacy one.
 *
 * Both names, for the same reason the JSON remover takes both: this predicate
 * is what decides which table gets rewritten on install and removed on
 * uninstall, so matching only the current name would strand every
 * `[mcp_servers.gestalt]` table an older build wrote in a Codex or Grok config
 * — invisible to the command that promises to remove it, and invisible to the
 * install that is supposed to replace it, which would then leave two servers
 * registered against one store.
 */
function isOurKey(key: string[]): boolean {
  if (key.length < 2 || key[0] !== "mcp_servers") return false;
  return key[1] === MCP_SERVER_KEY || key[1] === LEGACY_MCP_SERVER_KEY;
}

/** The env-variable NAMES a removed entry carried, never their values. Used only
 * to tell the user WHICH secret just left disk (`uninstallMcp`). */
function envKeysOfEntry(entry: unknown): string[] {
  if (!entry || typeof entry !== "object") return [];
  const env = (entry as { env?: unknown }).env;
  if (!env || typeof env !== "object") return [];
  return Object.keys(env as Record<string, unknown>);
}

/**
 * Write `[mcp_servers.gestalt]` into a TOML host config (codex, grok).
 *
 * Detection is the DIRECTORY, per house rule: no `~/.grok` means the host is
 * not installed, which is reported, not failed. See the block comment above for
 * the safety contract this implements.
 */
async function writeTomlConfig(
  target: InstallTarget,
  configPath: string,
  serverEntry: ServerEntry,
): Promise<WriterResult> {
  const refuse = (why: string): WriterResult => ({
    target,
    path: configPath,
    wrote: false,
    note: `left unchanged — ${why} Add the [mcp_servers.${MCP_SERVER_KEY}] section by hand.`,
  });

  const dir = path.dirname(configPath);
  if (!existsSync(fsPath(dir))) {
    return {
      target,
      path: configPath,
      wrote: false,
      note: `${target} config folder not found — app not installed? Add the [mcp_servers.${MCP_SERVER_KEY}] section yourself.`,
    };
  }

  if (!existsSync(fsPath(configPath))) {
    const section = gestaltTomlSection(serverEntry, "\n");
    await writeFileAtomicPlain(configPath, section + "\n");
    return { target, path: configPath, wrote: true, note: `created ${path.basename(configPath)} with the ${MCP_SERVER_KEY} server.` };
  }

  // A leading UTF-8 BOM is held aside and re-emitted verbatim, so the scanner
  // sees line 1 starting at its first real character (see `decodeUtf8Strict`).
  const read = readTomlForEdit(readFileSync(fsPath(configPath)));
  if (!read.ok) return refuse(read.why);
  const { bom, text: existing } = read.view;
  const scan = { preamble: read.view.preamble, sections: read.view.sections };

  const ours = scan.sections.filter((s) => isOurKey(s.key));
  if (ours.some((s) => s.arrayOfTables)) {
    return refuse(`[[mcp_servers.${MCP_SERVER_KEY}]] is an array of tables here, which is not a shape this writer produces.`);
  }
  const mains = ours.filter((s) => s.key.length === 2);
  if (mains.length > 1) {
    return refuse(`[mcp_servers.${MCP_SERVER_KEY}] appears more than once, so which one is authoritative is ambiguous.`);
  }
  const mcpServersTable = scan.sections.find((s) => s.key.length === 1 && s.key[0] === "mcp_servers");
  if (
    (mcpServersTable && assignsGestaltKey(existing.slice(mcpServersTable.start, mcpServersTable.end), false)) ||
    assignsGestaltKey(existing.slice(0, scan.preamble), true)
  ) {
    return refuse(`this config defines the ${MCP_SERVER_KEY} server as an inline key rather than a [mcp_servers.${MCP_SERVER_KEY}] table, and adding the table would define it twice.`);
  }
  if (assignsMcpServersInlineTable(existing.slice(0, scan.preamble))) {
    // `mcp_servers = { … }`: a TOML inline table is self-contained and may NOT
    // be extended, so adding [mcp_servers.gestalt] would define `mcp_servers`
    // twice and cost the user every server (and key) in that inline table. The
    // dotted form (`mcp_servers.playwright = { … }`) is fine and not matched.
    return refuse(`this config defines mcp_servers as an inline table, which TOML does not allow a [mcp_servers.${MCP_SERVER_KEY}] table to extend.`);
  }

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const section = gestaltTomlSection(serverEntry, eol);
  const main = mains[0];

  // The replacement covers our main table AND the run of our sub-tables that
  // follows it, so the blank-line separator to keep is the one at the end of
  // that WHOLE run — not the one inside it. Measuring `main` instead adds an
  // extra EOL on every run once an [mcp_servers.gestalt.env] sub-table exists,
  // which breaks the "a second identical run writes nothing" contract for
  // exactly the command encrypted-store users are told to run.
  let lastOfOurs = main;
  if (main) {
    const mainIdx = scan.sections.indexOf(main);
    for (let i = mainIdx + 1; i < scan.sections.length && isOurKey(scan.sections[i]!.key); i += 1) {
      lastOfOurs = scan.sections[i]!;
    }
  }

  // Reassemble from the tiled blocks: every block that is not ours is copied
  // byte-for-byte, and ours is substituted AT ITS OWN POSITION, preserving the
  // blank lines that separated it from the next section.
  const pieces: string[] = [existing.slice(0, scan.preamble)];
  for (const s of scan.sections) {
    const block = existing.slice(s.start, s.end);
    if (!isOurKey(s.key)) {
      pieces.push(block);
      continue;
    }
    if (s !== main) continue; // sub-table of ours: folded into the replacement
    const tailBlock = existing.slice(lastOfOurs!.start, lastOfOurs!.end);
    const trailing = /(?:\r?\n)*$/.exec(tailBlock)![0];
    const blanks = trailing === "" ? 1 : trailing.split(/\r?\n/).length - 1;
    pieces.push(section + eol.repeat(Math.max(1, blanks)));
  }

  let updated = pieces.join("");
  let note: string;
  if (main) {
    note = `updated the existing ${MCP_SERVER_KEY} server section (every other section untouched).`;
  } else {
    const sep = updated === "" ? "" : updated.endsWith(eol + eol) ? "" : updated.endsWith("\n") ? eol : eol + eol;
    updated = updated + sep + section + eol;
    note = `appended the gestalt server section (restart ${target} to pick it up).`;
  }

  if (updated === existing) {
    return { target, path: configPath, wrote: false, unchanged: true, note: "already up to date — nothing written." };
  }
  await writeFileAtomicPlain(configPath, bom + updated);
  return { target, path: configPath, wrote: true, note };
}

/* ══════════════════════════ uninstall-mcp ═══════════════════════════════════
 *
 * `install-mcp` writes up to seven host config files; until now nothing removed
 * them. A tester who tried it and backed out had to hand-edit JSON and TOML
 * across seven files — and if they had used `--env-passthrough
 * GESTALT_PASSPHRASE`, one of those files held their passphrase in plain text.
 * An install path with no uninstall is worse than a hard install.
 *
 * This is the SAME scan with an empty substitution: the same registry, the same
 * detection rule (the host's config DIRECTORY decides whether it is installed),
 * the same parsers, the same per-host reporting, and the same refusal contract —
 *
 *   - a config that cannot be parsed is REFUSED, never rewritten;
 *   - nothing outside `[mcp_servers.gestalt]` / `mcpServers.gestalt` is touched;
 *   - a second run does nothing (idempotent);
 *   - when there is nothing of ours to remove the file is left BYTE-IDENTICAL
 *     (not even reserialized, not even its mtime).
 *
 * Two places deliberately DIVERGE from the writer, both in the same direction —
 * the user asked for our entry to be gone, so ambiguity resolves towards
 * removing more of OURS, never towards touching anything else:
 *
 *   1. duplicate `[mcp_servers.gestalt]` tables. The writer refuses (it cannot
 *      know which one is authoritative). Removal has no such question: both are
 *      ours, both go, and the file comes out parseable again instead of keeping
 *      a duplicate table — and a copy of any secret — that "uninstall" claimed
 *      to have taken away.
 *   2. an INLINE `gestalt = { ... }` key is refused here as it is by the writer,
 *      but for the opposite reason: the writer refuses because adding a table
 *      would define the key twice; removal refuses because the key shares its
 *      line with syntax this module does not edit. Reporting "nothing to
 *      remove" over a live entry — possibly one holding a passphrase — would be
 *      the worst answer available, so it is reported as a refusal naming the
 *      file and what to delete.
 *
 * WHAT THIS DOES NOT DO: there is no `--with-rules` / `--with-hooks` here. See
 * the note on `UninstallMcpOptions`.
 */

/** One host's outcome. Mirrors `WriterResult`, in removal's terms. */
export interface RemoverResult {
  target: InstallTarget;
  path: string;
  /** True when the file was rewritten to drop our entry. */
  removed: boolean;
  /**
   * True when there was nothing of ours to remove and the file was left exactly
   * as found — including the host not being installed here. A SUCCESS, and the
   * other reason `removed` is false; `removed: false` with no `absent` means
   * "would not / could not remove", which is the yellow case.
   */
  absent?: boolean;
  /**
   * `dryRun` only: our entry IS in this file and a real run would take it out.
   * Kept distinct from a refusal so `--dry-run` finding work to do is not
   * reported as a failure, while a config it could not parse still is.
   */
  wouldRemove?: boolean;
  note: string;
  /** Env-variable NAMES the removed entry carried (never their values). */
  envKeys?: string[];
}

export interface UninstallMcpOptions {
  targets?: string[]; // default: all known targets
  /**
   * Report what WOULD be removed and write nothing. Exists because removing an
   * env block is irreversible: it can be the last plaintext copy of the
   * passphrase to an encrypted store.
   */
  dryRun?: boolean;
  // Injectable config paths for tests (never touch real client configs in CI):
  desktopConfigPath?: string;
  cursorConfigPath?: string;
  codexConfigPath?: string;
  geminiConfigPath?: string;
  grokConfigPath?: string;
  windsurfConfigPath?: string;
  /** Injectable `~/.claude.json` for the READ-ONLY claude-code report. */
  claudeCodeConfigPath?: string;
  /*
   * NO `--with-rules` / `--with-hooks`, deliberately.
   *
   * `install-rules --with-hooks` earns its flag: rules and hooks are one layer
   * (what the agent reads, and when it is injected), and `--mode shim` is not
   * even true without the hook. MCP config is a different layer — how a host
   * LAUNCHES the server — and `install-mcp` has no `--with-*` flags at all.
   * Adding them only to the uninstall side would ship a command that removes
   * strictly more than its counterpart installs, with no mirror-image command
   * to put it back. That is how an uninstaller earns a reputation for taking
   * things the user did not offer.
   *
   * The composite that DOES exist is `setup` (init → install-mcp →
   * install-hooks → install-rules → doctor), so the honest home for a
   * one-command back-out is a teardown verb mirroring `setup`, not flags bolted
   * onto one of its three steps. Until that exists, this command prints the two
   * remaining commands verbatim, which keeps the whole back-out on one screen
   * and leaves nothing to guess.
   */
}

export interface UninstallMcpResult {
  removers: RemoverResult[];
  /**
   * Claude Code is add-by-COMMAND (`claude mcp add`), so `install-mcp` prints a
   * line instead of writing `~/.claude.json`. Removal is symmetric: print
   * `claude mcp remove`, and read the file only to say whether there is
   * anything there to remove.
   */
  claudeCode?: {
    command: string;
    path: string;
    /** Read-only: is a `gestalt` entry present in the user-scope map today? */
    registered: boolean;
    /** Env names on that entry — the command below deletes them with it. */
    envKeys?: string[];
  };
  /** Union of env names removed (or, under `dryRun`, that would be). */
  envKeysRemoved: string[];
  dryRun: boolean;
  warnings: Warning[];
}

/**
 * Remove the `gestalt` MCP entry from the host configs `install-mcp` writes.
 *
 * ORDER MATTERS WHEN THE ENTRY HOLDS A SECRET. `--env-passthrough
 * GESTALT_PASSPHRASE` writes the passphrase to an encrypted store into these
 * files in plain text, and for some people that config file is the only place
 * that passphrase exists. Removing it is therefore not a tidy-up: it is a
 * one-way door in one direction and a leak in the other. So this reports the
 * env NAMES it removed (never the values) and warns both ways — keeping the
 * store, make sure you can still open it before removing this; discarding the
 * store, remove this FIRST so no passphrase is left lying in a config file.
 */
export async function uninstallMcp(opts: UninstallMcpOptions = {}): Promise<UninstallMcpResult> {
  const targets = (opts.targets ?? INSTALL_TARGETS) as InstallTarget[];
  const dryRun = opts.dryRun === true;
  const warnings: Warning[] = [];
  for (const t of targets) {
    if (!(INSTALL_TARGETS as string[]).includes(t)) {
      warnings.push({ code: "unknown_target", message: `unknown target "${t}" — known: ${INSTALL_TARGETS.join(", ")}` });
    }
  }

  const result: UninstallMcpResult = { removers: [], envKeysRemoved: [], dryRun, warnings };
  const defaults = new Map(defaultHostConfigFiles().map((h) => [h.target, h]));

  const jsonTargets: Array<{ target: InstallTarget; file: string; key: string }> = [
    { target: "claude-desktop", file: opts.desktopConfigPath ?? defaults.get("claude-desktop")!.file, key: "mcpServers" },
    { target: "cursor", file: opts.cursorConfigPath ?? defaults.get("cursor")!.file, key: "mcpServers" },
    { target: "gemini", file: opts.geminiConfigPath ?? defaults.get("gemini")!.file, key: "mcpServers" },
    { target: "windsurf", file: opts.windsurfConfigPath ?? defaults.get("windsurf")!.file, key: "mcpServers" },
  ];
  for (const jt of jsonTargets) {
    if (!targets.includes(jt.target)) continue;
    // Same refusal as the install side: with no APPDATA there is no file to
    // read, and `path.dirname` of the sentinel would be the process CWD.
    if (jt.file === DESKTOP_CONFIG_UNRESOLVED) {
      result.removers.push({
        target: jt.target,
        path: jt.file,
        removed: false,
        note:
          "APPDATA is not set in this environment, so the Claude Desktop config location " +
          "is unknown and nothing could be checked. If you passed a passphrase through to " +
          "Claude Desktop, remove it by hand from %APPDATA%\\Claude\\claude_desktop_config.json.",
      });
      continue;
    }
    result.removers.push(
      await guardRemove(jt.target, jt.file, () => removeJsonConfig(jt.target, jt.file, jt.key, dryRun)),
    );
  }

  const tomlTargets: Array<{ target: InstallTarget; file: string }> = [
    { target: "codex", file: opts.codexConfigPath ?? defaults.get("codex")!.file },
    { target: "grok", file: opts.grokConfigPath ?? defaults.get("grok")!.file },
  ];
  for (const tt of tomlTargets) {
    if (!targets.includes(tt.target)) continue;
    result.removers.push(await guardRemove(tt.target, tt.file, () => removeTomlConfig(tt.target, tt.file, dryRun)));
  }

  if (targets.includes("claude-code")) {
    // Claude Code owns this file's schema (project scopes, OAuth token state),
    // so `install-mcp` never writes it and neither does this. The command below
    // is the one Claude Code builds for ITSELF: the shipped executable
    // constructs `mcp remove <name> -s <scope>` for scope `user` (verified
    // 2026-07-31 by reading ~/.local/share/claude/versions/2.1.214 on this
    // disk — `TE("mcp remove", name, `-s ${scope}`)`, scopes
    // local|user|project). That same binary states that `claude mcp remove`
    // "permanently deletes the server config (env vars, headers)", which is
    // exactly why the env names are surfaced here rather than left implicit.
    const file = opts.claudeCodeConfigPath ?? defaults.get("claude-code")!.file;
    const seen = readClaudeCodeEntry(file);
    result.claudeCode = {
      // The name that is actually registered, not the one we would write today.
      command: `claude mcp remove ${seen.key ?? MCP_SERVER_KEY} -s user`,
      path: file,
      registered: seen.registered,
      ...(seen.envKeys.length > 0 ? { envKeys: seen.envKeys } : {}),
    };
    if (seen.envKeys.length > 0) {
      warnings.push({
        code: "env_secret_pending",
        message:
          `claude-code still holds an env block (${seen.envKeys.join(", ")}) in PLAIN TEXT at ${file} — ` +
          "this command did not touch that file. Running the printed `claude mcp remove` deletes the entry AND those values.",
      });
    }
  }

  const removedEnv = new Set<string>();
  for (const r of result.removers) for (const k of r.envKeys ?? []) removedEnv.add(k);
  result.envKeysRemoved = [...removedEnv];
  if (removedEnv.size > 0) {
    const hosts = result.removers.filter((r) => (r.envKeys ?? []).length > 0).map((r) => r.target);
    warnings.push({
      code: dryRun ? "env_secret_would_remove" : "env_secret_removed",
      message: dryRun
        ? `${hosts.join(", ")} hold an env block (${result.envKeysRemoved.join(", ")}) in plain text — a real run DELETES those values. ` +
          "If that is the only record of the passphrase to an encrypted store, make sure you can open the store another way first."
        : `removed an env block (${result.envKeysRemoved.join(", ")}) from ${hosts.join(", ")} — those values are gone from disk. ` +
          "Keeping the store: you now need that passphrase (or your 24-word recovery phrase) from somewhere else. " +
          "Discarding the store: this was the right order — no passphrase is left sitting in a config file.",
    });
  }
  return result;
}

/**
 * Read-only peek at the user-scope `mcpServers.gestalt` entry in
 * `~/.claude.json`. Never throws and never writes; an unreadable or non-JSON
 * file simply reports "not registered" — Claude Code's own CLI is the authority
 * on that file, and this is only deciding how loudly to print its command.
 */
function readClaudeCodeEntry(file: string): {
  registered: boolean;
  key?: string;
  envKeys: string[];
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fsPath(file), "utf8"));
    if (!parsed || typeof parsed !== "object") return { registered: false, envKeys: [] };
    const servers = (parsed as Record<string, unknown>)["mcpServers"];
    if (!servers || typeof servers !== "object") return { registered: false, envKeys: [] };
    const map = servers as Record<string, unknown>;
    // Either name. Claude Code is the one host we cannot write, so we print a
    // command for the user to run — and printing `claude mcp remove fimemory`
    // at somebody whose entry is still registered under the legacy name would
    // be advice that silently does nothing. Report which name is actually
    // there so the caller can print the command that matches reality.
    const foundKey =
      map[MCP_SERVER_KEY] !== undefined
        ? MCP_SERVER_KEY
        : map[LEGACY_MCP_SERVER_KEY] !== undefined
          ? LEGACY_MCP_SERVER_KEY
          : null;
    if (foundKey === null) return { registered: false, envKeys: [] };
    return { registered: true, key: foundKey, envKeys: envKeysOfEntry(map[foundKey]) };
  } catch {
    return { registered: false, envKeys: [] };
  }
}

/** `guardWrite`'s twin: a thrown read/write failure becomes that host's row, so
 * one unreadable config cannot abort the report for the hosts after it. */
async function guardRemove(
  target: InstallTarget,
  file: string,
  run: () => Promise<RemoverResult>,
): Promise<RemoverResult> {
  try {
    return await run();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { target, path: file, removed: false, note: `left unchanged — the removal failed: ${why}` };
  }
}

/** Delete `[key].gestalt` from a JSON host config, atomically + codec-free. */
async function removeJsonConfig(
  target: InstallTarget,
  configPath: string,
  key: string,
  dryRun: boolean,
): Promise<RemoverResult> {
  const base = { target, path: configPath };
  const absent = (note: string): RemoverResult => ({ ...base, removed: false, absent: true, note });
  const refuse = (why: string): RemoverResult => ({
    ...base,
    removed: false,
    note: `left unchanged — ${why} Delete our entry ("${MCP_SERVER_KEY}", or legacy "${LEGACY_MCP_SERVER_KEY}") under "${key}" by hand.`,
  });

  if (!existsSync(fsPath(path.dirname(configPath)))) {
    return absent(`${target} config folder not found — app not installed here; nothing to remove.`);
  }
  if (!existsSync(fsPath(configPath))) return absent(`no ${target} config file — nothing to remove.`);

  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(fsPath(configPath), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return refuse("existing config is not a JSON object.");
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return refuse("existing config is not valid JSON.");
  }

  const servers = config[key];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return absent(`no "${key}" map in this config — nothing to remove.`);
  }
  const map = servers as Record<string, unknown>;
  // BOTH names, always. `install-mcp` writes only the current key, but this
  // command's whole promise is that it removes what we put there — and older
  // builds put the legacy key in these same files. Looking for the new name
  // alone would leave every pre-rename entry stranded: invisible to the tool
  // that exists to remove it, in seven config files, some of which hold the
  // user's passphrase in plain text via --env-passthrough.
  const ourKeys = [MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEY].filter(
    (k, i, all) => all.indexOf(k) === i && Object.prototype.hasOwnProperty.call(map, k),
  );
  if (ourKeys.length === 0) {
    // Byte-identical: return BEFORE any write, so the file is not even
    // reserialized — reformatting someone else's config for nothing is still
    // touching it, and it churns the mtime of a file that may hold API keys.
    return absent(`no ${MCP_SERVER_KEY} entry under "${key}" — nothing to remove.`);
  }

  const named = ourKeys.map((k) => `"${k}"`).join(" and ");
  // Union across both entries: an upgraded machine can carry a passphrase in
  // the legacy entry's env and not the new one, and the user must be told which
  // secrets just left disk regardless of which name carried them.
  const envKeys = [...new Set(ourKeys.flatMap((k) => envKeysOfEntry(map[k])))];
  const withEnv = envKeys.length > 0 ? { envKeys } : {};
  if (dryRun) {
    return { ...base, removed: false, wouldRemove: true, note: `would remove the ${named} server entry.`, ...withEnv };
  }

  const nextMap = { ...map };
  for (const k of ourKeys) delete nextMap[k];
  // The now-possibly-empty `mcpServers` map is LEFT IN PLACE. We only ever
  // added a key inside it; deleting the map itself would remove structure the
  // host (or the user) owns, which is precisely the sibling damage this command
  // exists to avoid.
  const next = { ...config, [key]: nextMap };
  await writeFileAtomicPlain(configPath, JSON.stringify(next, null, 2) + "\n");
  return {
    ...base,
    removed: true,
    note: `removed the ${named} server entry (restart ${target} to drop it).`,
    ...withEnv,
  };
}

/** Env names declared by our TOML section: the `[mcp_servers.gestalt.env]`
 * sub-table's bare/quoted keys, plus an inline `env = { ... }` on the main
 * table (a hand-written shape this module never emits but must still report,
 * because the user needs to know a secret just left disk either way). */
function tomlEnvKeys(text: string, sections: TomlSection[], mains: TomlSection[]): string[] {
  const keys = new Set<string>();
  const bodyLines = (s: TomlSection): string[] =>
    text
      .slice(s.start, s.end)
      .split("\n")
      .slice(1)
      .filter((l) => !l.trimStart().startsWith("#"));
  const keyOf = (s: string): string | undefined => {
    const m = /^[ \t]*(?:([A-Za-z0-9_-]+)|"([^"]*)"|'([^']*)')[ \t]*=/.exec(s);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };

  for (const s of sections) {
    if (!isOurKey(s.key) || s.key.length !== 3 || s.key[2] !== "env") continue;
    for (const line of bodyLines(s)) {
      const k = keyOf(line);
      if (k) keys.add(k);
    }
  }
  for (const main of mains) {
    for (const line of bodyLines(main)) {
      const m = /^[ \t]*env[ \t]*=[ \t]*\{(.*)\}/.exec(line);
      if (!m) continue;
      for (const part of m[1]!.split(",")) {
        const k = keyOf(part);
        if (k) keys.add(k);
      }
    }
  }
  return [...keys];
}

/**
 * Remove `[mcp_servers.gestalt]` (and its sub-tables) from a TOML host config.
 *
 * Same scan as the writer, empty substitution: every block that is not ours is
 * copied byte-for-byte, and ours are dropped along with the blank-line seam
 * they own — so `install-mcp` then `uninstall-mcp` returns the config to the
 * bytes it had before the install.
 */
async function removeTomlConfig(
  target: InstallTarget,
  configPath: string,
  dryRun: boolean,
): Promise<RemoverResult> {
  const base = { target, path: configPath };
  const absent = (note: string): RemoverResult => ({ ...base, removed: false, absent: true, note });
  const refuse = (why: string): RemoverResult => ({
    ...base,
    removed: false,
    note: `left unchanged — ${why} Delete the [mcp_servers.${MCP_SERVER_KEY}] (or legacy [mcp_servers.${LEGACY_MCP_SERVER_KEY}]) section by hand.`,
  });

  if (!existsSync(fsPath(path.dirname(configPath)))) {
    return absent(`${target} config folder not found — app not installed here; nothing to remove.`);
  }
  if (!existsSync(fsPath(configPath))) return absent(`no ${target} config file — nothing to remove.`);

  const read = readTomlForEdit(readFileSync(fsPath(configPath)));
  if (!read.ok) return refuse(read.why);
  const { bom, text: existing } = read.view;
  const scan = { preamble: read.view.preamble, sections: read.view.sections };

  const ours = scan.sections.filter((s) => isOurKey(s.key));
  if (ours.length === 0) {
    // No table of ours — but an INLINE `gestalt = { ... }` is still a live
    // entry. Reporting "nothing to remove" over it would be a false all-clear,
    // and if it carries a passphrase that false all-clear is the whole hazard.
    const mcpServersTable = scan.sections.find((s) => s.key.length === 1 && s.key[0] === "mcp_servers");
    const preamble = existing.slice(0, scan.preamble);
    const inlineUnderTable =
      mcpServersTable !== undefined &&
      assignsGestaltKey(existing.slice(mcpServersTable.start, mcpServersTable.end), false);
    const inlineDotted = assignsGestaltKey(preamble, true);
    const inlineWholeMap =
      assignsMcpServersInlineTable(preamble) &&
      preamble.split("\n").some((l) => !l.trimStart().startsWith("#") && /\bgestalt\b/.test(l));
    if (inlineUnderTable || inlineDotted || inlineWholeMap) {
      return refuse(
        "this config declares our server as an inline key sharing a line with other syntax, which this remover will not edit.",
      );
    }
    return absent(`no [mcp_servers.${MCP_SERVER_KEY}] section — nothing to remove.`);
  }

  if (ours.some((s) => s.arrayOfTables)) {
    return refuse(`[[mcp_servers.${MCP_SERVER_KEY}]] is an array of tables here, which is not a shape this writer produces.`);
  }

  const mains = ours.filter((s) => s.key.length === 2);
  const envKeys = tomlEnvKeys(existing, scan.sections, mains);
  const withEnv = envKeys.length > 0 ? { envKeys } : {};
  if (dryRun) {
    return {
      ...base,
      removed: false,
      wouldRemove: true,
      // Name the section actually matched — after the rename it can be either.
      note: `would remove the ${mains[0]?.key[1] ?? MCP_SERVER_KEY} server section.`,
      ...withEnv,
    };
  }

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const pieces: string[] = [existing.slice(0, scan.preamble)];
  for (const s of scan.sections) {
    if (isOurKey(s.key)) continue; // dropped, along with the seam it owned
    pieces.push(existing.slice(s.start, s.end));
  }
  let updated = pieces.join("");
  // Our section was LAST in the file, so removing it can leave behind the
  // blank-line separator `install-mcp`'s append path added.
  //
  // That separator is added ONLY when the file did not already end in a blank
  // line (`sep = updated.endsWith(eol+eol) ? "" : …`), so the only trailing run
  // it can produce is EXACTLY TWO newlines. A longer run was the user's own and
  // belongs to the PRECEDING block, not to us: collapsing it unconditionally
  // deleted blank lines nobody of ours wrote, which made the module's own
  // "install-mcp then uninstall-mcp returns the config to the bytes it had"
  // contract false and showed up as an unexplained whitespace change in a
  // version-controlled dotfile.
  //
  // Residual ambiguity, stated rather than papered over: a file that ALREADY
  // ended in exactly two newlines got no separator, and after removal is
  // indistinguishable from one that did. Two is collapsed to one, because a
  // config ending in a single newline is overwhelmingly the common input.
  const tail = /(?:\r?\n)*$/.exec(updated)![0];
  const tailCount = tail === "" ? 0 : tail.split(/\r?\n/).length - 1;
  if (isOurKey(scan.sections[scan.sections.length - 1]!.key) && updated !== "" && tailCount === 2) {
    updated = updated.replace(/(?:\r?\n)+$/, eol);
  }

  if (updated === existing) return absent("no gestalt section to remove — nothing written.");
  // A file that held ONLY our section becomes empty rather than being deleted:
  // an empty config.toml is valid TOML and harmless, and unlinking a file we
  // cannot prove we created is not a risk an uninstaller should take.
  await writeFileAtomicPlain(configPath, bom + updated);
  return {
    ...base,
    removed: true,
    note:
      mains.length > 1
        ? `removed ${mains.length} duplicate gestalt server sections (every other section untouched; restart ${target}).`
        : `removed the gestalt server section (every other section untouched; restart ${target}).`,
    ...withEnv,
  };
}
