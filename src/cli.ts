#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIN, PRODUCT, passphraseExample, readEnv } from "./brand.js";
import { clipboardHint, copyToClipboardDetailed, readClipboardDetailed } from "./clipboard.js";
import { insertionDiff } from "./diff.js";
import { GestaltError } from "./errors.js";
import type { Warning } from "./errors.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { catNote } from "./ops/cat.js";
import { createTopic } from "./ops/create.js";
import { STALE_WINDOW_LABEL, runDoctor, humanMs } from "./ops/doctor.js";
import { exportPlaintext } from "./ops/exportOp.js";
import { get } from "./ops/get.js";
import { ingest } from "./ops/ingest.js";
import { brief, DEFAULT_LOG_TAIL, HOOK_BUDGET_MS, isNonHumanPrompt } from "./ops/brief.js";
import { INSTALL_TARGETS, installMcp, uninstallMcp } from "./ops/installMcp.js";
import {
  GROK_COMPAT_COST,
  GROK_COMPAT_KEY,
  GROK_COMPAT_OFFER,
  GROK_HOOKS_BEHAVIOUR,
  installHooks,
  readGrokCompat,
  setGrokCompatHooks,
  uninstallHooks,
} from "./ops/installHooks.js";
import {
  RULES_HOST_IDS,
  RULES_WRITABLE_HOST_IDS,
  installRulesAll,
  rulesBlock,
  rulesHostDetected,
  rulesHosts,
  uninstallRulesAll,
} from "./ops/installRules.js";
import type { RulesHostOutcome, RulesMode } from "./ops/installRules.js";
import { list } from "./ops/list.js";
import { migrateToEncrypted } from "./ops/migrateEncrypt.js";
import { migrateToPlaintext } from "./ops/migrateDecrypt.js";
import { runStdioServer } from "./mcp/server.js";
import { appendLog } from "./ops/logOp.js";
import { mergeTopics } from "./ops/merge.js";
import { emptyRemainingVerdict, hostMatrix, remainingSteps, renderTwoScores, runOnboard } from "./ops/onboard.js";
import { compact } from "./ops/compact.js";
import { pack } from "./ops/pack.js";
import { reindexStore } from "./ops/reindexOp.js";
import { buildDemoStore } from "./ops/demoStore.js";
import { loadConfig } from "./config.js";
import { resolveHome, storePaths } from "./paths.js";
import {
  peekSessionCache,
  readSessionCache,
  sweepSessionCache,
  wipeAllSessionCaches,
  wipeSessionCache,
  writeSessionCache,
} from "./sessionKeyCache.js";
import { recordRead } from "./telemetry.js";
import {
  reviewApprove,
  reviewList,
  reviewReject,
  reviewShow,
} from "./ops/review.js";
import { search } from "./ops/search.js";
import { runSetup } from "./ops/setup.js";
import type { SetupDetail, SetupStep } from "./ops/setup.js";
import { seedAfterInit } from "./ops/seed.js";
import type { SeedResult } from "./ops/seed.js";
import { SUPPORTERS_FILE, readSupporters } from "./ops/supporters.js";
import { updateTopic } from "./ops/update.js";
import { activateDek, clearActiveKey } from "./store/codec.js";
import {
  assertEnvKeyMatchesStore,
  keyringExists,
  recover,
  storeHasSealedContent,
  unlockWithPassphrase,
} from "./store/keyring.js";
import { splitOwnerNotes } from "./store/ownerNotes.js";

// ---- tiny ANSI helper (off when piped or NO_COLOR) ----
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = {
  b: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

const out = (s = ""): void => {
  process.stdout.write(s + "\n");
};
const fmt = (n: number): string => n.toLocaleString("en-US");

const USAGE = `${PRODUCT} — your shared memory for AI tools

Start here:
  setup [--encrypted [--passphrase "..."]]
                               Create the store IF NEEDED, then connect it to every AI
                               tool on this machine (MCP + rules + hook) and check it.
                               Safe to re-run. This is the one command most people want.
                               --encrypted NEEDS a passphrase: this flag, or GESTALT_PASSPHRASE.
  onboard [--status]           The guided first-win path, AFTER setup: run the review
                               loop once, put your first real facts in, see a search
                               answer with them, and learn what each tool still needs.
                               --status (or a non-interactive terminal): report the two
                               scores (Connect / Content) and the remaining steps, ask nothing.

Everyday:
  init [--encrypted] [--no-seed]   Create your store ONLY — nothing reads it until you
                               run \`setup\` (starter topics included; --no-seed skips them)
  status                       Store path, topics, suggested edits, read budget
  list                         Your topics, newest first
  search <words...>            Find topics (search first, then read a few)
  get <id...> [--log-tail N]   Read topics within a budget
  create <id> --title "..."    Start a new topic
  log <id> --type T --project P -m "..."   Add a typed changelog entry
    [--refs repo#path[@sha],...]  Comma-separated file refs this entry is grounded in
                               (portable repo#path[@sha], or an absolute path —
                               stored machine-scoped as ~machineId:/abs/path)

Trust:
  doctor                       Check the whole setup — store mode, key sources, MCP registration, rules, last read
  update <id> [--file f | -]   Suggest a note edit (waits for your ok)
  review [list|show N|approve N|reject N]   See and apply suggested edits
  fold <id> [--since TS]       Get a compaction work packet (alias: compact)

Your files (you own them):
  export --plaintext <dir>     Write every note, log + suggested edit as plain .md you can read anywhere
  cat <id>                     Print one topic's note as plain text

Sharing:
  pack <id...> [--for grok]    Copy a brief for a web chat (clipboard + screen)
  ingest [--clipboard]         File what a session learned (paste or clipboard)
  brief|context <prompt...>    Budgeted retrieval inject for a prompt (search→top-2 get)
    [--session-id S] [--json]  Human or JSON; empty when nothing relevant

Connect an AI tool (\`setup\` runs all of these for you):
  mcp                          Run the MCP server (for Claude Desktop/Code)
  install-mcp [targets...]     Write MCP config (claude-code, claude-desktop, cursor,
                               codex, gemini, grok, windsurf; default: all)
    [--env K=V]... [--env-passthrough KEY]...   Optional env block for the server —
    values are written into host configs in PLAIN TEXT (your explicit choice;
    default writes none). Encrypted stores: e.g. --env-passthrough GESTALT_PASSPHRASE
  uninstall-mcp [targets...]   Remove that config again — same hosts, same files,
                               nothing else in them touched (default: all)
    [--dry-run]                Say what would go, write nothing. Use this first if
    you passed --env-passthrough: removal deletes that plaintext passphrase too,
    and for some people the config file is the only copy of it
  install-rules [hosts...] [--mode rules|shim]   Write the memory rule block (§2.5 or §2.5b)
    no hosts named: every host DETECTED on this machine (claude-code, codex,
    gemini, grok, windsurf); name hosts to target just those; --list-hosts to
    see them all and where each keeps its rules file
    --mode shim is the "context is already injected" wording; it is written only
    where the retrieval hook actually RUNS (today: Claude Code, the host
    install-hooks writes). Every other host gets the search-first block, and
    --list-hosts states the per-host reason rather than a blanket platform claim
    [--file f]                 Write to one exact file instead (any host we don't know)
      a target ending in .mdc gets Cursor's required alwaysApply frontmatter,
      so --file .cursor/rules/fimemory.mdc is a working Cursor project rule
    [--print]                  Write the block to stdout and touch nothing, for
      hosts whose global rules live in a settings UI with no file underneath
      (Cursor's Customize -> Rules). Copy, paste, done.
  uninstall-rules [hosts...] [--file f]   Remove exactly that block, nothing else
    (no hosts named: every rules file that has one)
  install-hooks [--capture]    Install Claude Code retrieve hooks; --capture adds SessionEnd capture (opt-in)
  uninstall-hooks              Remove only the fimemory shim hooks
  grok-compat [--off|--on]     Grok CLI also reads ~/.claude/settings.json for hooks, loads the two
                               handlers install-hooks writes, drops their \`args\` (its schema has no
                               such field) and spawns a process that dies on every Grok prompt.
                               No arguments: report the state, write nothing.
                               --off: set [compat.claude] hooks = false in ~/.grok/config.toml.
                                 THIS IS GLOBAL TO GROK — it stops Grok honouring EVERY Claude hook,
                                 not just ours, including any you add later. One marked line, in a
                                 file we do not own, that you can delete by hand.
                               --on: the exact inverse.
  hook-retrieve                Pure-stdout hook entry (stdin JSON → additionalContext); fail-open
  hook-capture                 SessionEnd capture (stdin JSON + transcript_path → worklog proposal); fail-open
  join <git-url> [--keyring f] Clone a shared encrypted store; import keyring OOB, reindex, install-rules, doctor
  pull                         git pull the store remote, then reindex (refreshes catalog + watermark)

Maintenance:
  merge <loser> <winner>       Fold one topic into another
  reindex                      Rebuild the catalog from your files
  demo <dir>                   Build the try-it store (invented studio history) at <dir>
  encrypt                      Encrypt an existing plaintext store at rest (prints a 24-word recovery phrase)
  decrypt [--yes-plaintext-remote] [--remove-backup]
                               Convert an encrypted store back to plaintext (needs it UNLOCKED;
                               keeps keyring.json as keyring-archived.json so you can re-encrypt later,
                               and keeps an encrypted backup beside the store unless --remove-backup)
  unlock [--passphrase "..."]  Unlock now and warm the session key cache (prints time remaining)
  lock                         Forget ALL cached session keys now (--home <path>: just that store's; --status: show warm/cold without wiping)
  recover --mnemonic "..." --passphrase "<new>"   Reset a forgotten passphrase with your 24-word phrase

About:
  supporters                   Print the ${SUPPORTERS_FILE} that ships with this package (opt-in credit)

Options: --home <path>  --json  --strict  --allow-owner-notes  -h/--help  --version
Encrypted stores: --encrypted (setup, init) — always with --passphrase "..." or GESTALT_PASSPHRASE
  --passphrase "..." also unlocks an existing store (unlock, recover)
  One unlock keeps commands fast for ~8h (config sessionKeyCacheTtlHours; 0 disables; fimemory lock ends it)`;

interface Args {
  command: string | undefined;
  positionals: string[];
  home: string | undefined;
  json: boolean;
  strict: boolean;
  new: boolean;
  allowOwnerNotes: boolean;
  clipboard: boolean;
  /** Repeatable `--env KEY=VALUE` pairs (install-mcp). */
  envPairs: string[];
  /** Repeatable `--env-passthrough KEY` keys (install-mcp). */
  envPassthrough: string[];
  values: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: undefined,
    positionals: [],
    home: undefined,
    json: false,
    strict: false,
    new: false,
    allowOwnerNotes: false,
    clipboard: false,
    envPairs: [],
    envPassthrough: [],
    values: {},
  };
  const valueFlags = new Set([
    "home", "title", "type", "project", "message", "m", "body",
    "supersedes", "refs", "file", "proposer", "for", "log-tail", "since", "passphrase", "mnemonic",
    "mode", "session-id", "budget-ms", "shim-id", "keyring",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") a.json = true;
    else if (arg === "--strict") a.strict = true;
    else if (arg === "--new") a.new = true;
    else if (arg === "--allow-owner-notes") a.allowOwnerNotes = true;
    else if (arg === "--clipboard") a.clipboard = true;
    else if (arg === "-h" || arg === "--help") a.values["help"] = "1";
    else if (arg === "--version" || arg === "-v") a.values["version"] = "1";
    // Repeatable flags (install-mcp): the generic path keeps ONE value per key,
    // so these are collected before it. `--env KEY=VALUE` values contain "=",
    // which the generic `--key=value` split would mangle anyway.
    else if (arg === "--env-passthrough") a.envPassthrough.push(argv[++i] ?? "");
    else if (arg.startsWith("--env-passthrough=")) a.envPassthrough.push(arg.slice("--env-passthrough=".length));
    else if (arg === "--env") a.envPairs.push(argv[++i] ?? "");
    else if (arg.startsWith("--env=")) a.envPairs.push(arg.slice("--env=".length));
    else if (arg.startsWith("--") || arg === "-m") {
      const key = arg === "-m" ? "message" : arg.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        a.values[normalizeKey(key.slice(0, eq))] = key.slice(eq + 1);
      } else if (valueFlags.has(key)) {
        a.values[normalizeKey(key)] = argv[++i] ?? "";
      } else {
        a.values[normalizeKey(key)] = "1";
      }
    } else if (a.command === undefined) a.command = arg;
    else a.positionals.push(arg);
  }
  a.home = a.values["home"];
  return a;
}

function normalizeKey(k: string): string {
  return k === "m" ? "message" : k;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function renderWarnings(warnings: Warning[]): void {
  for (const w of warnings) {
    out(c.yellow(`  ! ${w.message}${w.id ? ` (${w.id})` : ""}`));
  }
}

/** One host's line for install-rules / uninstall-rules, in install-mcp's shape:
 * what happened, the file underneath it, then any host gotcha that decides
 * whether a WRITTEN block is ever actually read. */
function renderRulesOutcome(h: RulesHostOutcome, withMode = false): void {
  // The mode is PER HOST: a host with no retrieval hook is downgraded from
  // shim to the search-first block, so one global `(mode=…)` suffix would be a
  // false claim about it.
  const tail = withMode && h.mode ? ` (mode=${h.mode})` : "";
  const line =
    h.action === "installed"
      ? c.green(`${h.host}: installed the memory rule block${tail}`)
      : h.action === "replaced"
        ? c.green(`${h.host}: replaced the memory rule block${tail}`)
        : h.action === "unchanged"
          ? c.dim(`${h.host}: already up to date${tail} — nothing written`)
          : h.action === "removed"
            ? c.green(`${h.host}: removed the memory rule block — text outside the markers was not touched`)
            : h.action === "absent"
              ? c.dim(`${h.host}: no memory rule block — nothing to remove`)
              : h.action === "failed"
                ? c.red(`${h.host}: FAILED — ${h.reason ?? "unknown error"}`)
                : c.yellow(`${h.host}: skipped — ${h.reason ?? "nothing to do"}`);
  out(line);
  if (h.path) out(c.dim(`      ${h.path}`));
  for (const note of h.notes) out(c.yellow(`      ! ${note}`));
}

/** One `setup` step: a marked headline, then one SHORT line per host.
 * Deliberately not the underlying verbs' own output — five verbs' worth of
 * report scrolls the answer off screen, which is its own kind of silence. */
function renderSetupStep(s: SetupStep): void {
  // A step can SUCCEED and still carry bad news — `doctor` runs fine and
  // reports failures, and `init` can seed-fail without failing the init. A
  // green tick over "1 finding needs attention" reads as "all good", which is
  // exactly the false-reassurance this command was built to end. So a step
  // holding any `fail` detail gets the warning mark, not the tick.
  const hasBadNews = s.details.some((d) => d.outcome === "fail");
  const mark =
    s.status === "failed"
      ? c.red("✗")
      : s.status === "skipped"
        ? c.dim("–")
        : hasBadNews
          ? c.yellow("!")
          : c.green("✓");
  out(`  ${mark} ${c.b(s.step)}: ${s.status === "failed" ? c.red(s.summary) : s.summary}`);
  for (const d of s.details) renderSetupDetail(d);
  out();
}

function renderSetupDetail(d: SetupDetail): void {
  const paint = d.outcome === "ok" ? c.dim : d.outcome === "fail" ? c.red : c.yellow;
  out(paint(`      ${d.name}: ${d.text}`));
  for (const note of d.notes ?? []) out(c.yellow(`        ! ${note}`));
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // "EVERY gestalt invocation sweeps" includes `--version`, `--help`, and
  // bare `gestalt`, which return before the store-aware sweep below — so the
  // no-store sweep runs FIRST, ahead of the early returns (it is a readdir of
  // a near-empty dir, and it never throws). Without this, the cheapest
  // commands were the ones that left an expired key on disk untouched.
  sweepSessionCache();
  if (args.values["version"]) {
    // Read name/version from the package's own package.json (dist/cli.js →
    // ../package.json) so the same source is honest in BOTH trees: the private
    // repo prints `gestalt-runtime 0.0.0`, the staged export `fimemory 0.1.0`
    // (guide Phase D.4: --version matches package.json).
    try {
      const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      out(`${pkg.name ?? "gestalt-runtime"} ${pkg.version ?? "0.0.0"}`);
    } catch {
      out("gestalt-runtime 0.0.0");
    }
    return 0;
  }
  if (args.values["help"] || args.command === undefined) {
    out(USAGE);
    return args.command === undefined && !args.values["help"] ? 1 : 0;
  }

  const homePath = resolveHome(args.home !== undefined ? { home: args.home } : {});
  const opts = { home: homePath };

  try {
    // E2c sweep — on EVERY invocation, not just warm reads: expired entries
    // (any store's), this store's entry when the CURRENT config TTL says it
    // is too old (lowering the TTL is retroactive; 0 wipes on sight), and
    // orphaned temp files are deleted whenever the CLI runs at all —
    // regardless of command, GESTALT_KEY, or ttl config. Without this the TTL
    // existed only at read time: unlock once, stop using the CLI, and the
    // plaintext DEK outlived its window indefinitely. (A machine that never
    // runs gestalt again still cannot sweep itself — that residue is stated
    // honestly in sessionKeyCache.ts and the SPEC; `fimemory lock` is the
    // answer before lending/decommissioning a machine.)
    const ttlMs =
      loadConfig(storePaths(homePath).config).config.sessionKeyCacheTtlHours * 3_600_000;
    sweepSessionCache({ home: homePath, ttlMs });

    // Unlock an encrypted store before any op that touches it. Encryption is
    // determined by the store's CONTENT (sealed files), not just keyring.json —
    // so deleting the keyring can't downgrade a sealed store to plaintext (M4).
    // `lock` is exempt like `init`: wiping the session cache must never itself
    // demand the passphrase (it is the command for people who DON'T want a
    // usable key lying around).
    // `encrypt` is exempt like `init`/`lock`: it is the command that ADDS
    // encryption to a plaintext store (where the gate is a no-op anyway), and on
    // an already-encrypted store it must reach its own clean "already encrypted"
    // refusal rather than have the gate demand a passphrase for a command that
    // is about to refuse.
    // Gate-exempt commands, each for its own stated reason:
    //   init/lock/encrypt — the original exemptions (see above);
    //   mcp — GRACEFUL LOCKED: the server must START against a locked store and
    //     answer every tool call with a structured E_LOCKED (retrying the
    //     unlock chain lazily per call) instead of dying at spawn — the gate
    //     moved into mcp/tools.ts. Every other command keeps its current
    //     locked behavior;
    //   doctor — diagnoses a LOCKED store read-only; a doctor that demands the
    //     passphrase can't tell you why the passphrase path is broken;
    //   unlock-status via `lock --status` rides lock's existing exemption;
    //   install-rules/uninstall-rules — never touch the store at all;
    //   install-hooks/uninstall-hooks — host settings only, no store;
    //   uninstall-mcp — host config files only, and it must work on a store
    //     nobody can unlock: backing out of an encrypted store you have lost
    //     the passphrase to is EXACTLY when the plaintext passphrase sitting in
    //     seven host configs most needs removing. A passphrase gate on the
    //     command that deletes the passphrase would be a locked door with the
    //     key taped to it;
    //   hook-retrieve / hook-capture — FAIL-OPEN: must exit 0 empty when locked,
    //     never throw a passphrase demand into the host's prompt path.
    //   join — may create a new home; passphrase is user-guided, not env-gated.
    //   setup — composes init + the three install verbs + doctor, none of which
    //     read store CONTENT. It must run to completion on a LOCKED store (the
    //     common case: an encrypted store on a fresh machine, wired up before
    //     anyone types a passphrase) and let its doctor step report the lock,
    //     rather than refuse the one command that fixes a disconnected install.
    const gateExempt = new Set([
      "init",
      "setup",
      "lock",
      "encrypt",
      "mcp",
      "doctor",
      "install-rules",
      "uninstall-rules",
      "install-hooks",
      "uninstall-hooks",
      // grok-compat — edits ONE key in ~/.grok/config.toml and reads Claude's
      // settings.json. No store content, in either direction.
      "grok-compat",
      // install-mcp and uninstall-mcp are the same kind of operation in both
      // directions: they read package.json to find the CLI path, then edit a
      // HOST's config file. Neither touches store content, so neither needs the
      // key. uninstall-mcp was exempt and install-mcp was not, which meant a
      // user with an encrypted store could REMOVE a connection without their
      // passphrase but not ADD one. Found by running install-mcp against a real
      // encrypted store; every sandbox test uses a plaintext one, so the
      // asymmetry never surfaced. `setup` was already exempt for exactly this
      // reason, which is why the composed path worked while the direct command
      // did not.
      "install-mcp",
      "uninstall-mcp",
      "hook-retrieve",
      "demo", // builds a NEW plaintext store at an explicit dir; never reads this one
      "hook-capture",
      "join",
      // supporters — reads a file shipped INSIDE the package, never the store.
      // Demanding a passphrase before printing a thank-you list would be a
      // pure insult to the user: there is nothing of theirs to unlock here.
      "supporters",
    ]);
    // `onboard`'s STATUS shape (--status, --json, or a terminal that cannot
    // ask questions) is a pure read-only repackaging of doctor — the verb that
    // is gate-exempt by charter — and doctor's content arm even ships a
    // purpose-built "not assessed — encrypted store" rendering for exactly the
    // locked case. Gating it printed an unlock demand instead of the scores,
    // right after `setup --encrypted` on a fresh machine (the common case
    // setup's own exemption names). The INTERACTIVE shape stays gated: it
    // writes, so it genuinely needs the key.
    const onboardStatusOnly =
      args.command === "onboard" &&
      (args.values["status"] === "1" ||
        args.json ||
        process.stdin.isTTY !== true ||
        process.stdout.isTTY !== true);
    const encrypted =
      !gateExempt.has(args.command) &&
      !onboardStatusOnly &&
      (keyringExists(homePath) || storeHasSealedContent(homePath));
    if (encrypted) {
      if (process.env.GESTALT_KEY) {
        // Power-user raw key: verify it is THIS store's key (binds to keyring
        // kid, or to the ciphertext when the keyring is gone). keyState uses it.
        assertEnvKeyMatchesStore(homePath, process.env.GESTALT_KEY);
      } else if (args.command !== "recover") {
        if (!keyringExists(homePath)) {
          throw new GestaltError(
            "E_STORE_MODE",
            "This store is encrypted but keyring.json is missing.",
            `Recover with your phrase: fimemory recover --mnemonic "..." --passphrase "<new>"`,
          );
        }
        // Session key cache (E2c): one passphrase unlock caches the DEK
        // OUTSIDE the store for `sessionKeyCacheTtlHours` (default 8 h, 0 =
        // off), so one-shot CLI commands skip the ~1.5 s Argon2id tax. An
        // explicit `--passphrase` flag is an explicit act and always derives
        // (so a wrong flag is reported, never masked by a warm cache) — and
        // "explicit" is PRESENCE, not truthiness: `--passphrase ""` (a CI
        // script whose variable silently unset) must fail like the wrong
        // passphrase it is, never be masked by a warm cache into "working".
        const explicit = "passphrase" in args.values ? args.values["passphrase"] : undefined;
        let unlocked = false;
        if (explicit === undefined && ttlMs > 0) {
          const cachedHex = readSessionCache(homePath, Date.now(), { ttlMs });
          if (cachedHex) {
            try {
              // The exact verification GESTALT_KEY gets (kid + ciphertext
              // binding) — the cache adds convenience, never a new trust path.
              assertEnvKeyMatchesStore(homePath, cachedHex);
              activateDek(Uint8Array.from(Buffer.from(cachedHex, "hex")));
              unlocked = true;
            } catch {
              // Stale (re-inited store, foreign file): fail CLOSED into the
              // ordinary passphrase path below — never a scary error, and the
              // dead entry is removed so it cannot re-offer itself.
              clearActiveKey();
              wipeSessionCache(homePath);
            }
          }
        }
        if (!unlocked) {
          // The ambient env var stays truthiness-gated (an EMPTY env var is
          // the ordinary "not set" spelling); only the explicit flag carries
          // presence semantics.
          const passphrase = explicit ?? readEnv("PASSPHRASE");
          if (passphrase === undefined) {
            throw new GestaltError(
              "E_STORE_MODE",
              "This store is encrypted.",
              `Set GESTALT_PASSPHRASE, pass --passphrase "...", or "fimemory recover" with your 24-word phrase.`,
            );
          }
          const dek = unlockWithPassphrase(homePath, passphrase); // throws on a wrong passphrase — nothing is cached
          activateDek(dek);
          if (ttlMs > 0) {
            // Best-effort: a read-only cache dir must never fail a command
            // that just unlocked correctly.
            try { writeSessionCache(homePath, dek, ttlMs); } catch { /* best effort */ }
          }
        }
      }
    }

    switch (args.command) {
      case "init": {
        const encrypted = args.values["encrypted"] === "1";
        const r = runInit({
          ...opts,
          encrypted,
          ...(args.values["passphrase"] ? { passphrase: args.values["passphrase"] } : {}),
        });
        // Seed-on-install (Lane F, F-A): three starter topics through the real
        // write path, on by default, `--no-seed` opts out. Runs after runInit so
        // a refused init never half-seeds — and FAULT-ISOLATED (seedAfterInit
        // never throws): the init already succeeded, so a seed failure must
        // never eat the init output. Above all the shown-once mnemonic of an
        // encrypted store, which is never stored — an unlock hiccup here once
        // aborted the command before the mnemonic printed, losing it forever.
        let seeded: SeedResult | undefined;
        let seedError: string | undefined;
        if (args.values["no-seed"] !== "1") {
          const s = await seedAfterInit(homePath, {
            encrypted: r.encrypted,
            ...(args.values["passphrase"] !== undefined
              ? { passphraseFlag: args.values["passphrase"] }
              : {}),
          });
          seeded = s.seeded;
          seedError = s.seedError;
        }
        // Same loud path as recover (E2c): a re-init whose stale-cache wipe
        // FAILED must say so — the PREVIOUS store's session key is still on
        // disk until `fimemory lock` succeeds. The init itself proceeded, so
        // exit stays 0; --json carries `sessionKeyWipeFailed` via `r`.
        if (r.sessionKeyWipeFailed) {
          process.stderr.write(
            c.red(`WARNING — could not remove the cached session key: ${r.sessionKeyWipeFailed.path} (${r.sessionKeyWipeFailed.error})\n`) +
            c.red("The PREVIOUS store's session key is still on disk until that file is gone — run `fimemory lock` (and re-run it until it succeeds).\n"),
          );
        }
        if (args.json) {
          out(JSON.stringify({
            ...r,
            ...(seeded ? { seededTopics: seeded.topics } : {}),
            ...(seedError !== undefined ? { seedError } : {}),
          }, null, 2));
        } else {
          out(`Created your ${r.encrypted ? "ENCRYPTED " : ""}store at ${r.home}`);
          out();
          // Count what the store actually holds NOW (init's example + seeds).
          const topicCount = r.topicCount + (seeded?.topics.length ?? 0);
          out(`  ${topicCount === 1 ? "1 topic" : `${topicCount} topics`}, and ${r.pendingProposals === 1 ? "1 suggested edit is" : `${r.pendingProposals} suggested edits are`} waiting for you.`);
          if (seeded) {
            out(`  Seeded ${seeded.topics.length} starter topics: ${seeded.topics.join(", ")} (skip next time with --no-seed).`);
            renderWarnings(seeded.warnings);
          }
          if (seedError !== undefined) {
            out(c.yellow(`  ! Starter topics were not seeded: ${seedError}`));
            out(c.yellow(`    Your store is fine — add topics with \`fimemory create\`.`));
          }
          if (r.encrypted && r.mnemonic) {
            out();
            out(c.yellow("  WRITE THIS DOWN — your 24-word recovery phrase (shown once, never stored):"));
            out();
            out(c.b("    " + r.mnemonic));
            out();
            out(c.dim(`  Key id ${r.kid}. Lose BOTH your passphrase and this phrase and the data is gone, by design.`));
            out(c.dim(`  To use this store, set GESTALT_PASSPHRASE (or pass --passphrase "...").`));
          }
          out();
          // THE HANDOFF. This block used to read "Try it: fimemory list" — all
          // three suggestions store-local, none of them wiring. The 112-step
          // install sweep called that the single roughest moment in the whole
          // product: init succeeds, the reader concludes they are done, and the
          // store it just made is connected to nothing. A working install and a
          // dead one looked identical, and the CLI's own last word was the
          // reason. So `init` now ENDS by naming what is still missing and the
          // one command that fixes it; looking around comes second.
          out(c.yellow("Nothing reads this store yet — no AI tool is connected to it."));
          out(c.dim("  No MCP server registered, no rule block written, no retrieval hook installed."));
          out();
          out("Next:");
          out(`  ${c.b(`${BIN} setup`)}   Connect your AI tools (MCP + rules + hook), then check it. Safe to re-run.`);
          out();
          out(c.dim("Or look around first:"));
          if (r.encrypted) {
            // The old line here was `GESTALT_PASSPHRASE=... fimemory get …`,
            // which is a parser error in BOTH shells a Windows user has — on
            // the only platform this build is verified on. See brand.ts.
            for (const line of passphraseExample("get gestalt-example")) {
              out(c.dim(`  ${line}`));
            }
          } else {
            out(c.dim(`  ${BIN} list`));
            out(c.dim(`  ${BIN} get gestalt-example`));
            out(c.dim(`  ${BIN} review`));
          }
        }
        return 0;
      }
      case "setup": {
        // `setup` is a whole-machine verb and takes no host names, but every
        // OTHER install verb here does (`install-mcp cursor`,
        // `install-rules grok`). So `fimemory setup claude-code` is a natural
        // thing to type, and until 2026-08-01 it was accepted in silence and
        // then wired EVERY tool on the machine anyway — the user asked to scope
        // the run, watched it not be scoped, and was told nothing. Refusing with
        // the two commands that DO scope is the whole fix.
        if (args.positionals.length > 0) {
          return usageError(
            `setup takes no host names (got "${args.positionals.join(" ")}") — it wires every AI tool it finds. ` +
              `To do one host, run the pieces named instead: \`${BIN} install-mcp ${args.positionals[0]}\` ` +
              `and \`${BIN} install-rules ${args.positionals[0]}\`.`,
          );
        }
        // The whole install sequence, one verb, fault-isolated per step. See
        // ops/setup.ts for the contract (re-runnable, nothing aborts the rest).
        const r = await runSetup({
          home: homePath,
          ...(args.values["encrypted"] === "1" ? { encrypted: true } : {}),
          ...(args.values["passphrase"] !== undefined ? { passphrase: args.values["passphrase"] } : {}),
          ...(args.values["no-seed"] === "1" ? { noSeed: true } : {}),
          ...(args.values["capture"] === "1" ? { capture: true } : {}),
        });
        if (args.json) {
          out(JSON.stringify(r, null, 2));
          return r.ok ? 0 : 1;
        }
        out(c.b(`${PRODUCT} setup — ${r.home}`));
        out();
        for (const s of r.steps) renderSetupStep(s);
        // The shown-once recovery phrase, if this run created an encrypted
        // store. Printed AFTER the steps so it is the last thing on screen
        // before the summary, and never hidden inside a step's detail list.
        if (r.mnemonic) {
          out();
          out(c.yellow("  WRITE THIS DOWN — your 24-word recovery phrase (shown once, never stored):"));
          out();
          out(c.b("    " + r.mnemonic));
          out();
          out(c.dim(`  Key id ${r.kid}. Lose BOTH your passphrase and this phrase and the data is gone, by design.`));
        }
        renderWarnings(r.warnings);
        if (r.nextSteps.length > 0) {
          out();
          out(c.b("Next steps:"));
          for (const n of r.nextSteps) out(`  ${n}`);
        }
        out();
        out(
          !r.ok
            ? c.red("Some steps failed — see above. Fix those and re-run `" + BIN + " setup`; the steps that worked will report `unchanged`.")
            : r.healthy
              ? c.green("Connected. Restart your AI tools, then ask one of them what it remembers.")
              : c.yellow(`Wiring done, but \`${BIN} doctor\` has findings above that need attention.`),
        );
        // Exit non-zero only when a STEP failed. Doctor findings are reported,
        // not fatal: `setup` did its job, and `doctor` is the verb whose exit
        // code answers "is this machine healthy".
        return r.ok ? 0 : 1;
      }
      case "onboard": {
        // The guided first-win path (ops/onboard.ts has the argument). Two
        // shapes, chosen honestly: `--status`, `--json`, or any terminal that
        // cannot ask questions (pipes, CI, a host spawning us) — reports the
        // two scores and the remaining commands, asks nothing, and never
        // hangs waiting on a stdin that will not answer. (`--json` implies the
        // status shape: an interactive Q&A has no JSON representation, and a
        // TTY user asking for JSON wants the report, not a conversation.) A
        // real TTY gets the guided path. Exit is 0 either way: onboarding
        // progress is adoption state, not an error, same contract as doctor's
        // warn levels.
        const wantStatus = args.values["status"] === "1";
        const interactive =
          !wantStatus && !args.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (!interactive) {
          const r = runDoctor({ home: homePath });
          if (args.json) {
            out(JSON.stringify(
              { home: homePath, content: r.content, healthy: r.healthy, hosts: hostMatrix(r), remaining: remainingSteps(r) },
              null,
              2,
            ));
            return 0;
          }
          out(c.b(`${PRODUCT} onboard — ${homePath}`));
          out();
          renderTwoScores(r, { out });
          out();
          const matrix = hostMatrix(r);
          if (matrix.length > 0) {
            out("What each connected tool will actually do with your memory:");
            for (const m of matrix) out(`  ${m.host}: ${m.text}`);
            out();
          }
          const remaining = remainingSteps(r);
          if (remaining.length > 0) {
            out(c.b("Remaining, in order of leverage:"));
            for (const s of remaining) out("  " + s);
          } else {
            // A TRUE claim only — "both green" over a red Connect column was
            // this branch's own review finding.
            out(emptyRemainingVerdict(r));
          }
          if (!wantStatus) {
            out();
            out(c.dim(`This terminal cannot ask questions — run \`${BIN} onboard\` in an interactive one for the guided path.`));
          }
          return 0;
        }
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await runOnboard(
            { home: homePath },
            { out: (l?: string) => out(l), ask: (q: string) => rl.question(q) },
          );
        } finally {
          rl.close();
        }
        return 0;
      }
      case "encrypt": {
        // Convert an EXISTING plaintext store to encrypted at rest. Passphrase
        // from --passphrase or GESTALT_PASSPHRASE (the op fails closed if
        // absent). Same ownership contract as `init --encrypted`: print the
        // 24-word recovery phrase ONCE — the user MUST record it.
        const r = await migrateToEncrypted({
          ...opts,
          ...(args.values["passphrase"] ? { passphrase: args.values["passphrase"] } : {}),
        });
        if (r.plaintextBackupRemovalFailed) {
          // The store IS encrypted, but a plaintext COPY still sits on disk until
          // that path is removed — say so loudly (same shape as the wipe-failed
          // warnings). The migration itself succeeded, so exit stays 0.
          process.stderr.write(
            c.red(`WARNING — the store is encrypted, but a PLAINTEXT copy is still on disk: ${r.plaintextBackupRemovalFailed.path} (${r.plaintextBackupRemovalFailed.error})\n`) +
            c.red("Delete that folder yourself — until it is gone, your memory is readable there in the clear.\n"),
          );
        }
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          out(c.green(`Encrypted your store at ${r.home}`));
          out();
          out(`  ${r.notes === 1 ? "1 note" : `${r.notes} notes`}, ${r.logs === 1 ? "1 log" : `${r.logs} logs`} and ${r.proposals === 1 ? "1 suggested edit" : `${r.proposals} suggested edits`} are now ciphertext at rest.`);
          out();
          out(c.yellow("  WRITE THIS DOWN — your 24-word recovery phrase (shown once, never stored):"));
          out();
          out(c.b("    " + r.mnemonic));
          out();
          out(c.dim(`  Key id ${r.kid}. Lose BOTH your passphrase and this phrase and the data is gone, by design.`));
          out(c.dim(`  To use this store, set GESTALT_PASSPHRASE (or pass --passphrase "...").`));
          out();
          out(c.dim("  Git history (if any) stays plaintext — this is a fresh encrypted state from here on, not a rewrite of past commits."));
        }
        return 0;
      }
      case "decrypt": {
        // Convert an encrypted store back to plaintext at rest — the inverse of
        // `encrypt`. NOT gate-exempt on purpose: the gate above must unlock the
        // store first, because this command may only ever convert data the
        // caller can already read. It refuses outright on a locked store.
        //
        // The remote consequence is stated by the op itself (`planLines`) and
        // requires an explicit acknowledgement: `--yes-plaintext-remote`, or —
        // in a real terminal — typing the word `decrypt` when asked. There is no
        // silent path, and `--json` does NOT imply consent: a machine-readable
        // caller still has to pass the flag.
        const preApproved = args.values["yes-plaintext-remote"] === "1";
        // Opt-in ONLY. The encrypted backup is the one-command way back from a
        // command that runs once against an irreplaceable store.
        const removeBackup = args.values["remove-backup"] === "1";
        const interactive =
          !preApproved && process.stdin.isTTY === true && process.stdout.isTTY === true;
        let rl: { question: (q: string) => Promise<string>; close: () => void } | undefined;
        if (interactive) {
          const { createInterface } = await import("node:readline/promises");
          rl = createInterface({ input: process.stdin, output: process.stdout });
        }
        try {
          const r = await migrateToPlaintext({
            ...opts,
            ...(removeBackup ? { removeBackup: true } : {}),
            ...(preApproved ? { confirmPlaintextRemote: true } : {}),
            ...(rl ? { confirm: (q: string) => rl!.question(q) } : {}),
            // The plan is a human-facing report; with --json it would corrupt
            // the document, so it goes to stderr there.
            out: (line: string) => {
              if (args.json) process.stderr.write(line + "\n");
              else out(line);
            },
          });
          if (r.ciphertextBackupRemovalFailed) {
            process.stderr.write(
              c.yellow(
                `WARNING — the store is plaintext, but an ENCRYPTED copy is still on disk: ${r.ciphertextBackupRemovalFailed.path} (${r.ciphertextBackupRemovalFailed.error})\n`,
              ),
            );
          }
          if (r.sessionWipe?.outcome === "failed") {
            process.stderr.write(
              c.red(
                `WARNING — the cached session key at ${r.sessionWipe.path} could not be removed (${r.sessionWipe.error}). Run \`fimemory lock\` until it succeeds.\n`,
              ),
            );
          }
          if (args.json) {
            out(JSON.stringify(r, null, 2));
            return 0;
          }
          if (!r.changed) {
            out(r.message);
            return 0;
          }
          out(c.green(r.message));
          out();
          out(
            `  ${r.notes === 1 ? "1 note" : `${r.notes} notes`}, ${r.logs === 1 ? "1 log" : `${r.logs} logs`}, ${r.proposals === 1 ? "1 suggested edit" : `${r.proposals} suggested edits`}` +
              `${r.ledgers > 0 ? ` and ${r.ledgers} task ledger file(s)` : ""} are readable plain files again.`,
          );
          if (r.ciphertextBackup) {
            out();
            out(c.green(`  The way back, one command:`));
            out(`    Your store as it was, still encrypted, is kept at`);
            out(`    ${r.ciphertextBackup}`);
            out(`    Rename it over ${r.home} and this decrypt is undone.`);
            out(
              c.dim(
                `    It is not deleted for you. When you are satisfied the store is complete,`,
              ),
            );
            out(c.dim(`    delete it and its .kept.json marker (or re-run with --remove-backup).`));
          }
          out();
          // Only printed when a keyring was ACTUALLY archived. On a GESTALT_KEY
          // store there is none, and this paragraph used to name a path that did
          // not exist — a false claim about recoverability, made at exactly the
          // moment someone decides an old backup is safe to delete.
          if (r.archivedKeyring) {
            out(c.dim(`  Your keyring was kept at ${r.archivedKeyring} — it is what still opens the`));
            out(c.dim(`  ciphertext already in git history and in your old backups, with the passphrase`));
            out(c.dim(`  and 24-word phrase you already have. Keep both.`));
          } else {
            out(c.dim(`  This store had no keyring.json (it was unlocked with GESTALT_KEY), so nothing`));
            out(c.dim(`  was archived. The ciphertext already in git history and in your old backups`));
            out(c.dim(`  is openable ONLY with that GESTALT_KEY value — keep it, or those copies are`));
            out(c.dim(`  unreadable forever.`));
          }
          if (r.remoteUrl) {
            out();
            out(c.yellow(`  From your next push, ${r.remoteUrl} holds this memory in PLAINTEXT.`));
          }
          out();
          out(c.dim(`  To lock it again for a backup or a trip: \`${BIN} encrypt\` (new key, new phrase).`));
          return 0;
        } finally {
          rl?.close();
        }
      }
      case "unlock": {
        // The unlock gate above already did the work (cache → explicit
        // --passphrase → GESTALT_PASSPHRASE, caching the derived DEK when the
        // TTL allows); this verb exists so warming the cache is an explicit,
        // scriptable act with an honest report — "unlocked until WHEN" — for
        // shim/per-spawn setups and for recovering a locked MCP server without
        // restarting the client (the server retries the cache lazily per call).
        const encryptedStore = keyringExists(homePath) || storeHasSealedContent(homePath);
        if (!encryptedStore) {
          if (args.json) out(JSON.stringify({ unlocked: true, encrypted: false, home: homePath }, null, 2));
          else out("This store is not encrypted — nothing to unlock.");
          return 0;
        }
        const peek = peekSessionCache(homePath, Date.now(), { ttlMs });
        const viaEnvKey = Boolean(process.env.GESTALT_KEY);
        if (args.json) {
          out(JSON.stringify({
            unlocked: true,
            encrypted: true,
            home: homePath,
            source: viaEnvKey ? "env-key" : peek.state === "warm" ? "session-cache" : "passphrase",
            cache: peek.state === "warm"
              ? { state: "warm", expires: new Date(peek.expires).toISOString(), msRemaining: peek.msRemaining }
              : { state: ttlMs <= 0 ? "disabled" : peek.state },
          }, null, 2));
          return 0;
        }
        out(c.green("Unlocked."));
        if (viaEnvKey) out(c.dim("  Using GESTALT_KEY from the environment — the session cache is not involved."));
        else if (peek.state === "warm") out(c.dim(`  Session key cached — commands stay fast for ${humanMs(peek.msRemaining)} (until ${new Date(peek.expires).toLocaleString()}). \`fimemory lock\` ends it early.`));
        else if (ttlMs <= 0) out(c.dim("  Session cache is disabled (sessionKeyCacheTtlHours = 0) — every command will need the passphrase."));
        else out(c.yellow("  The passphrase worked, but the session key could not be cached — the next command will need the passphrase again."));
        return 0;
      }
      case "lock": {
        // `lock --status` is the READ-ONLY sibling: report warm/cold and time
        // remaining WITHOUT wiping, deriving, or sweeping anything — the "is my
        // key still cached?" question must never itself change the answer.
        if (args.values["status"] === "1") {
          const encryptedStore = keyringExists(homePath) || storeHasSealedContent(homePath);
          const peek = peekSessionCache(homePath, Date.now(), { ttlMs });
          if (args.json) {
            out(JSON.stringify({
              home: homePath,
              encrypted: encryptedStore,
              cache: peek.state === "warm"
                ? { state: "warm", expires: new Date(peek.expires).toISOString(), msRemaining: peek.msRemaining }
                : { state: peek.state },
            }, null, 2));
            return 0;
          }
          if (!encryptedStore) out("This store is not encrypted — there is no key to lock.");
          else if (peek.state === "warm") out(`UNLOCKED (warm) — the cached session key expires in ${humanMs(peek.msRemaining)}. \`fimemory lock\` forgets it now.`);
          else if (peek.state === "expired") out("LOCKED (expired) — a session key was cached but has aged out. The next command needs GESTALT_PASSPHRASE or `fimemory unlock`.");
          else out("LOCKED (cold) — no cached session key. The next command needs GESTALT_PASSPHRASE or `fimemory unlock`.");
          return 0;
        }
        // Wipe cached session key(s) NOW. Needs no passphrase (see the gate
        // above). No `--home` wipes ALL stores' entries: "lock" with no
        // qualifier must mean "no usable cached key remains on this machine",
        // never "only the spelling cwd/env happened to select". A wipe that
        // FAILS (AV lock, ACL) is loud and non-zero — the one lie `lock` must
        // never tell is "nothing was cached" while a live key it could not
        // delete stays on disk.
        const lockFailed = (failed: { path: string; error: string }[]): number => {
          if (args.json) {
            out(JSON.stringify({ locked: false, failed }, null, 2));
          } else {
            for (const f of failed) {
              process.stderr.write(c.red(`LOCK FAILED — could not remove the cached session key: ${f.path} (${f.error})\n`));
            }
            process.stderr.write(c.red("Key material is STILL on disk. Close whatever holds the file (antivirus scan, another process) and run `fimemory lock` again.\n"));
          }
          return 1;
        };
        if (args.home === undefined) {
          const r = wipeAllSessionCaches();
          if (r.failed.length > 0) return lockFailed(r.failed);
          if (args.json) out(JSON.stringify({ locked: true, scope: "all-stores", wiped: r.wiped }, null, 2));
          else if (r.wiped > 0) out(c.green(`Locked — wiped ${r.wiped} cached session key file${r.wiped === 1 ? "" : "s"} (every store on this machine). The next command needs a passphrase.`));
          else out("Locked — nothing was cached on this machine. Every store already needs its passphrase.");
          return 0;
        }
        const r = wipeSessionCache(homePath);
        if (r.outcome === "failed") return lockFailed([{ path: r.path, error: r.error }]);
        const wiped = r.outcome === "wiped";
        if (args.json) out(JSON.stringify({ locked: true, wiped, home: homePath }, null, 2));
        else if (wiped) out(c.green("Locked — the cached session key was wiped. The next command needs your passphrase."));
        else out("Locked — nothing was cached for this store. It already needs your passphrase.");
        return 0;
      }
      case "recover": {
        // Prefer the phrase via stdin (piped); a mnemonic on argv is visible in
        // process listings, so warn if it's used that way (Grok H2).
        let mnemonic = args.values["mnemonic"] ?? args.positionals.join(" ");
        if (mnemonic.trim()) {
          process.stderr.write(
            "  ! A recovery phrase on the command line is visible to other processes — prefer piping it via stdin.\n",
          );
        } else {
          mnemonic = (await readStdin()).trim(); // e.g. `fimemory recover --passphrase X < phrase.txt`
        }
        if (!mnemonic.trim()) {
          return usageError(`recover needs your 24-word phrase (stdin or --mnemonic) + --passphrase "<new>"`);
        }
        const newPass = args.values["passphrase"] ?? process.env.GESTALT_PASSPHRASE;
        if (!newPass) {
          return usageError(`recover needs a NEW passphrase: --passphrase "<new>" (or GESTALT_PASSPHRASE)`);
        }
        if (args.values["passphrase"]) {
          // Symmetric with the mnemonic warning (Grok H2/R3): a passphrase on the
          // command line is visible to other processes — prefer GESTALT_PASSPHRASE.
          process.stderr.write(
            "  ! A passphrase on the command line is visible to other processes — prefer setting GESTALT_PASSPHRASE.\n",
          );
        }
        // Derive the DEK from the phrase, reset the passphrase — and surface
        // the session-cache wipe's outcome instead of discarding it: a reset
        // that leaves the OLD session key serving is a reset the user must
        // hear about (the reset itself still proceeds; `fimemory lock` is the
        // retry verb).
        const { dek, sessionWipe } = recover(homePath, mnemonic, newPass);
        activateDek(dek);
        const wipeFailed = sessionWipe.outcome === "failed";
        if (wipeFailed) {
          process.stderr.write(
            c.red(`WARNING — could not remove the cached session key: ${sessionWipe.path} (${sessionWipe.error})\n`) +
            c.red("The OLD session key may still unlock this store until that file is gone — run `fimemory lock` (and re-run it until it succeeds).\n"),
          );
        }
        if (args.json) {
          out(JSON.stringify({
            recovered: true,
            home: homePath,
            ...(wipeFailed
              ? { sessionKeyWipeFailed: { path: sessionWipe.path, error: sessionWipe.error } }
              : {}),
          }, null, 2));
        } else {
          out(c.green("Recovered — your passphrase has been reset and the store is unlocked."));
        }
        return 0;
      }
      case "status": {
        const r = runStatus(opts);
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          out(`FIMemory store: ${r.home}`);
          out();
          out(`  Topics:          ${fmt(r.topicCount)}`);
          out(`  Suggested edits: ${r.pendingProposals === 0 ? "none" : `${fmt(r.pendingProposals)} waiting for you`}`);
          out();
          out(`Read budget per request: ${fmt(r.budget.maxTokensPerGet)} (up to ${fmt(r.budget.maxTopicsPerGet)} topics)`);
        }
        renderWarnings(r.warnings);
        return args.strict && r.warnings.length > 0 ? 1 : 0;
      }
      case "list": {
        const r = await list(homePath);
        if (args.json) out(JSON.stringify(r, null, 2));
        else if (r.rows.length === 0) out("No topics yet. Try: fimemory create <id> --title \"...\"");
        else {
          for (const row of r.rows) {
            out(`${c.b(row.id)} — ${row.title}`);
            out(c.dim(`  ${row.logEntries} log ${row.logEntries === 1 ? "entry" : "entries"} · ${fmt(row.noteTokens)} read budget · updated ${row.updated}`));
          }
          if (r.pending > 0) out(c.yellow(`\n${r.pending} suggested edit(s) waiting — fimemory review`));
        }
        return 0;
      }
      case "search": {
        const query = args.positionals.join(" ");
        const r = await search(homePath, query);
        // Last-read heartbeat (trust surface): best-effort, never into the store.
        recordRead(homePath, "search", r.hits.map((h) => h.id), "cli");
        if (args.json) out(JSON.stringify(r, null, 2));
        else if (r.hits.length === 0) out(`No topics match "${query}".`);
        else for (const h of r.hits) {
          out(`${c.b(h.id)} — ${h.title}  ${c.dim(`(${fmt(h.noteTokens)} read budget)`)}`);
          if (h.excerpt) out(c.dim(`  ${h.excerpt}`));
        }
        renderWarnings(r.warnings);
        return 0;
      }
      case "get": {
        const r = await get(homePath, args.positionals, logTail(args));
        // Last-read heartbeat (trust surface): best-effort, never into the store.
        recordRead(homePath, "get", args.positionals, "cli");
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          for (const t of r.topics) {
            out(c.b(t.summary));
            // Log above body, matching brief.ts and the MCP path: the freshest
            // material should be the first thing read, not a footnote under a
            // summary that may well predate it.
            if (t.logTail?.trim()) {
              out(c.dim("Recent log (prefer when newer than body):"));
              out(t.logTail.trimEnd());
              out();
            }
            if (t.body.trim()) out(t.body.trimEnd());
            out();
          }
          out(c.dim(`Served ${fmt(r.tokensUsed)} of ${fmt(2000)} read budget${r.clamped ? " (clamped)" : ""}.`));
        }
        renderWarnings(r.warnings);
        return 0;
      }
      case "create": {
        const id = args.positionals[0];
        if (!id) return usageError("create needs an id: fimemory create <id> --title \"...\"");
        const r = await createTopic(homePath, id, args.values["title"] ?? id, { force: args.new });
        if (args.json) out(JSON.stringify(r, null, 2));
        else out(c.green(`Created "${r.entry.id}". Add entries with: fimemory log ${r.entry.id} --type decision --project <p> -m "..."`));
        return 0;
      }
      case "log": {
        const id = args.positionals[0];
        if (!id) return usageError("log needs a topic id");
        const r = await appendLog(homePath, id, {
          type: args.values["type"] ?? "",
          project: args.values["project"] ?? "",
          agent: args.values["proposer"] ?? "cli",
          summary: args.values["message"] ?? "",
          ...(args.values["body"] ? { body: args.values["body"] } : {}),
          ...(args.values["supersedes"] ? { supersedes: args.values["supersedes"] } : {}),
          // Single comma-separated --refs a,b (not repeatable — the generic
          // parser keeps one value per key). Whitespace around commas is shed.
          ...(args.values["refs"]
            ? { refs: args.values["refs"].split(",").map((s) => s.trim()).filter(Boolean) }
            : {}),
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else out(c.green(`Logged a ${args.values["type"]} on "${id}".`));
        return 0;
      }
      case "update": {
        const id = args.positionals[0];
        if (!id) return usageError("update needs a topic id");
        const noteText = args.values["file"] && args.values["file"] !== "-"
          ? readFileSync(args.values["file"], "utf8")
          : await readStdin();
        const r = await updateTopic(homePath, id, noteText, {
          allowOwnerNotes: args.allowOwnerNotes,
          ...(args.values["proposer"] ? { proposer: args.values["proposer"] } : {}),
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else out(c.green(`Suggested edit #${r.seq} on "${id}" is waiting for your ok: fimemory review show ${r.seq}`));
        renderWarnings(r.warnings);
        return 0;
      }
      case "review":
        return reviewCommand(args, homePath);
      case "export": {
        // `--plaintext` is required, not implied: writing every note you own to
        // the disk in the clear is a deliberate act, and it keeps `export` free
        // to grow other formats without changing what a bare `export` did.
        if (args.values["plaintext"] !== "1") {
          return usageError("export needs --plaintext: fimemory export --plaintext <dir>");
        }
        const dest = args.positionals[0];
        if (!dest) return usageError("export needs a destination: fimemory export --plaintext <dir>");
        const r = await exportPlaintext(homePath, dest);
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          const s = (n: number): string => (n === 1 ? "" : "s");
          const wrote = r.files.length > 0;
          // The success line belongs to a COMPLETED export (`failed === 0`), not
          // to a non-empty one. Gating it on `wrote` meant an EMPTY store — the
          // fresh store someone runs this on precisely to find out whether the
          // escape hatch is real before they trust it with anything — printed
          // zero bytes on stdout, zero on stderr, and exit 0: indistinguishable
          // from a no-op or a silent failure. An empty store exports completely;
          // the answer is "0 notes, here is the folder", and it is confirmed.
          if (r.failed === 0) {
            out(
              c.green(
                `Exported ${r.notes} note${s(r.notes)} + ${r.logs} log${s(r.logs)} + ${r.proposals} suggested edit${s(r.proposals)} to ${r.dest}`,
              ),
            );
            out(c.dim("  Plain .md files, outside your store — yours to read, grep, edit, or back up."));
            if (r.mode === "encrypted" && wrote) {
              out(c.yellow("  ! These are DECRYPTED. Anyone who can read that folder can read your memory."));
            }
          }
          if (r.failed > 0) {
            // Loud, itemized, and on stderr: this export is INCOMPLETE. Silence
            // here is the one failure mode a recovery tool cannot have — the
            // user must not back this up believing it is everything.
            //
            // Facts, not causes: each item's own message is the underlying error
            // verbatim, and neither the header nor the footer adds a diagnosis.
            // A blanket "could not be decoded … restore from a backup" (what
            // this printed before) is actively harmful for a locked file: it
            // misdiagnoses an editor holding a note open as data loss, and the
            // advice destroys the current note.
            process.stderr.write(
              c.red(
                `\n  ${r.failed} item${s(r.failed)} could NOT be exported and ${r.failed === 1 ? "is" : "are"} MISSING from this export:\n`,
              ),
            );
            for (const w of r.warnings) process.stderr.write(c.red(`    - ${w.message}\n`));
            // "Everything else exported fine" is only true if there IS an "else".
            // When NOTHING was written, that line claimed a successful export of
            // a store that produced no files at all. Say the count instead — and
            // no verdict on why: export does not know, and guessing is how a
            // recovery tool talks someone into destroying their own data.
            //
            // "could be READ" is a claim about the STORE, and it was printed
            // whenever nothing was written — including the case where every item
            // read perfectly and every WRITE failed (Windows Controlled Folder
            // Access, an AV shield, and a full disk all permit mkdir and deny
            // file creation). It sent someone whose memory is completely intact
            // to go looking for damage in it, which is the same wrong direction
            // the deleted classifier pointed. `phase` already knows which side
            // failed, so it — not an assumption — chooses the wording.
            const hasWriteFail = r.failures.some((f) => f.phase === "write");
            const hasStoreFail = r.failures.some((f) => f.phase !== "write");
            process.stderr.write(
              c.dim(
                wrote
                  ? `  Everything else exported fine (${r.files.length} item${s(r.files.length)} in ${r.dest}). This export is incomplete — fix the above and re-run into a FRESH folder.\n`
                  : !hasWriteFail
                    ? `  0 of ${r.failed} item${s(r.failed)} could be read — see the errors above. Nothing was exported.\n`
                    : !hasStoreFail
                      ? `  0 of ${r.failed} item${s(r.failed)} could be written to ${r.dest} — see the errors above. Nothing was exported.\n`
                      : `  Nothing was exported — see the errors above.\n`,
              ),
            );
          }
        }
        if (r.failed === 0) renderWarnings(r.warnings);
        // Non-zero on an incomplete export: a script that backs this up and
        // deletes the store must be able to tell that something did not make it.
        return r.failed > 0 ? 1 : 0;
      }
      case "cat": {
        const id = args.positionals[0];
        if (!id) return usageError(`cat needs a topic id: ${BIN} cat <id>`);
        const r = await catNote(homePath, id);
        if (args.json) out(JSON.stringify(r, null, 2));
        else process.stdout.write(r.text); // verbatim — exactly the note's bytes
        return 0;
      }
      case "supporters": {
        // Supporter names live in SUPPORTERS.md, a file shipped INSIDE the
        // package, and NEVER in LICENSE.md (owner decision, 2026-07-30):
        // LICENSE.md is a legal instrument that tooling parses to detect the
        // project's terms, so appending a growing list of names to it corrupts
        // that detection and would mean editing the licence on every sale.
        // Credit is opt-in — by real name, by handle, or not at all.
        //
        // Prints the file VERBATIM, like `cat` does with a note: the credit
        // file's own words are the answer, so this command adds no framing of
        // its own that could drift from what actually ships.
        const r = readSupporters();
        if (args.json) {
          out(JSON.stringify(r, null, 2));
          return 0;
        }
        if (!r.present) {
          // GRACEFUL, and exit 0. A missing credit file is a packaging fault,
          // not the user's mistake and not a store problem, so it must not look
          // like either — no red error, no "run doctor", no non-zero exit that
          // a script would read as "your memory is broken". It says which path
          // it looked at (so the fault is diagnosable) and, because someone
          // seeing this could reasonably wonder whether they are missing
          // something they paid for, states plainly that they are not.
          out(`No ${SUPPORTERS_FILE} shipped with this copy of ${PRODUCT}.`);
          out(c.dim(`  Looked for it at ${r.path}${r.reason ? ` (${r.reason})` : ""}.`));
          out(c.dim(`  ${PRODUCT} is free to everyone either way — nothing about the software reads that file.`));
          return 0;
        }
        process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
        return 0;
      }
      case "compact":
      case "fold": {
        const id = args.positionals[0];
        if (!id) return usageError("fold needs a topic id");
        const r = await compact(homePath, id, args.values["since"] ? { since: args.values["since"] } : {});
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          out(c.b(`Fold packet for "${id}" — ${r.entries.length} entr${r.entries.length === 1 ? "y" : "ies"} to fold${r.hasMore ? ", more remain" : ""}.`));
          out(c.dim("Draft the folded note from the current note below, then submit with: fimemory update " + id + " --file - < folded.md"));
          out();
          out(r.note.trimEnd());
          if (r.entries.length) { out(); out(c.dim("— entries to fold —")); out(r.entries.join("\n\n")); }
          if (r.hasMore && r.cursor) out(c.dim(`\nMore: ${BIN} fold ${id} --since ${r.cursor}`));
        }
        renderWarnings(r.warnings);
        return 0;
      }
      case "merge": {
        const [loser, winner] = args.positionals;
        if (!loser || !winner) return usageError("merge needs two ids: fimemory merge <loser> <winner>");
        const r = await mergeTopics(homePath, loser, winner);
        if (args.json) out(JSON.stringify(r, null, 2));
        else out(c.green(`Merged "${loser}" into "${winner}".`));
        renderWarnings(r.warnings);
        return 0;
      }
      case "pack": {
        const r = await pack(homePath, args.positionals, {
          ...(args.values["for"] ? { for: args.values["for"] } : {}),
          ...logTail(args),
        });
        // A clipboard tool that is NOT INSTALLED is a different thing from one
        // that ran and failed, and on a stock Linux desktop the first is the
        // likely one (xclip ships with nothing, and a Wayland session needs
        // wl-clipboard). Saying "clipboard unavailable" to someone who only
        // needs `apt install` sends them looking for a bug in this program.
        const copied = copyToClipboardDetailed(r.text);
        out(r.text);
        out(
          c.dim(
            copied.value
              ? "(copied to your clipboard)"
              : copied.toolRan
                ? "(clipboard unavailable — copy the text above)"
                : `(${clipboardHint() ?? "clipboard unavailable"} — copy the text above)`,
          ),
        );
        renderWarnings(r.warnings);
        return 0;
      }
      case "ingest": {
        let text: string;
        if (args.clipboard) {
          const read = readClipboardDetailed();
          // Same distinction as `pack`: "no clipboard tool is installed" must
          // not be reported as "nothing on the clipboard", which is what the
          // old single-command path said on every Linux desktop without xclip.
          // stderr, not stdout: `ingest --json` must stay machine-readable.
          if (!read.toolRan) {
            process.stderr.write(c.yellow(clipboardHint() ?? "clipboard unavailable") + "\n");
          }
          text = read.value ?? "";
        } else {
          text = await readStdin();
        }
        const r = await ingest(homePath, text);
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          if (r.landed === 0 && r.rejected === 0) out("No ```gestalt-log blocks found in the input.");
          for (const line of r.lines) out(line.ok ? c.green(`  ✓ ${line.message}`) : c.red(`  ✗ ${line.topic}: ${line.message}`));
          out();
          out(`Filed ${r.landed}, rejected ${r.rejected}.`);
        }
        return args.strict && r.rejected > 0 ? 1 : 0;
      }
      case "demo": {
        // Build the try-it store (INVENTED studio history, deterministic) at an
        // EXPLICIT directory — never the user's own store home. The content is
        // fabricated on purpose: this ships to every installer, so it must
        // never carry the owner's real notes. See ops/demoStore.ts.
        const dir = args.positionals[0];
        if (!dir) {
          process.stderr.write("Usage: fimemory demo <dir> — builds the demo store at <dir> (must not already hold a store).\n");
          return 2;
        }
        const r = await buildDemoStore(dir);
        out(c.green(`Demo store built at ${r.home} — ${r.topics.length} topics, ${r.entries} entries, 1 suggested edit pending.`));
        out(`Try it:  GESTALT_HOME=${r.home} fimemory search "hourly fixed fee"`);
        return 0;
      }
      case "reindex": {
        const r = await reindexStore(homePath);
        if (args.json) out(JSON.stringify({ topics: Object.keys(r.index.topics).length, warnings: r.warnings }, null, 2));
        else out(c.green(`Rebuilt the catalog — ${Object.keys(r.index.topics).length} topic(s).`));
        renderWarnings(r.warnings);
        return 0;
      }
      case "mcp": {
        // Start the stdio MCP server and keep the process alive until stdin ends.
        runStdioServer(homePath);
        return new Promise<number>(() => {});
      }
      case "install-mcp": {
        // Optional env block: `--env KEY=VALUE` / `--env-passthrough KEY`.
        // Values land in host config files in PLAIN TEXT — an explicit choice
        // (see installMcp docs); the default writes no env block at all.
        // The KEY is written into TOML host configs as a raw key, so it must be
        // a TOML bare key — `--env "MY KEY=v"` (a quoting slip) would otherwise
        // write a syntax error into a file full of other servers' API keys.
        const bareEnvKey = /^[A-Za-z0-9_-]+$/;
        const envPairs: Record<string, string> = {};
        for (const pair of args.envPairs) {
          const eq = pair.indexOf("=");
          if (eq <= 0) return usageError(`--env needs KEY=VALUE, got "${pair}"`);
          const key = pair.slice(0, eq);
          if (!bareEnvKey.test(key)) {
            return usageError(`--env key "${key}" is not a usable environment-variable name (letters, digits, "_" and "-" only)`);
          }
          envPairs[key] = pair.slice(eq + 1);
        }
        for (const key of args.envPassthrough) {
          if (!key.trim()) return usageError("--env-passthrough needs a KEY name");
          if (!bareEnvKey.test(key)) {
            return usageError(`--env-passthrough key "${key}" is not a usable environment-variable name (letters, digits, "_" and "-" only)`);
          }
        }
        // Same normalization as uninstall-mcp, so the two verbs accept exactly
        // the same spellings — `install-mcp Grok` and `uninstall-mcp Grok` must
        // not disagree about whether that names a host.
        const mcpTargets = args.positionals.map((p) => p.trim().toLowerCase());
        const r = await installMcp({
          home: homePath,
          ...(mcpTargets.length ? { targets: mcpTargets } : {}),
          ...(Object.keys(envPairs).length ? { env: envPairs } : {}),
          ...(args.envPassthrough.length ? { envPassthrough: args.envPassthrough } : {}),
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          for (const w of r.writers) {
            // `unchanged` is a SUCCESS (the config already says exactly this),
            // not the yellow "could not write" case.
            out((w.wrote || w.unchanged ? c.green : c.yellow)(`${w.target}: ${w.note}`) + c.dim(`\n  ${w.path}`));
          }
          if (r.claudeCode) {
            // Lead with the remedy that works HERE. IDE/desktop Claude Code
            // installs no `claude` binary, so on those machines the one-liner
            // fails with `command not found` and no hint — the manual paste is
            // the working path and the command is kept as the footnote.
            if (r.claudeCode.cliDetected) {
              out("claude-code — run:");
              out("  " + r.claudeCode.command);
            } else {
              // The snippet already carries the mcpServers wrapper, so the
              // instruction states the MERGE rule — "add this under
              // mcpServers" would double-nest it on any file that already has
              // the key, and Claude Code silently ignores the result.
              out(c.yellow("claude-code — no `claude` CLI on PATH (IDE/desktop installs ship none). Merge this into " + r.claudeCode.configPath + ' — if the file already has an "mcpServers" section, add only the inner "gestalt" entry to it:'));
              out(r.claudeCode.snippet);
              out(c.dim("  If you later install the Claude Code CLI: " + r.claudeCode.command));
            }
          }
          out();
          out(c.dim("Generic MCP snippet (paste into any other client's config):"));
          out(r.snippet);
        }
        renderWarnings(r.warnings);
        return 0;
      }
      case "uninstall-mcp": {
        // Same registry, same detection rule, same per-host reporting as
        // install-mcp — the same scan with an empty substitution.
        // Normalize ONCE and use the normalized list. Validating `"Grok"` after
        // lowercasing and then passing the raw spelling through meant a target
        // that differs only by case passed the usage check, matched nothing
        // inside the op, produced zero removers — and exited 0 having removed
        // nothing, possibly leaving a plaintext passphrase in a config the
        // user believes is now clean.
        const targets = args.positionals.map((p) => p.trim().toLowerCase());
        const unknown = targets.filter((p) => !(INSTALL_TARGETS as string[]).includes(p));
        if (unknown.length > 0) {
          return usageError(`unknown target: ${unknown.join(", ")} — known: ${INSTALL_TARGETS.join(", ")}`);
        }
        const dryRun = args.values["dry-run"] === "1";
        const r = await uninstallMcp({
          ...(targets.length ? { targets } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          for (const w of r.removers) {
            // removed = green (it went); absent = dim (nothing was there, and
            // the file was not touched); anything else = yellow, because
            // something of ours is or may still be in that file.
            const paint = w.removed ? c.green : w.absent ? c.dim : c.yellow;
            out(paint(`${w.target}: ${w.note}`) + c.dim(`\n  ${w.path}`));
            if (w.envKeys) out(c.yellow(`  ! plaintext env block: ${w.envKeys.join(", ")}`));
          }
          if (r.claudeCode) {
            // install-mcp prints `claude mcp add`; this prints its mirror. The
            // file is read, never written — Claude Code owns its schema.
            out(
              r.claudeCode.registered
                ? "claude-code — a gestalt entry is registered; run:"
                : c.dim("claude-code — no gestalt entry found in the user scope. If your host still lists one:"),
            );
            out("  " + r.claudeCode.command);
            out(c.dim(`  ${r.claudeCode.path}`));
          }
          out();
          if (dryRun) {
            out(c.yellow("Dry run — nothing was written. Re-run without --dry-run to remove."));
          } else {
            // MCP config is one layer. Naming the other two verbatim keeps the
            // whole back-out on one screen without this command reaching into
            // files install-mcp never wrote (see UninstallMcpOptions).
            out(c.dim("MCP config only. The rest of the back-out:"));
            out(c.dim("  fimemory uninstall-rules     remove the memory rule block"));
            out(c.dim("  fimemory uninstall-hooks     remove the retrieval hooks"));
          }
        }
        renderWarnings(r.warnings);
        // A refusal is not a success here. `uninstall-mcp && rm -rf <store>` has
        // to stop when a config we could not parse may still hold a passphrase —
        // "not installed" (absent) is fine and stays 0, and so is a dry run that
        // simply found work to do (`wouldRemove`).
        return r.removers.some((w) => !w.removed && !w.absent && !w.wouldRemove) ? 1 : 0;
      }
      case "doctor": {
        const r = runDoctor({ home: homePath });
        if (args.json) {
          out(JSON.stringify(r, null, 2));
          return r.healthy ? 0 : 1;
        }
        out(c.b(`FIMemory doctor — ${r.home}`));
        out();
        // Store + keys
        const modeLine =
          r.mode === "absent" ? c.red("MISSING — no store here")
          : r.mode === "plaintext" ? c.green("plaintext")
          : r.mode === "encrypted-unlocked" ? c.green("encrypted (unlocked)")
          : c.red("encrypted (LOCKED)");
        out(`  Store:  ${modeLine}`);
        if (r.mode === "encrypted-locked" && r.unlockHint) out(c.yellow(`          → ${r.unlockHint}`));
        if (r.keySources) {
          const k = r.keySources;
          out(c.dim(`  Keys:   GESTALT_PASSPHRASE ${k.envPassphraseSet ? "set" : "not set"} · GESTALT_KEY ${k.envKeySet ? (k.envKeyValid === false ? "set (WRONG for this store)" : "set") : "not set"}`));
          const cacheLine =
            k.cache.state === "warm" ? `warm — expires in ${humanMs(k.cache.msRemaining)}`
            : k.cache.state === "expired" ? "expired (was cached, aged out)"
            : "cold (nothing cached)";
          out(c.dim(`          session key cache: ${cacheLine} (TTL ${r.sessionKeyCacheTtlHours ?? "?"}h)`));
        }
        if (r.divergence === "shim-locked-mcp-warm") {
          out(c.yellow("          ⚠ shim locked, MCP warm — one-shot commands are locked, but a running MCP server still holds the key."));
        }
        out();
        // Machines — the third score: is this the same store the other boxes see?
        // The window is printed, not implied: another tool on this box reports
        // on the same records, and two reports that disagree about one machine
        // must at least show which threshold each one used.
        out(`  Machines (heartbeat into this store — overdue after ${STALE_WINDOW_LABEL}):`);
        // Printed before the machines and outside the assessed branch: these
        // are the machines the list below cannot show, so the list is not
        // complete until they are named.
        for (const u of r.sync.unreadable) {
          out(c.yellow(`    ! ${u.file.padEnd(28)} unreadable — ${u.reason}`));
        }
        if (!r.sync.assessed) {
          out(c.dim(`    – not assessed: ${r.sync.reason}`));
        } else {
          const ageOf = (m: { skewed: boolean; ageMs: number | null }) =>
            m.skewed ? "clock is AHEAD of this machine" : m.ageMs === null ? "no timestamp" : `${humanMs(m.ageMs)} ago`;

          for (const m of r.sync.machines.filter((x) => !x.ghost && !x.stale && !x.suspect)) {
            out(`    ${c.green("✓")} ${(m.host ?? "?").padEnd(28)} ${ageOf(m)}`);
            out(c.dim(`        ${m.machineId}`));
            // Drift from an overdue record is a stale reading by definition, so
            // it is only shown for machines that are actually beating.
            for (const d of m.drift) {
              const bits = [d.ahead > 0 ? `${d.ahead} unpushed` : "", d.behind > 0 ? `${d.behind} behind` : ""]
                .filter(Boolean)
                .join(", ");
              out(c.yellow(`        ${d.label}: ${bits}`));
            }
          }

          // One row per dark HOST. Several retired ids on one dead box must not
          // read as several dead boxes.
          const dark = new Map<string, typeof r.sync.machines>();
          for (const m of r.sync.machines.filter((x) => x.stale)) {
            const key = m.host ?? m.machineId;
            const g = dark.get(key);
            if (g) g.push(m);
            else dark.set(key, [m]);
          }
          for (const [host, records] of dark) {
            const freshest = records.reduce((a, b) =>
              (a.ageMs ?? Number.MAX_SAFE_INTEGER) <= (b.ageMs ?? Number.MAX_SAFE_INTEGER) ? a : b,
            );
            out(`    ${c.red("✗")} ${host.padEnd(28)} ${ageOf(freshest)}${c.red("  NOT SYNCING")}`);
            out(c.dim(`        ${records.map((m) => m.machineId).join(", ")}`));
          }

          // An overdue id on a beating host reads two ways, and they must not
          // look alike. One is accounted for by a machine that is syncing; the
          // other is accounted for by nobody, and could be a daemon that
          // stopped on a box that merely shares a hostname.
          for (const m of r.sync.machines.filter((x) => x.suspect && x.claimedBy !== null)) {
            // Dim applied ONCE per line: c.dim closes with a full reset, so a
            // dim mark nested inside a dim line cancels the rest of the line.
            out(c.dim(`    ? ${(m.host ?? "?").padEnd(28)} ${ageOf(m)}  retired name — ${m.claimedBy} on this host claims it`));
            out(c.dim(`        ${m.machineId}`));
          }
          for (const m of r.sync.machines.filter((x) => x.suspect && x.claimedBy === null)) {
            out(c.yellow(`    ! ${(m.host ?? "?").padEnd(28)} ${ageOf(m)}  UNACCOUNTED — a retired id, or a daemon here that stopped`));
            out(c.dim(`        ${m.machineId}`));
          }

          const ghosts = r.sync.machines.filter((x) => x.ghost);
          if (ghosts.length > 0) {
            // Named, not warned about: these are retired ids the live record on
            // the same host disowns. Silence would look like a missing machine.
            out(c.dim(`    – retired ids (disowned by a live record on the same host): ${ghosts.map((g) => g.machineId).join(", ")}`));
          }
        }
        out();
        // MCP registration (written) per host
        out("  MCP registration (written):");
        for (const m of r.mcp) {
          const mark = m.registered ? c.green("✓") : m.configPresent ? c.yellow("✗") : c.dim("–");
          out(`    ${mark} ${m.target}: ${m.note}`);
          out(c.dim(`        ${m.path}`));
        }
        out();
        // Rules block (written)
        out("  Rules block (written):");
        for (const rb of r.rules) {
          out(`    ${rb.written ? c.green("✓") : c.dim("–")} ${rb.host}: ${rb.note}`);
          out(c.dim(`        ${rb.path}`));
        }
        out();
        // L1 retrieval shim (hooks + audit)
        out("  Retrieval shim (L1 hooks):");
        {
          const s = r.shim;
          const mark = s.written
            ? (s.resolvable ? c.green("✓") : c.red("✗"))
            : c.dim("–");
          out(`    ${mark} ${s.note}`);
          out(c.dim(`        ${s.settingsPath}`));
          if (r.shimAudit?.lastInjectAt) {
            out(c.dim(`        last inject: ${humanMs(Date.now() - Date.parse(r.shimAudit.lastInjectAt))} ago · topics ${r.shimAudit.lastInjectTopics.join(", ") || "—"} · ${r.shimAudit.lastDurationMs ?? "?"}ms`));
          } else if (r.shimAudit?.lastShimAt) {
            out(c.dim(`        last run: ${humanMs(Date.now() - Date.parse(r.shimAudit.lastShimAt))} ago · skipped=${r.shimAudit.lastSkippedReason ?? "?"} · ${r.shimAudit.lastDurationMs ?? "?"}ms`));
          } else if (s.written) {
            out(c.dim("        last inject: never observed"));
          }
          // The second reader of that same settings.json.
          const g = r.grok;
          if (g.installed) {
            const gm = g.dyingProcess ? c.yellow("!") : g.hooks === "off" ? c.green("✓") : c.dim("–");
            out(`    ${gm} Grok CLI: ${g.note}`);
            out(c.dim(`        ${g.configPath}`));
          }
        }
        out();
        // Session-end capture (opt-in)
        out("  Session-end capture:");
        {
          const cap = r.capture;
          const mark = cap.hookInstalled ? c.green("✓") : c.dim("–");
          out(`    ${mark} hook ${cap.hookInstalled ? "installed (SessionEnd/Stop)" : "not installed (opt-in: install-hooks --capture)"}`);
          if (cap.lastCaptureAt) {
            out(c.dim(
              `        last capture: ${humanMs(Date.now() - Date.parse(cap.lastCaptureAt))} ago · session ${cap.lastCaptureSessionId ?? "?"} · proposal #${cap.lastCaptureSeq ?? "?"} · n=${cap.capturedSessionCount}`,
            ));
          } else if (cap.hookInstalled) {
            out(c.dim("        last capture: never observed"));
          }
        }
        out();
        // Content — the second score. Everything above is CONNECT (wired);
        // this is whether the store holds anything true about its owner. The
        // two used to be conflated under one "Healthy." — see DoctorReport.
        out("  Content (is the store yours yet?):");
        {
          const ct = r.content;
          if (!ct.assessed) {
            out(c.dim(`    – not assessed — ${ct.reason ?? "unknown"}`));
          } else {
            const mark = ct.hasUserContent ? c.green("✓") : c.yellow("✗");
            const real = ct.realTopics.length;
            out(
              `    ${mark} ${ct.topicsTotal} topic${ct.topicsTotal === 1 ? "" : "s"} (${real} yours, ${ct.templateTopics.length} still template) · ` +
                `${ct.realLogEntries} real log entr${ct.realLogEntries === 1 ? "y" : "ies"} · ` +
                `${ct.pendingProposals}/${ct.maxPendingProposals} suggested edits pending`,
            );
            if (!ct.hasUserContent) out(c.dim(`        → ${BIN} onboard   walks the guided first-win path`));
          }
        }
        out();
        // Last read (loaded)
        if (r.lastRead) {
          out(`  Last store read: ${humanMs(Date.now() - Date.parse(r.lastRead.ts))} ago via ${r.lastRead.source} (${r.lastRead.op})`);
          for (const [source, hb] of Object.entries(r.lastReadBySource)) {
            if (r.lastRead && hb.ts === r.lastRead.ts && source === r.lastRead.source) continue;
            out(c.dim(`    ${source}: ${humanMs(Date.now() - Date.parse(hb.ts))} ago (${hb.op})`));
          }
        } else {
          out(c.yellow("  Last store read: never observed — written is not loaded until a real read lands."));
        }
        out();
        // Findings
        if (r.findings.length === 0) out(c.green("  No findings — everything checks out."));
        else {
          for (const f of r.findings) {
            const tag = f.level === "fail" ? c.red("FAIL") : f.level === "warn" ? c.yellow("warn") : c.dim("info");
            out(`  ${tag} ${f.message}`);
            if (f.hint) out(c.dim(`       → ${f.hint}`));
          }
        }
        out();
        // Two scores, one verdict line. "Healthy." alone was accurate about
        // plumbing and misleading about readiness (both Mac-beta assessments);
        // the exit-code contract is untouched — content never flips it.
        out(
          !r.healthy
            ? c.red("Findings above need attention.")
            : r.content.assessed && !r.content.hasUserContent
              ? c.green("Healthy (connect).") + c.yellow(` Content is still empty of you — \`${BIN} onboard\` is the guided fix.`)
              : c.green("Healthy."),
        );
        return r.healthy ? 0 : 1;
      }
      case "install-rules": {
        if (args.values["list-hosts"] === "1") {
          for (const h of rulesHosts()) {
            const state = h.file === null
              ? c.dim("no rules file")
              : rulesHostDetected(h)
                ? c.green("detected")
                : c.dim("not detected");
            out(`  ${h.id} (${h.label}) — ${state}`);
            out(c.dim(`      ${h.file ?? h.unsupported ?? "—"}`));
            // Why this host does or does not get the `--mode shim` body, in its
            // own terms and with the source we actually read. Printed here so
            // the answer is one command away instead of buried in a comment —
            // and so no blanket platform claim has anywhere to hide.
            out(c.dim(`      hook: ${h.hookNote}`));
          }
          return 0;
        }
        const modeRaw = (args.values["mode"] ?? "rules").toLowerCase();
        const mode: RulesMode = modeRaw === "shim" ? "shim" : "rules";
        // Some hosts keep their global rules behind a settings UI with no file
        // underneath (Cursor's Customize -> Rules; a Claude Desktop project
        // instruction). Those are the one class of host we cannot install into
        // no matter how much we automate — but "type this block by hand" and
        // "paste this block" are very different asks, and only the second one
        // survives a tester's first ten minutes. `--print` writes the exact
        // block to stdout and touches nothing, so a UI-only host is a copy and
        // a paste. Deliberately bare: no banner, no colour, no marker commentary,
        // because the output is meant to be piped or selected whole.
        if (args.values["print"] === "1") {
          process.stdout.write(rulesBlock(mode) + "\n");
          return 0;
        }
        const redirected = args.values["file"] !== undefined;
        const named = args.positionals.map((p) => p.trim().toLowerCase());
        if (redirected && named.length > 0) {
          return usageError("--file writes one exact file; drop the host names, or drop --file");
        }
        const unknown = named.filter((n) => !(RULES_HOST_IDS as string[]).includes(n));
        if (unknown.length > 0) {
          return usageError(`unknown rules host: ${unknown.join(", ")} — known: ${RULES_HOST_IDS.join(", ")} (or use --file)`);
        }
        const r = await installRulesAll({
          mode,
          ...(redirected ? { file: args.values["file"]! } : {}),
          ...(named.length > 0 ? { hosts: named } : {}),
        });
        // Optional: install hooks in the same step when mode=shim or --with-hooks.
        // --capture opts into session-end capture (SESSION-CAPTURE-SPEC v1).
        //
        // SCOPING (2026-07-28): `--file` redirects the RULES file, but hooks
        // live in the host's own settings.json, so they used to be written to
        // the REAL ~/.claude/settings.json even when the caller had clearly
        // aimed everything else at a scratch path. Testing the installer then
        // silently repointed the tester's live shim at a throwaway build.
        // A redirected --file now means "do not touch my host": hooks are
        // skipped unless explicitly asked for with --with-hooks. Naming hosts
        // that do not include claude-code is the same statement (2026-07-30):
        // the hooks belong to Claude Code, so `install-rules grok` must not
        // rewrite Claude Code's settings.json behind the user's back.
        //
        // DETECTION is part of scope (2026-07-30): the argument list alone said
        // "claude-code is in scope" on a machine with no ~/.claude at all, so a
        // Codex/Grok-only box running the shipped quickstart printed
        // "claude-code: skipped — not detected" and then CREATED ~/.claude with
        // UserPromptSubmit/SessionStart hooks for an app the user does not
        // have — after which `doctor` reported a retrieval shim the machine
        // cannot run. Hooks now require Claude Code to have been a real write
        // target, unless --with-hooks says otherwise.
        const claudeWritten = r.results.some(
          (h) =>
            h.host === "claude-code" &&
            (h.action === "installed" || h.action === "replaced" || h.action === "unchanged"),
        );
        const claudeNamed = !redirected && (named.length === 0 || named.includes("claude-code"));
        const claudeInScope = claudeNamed && claudeWritten;
        let hooksNote: string | undefined;
        if (!claudeInScope && mode === "shim" && args.values["with-hooks"] !== "1") {
          // Wording note (2026-07-31): these lines used to say "retrieval hooks
          // are Claude Code's only". That is a claim about OTHER hosts and it is
          // FALSE — Grok CLI scans ~/.claude/settings.json for hooks by default
          // and had these very handlers loaded. The true, narrow statement is
          // about US: install-hooks writes exactly one file, Claude Code's.
          hooksNote = redirected
            ? "hooks SKIPPED — install-hooks writes only Claude Code's settings.json, and --file points the rules somewhere custom, so ~/.claude/settings.json was left alone. Add --with-hooks to install them anyway."
            : claudeNamed
              ? "hooks SKIPPED — install-hooks writes only Claude Code's settings.json, and Claude Code was not written here (not detected). Add --with-hooks to install them anyway."
              : "hooks SKIPPED — install-hooks writes only Claude Code's settings.json; you named other hosts, so Claude Code's settings were left alone. Add --with-hooks to install them there anyway.";
        } else if (mode === "shim" || args.values["with-hooks"] === "1") {
          const hr = await installHooks({
            home: homePath,
            capture: args.values["capture"] === "1",
          });
          hooksNote = `hooks ${hr.action}${hr.capture ? " +capture" : ""} → ${hr.path}`;
        }
        const wroteSomething = r.results.some(
          (h) => h.action === "installed" || h.action === "replaced" || h.action === "unchanged",
        );
        // An explicitly named host that produced no write is a failed ask, not
        // a quiet success — `install-rules cursor && echo ok` must not print ok.
        const namedButNothing = named.length > 0 && !wroteSomething;
        if (args.json) out(JSON.stringify({ ...r, hooksNote }, null, 2));
        else {
          for (const h of r.results) renderRulesOutcome(h, true);
          // Only blame DETECTION when detection is actually the reason. A host
          // that refused because it has no rules file at all has already
          // explained itself, and re-suggesting it (it is in RULES_HOST_IDS)
          // told the user to name the very host that just refused.
          const allUnsupported =
            r.results.length > 0 && r.results.every((h) => h.action === "skipped" && h.path === null);
          // A detected host with no rules file now appears in the default sweep
          // (see installRulesAll), so "no known host detected here" can follow
          // three lines that just described one in detail. Both sentences were
          // true — no WRITABLE host was detected — and together they read as a
          // contradiction, which is worse than either alone.
          const explainedItself =
            r.results.some((h) => h.action === "skipped" && h.path === null);
          if (!wroteSomething && !allUnsupported) {
            out(
              c.yellow(
                explainedItself
                  ? `  ! nothing written automatically — the host above takes the step it describes. For the others: name one (${RULES_WRITABLE_HOST_IDS.join(", ")}) or use --file <path>.`
                  : `  ! nothing written — no known host detected here. Name one (${RULES_WRITABLE_HOST_IDS.join(", ")}) or use --file <path>.`,
              ),
            );
          }
          if (hooksNote) out(c.green(`  ${hooksNote}`));
          // "Written, not yet loaded" is the right last word after a write and
          // a plain falsehood after a run that wrote nothing, which is the same
          // incoherence as the detection line above.
          if (wroteSomething) out(c.yellow(`  ! ${r.caveat}`));
        }
        return r.results.some((h) => h.action === "failed") || namedButNothing ? 1 : 0;
      }
      case "uninstall-rules": {
        const redirected = args.values["file"] !== undefined;
        const named = args.positionals.map((p) => p.trim().toLowerCase());
        if (redirected && named.length > 0) {
          return usageError("--file removes from one exact file; drop the host names, or drop --file");
        }
        const unknown = named.filter((n) => !(RULES_HOST_IDS as string[]).includes(n));
        if (unknown.length > 0) {
          return usageError(`unknown rules host: ${unknown.join(", ")} — known: ${RULES_HOST_IDS.join(", ")} (or use --file)`);
        }
        const r = await uninstallRulesAll({
          ...(redirected ? { file: args.values["file"]! } : {}),
          ...(named.length > 0 ? { hosts: named } : {}),
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          for (const h of r.results) renderRulesOutcome(h);
          if (r.results.length === 0) out("No rules file carries the memory rule block — nothing to remove.");
        }
        return r.results.some((h) => h.action === "failed") ? 1 : 0;
      }
      case "install-hooks": {
        const r = await installHooks({
          home: homePath,
          capture: args.values["capture"] === "1",
        });
        if (args.json) out(JSON.stringify(r, null, 2));
        else {
          out(c.green(r.action === "unchanged"
            ? `Shim hooks already installed in ${r.path}`
            : r.action === "replaced"
              ? `Replaced shim hooks in ${r.path}`
              : `Installed shim hooks into ${r.path}`));
          out(c.dim(`  events: ${r.events.join(", ")}`));
          out(c.dim(`  ${r.command} ${r.args.join(" ")}`));
          if (r.capture) out(c.dim("  capture: SessionEnd + Stop → hook-capture (opt-in)"));
          out(c.yellow("  ! Host loads settings at session start — restart Claude Code to activate."));
          // The file we just wrote is read by a second tool. Say so HERE, at
          // the moment we create the situation, rather than leaving it for a
          // doc nobody opens. Stated as a fact about Grok, with the citation,
          // and offering a choice — this command does not touch Grok's config.
          const grok = readGrokCompat({});
          if (grok.dyingProcess) {
            out();
            out(c.yellow("  ! Grok CLI is installed here and reads this same file."));
            // The hedge travels with the finding: when we could not read the
            // compat cell, `grok.note` says so in its own words, and the
            // behaviour paragraph is introduced as a conditional rather than as
            // an observation about this machine.
            out(c.dim(`    ${grok.note}`));
            out(c.dim(`    ${grok.hooks === "unknown" ? "If it is scanning: " : ""}${GROK_HOOKS_BEHAVIOUR}`));
            if (!grok.optOutRefused) out(c.dim(`    ${GROK_COMPAT_OFFER}`));
          }
        }
        return 0;
      }
      case "grok-compat": {
        // Report by default; --off/--on are the only writes, and both are
        // explicit. There is deliberately no flag on `install-hooks` that does
        // this: install-hooks' whole contract is "writes exactly one file,
        // Claude Code's settings.json" (it says so in the setup renderer), and
        // `setup` calls it — a flag there is one refactor away from becoming a
        // default that silently reconfigures a second vendor's tool.
        const off = args.values["off"] === "1";
        const on = args.values["on"] === "1";
        if (off && on) return usageError("grok-compat: pass --off or --on, not both.");
        if (!off && !on) {
          const state = readGrokCompat({});
          if (args.json) {
            out(JSON.stringify({ ...state, behaviour: GROK_HOOKS_BEHAVIOUR, cost: GROK_COMPAT_COST }, null, 2));
            return 0;
          }
          const mark = state.dyingProcess ? c.yellow("!") : state.hooks === "off" ? c.green("✓") : c.dim("–");
          out(`${mark} ${state.note}`);
          out(c.dim(`  ${state.configPath}`));
          if (state.dyingProcess) {
            out();
            out(c.dim(`  ${state.hooks === "unknown" ? "If it is scanning: " : ""}${GROK_HOOKS_BEHAVIOUR}`));
            out();
            // Do not offer a command that will refuse. When the config's shape
            // is one this writer will not edit, say what to do instead.
            if (state.optOutRefused) {
              out(c.b(`  This config's shape is one \`--off\` will REFUSE. Run \`grok inspect\` for the resolved cell,`));
              out(c.b(`  then set ${GROK_COMPAT_KEY} = false by hand if you want it.`));
            } else {
              out(c.b("  To stop it: fimemory grok-compat --off"));
            }
            out(c.yellow(`  ! ${GROK_COMPAT_COST}`));
          } else if (state.hooks === "off") {
            out(c.yellow(`  ! ${GROK_COMPAT_COST}`));
            out(c.dim("  Undo with: fimemory grok-compat --on"));
          }
          return 0;
        }
        // THE COST IS PRINTED BEFORE THE ACTION, not after it and not in a doc.
        // The flag is the consent (this CLI is non-interactive by design and
        // treats an explicit flag as the decision, exactly as --env-passthrough
        // does for writing a passphrase in plaintext), so the one thing owed to
        // the user is that the price is on screen at the moment they read the
        // result.
        if (off && !args.json) out(c.yellow(`! ${GROK_COMPAT_COST}`));
        const r = await setGrokCompatHooks({ scan: on });
        if (args.json) {
          out(JSON.stringify({ ...r, cost: GROK_COMPAT_COST }, null, 2));
        } else {
          const line = `${r.action === "refused" || r.action === "absent" ? c.yellow("!") : c.green("✓")} ${r.note}`;
          out(line);
          out(c.dim(`  ${r.configPath}`));
          if (r.reverse) out(c.dim(`  ${r.reverse}`));
          if (r.action === "set" || r.action === "restored") {
            out(c.yellow("  ! Grok loads its config at start — restart Grok CLI to pick this up."));
          }
        }
        // A refusal is a real failure to do what was asked; `absent` and
        // `unchanged` are both fine answers.
        return r.action === "refused" ? 1 : 0;
      }
      case "uninstall-hooks": {
        const r = await uninstallHooks({});
        if (args.json) out(JSON.stringify(r, null, 2));
        else out(r.action === "removed"
          ? c.green(`Removed ${r.removed} shim hook handler(s) from ${r.path}.`)
          : `No fimemory shim hooks in ${r.path} — nothing to remove.`);
        return 0;
      }
      case "hook-capture": {
        // Session-end capture — fail-open, exit 0 always (SESSION-CAPTURE-SPEC).
        return await runHookCapture(homePath, args);
      }
      case "join": {
        const gitUrl = args.positionals[0]?.trim();
        if (!gitUrl) return usageError('join needs a git URL: fimemory join <git-url> [--home <path>] [--keyring <file>]');
        const { joinStore } = await import("./ops/joinOp.js");
        try {
          const r = await joinStore({
            gitUrl,
            home: homePath,
            // --skip-clone is for tests / already-cloned trees only.
            skipClone: args.values["skip-clone"] === "1",
            keyringFile: args.values["keyring"],
          });
          if (args.json) {
            out(JSON.stringify(r, null, 2));
            return 0;
          }
          out(c.green(`Joined store at ${r.home}`));
          for (const s of r.steps) out(c.dim(`  · ${s}`));
          out();
          out(c.b("Passphrase setup (machine-local only — never committed):"));
          for (const line of r.passphraseGuide) out(`  ${line}`);
          out();
          if (r.warnings.length) {
            for (const w of r.warnings) out(c.yellow(`  ! ${w}`));
            out();
          }
          out(c.b("Success check:"));
          out(`  ${r.successCheck}`);
          out();
          out(
            c.dim(
              `doctor healthy=${r.doctorHealthy} · encrypted=${r.encrypted} · keyring=${r.keyringPresent} · reindexed=${r.reindexed}`,
            ),
          );
          return 0;
        } catch (err) {
          if (err instanceof GestaltError) {
            process.stderr.write(`${c.red(err.message)}\n  ${c.dim("→")} ${err.hint}\n`);
            return 1;
          }
          throw err;
        }
      }
      case "pull": {
        const { pullStore } = await import("./ops/pullOp.js");
        try {
          const r = await pullStore({ home: homePath });
          if (args.json) {
            out(JSON.stringify({
              pulled: r.pulled,
              topics: Object.keys(r.index.topics).length,
              lastTimestamp: r.index.lastTimestamp,
              warnings: r.warnings,
              steps: r.steps,
            }, null, 2));
            return 0;
          }
          out(c.green(`Pulled store at ${r.home}`));
          for (const s of r.steps) out(c.dim(`  · ${s}`));
          out(
            c.dim(
              `catalog: ${Object.keys(r.index.topics).length} topic(s), lastTimestamp=${r.index.lastTimestamp ?? "null"}`,
            ),
          );
          renderWarnings(r.warnings);
          return 0;
        } catch (err) {
          if (err instanceof GestaltError) {
            process.stderr.write(`${c.red(err.message)}\n  ${c.dim("→")} ${err.hint}\n`);
            return 1;
          }
          throw err;
        }
      }
      case "brief":
      case "context": {
        const prompt = args.positionals.join(" ").trim();
        if (!prompt) return usageError(`${args.command} needs a prompt (words after the verb)`);
        // Soft-unlock for encrypted stores (session cache / env) — same path as
        // normal commands, but brief itself also fail-opens on lock.
        const r = await brief(homePath, prompt, {
          ...(args.values["session-id"] ? { sessionId: args.values["session-id"] } : {}),
          force: args.values["force"] === "1",
        });
        if (args.json) {
          out(JSON.stringify(r, null, 2));
        } else if (r.inject) {
          out(r.inject);
          out(c.dim(`# ${r.topics.length} topic(s) · ${r.tokens} tokens · ${r.durationMs}ms · q=${r.query}`));
        } else {
          out(c.dim(`(no inject — ${r.skippedReason ?? "empty"} · ${r.durationMs}ms)`));
        }
        return 0;
      }
      case "hook-retrieve": {
        // Dedicated pure-stdout entry for Claude Code hooks (guide A2/F-struct).
        // Contract: ALWAYS exit 0. Stdout is the protocol payload only.
        // Diagnostics → stderr. Never exit 2 (that blocks the user's prompt).
        return await runHookRetrieve(homePath, args);
      }
      default:
        return usageError(`Unknown command: ${args.command}`);
    }
  } catch (err) {
    if (err instanceof GestaltError) {
      if (args.json) process.stderr.write(JSON.stringify(err.toJSON(), null, 2) + "\n");
      else process.stderr.write(`${c.red(err.message)}\n  ${c.dim("→")} ${err.hint}\n`);
      return 1;
    }
    throw err;
  }
}

/**
 * SessionEnd capture hook — fail-open, empty stdout, exit 0 always.
 * stdin JSON carries transcript_path + session_id (SESSION-CAPTURE-SPEC v1).
 */
async function runHookCapture(home: string, args: Args): Promise<number> {
  const budgetMs = Math.max(
    50,
    Number(args.values["budget-ms"] ?? 500) || 500,
  );
  // Soft unlock only — never Argon2 in the hook path.
  try {
    const encrypted = keyringExists(home) || storeHasSealedContent(home);
    if (encrypted) {
      if (process.env.GESTALT_KEY) {
        try {
          assertEnvKeyMatchesStore(home, process.env.GESTALT_KEY);
          activateDek(Uint8Array.from(Buffer.from(process.env.GESTALT_KEY.trim(), "hex")));
        } catch {
          /* locked — capture will skip */
        }
      } else {
        const ttlMs =
          loadConfig(storePaths(home).config).config.sessionKeyCacheTtlHours * 3_600_000;
        if (ttlMs > 0) {
          const cachedHex = readSessionCache(home, Date.now(), { ttlMs });
          if (cachedHex) {
            try {
              assertEnvKeyMatchesStore(home, cachedHex);
              activateDek(Uint8Array.from(Buffer.from(cachedHex, "hex")));
            } catch {
              clearActiveKey();
            }
          }
        }
      }
    }
  } catch {
    /* fail open */
  }

  let payload: Record<string, unknown> = {};
  try {
    const raw = await readStdinWithDeadline(Math.min(budgetMs, 100));
    if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 0;
  }

  try {
    const { runSessionCapture } = await import("./ops/sessionCapture.js");
    await runSessionCapture({ home, payload, budgetMs });
  } catch {
    /* ignore — exit 0 always */
  }
  return 0;
}

/**
 * Claude Code hook entry — fail-open, stdout-pure, hard wall budget.
 *
 * Input: JSON on stdin (`prompt`, `session_id`, `hook_event_name`, …).
 * Output on success with inject:
 *   { "hookSpecificOutput": { "hookEventName": "…", "additionalContext": "…" } }
 * Output on skip/empty/timeout/error: empty stdout, exit 0.
 * Never exit 2. Never write diagnostics to stdout.
 */
async function runHookRetrieve(home: string, args: Args): Promise<number> {
  const budgetMs = Math.max(
    50,
    Number(args.values["budget-ms"] ?? HOOK_BUDGET_MS) || HOOK_BUDGET_MS,
  );
  const sessionStart = args.values["session-start"] === "1";

  // Soft unlock from session cache / env key only — never prompt, never derive
  // Argon2 (that alone blows the 300ms budget).
  try {
    const encrypted = keyringExists(home) || storeHasSealedContent(home);
    if (encrypted) {
      if (process.env.GESTALT_KEY) {
        try {
          assertEnvKeyMatchesStore(home, process.env.GESTALT_KEY);
          activateDek(Uint8Array.from(Buffer.from(process.env.GESTALT_KEY.trim(), "hex")));
        } catch {
          /* locked — brief will skip */
        }
      } else {
        const ttlMs =
          loadConfig(storePaths(home).config).config.sessionKeyCacheTtlHours * 3_600_000;
        if (ttlMs > 0) {
          const cachedHex = readSessionCache(home, Date.now(), { ttlMs });
          if (cachedHex) {
            try {
              assertEnvKeyMatchesStore(home, cachedHex);
              activateDek(Uint8Array.from(Buffer.from(cachedHex, "hex")));
            } catch {
              clearActiveKey();
            }
          }
        }
      }
    }
  } catch {
    /* ignore — fail open */
  }

  let prompt = "";
  let sessionId = "";
  let hookEventName = sessionStart ? "SessionStart" : "UserPromptSubmit";
  let payload: Record<string, unknown> = {};
  const startedAt = Date.now();

  try {
    const raw = await readStdinWithDeadline(Math.min(budgetMs, 100));
    if (raw.trim()) {
      const j = JSON.parse(raw) as Record<string, unknown>;
      payload = j;
      if (typeof j["prompt"] === "string") prompt = j["prompt"];
      if (typeof j["session_id"] === "string") sessionId = j["session_id"];
      if (typeof j["hook_event_name"] === "string") hookEventName = j["hook_event_name"];
    }
  } catch {
    // stdin parse failure → empty inject + exit 0 (guide A2 checklist #5)
    return 0;
  }

  // SessionStart has no user prompt — inject nothing (per-turn refresh is
  // UserPromptSubmit's job). Still exit 0 so the host is never blocked.
  if (sessionStart || hookEventName === "SessionStart") {
    if (!prompt.trim()) return 0;
  }
  if (!prompt.trim()) return 0;

  // Machine-generated prompts (task notifications, control tags) waste tokens
  // if we retrieve. Cheap skip — must stay fail-open and under the 300ms budget.
  if (isNonHumanPrompt(prompt, payload)) {
    try {
      const { recordShimAudit } = await import("./ops/shimAudit.js");
      recordShimAudit(home, {
        durationMs: Math.max(0, Date.now() - startedAt),
        skippedReason: "non-human",
        injected: false,
      });
    } catch {
      /* ignore */
    }
    return 0;
  }

  try {
    const work = brief(home, prompt, {
      sessionId: sessionId || undefined,
    });
    const raced = await Promise.race([
      work.then((r) => ({ kind: "ok" as const, r })),
      sleep(budgetMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (raced.kind === "timeout") {
      // Best-effort audit that we timed out (don't await long).
      try {
        const { recordShimAudit } = await import("./ops/shimAudit.js");
        recordShimAudit(home, {
          durationMs: budgetMs,
          skippedReason: "timeout",
          injected: false,
        });
      } catch {
        /* ignore */
      }
      return 0;
    }
    const r = raced.r;
    if (!r.inject) return 0;
    // Protocol payload only — no trailing logs.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: r.inject,
        },
      }) + "\n",
    );
    return 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read stdin until EOF or a soft deadline (ms). Empty on timeout/error.
 * Distinct from the unbounded `readStdin()` used by recover/ingest. */
function readStdinWithDeadline(deadlineMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (s: string): void => {
      if (done) return;
      done = true;
      resolve(s);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8")), deadlineMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    // In case stdin is already ended before listeners attach.
    process.stdin.resume();
  });
}

async function reviewCommand(args: Args, home: string): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const seq = Number(args.positionals[1]);

  if (sub === "list") {
    const rows = await reviewList(home);
    if (args.json) { out(JSON.stringify(rows, null, 2)); return 0; }
    const pending = rows.filter((r) => r.status === "pending");
    if (pending.length === 0) out("No suggested edits waiting.");
    for (const r of pending) out(`  ${c.b("#" + r.seq)} on ${r.id} ${c.dim(`by ${r.proposer}`)}  — fimemory review show ${r.seq}`);
    const others = rows.filter((r) => r.status !== "pending");
    if (others.length) out(c.dim(`\n${others.length} resolved (approved/rejected/outdated).`));
    return 0;
  }

  if (sub === "show") {
    const doc = await reviewShow(home, seq);
    if (args.json) { out(JSON.stringify(doc, null, 2)); return 0; }
    out(c.b(`Suggested edit #${doc.seq} on "${doc.id}"`) + c.dim(`  (${doc.status}, by ${doc.proposer})`));
    const ownerChanged =
      splitOwnerNotes(strip(doc.oldNote)).owner !== splitOwnerNotes(strip(doc.newNote)).owner;
    if (ownerChanged) out(c.yellow("  ⚠ This changes your Owner notes — approve with --allow-owner-notes only if you mean to."));
    out();
    out(insertionDiff(doc.oldNote, doc.newNote, "current", "suggested").trimEnd());
    out();
    out(c.dim(`Apply: fimemory review approve ${doc.seq}${ownerChanged ? " --allow-owner-notes" : ""}   ·   Discard: fimemory review reject ${doc.seq}`));
    return 0;
  }

  if (sub === "approve") {
    const r = await reviewApprove(home, seq, { allowOwnerNotes: args.allowOwnerNotes });
    out(c.green(`Approved #${seq} — "${r.id}" updated.`));
    return 0;
  }

  if (sub === "reject") {
    const r = await reviewReject(home, seq);
    out(`Rejected #${seq} on "${r.id}". Nothing changed.`);
    return 0;
  }

  return usageError("review needs: list | show <N> | approve <N> | reject <N>");
}

function strip(noteText: string): string {
  // body only, for the owner-notes compare in review show
  const i = noteText.indexOf("\n---\n");
  return i === -1 ? noteText : noteText.slice(i + 5);
}

/**
 * Returning `{}` here meant `get` fell through to ITS default, which was 0
 * until 2026-08-01 — so `fimemory get <id>` printed the curated note and no log
 * entries unless you knew to pass --log-tail. Same defect as the MCP path, same
 * reason it hid: the body only changes when a proposal is approved while the log
 * moves every session, so the quiet default served the stale half.
 *
 * Defaulted explicitly rather than left to the callee, so reading this function
 * tells you what a bare `get` actually does.
 */
function logTail(args: Args): { logTail: number } {
  const n = args.values["log-tail"];
  return { logTail: n !== undefined ? Number(n) : DEFAULT_LOG_TAIL };
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
