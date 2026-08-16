import { existsSync, readFileSync } from "node:fs";
import {
  BIN,
  LEGACY_MCP_SERVER_KEY,
  LEGACY_TOOL_PREFIX,
  MCP_SERVER_KEY,
  readEnv,
} from "../brand.js";
import { loadConfig } from "../config.js";
import { fsPath, storePaths } from "../paths.js";
import { peekSessionCache } from "../sessionKeyCache.js";
import type { SessionCachePeek } from "../sessionKeyCache.js";
import {
  assertEnvKeyMatchesStore,
  keyringExists,
  storeHasSealedContent,
} from "../store/keyring.js";
import { checkIndexIntegrity } from "../store/index.js";
import type { IndexIntegrity } from "../store/index.js";
import { readTelemetry } from "../telemetry.js";
import type { IndexRepairRecord, ReadHeartbeat } from "../telemetry.js";
import { PROPOSAL_CAP_WARN_RATIO, assessContent, notAssessed } from "./contentReadiness.js";
import type { ContentReadiness } from "./contentReadiness.js";
import {
  STALE_AFTER_MS,
  assessSyncFreshness,
  notAssessed as syncNotAssessed,
} from "./syncFreshness.js";
import type { MachineHeartbeat, SyncFreshness } from "./syncFreshness.js";
import { defaultHostConfigFiles } from "./installMcp.js";
import type { HostConfigFile, InstallTarget } from "./installMcp.js";
import {
  GROK_COMPAT_COST,
  GROK_COMPAT_OFFER,
  GROK_HOOKS_BEHAVIOUR,
  checkShimHooks,
  readGrokCompat,
} from "./installHooks.js";
import type { GrokCompatState, ShimHookCheck } from "./installHooks.js";
import {
  defaultRulesPath,
  detectRulesHosts,
  namesLegacyTools,
  rulesBlockBody,
  rulesHosts,
} from "./installRules.js";
import type { RulesRegistryOptions } from "./installRules.js";
import { captureHealth } from "./sessionCapture.js";
import { readShimAudit } from "./shimAudit.js";
import type { ShimAudit } from "./shimAudit.js";

/**
 * `fimemory doctor` — the trust surface: a stranger must be able to SEE whether
 * the install works, without reading source code and without risking their
 * data. Every check here is READ-ONLY by hard contract: doctor never creates,
 * writes, sweeps, wipes, or unlocks-and-caches anything — it only reports.
 * (That is why it uses `peekSessionCache`, never `readSessionCache`, and why it
 * never attempts the Argon2 passphrase derivation: a derivation would tempt a
 * cache write, and a diagnostic that mutates state can't be trusted mid-debug.)
 *
 * What it answers (guide Phases B–D + addendum Session-2):
 *   - store present? plaintext / encrypted-unlocked / encrypted-LOCKED (with
 *     the exact unlock hint);
 *   - where would a key come from? (env set? session cache warm/cold, TTL
 *     remaining — never the secret itself);
 *   - is the MCP server REGISTERED per host (written), and has anything
 *     actually READ the store (loaded) — the written-vs-loaded distinction of
 *     addendum §2.3: a config entry on disk proves nothing until a read lands;
 *   - is the rule block WRITTEN (marker scan) — loaded is unknowable statically
 *     (a written block is only loaded next session), and doctor says so;
 *   - does the derived `index.json` still SEE the notes on disk (D1)? The index
 *     is gitignored by `init` (derived + per-machine), so a cloned/copied/
 *     restored store arrives with every note and no index — and search, which
 *     iterates the index for its topic list, then returns nothing at all with
 *     no error. Before this check doctor said "Healthy." to that store;
 *   - last-read telemetry: has any agent read the store in the last N hours?
 *     (warn-only by addendum §2.4 — last-read must never flip the exit code);
 *   - the "shim locked, MCP warm" divergence (addendum Session-2 #2): the
 *     session cache has expired so every one-shot spawn is locked, while a
 *     long-lived MCP server still holds the DEK in process memory and keeps
 *     answering — diagnosable, not mysterious.
 *
 * Exit-code contract (the CLI's): 0 healthy, 1 findings — where "findings"
 * means level `fail` only. `warn`/`info` never flip the exit code, so a store
 * that is merely unused (or locked-but-passphrase-available) doesn't read as
 * broken.
 */

export type StoreMode =
  | "absent"
  | "plaintext"
  | "encrypted-unlocked"
  | "encrypted-locked";

export interface DoctorFinding {
  level: "fail" | "warn" | "info";
  code: string;
  message: string;
  hint?: string;
}

export interface DoctorMcpCheck {
  target: InstallTarget;
  path: string;
  /** The host app's config dir/file exists at all (app appears installed). */
  configPresent: boolean;
  /** WRITTEN: a gestalt server entry is present in that config. */
  registered: boolean;
  note: string;
}

export interface DoctorRulesCheck {
  host: string;
  path: string;
  /** WRITTEN: the marker scan found our block (current or legacy markers). */
  written: boolean;
  /**
   * WHICH BODY the file carries — not just that a marker is there.
   * `shim` = §2.5b "context may already be injected, do not re-search";
   * `rules` = §2.5 search-first; `unknown` = a block that is neither shipped
   * body; null = no block. A marker scan alone cannot tell a correct install
   * from a silently degraded one (see the `rules_shim_shared` finding).
   */
  body: "rules" | "shim" | "unknown" | null;
  /**
   * The block is installed but still names the pre-rename `gestalt_*` tool ids.
   * Present only when true. Upgrading the package changes which tools the MCP
   * server exposes; it does not rewrite a rules file already on disk, so until
   * `install-rules` runs again the model is told to call tools that no longer
   * exist and the store quietly stops answering.
   */
  legacyTools?: boolean;
  note: string;
}

export interface DoctorKeySources {
  /** GESTALT_PASSPHRASE is set in the environment (value never read further). */
  envPassphraseSet: boolean;
  /** GESTALT_KEY is set in the environment. */
  envKeySet: boolean;
  /** GESTALT_KEY (when set) actually opens THIS store. */
  envKeyValid?: boolean;
  /** Session-key cache freshness — warm/expired/cold, TTL remaining. */
  cache: SessionCachePeek;
}

export interface DoctorReport {
  home: string;
  storePresent: boolean;
  mode: StoreMode;
  /** The exact next step when mode is encrypted-locked. */
  unlockHint?: string;
  keySources?: DoctorKeySources;
  sessionKeyCacheTtlHours?: number;
  mcp: DoctorMcpCheck[];
  rules: DoctorRulesCheck[];
  /**
   * Derived-index integrity (D1). Null only when there is no store to check.
   * Note `entriesVerified: false` on an encrypted store — doctor never derives
   * keys, so it checks presence and age there and says so rather than asserting
   * a comparison it did not make.
   */
  index: IndexIntegrity | null;
  /** Last automatic index rebuild by the read path (null when none observed). */
  indexRepair: IndexRepairRecord | null;
  /** Most recent successful read, any source — null when never observed. */
  lastRead: ReadHeartbeat | null;
  /** Most recent successful read per source (cli / mcp). */
  lastReadBySource: Record<string, ReadHeartbeat>;
  /** Addendum Session-2 #2: one-shot spawns locked, long-lived MCP still warm. */
  divergence?: "shim-locked-mcp-warm";
  /**
   * L1 retrieval-shim surface (F-struct): Claude Code hooks + last inject
   * audit. Absent when doctor is pointed at a non-default settings path that
   * the caller did not supply — still always populated under defaults.
   */
  shim: ShimHookCheck;
  /**
   * What Grok CLI does with the hooks we wrote into Claude's settings. Exactly
   * the class of thing doctor exists for: a setup that LOOKS wired and is not.
   * Grok loads our handlers, cannot pass their `args`, and fails open — so on a
   * machine with both tools the only symptom is a process born and killed on
   * every Grok prompt, which nothing else on this machine would ever mention.
   */
  grok: GrokCompatState;
  /** Last shim run audit (null when never observed). */
  shimAudit: ShimAudit | null;
  /** Session-end capture health (SESSION-CAPTURE-SPEC v1). */
  capture: {
    hookInstalled: boolean;
    lastCaptureAt: string | null;
    lastCaptureSessionId: string | null;
    lastCaptureSeq: number | null;
    capturedSessionCount: number;
    lastSkippedReason: string | null;
  };
  /**
   * The SECOND score. Everything above answers CONNECT — is the machine wired.
   * This answers CONTENT — does the store hold anything true about its owner.
   * Both Mac-beta assessments (2026-08-05) found the two conflated: a store in
   * daily use and one never touched both reported "Healthy", and the one
   * signal the operator checks could not tell them apart. Warn-only like
   * last-read: an empty store is a fact about adoption, not a broken install,
   * so it never flips the exit code.
   */
  content: ContentReadiness;
  /**
   * The THIRD score. CONNECT says the machine is wired, CONTENT says the store
   * holds something true — neither says whether this is the SAME store the
   * owner's other machines are looking at. A store whose syncer died three days
   * ago reported exactly what a store syncing every 30 seconds reported, and
   * telling them apart meant a per-machine git investigation. Read from the
   * plaintext machine-state heartbeats Harness syncs into the store, so it
   * works offline and on a locked store. Warn-only: a machine asleep is a fact
   * about the day, not a broken install.
   */
  sync: SyncFreshness;
  findings: DoctorFinding[];
  /** True iff no `fail`-level findings. */
  healthy: boolean;
}

export interface DoctorOptions {
  home?: string;
  /** Environment to inspect (GESTALT_PASSPHRASE / GESTALT_KEY presence).
   * Defaults to process.env. Values are never echoed into the report. */
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Override host MCP config paths (tests / exotic layouts). Any target not
   * named falls back to its default location. */
  hostConfigPaths?: Partial<Record<InstallTarget, string>>;
  /** Override the rules files to scan. Default: every host `install-rules`
   * detects on this machine (claude-code, codex, gemini, grok, windsurf). */
  rulesPaths?: { host: string; file: string }[];
  /** User home used to BUILD the default rules-file AND host-config lists (not
   * the store home). Injectable so the default scans are reachable from a test. */
  userHome?: string;
  /** Override Claude settings.json for shim-hook checks (tests). */
  shimSettingsPath?: string;
  /** "Recently read" window for the last-read report, hours. Default 24. */
  lastReadWindowHours?: number;
}

export const UNLOCK_HINT =
  `Set GESTALT_PASSPHRASE, or run \`fimemory unlock --passphrase "..."\` (warms the session key cache), or check \`fimemory lock --status\`.`;

/** How recent an MCP read must be (ms) to count the server as "still warm" for
 * the shim-locked-MCP-warm divergence call. Deliberately much shorter than the
 * cache TTL: this is "the server answered just now", not "sometime today". */
const MCP_WARM_WINDOW_MS = 60 * 60_000;

/**
 * The rules files doctor scans, taken from `install-rules`' host registry so
 * the writer and the checker can never drift (same contract installMcp's
 * `defaultHostConfigFiles` has with doctor's MCP scan).
 *
 * Only hosts that are DETECTED here are listed — reporting "no rule block" for
 * five apps the user does not have is noise. Claude Code is always listed as
 * the floor, so the section is never empty. (Before 2026-07-30 this scanned
 * `~/.cursor/rules/fimemory.mdc`, a path Cursor does not load at all.)
 */
export function defaultRulesFiles(
  opts: RulesRegistryOptions = {},
): { host: string; file: string }[] {
  // The registry options are threaded through (rather than calling the
  // zero-arg default) so this function is REACHABLE from a test with a fake
  // home. Untested, the "writer and checker cannot drift" property it exists
  // for was asserted nowhere.
  const registry = rulesHosts(opts);
  const detected = detectRulesHosts(registry).map((h) => ({ host: h.id as string, file: h.file! }));
  if (detected.length > 0) return detected;
  const claude = registry.find((h) => h.id === "claude-code")?.file;
  return [{ host: "claude-code", file: claude ?? defaultRulesPath() }];
}

/** READ-ONLY check of one host config for a gestalt server entry. */
function checkHostConfig(host: HostConfigFile): DoctorMcpCheck {
  const base: Omit<DoctorMcpCheck, "configPresent" | "registered" | "note"> = {
    target: host.target,
    path: host.file,
  };
  if (!existsSync(fsPath(host.file))) {
    return {
      ...base,
      configPresent: false,
      registered: false,
      note: "config file not found — app not installed, or MCP never installed for it.",
    };
  }
  let raw: string;
  try {
    raw = readFileSync(fsPath(host.file), "utf8");
  } catch {
    return { ...base, configPresent: true, registered: false, note: "config exists but is unreadable." };
  }
  if (host.kind === "toml") {
    // Line-anchored: a commented-out `#[mcp_servers.fimemory]` must not read as
    // registered — TOML section headers only count at the start of a line.
    //
    // BOTH names, like every other reader of this surface. This is a separate
    // code path from the JSON check below and it was missed on the first pass
    // of the rename; the tests caught it. A Codex or Grok config still holding
    // the section an older build wrote is registered, and saying otherwise
    // sends someone to repair an install that works.
    const current = new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_KEY}\\]`, "m").test(raw);
    const legacy = new RegExp(`^\\s*\\[mcp_servers\\.${LEGACY_MCP_SERVER_KEY}\\]`, "m").test(raw);
    const registered = current || legacy;
    return {
      ...base,
      configPresent: true,
      registered,
      note: current
        ? `${MCP_SERVER_KEY} server section present.`
        : legacy
          ? `legacy [mcp_servers.${LEGACY_MCP_SERVER_KEY}] section present — run \`${BIN} install-mcp\` to migrate it.`
          : `no [mcp_servers.${MCP_SERVER_KEY}] section.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed?.[host.key];
    // Either name counts as registered. doctor's job is to tell the truth
    // about what is on disk, and after the rename a machine can legitimately
    // hold a legacy entry an older build wrote — reporting that as "not
    // registered" would send someone to fix an install that already works.
    // The note names WHICH one, so a legacy entry is visible rather than
    // merely tolerated: re-running `install-mcp` migrates it.
    const map =
      servers !== null && typeof servers === "object"
        ? (servers as Record<string, unknown>)
        : null;
    const foundKey =
      map === null
        ? null
        : map[MCP_SERVER_KEY] !== undefined
          ? MCP_SERVER_KEY
          : map[LEGACY_MCP_SERVER_KEY] !== undefined
            ? LEGACY_MCP_SERVER_KEY
            : null;
    const registered = foundKey !== null;
    return {
      ...base,
      configPresent: true,
      registered,
      note: registered
        ? foundKey === MCP_SERVER_KEY
          ? `${MCP_SERVER_KEY} server entry present.`
          : `legacy "${LEGACY_MCP_SERVER_KEY}" server entry present — run \`${BIN} install-mcp\` to migrate it to "${MCP_SERVER_KEY}".`
        : `no ${MCP_SERVER_KEY} entry under "${host.key}".`,
    };
  } catch {
    return { ...base, configPresent: true, registered: false, note: "config exists but is not valid JSON." };
  }
}

/** Human "Xh Ym" / "Ym" / "Zs" for durations — shared by the CLI renderer. */
export function humanMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * The staleness window as a human reads it ("4h").
 *
 * Printed wherever a machine is called overdue, so this report and the
 * cross-machine report the daemon that writes these records produces can be
 * reconciled by eye instead of by reading both sources. Derived from the
 * constant, never typed out, so it cannot drift from the value in force.
 */
export const STALE_WINDOW_LABEL = humanMs(STALE_AFTER_MS).replace(/ 0m$/, "");

/** Run every check. Read-only end to end — see the module comment. */
export function runDoctor(opts: DoctorOptions = {}): DoctorReport {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const home = opts.home ?? "";
  const findings: DoctorFinding[] = [];

  // ── Store presence + mode ─────────────────────────────────────────────────
  const paths = storePaths(home);
  // A STORE IS `config.json`. This used to accept `topics/` on its own, and
  // that skeleton is exactly what a REFUSED encrypted init left behind: the
  // directory tree is created before the missing-passphrase throw, so
  // `setup --encrypted` with no passphrase failed the init, wired MCP + hook +
  // rules to nothing, and then doctor — with no config.json, no keyring and no
  // sealed content — classified the folder `plaintext` and printed "Healthy."
  // The reader had ASKED for encryption and was told everything was fine over
  // an empty, unencrypted, config-less folder. `status` already reported the
  // missing config.json on the same store; doctor was the one verb that did
  // not. This predicate now matches `storeExistsAt` (setup.ts) and `runInit`'s
  // own E_EXISTS refusal, so the three cannot disagree.
  const storePresent = existsSync(fsPath(paths.config));
  const halfCreated = !storePresent && existsSync(fsPath(paths.topicsDir));
  let mode: StoreMode;
  let keySources: DoctorKeySources | undefined;
  let ttlHours: number | undefined;
  let unlockHint: string | undefined;

  if (!storePresent) {
    mode = "absent";
    findings.push(
      halfCreated
        ? {
            level: "fail",
            code: "store_half_created",
            // Named separately from `store_missing` because the remedy is
            // different: `init` REFUSES over this folder on some paths and the
            // reader is left re-running a command that cannot succeed, and a
            // plain `setup` here would silently create a PLAINTEXT store where
            // an encrypted one was asked for.
            message:
              `A half-created store is at ${home}: topics/ exists but config.json does not, so this is not a usable store ` +
              "(an init that failed part-way leaves exactly this).",
            hint: `Delete ${home} and run \`fimemory setup\` again (add --encrypted --passphrase "..." if you want it encrypted).`,
          }
        : {
            level: "fail",
            code: "store_missing",
            message: `No FIMemory store at ${home}.`,
            hint: "Run `fimemory init` (add --encrypted for at-rest encryption), or point --home / GESTALT_HOME at the real store.",
          },
    );
  } else if (!(keyringExists(home) || storeHasSealedContent(home))) {
    mode = "plaintext";
  } else {
    ttlHours = loadConfig(paths.config).config.sessionKeyCacheTtlHours;
    const ttlMs = ttlHours * 3_600_000;
    const envKeySet = Boolean(env["GESTALT_KEY"]);
    let envKeyValid: boolean | undefined;
    if (envKeySet) {
      try {
        assertEnvKeyMatchesStore(home, env["GESTALT_KEY"]!.trim());
        envKeyValid = true;
      } catch {
        envKeyValid = false;
      }
    }
    // Freshness only, by design: `peekSessionCache` never returns the DEK, so
    // doctor cannot (and must not) try the key against the ciphertext — a
    // stale-after-re-init warm entry is caught and cleared by the next REAL
    // unlock (`readSessionCache` verifies + wipes); doctor just reports what a
    // warm read would see.
    const cache = peekSessionCache(home, now, { ttlMs });
    keySources = {
      envPassphraseSet: Boolean(readEnv("PASSPHRASE", env)),
      envKeySet,
      ...(envKeyValid !== undefined ? { envKeyValid } : {}),
      cache,
    };
    const unlocked = envKeyValid === true || cache.state === "warm";
    mode = unlocked ? "encrypted-unlocked" : "encrypted-locked";
    if (!unlocked) {
      unlockHint = UNLOCK_HINT;
      if (keySources.envPassphraseSet) {
        findings.push({
          level: "warn",
          code: "locked_passphrase_available",
          message:
            "Store is encrypted and the session cache is cold, but GESTALT_PASSPHRASE is set — the next command will unlock (doctor never derives keys itself).",
          hint: "Run `fimemory unlock` to warm the session cache now.",
        });
      } else if (envKeySet && envKeyValid === false) {
        findings.push({
          level: "fail",
          code: "env_key_mismatch",
          message: "GESTALT_KEY is set but does not open this store.",
          hint: "Unset it or set the right key; or unlock with the passphrase instead.",
        });
      } else {
        findings.push({
          level: "fail",
          code: "store_locked",
          message: "Store is encrypted and LOCKED — no passphrase, key, or warm session cache is available.",
          hint: UNLOCK_HINT,
        });
      }
    }
  }

  // ── Derived index sees the notes on disk (D1) ─────────────────────────────
  // Read-only, like everything here: it stats and (on a plaintext store) parses
  // files. It never rebuilds — the repair lives in the READ path
  // (`loadIndexOrEmpty`), so running doctor cannot change the answer doctor is
  // about to give you. See that function for the argument.
  const telemetry = storePresent ? readTelemetry(home) : null;
  const indexRepair = telemetry?.lastIndexRepair ?? null;
  let index: IndexIntegrity | null = null;
  if (storePresent) {
    index = checkIndexIntegrity(home, { encrypted: mode !== "plaintext" });
    if (index.topicFiles > 0 && !index.indexPresent) {
      findings.push({
        level: "fail",
        code: "index_missing",
        message: `${index.topicFiles} topic file(s) on disk but no index.json — search and list return NOTHING, with no error.`,
        hint: "Run `fimemory reindex` (the next read also rebuilds it automatically). index.json is derived and per-machine, so `init` gitignores it — a cloned, copied, or restored store always arrives without one.",
      });
    } else if (index.invisible.length > 0) {
      const shown = index.invisible.slice(0, 8).join(", ");
      findings.push({
        level: "fail",
        code: "index_blind",
        message: `index.json does not list ${index.invisible.length} topic(s) that exist on disk: ${shown}${
          index.invisible.length > 8 ? ", …" : ""
        } — search iterates the index, so those notes are unreachable.`,
        hint: "Run `fimemory reindex` (the next read also rebuilds it automatically).",
      });
    } else if (index.indexPresent && mode === "plaintext" && !index.entriesVerified) {
      findings.push({
        level: "fail",
        code: "index_unreadable",
        message: `index.json is present but unusable: ${index.unverifiedReason}.`,
        hint: "Run `fimemory reindex` — the index is fully derived from topics/ and logs/, so rebuilding it loses nothing.",
      });
    }
    if (index.corrupt.length > 0) {
      // A topic file that cannot be parsed is a FAIL, not a curiosity. Every
      // other check deliberately looks past it — `reindex` skips it, and
      // `invisible` excludes it so a tombstone does not read as a defect — so
      // before this it was the one damaged state nothing in the product
      // mentioned. The read path no longer overwrites a good index with a
      // rebuild that dropped it, but the note itself is still unreadable and
      // only the owner can fix it.
      const shown = index.corrupt.slice(0, 8).join(", ");
      findings.push({
        level: "fail",
        code: "notes_unparsable",
        message: `${index.corrupt.length} topic file(s) on disk cannot be parsed: ${shown}${
          index.corrupt.length > 8 ? ", …" : ""
        } — a rebuild skips them, so they would silently disappear from list and search.`,
        hint: "Open each file and fix its frontmatter (a `git pull` that leaves conflict markers is the usual cause), then run `fimemory reindex`.",
      });
    }
    if (index.orphaned.length > 0) {
      findings.push({
        level: "warn",
        code: "index_orphan_entries",
        message: `index.json lists ${index.orphaned.length} topic(s) with no file on disk: ${index.orphaned
          .slice(0, 8)
          .join(", ")}${index.orphaned.length > 8 ? ", …" : ""} — every search pays for them and warns.`,
        hint: "Run `fimemory reindex`.",
      });
    }
    // Staleness is an mtime comparison and needs NO key, so it is knowable on
    // an encrypted store too. This used to require `entriesVerified`, which is
    // false for every encrypted store by construction (doctor never derives
    // keys), so the one finding that told an encrypted user their catalog had
    // fallen behind their notes could never fire for them. Gate it instead on
    // "no stronger finding about this same file already fired", which is what
    // the old condition was reaching for. For a plaintext store this is exactly
    // equivalent to the previous expression.
    const strongerIndexFinding =
      index.invisible.length > 0 || (mode === "plaintext" && !index.entriesVerified);
    if (index.stale && !strongerIndexFinding) {
      findings.push({
        level: "warn",
        code: "index_stale",
        message: `index.json is older than ${index.newestDurablePath ?? "the newest note/log"} — search still finds every topic (it re-reads notes and logs), but list/brief metadata may be behind.`,
        hint: "Run `fimemory reindex`; a normal write also refreshes it.",
      });
    }
    if (index.indexPresent && mode !== "plaintext") {
      findings.push({
        level: "info",
        code: "index_unverified",
        message: `index.json is present but its contents were NOT compared against topics/ — ${index.unverifiedReason}.`,
        hint: "Unverified, not clean. `fimemory reindex` on an unlocked store rebuilds it unconditionally if you want certainty.",
      });
    }
    // Sealed store without a local keyring: the passphrase ALONE cannot open a
    // fresh clone. keyring.json is gitignored on purpose (it is the wrapped key
    // material, and it must never ride the git remote), so a teammate who
    // clones and knows the passphrase still gets nothing until the keyring
    // travels out of band. Before this, that state looked like a wrong
    // passphrase, which is the least useful thing it could have looked like.
    if (storeHasSealedContent(home) && !keyringExists(home)) {
      findings.push({
        level: "fail",
        code: "keyring_missing",
        message:
          "This store is encrypted but keyring.json is missing — the passphrase alone cannot open a fresh clone (keyring is gitignored and must travel out of band).",
        hint: "Get keyring.json from the owner out of band (password manager / in person), place it in the store root, or run `fimemory join --keyring <path>`. Never commit keyring.json or the passphrase to the git remote.",
      });
    }
  }
  if (indexRepair !== null) {
    findings.push({
      level: "info",
      code: "index_auto_rebuilt",
      message: `index.json was rebuilt automatically by the read path ${humanMs(
        now - Date.parse(indexRepair.ts),
      )} ago (reason: ${indexRepair.reason}; ${indexRepair.topics} topic(s) indexed).`,
      hint: "Nothing to do — the index is derived, so a rebuild changes no notes. This is reported so the self-heal is not silent.",
    });
    if (indexRepair.skipped && indexRepair.skipped.length > 0) {
      // The rebuild that ran had nothing to preserve (no readable index), so it
      // wrote a NARROWED index. Whatever it could not parse is now absent from
      // list and search. Reported at `fail`, because the user's data is on disk
      // and invisible.
      findings.push({
        level: "fail",
        code: "index_rebuild_dropped",
        message:
          `that rebuild could not parse ${indexRepair.skipped.length} topic(s) and left them OUT of index.json: ` +
          `${indexRepair.skipped.slice(0, 8).join(", ")}${indexRepair.skipped.length > 8 ? ", …" : ""} — ` +
          "the files are still on disk, but list and search cannot see them.",
        hint: "Fix those topic files (conflict markers or broken frontmatter), then run `fimemory reindex`.",
      });
    }
  }

  // ── MCP registration per host (written) ───────────────────────────────────
  // The registry is built with the SAME injectables the rules scan uses, so a
  // test can point the whole host sweep at a fake home — and so `$GROK_HOME`
  // moves doctor's grok check exactly where install-mcp would write.
  const mcp: DoctorMcpCheck[] = defaultHostConfigFiles({
    ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }).map((h) =>
    checkHostConfig({
      ...h,
      file: opts.hostConfigPaths?.[h.target] ?? h.file,
    }),
  );
  const anyRegistered = mcp.some((m) => m.registered);
  const anyConfigPresent = mcp.some((m) => m.configPresent);
  if (!anyRegistered) {
    findings.push({
      level: "fail",
      code: "mcp_not_registered",
      message: anyConfigPresent
        ? "No host config has the gestalt MCP server registered."
        : "No host configs found at all — no AI tool can reach the store.",
      hint: "Run `fimemory install-mcp` (and restart the host so it loads the entry).",
    });
  }

  // ── Rules block written (marker scan) + WHICH BODY ────────────────────────
  const rulesRegistry = rulesHosts({
    ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  const rules: DoctorRulesCheck[] = (
    opts.rulesPaths ??
    defaultRulesFiles({
      ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    })
  ).map(
    ({ host, file }) => {
      if (!existsSync(fsPath(file))) {
        return { host, path: file, written: false, body: null, note: "file not found." };
      }
      let body: "rules" | "shim" | "unknown" | null;
      let legacyTools: boolean;
      try {
        const raw = readFileSync(fsPath(file), "utf8");
        body = rulesBlockBody(raw);
        legacyTools = body !== null && namesLegacyTools(raw);
      } catch {
        return { host, path: file, written: false, body: null, note: "file exists but is unreadable." };
      }
      const written = body !== null;
      return {
        host,
        path: file,
        written,
        body,
        ...(legacyTools ? { legacyTools: true } : {}),
        note: written
          ? legacyTools
            ? `rule block names the OLD ${LEGACY_TOOL_PREFIX}_* tool ids, which this build no longer exposes — ` +
              `the model is being told to call tools that do not exist. Run \`${BIN} install-rules\` to rewrite it.`
            : `rule block written (${body === "shim" ? "shim body" : body === "rules" ? "search-first body" : "body not recognised — hand-edited?"}; ` +
              "loaded: unknown — a written block is only loaded next session)."
          : "no fimemory rule block (markers not found).",
      };
    },
  );
  // THE SHARED-FILE TRAP, reported rather than assumed away. A rules file is not
  // private to the host that owns its path: Grok CLI reads ~/.claude/CLAUDE.md
  // (~/.grok/docs/user-guide/12-project-rules.md:26 and 05-configuration.md's
  // `[compat.claude] agents = true`; confirmed first-hand by `grok inspect
  // --json`). The shim body tells a model to STOP calling fimemory_search in
  // exchange for an injection, so in a file a non-hook host also reads it makes
  // that host strictly worse than uninstalled — and a marker-only scan called
  // that machine Healthy.
  for (const r of rules) {
    if (r.body !== "shim") continue;
    const host = rulesRegistry.find((h) => (h.id as string) === r.host);
    const sharers = (host?.alsoReadBy ?? [])
      .map((id) => rulesRegistry.find((h) => h.id === id))
      .filter((h) => h !== undefined && !h.supportsHook && h.detectDir !== null && existsSync(fsPath(h.detectDir)));
    if (sharers.length === 0) continue;
    findings.push({
      level: "fail",
      code: "rules_shim_shared",
      message:
        `${r.path} carries the SHIM rule block, but ${sharers.map((h) => h!.label).join(", ")} also read${sharers.length === 1 ? "s" : ""} that file ` +
        "and the retrieval hook does not run there — those agents are being told not to search, for an injection that never arrives.",
      hint: "Run `fimemory setup` (or `fimemory install-rules`) — it now writes the search-first block to any file a non-hook host shares.",
    });
  }
  const rulesMissing = rules.filter((r) => !r.written);
  if (rules.length > 0 && rulesMissing.length === rules.length) {
    findings.push({
      level: "warn",
      code: "rules_not_written",
      message: "No rules file carries the memory rule block — agents are not told to search the store first.",
      hint: "Run `fimemory install-rules` (takes effect next session).",
    });
  } else if (rulesMissing.length > 0) {
    // Per HOST, not "at least one host somewhere". The all-missing check above
    // is silenced the moment a single host carries the block, so on a machine
    // with Claude Code + Codex + Gemini + Grok, one hand-written ~/.claude
    // CLAUDE.md made doctor report Healthy while three of four detected hosts
    // had nothing and kept answering from assumption.
    findings.push({
      level: "warn",
      code: "rules_not_written_host",
      message:
        `Detected host(s) with no memory rule block: ${rulesMissing
          .map((r) => `${r.host} (${r.path})`)
          .join("; ")} — those agents are not told to search the store first.`,
      hint: "Run `fimemory install-rules` — with no arguments it writes every detected host (takes effect next session).",
    });
  }

  // ── Last-read telemetry (loaded) — warn-only by addendum §2.4 ─────────────
  const lastRead = telemetry?.lastRead ?? null;
  const lastReadBySource = telemetry?.bySource ?? {};
  const windowMs = (opts.lastReadWindowHours ?? 24) * 3_600_000;
  if (lastRead === null) {
    // INFO, not warn. A store nobody has read yet is the EXPECTED state at the
    // end of a successful install: the user cannot have generated a read,
    // because they have not restarted their AI tool. Ending a clean first run
    // on a yellow "warn" told them something had gone wrong when nothing had,
    // which is the last thing a stranger sees before deciding whether this
    // worked. Nothing is wrong and there is nothing to fix, so the line states
    // the next action instead of flagging a defect.
    findings.push({
      level: "info",
      code: "never_read",
      message: "No agent read yet — expected until you restart your AI tool and ask it something.",
      hint: "Restart the tool you connected, then ask it a question about a project. A successful search or get records a heartbeat here.",
    });
  } else if (now - Date.parse(lastRead.ts) > windowMs) {
    findings.push({
      level: "warn",
      code: "not_read_recently",
      message: `Last store read was ${humanMs(now - Date.parse(lastRead.ts))} ago (${lastRead.source}, ${lastRead.op}) — older than ${opts.lastReadWindowHours ?? 24}h.`,
      hint: "The host may simply not have been used; this never fails doctor.",
    });
  }
  if (anyRegistered && lastReadBySource["mcp"] === undefined) {
    // The level turns on whether ANYTHING has read the store yet, because the
    // two cases mean opposite things and used to share one yellow warning.
    //
    // Nothing has read it: this is a fresh install before the first restart.
    // Expected, not a defect, and pairing it with a yellow line was half of why
    // a clean install ended on two warnings.
    //
    // Something HAS read it but never over MCP: that is a real anomaly. The
    // shim or the CLI is reaching the store while the MCP entry we wrote is
    // not being loaded, which usually means the host never picked it up. Worth
    // a warning, because a user in that state believes they are connected and
    // is only half connected.
    // `null`, not `undefined`: line 596 normalises the absent case with `?? null`.
    const nothingHasReadYet = lastRead === null;
    findings.push({
      level: nothingHasReadYet ? "info" : "warn",
      code: "mcp_written_not_loaded",
      message: nothingHasReadYet
        ? "MCP entry is written but not loaded yet — expected until the host restarts."
        : "MCP is registered (written) but no MCP read has ever been observed (loaded), while the store HAS been read another way — the host is probably not picking the entry up.",
      hint: "Restart the host, then ask it a project question; doctor should then show an MCP read.",
    });
  }

  // ── Divergence: shim locked, MCP warm (addendum Session-2 #2) ─────────────
  let divergence: DoctorReport["divergence"];
  const mcpLast = lastReadBySource["mcp"];
  if (
    mode === "encrypted-locked" &&
    mcpLast !== undefined &&
    now - Date.parse(mcpLast.ts) <= MCP_WARM_WINDOW_MS
  ) {
    divergence = "shim-locked-mcp-warm";
    findings.push({
      level: "warn",
      code: "shim_locked_mcp_warm",
      message:
        "Divergence: one-shot commands are LOCKED (session cache cold, no env key) but a long-lived MCP server read the store recently — it still holds the key in process memory.",
      hint: "Run `fimemory unlock` to re-warm the one-shot path; the MCP server keeps working either way.",
    });
  }

  // ── L1 retrieval shim (F-struct): hooks + last-inject audit ───────────────
  const shim = checkShimHooks({
    ...(opts.shimSettingsPath ? { settingsPath: opts.shimSettingsPath } : {}),
    home,
  });
  // Orphaned hooks = FAIL (guide ship-blocker #3): install wrote a path that
  // no longer resolves → rage-uninstall / reinstall path.
  if (shim.written && !shim.resolvable) {
    findings.push({
      level: "fail",
      code: "shim_orphan_hooks",
      message:
        "Shim hooks are written in Claude settings but the command/cli path does not resolve — every prompt may hang or fail-open forever.",
      hint: "Run `fimemory uninstall-hooks` then `fimemory install-hooks` (or reinstall the package so dist/cli.js exists).",
    });
  }
  // ── Grok's Claude-compat hook scanning ────────────────────────────────────
  // Read-only, like everything here. Uses the SAME registry install-mcp writes
  // (so $GROK_HOME is honoured identically) and the shim result just computed,
  // rather than re-reading settings.json.
  const grok = readGrokCompat({
    ...(opts.hostConfigPaths?.grok !== undefined ? { configPath: opts.hostConfigPaths.grok } : {}),
    ...(opts.userHome !== undefined ? { userHome: opts.userHome } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    shimHooksPresent: shim.written,
  });
  // ORDER MATTERS, and it used to be wrong. `unknown` is folded into
  // `dyingProcess` on purpose (Grok's default is to scan, so "we could not
  // tell" must not read as an all-clear) — but the hooks_dead message states
  // the scanning as OBSERVED, and the hedged `grok_compat_unknown` branch below
  // was unreachable in exactly the case that matters, i.e. whenever our shim
  // hooks were present. A user who had already opted out in a shape we do not
  // parse was told, as fact, that his machine spawns a dead process per prompt,
  // and then handed a command that refuses and exits 1. So: unknown is reported
  // as unknown FIRST, with the conservative default stated as an assumption.
  if (grok.installed && grok.hooks === "unknown") {
    findings.push({
      level: grok.dyingProcess ? "warn" : "info",
      code: "grok_compat_unknown",
      message: grok.dyingProcess
        ? `${grok.note} If it is scanning: ${GROK_HOOKS_BEHAVIOUR}`
        : `Could not tell whether Grok scans Claude's settings for hooks: ${grok.reason}.`,
      hint: grok.optOutRefused
        ? `Assume it does (that is Grok's default). \`fimemory grok-compat --off\` will REFUSE this config rather than ` +
          `rewrite a shape it does not understand — run \`grok inspect\` to see the resolved cell, and set the flag by ` +
          `hand if you want it. ${GROK_COMPAT_COST}`
        : `Assume it does (that is Grok's default). ${GROK_COMPAT_OFFER} ${GROK_COMPAT_COST}`,
    });
  } else if (grok.dyingProcess) {
    // WARN, not fail. Nothing is broken: Grok fails open, Claude Code is
    // unaffected, and no data is at risk. It is waste plus a hook-failure line
    // in Grok's scrollback that no other surface would explain — which is the
    // definition of a doctor finding rather than an error.
    // THE EXPLANATION MOVES, THE PRICE DOES NOT.
    //
    // GROK_HOOKS_BEHAVIOUR is 1,303 characters of citations into Grok's own
    // docs explaining WHY this happens, and it was inlined into this finding on
    // the command whose whole job is a fast "is my setup fine". A cold-install
    // walkthrough on 2026-08-01 measured doctor at 5,737 characters with that
    // one paragraph taking a fifth of it, burying the findings either side.
    // `fimemory grok-compat` already prints it in full, reports only and writes
    // nothing, which is exactly what that verb is for — so the background goes
    // there and this message states the condition.
    //
    // GROK_COMPAT_COST STAYS, and a first pass at this wrongly dropped it. The
    // hint OFFERS `grok-compat --off`, and that switch is global to Grok: it
    // stops Grok honouring every Claude hook, not only ours. A remedy offered
    // without its price attached is a trap, however well documented the price
    // is somewhere else. grok-compat.test.ts pins this, and it was right to.
    findings.push({
      level: "warn",
      code: "grok_compat_hooks_dead",
      message: `${grok.note} Run \`${BIN} grok-compat\` for the full explanation (it writes nothing).`,
      hint: `${GROK_COMPAT_OFFER} ${GROK_COMPAT_COST}`,
    });
  } else if (grok.hooks === "off" && grok.ours) {
    // The cost of the remedy does not expire when the command exits, so it is
    // restated for as long as the line is in force — and only when WE put it
    // there, so a user who set it himself is not lectured about his own config.
    findings.push({
      level: "info",
      code: "grok_compat_hooks_off",
      message:
        `Grok's Claude-compat hook scanning is OFF at ${grok.configPath}, set by fimemory. ${GROK_COMPAT_COST}`,
      hint: "Run `fimemory grok-compat --on` to restore Grok's default, or delete the marked line from that file.",
    });
  }

  const shimAudit = storePresent ? readShimAudit(home) : null;
  if (shim.written && shimAudit?.lastSkippedReason === "locked") {
    findings.push({
      level: "warn",
      code: "shim_skipped_locked",
      message:
        "Shim last ran while the store was LOCKED / session cache cold — injects are silently empty until unlock.",
      hint: UNLOCK_HINT,
    });
  }
  if (shim.written && shimAudit === null) {
    findings.push({
      level: "info",
      code: "shim_never_injected",
      message: "Shim hooks are installed but no inject has been observed yet.",
      hint: "Submit a prompt in Claude Code; doctor will then show last inject / skip reason.",
    });
  }

  const cap = storePresent
    ? captureHealth(home)
    : {
        lastCaptureAt: null,
        lastCaptureSessionId: null,
        lastCaptureSeq: null,
        capturedSessionCount: 0,
        lastSkippedReason: null,
      };
  const capture = {
    hookInstalled: shim.capture,
    ...cap,
  };
  if (shim.capture && cap.lastCaptureAt === null && cap.capturedSessionCount === 0) {
    findings.push({
      level: "info",
      code: "capture_never_fired",
      message: "Session-end capture hooks are installed but no capture has been observed yet.",
      hint: "End a Claude Code session with tool use; a worklog proposal should appear in `fimemory review`.",
    });
  }

  // ── Content readiness — the second score (see DoctorReport.content) ───────
  const content = !storePresent
    ? notAssessed("no store")
    : mode !== "plaintext"
      ? notAssessed("encrypted store — doctor never derives keys, so content was not inspected")
      : assessContent(home);
  if (content.assessed) {
    if (!content.hasUserContent) {
      // The LEVEL turns on whether anything has read the store yet, the same
      // split `never_read` draws. Before the first read, an all-template store
      // is the expected end-state of a clean install — info, next action
      // stated. Once reads are landing, the asymmetry both beta assessments
      // named is LIVE: retrieval fires by machinery on every prompt and
      // returns tutorial stubs — a search tax, strictly worse than no store.
      // That is worth yellow.
      findings.push({
        level: lastRead === null ? "info" : "warn",
        code: "content_empty",
        message:
          lastRead === null
            ? "Content: the store is wired but holds nothing about you yet — every topic is a starter template."
            : "Content: agents ARE reading this store, and it still holds nothing about you — every search returns tutorial stubs, which trains you and your agents that the store is useless.",
        hint: `Run \`${BIN} onboard\` — the guided first-win path: close the review loop, then put your first real facts in.`,
      });
    }
    if (content.seedProposalPending) {
      findings.push({
        level: "info",
        code: "seed_review_pending",
        message:
          "The suggested edit pre-staged at install is still waiting — the approve flow (the product's trust model) has never been exercised.",
        hint: `Run \`${BIN} review show 1\`, then \`${BIN} review approve 1\` or \`reject 1\` — one loop, once.`,
      });
    }
    if (
      content.maxPendingProposals > 0 &&
      content.pendingProposals >= Math.ceil(content.maxPendingProposals * PROPOSAL_CAP_WARN_RATIO)
    ) {
      // The cap is a hard refusal (`maxPendingProposals`), and until this line
      // it arrived with no approach warning — debt that accrues invisibly and
      // surfaces as a failure is the wrong shape (Mac assessment F5).
      findings.push({
        level: "warn",
        code: "proposals_near_cap",
        message:
          `${content.pendingProposals} of ${content.maxPendingProposals} allowed suggested edits are pending — at the cap, ` +
          "new suggested edits are REFUSED and capture quietly stops producing anything.",
        hint: `Run \`${BIN} review\` and work the queue down (approve or reject; both are one command).`,
      });
    }
  }

  // ── Sync freshness — the third score (see DoctorReport.sync) ──────────────
  // Deliberately NOT gated on `mode`: the machine-state records are plaintext
  // by design, so this is the one score that still works on a locked store.
  const sync = !storePresent
    ? syncNotAssessed("no store")
    : assessSyncFreshness(home, now);
  // Outside the `assessed` gate on purpose. An unreadable record is the one
  // sync problem that survives having nothing to assess: if every record in
  // state/ is a merge conflict, the check assesses nothing and the fleet would
  // otherwise be reported as empty rather than as unreadable.
  if (sync.unreadable.length > 0) {
    findings.push({
      level: "warn",
      code: "machine_state_unreadable",
      message:
        `${sync.unreadable.length} machine heartbeat record(s) in state/ could not be read, so those machines are ` +
        `absent from this report rather than reported as stopped: ` +
        sync.unreadable.map((u) => `${u.file} (${u.reason})`).join("; "),
      hint:
        "These files sync between machines like everything else, so the usual causes are a merge conflict left in the " +
        "file or a half-written copy. Open each one: repair it, or delete it and let that machine publish a fresh " +
        "record. A record nothing can read looks exactly like a machine that never existed.",
    });
  }
  if (sync.assessed) {
    const staleWindow = STALE_WINDOW_LABEL;
    /** How long since a record checked in, for a reader skimming one line. */
    const ageWord = (m: MachineHeartbeat): string =>
      m.skewed
        ? "clock ahead of this machine, so its age cannot be read"
        : m.ageMs === null
          ? "no readable timestamp"
          : `last seen ${humanMs(m.ageMs)} ago`;
    // ONE finding per dark HOST, not per record. A box that goes dark with two
    // retired ids beside it otherwise produces three identical warnings naming
    // the same machine — the cry-wolf failure this tiering exists to prevent,
    // reappearing one level up.
    const darkHosts = new Map<string, MachineHeartbeat[]>();
    for (const m of sync.machines) {
      if (!m.stale) continue;
      const key = m.host ?? m.machineId;
      const group = darkHosts.get(key);
      if (group) group.push(m);
      else darkHosts.set(key, [m]);
    }
    for (const [where, records] of darkHosts) {
      const freshest = records.reduce((a, b) =>
        (a.ageMs ?? Number.MAX_SAFE_INTEGER) <= (b.ageMs ?? Number.MAX_SAFE_INTEGER) ? a : b,
      );
      const when = freshest.skewed
        ? "published a heartbeat dated in the FUTURE, so its clock is wrong and its real age cannot be read"
        : freshest.ageMs === null
          ? "published a heartbeat with no readable timestamp"
          : `has not published a heartbeat in ${humanMs(freshest.ageMs)} (overdue past ${staleWindow})`;
      const extra =
        records.length > 1 ? ` (${records.length} ids, newest shown: ${freshest.machineId})` : "";
      findings.push({
        level: "warn",
        code: "machine_not_syncing",
        message:
          `Machine "${where}"${extra} ${when} — ` +
          "this store and that machine's store are drifting apart, and neither will say so on its own.",
        hint:
          "On that machine: check the Harness daemon is running, then in its store run " +
          "`git pull --rebase origin main` and `git push origin main`.",
      });
    }
    // Divergence a live machine reported about ITSELF, which is the case a
    // heartbeat alone cannot show: it is checking in on time and still holds
    // commits nobody else has.
    // An overdue id on a host that is otherwise beating splits in two, and the
    // split is what evidence says, not what the hostname says.
    const claimed = sync.machines.filter((m) => m.suspect && m.claimedBy !== null);
    const unclaimed = sync.machines.filter((m) => m.suspect && m.claimedBy === null);
    if (claimed.length > 0) {
      // Info: a beating record on that host named this id as its own, so there
      // is a machine accounting for it. Still not asserted as certain — it is
      // reported as what was actually observed.
      findings.push({
        level: "info",
        code: "machine_id_probably_retired",
        message:
          `${claimed.length} overdue machine id(s) are accounted for by a machine that IS syncing: ` +
          claimed.map((m) => `${m.machineId} (claimed by ${m.claimedBy} on ${m.host ?? "?"})`).join(", ") +
          " — that machine reports the id as its own, so this reads as a retired name rather than a stopped machine.",
        hint:
          "Nothing to do unless you disagree. To stop it being listed, move state/<id>.json into state/.retired/ — " +
          "the report ignores that folder, and moving the file back undoes it.",
      });
    }
    if (unclaimed.length > 0) {
      // WARN, and deliberately unsure. This used to be info with the wording
      // "almost certainly retired ids, not stopped machines", which is a claim
      // the check has no evidence for: nothing here distinguishes a retired id
      // from a second daemon on that box that stopped, and a hostname does not
      // even establish it is the same box. Going quiet on that is how a machine
      // dark for three days read as all-clear.
      findings.push({
        level: "warn",
        code: "machine_id_unaccounted",
        message:
          `${unclaimed.length} overdue machine id(s) are on a host that is syncing, but nothing on that host ` +
          `accounts for them: ` +
          unclaimed.map((m) => `${m.machineId} (${m.host ?? "?"}, ${ageWord(m)})`).join(", ") +
          " — this is EITHER a retired id nobody cleaned up OR a second daemon on that machine that stopped, and " +
          "this check cannot tell which. Note that a matching hostname does not prove it is the same machine: a " +
          "default name from the hardware is common to every box of that model.",
        hint:
          "If the id is retired, move state/<id>.json into state/.retired/ (the report ignores that folder, and " +
          "moving the file back undoes it) and this clears for good. If it is not retired, something that should be " +
          "publishing under it has stopped — check that machine.",
      });
    }
    for (const m of sync.machines) {
      if (m.stale || m.ghost || m.suspect || m.drift.length === 0) continue;
      const unpushed = m.drift.filter((d) => d.ahead > 0);
      if (unpushed.length === 0) continue;
      findings.push({
        level: "warn",
        code: "machine_has_unpushed",
        message:
          `Machine "${m.host ?? m.machineId}" is syncing but reports unpushed commits: ` +
          unpushed.map((d) => `${d.label} +${d.ahead}`).join(", ") +
          " — that work exists on one disk only.",
        hint: "On that machine, push those repos; a heartbeat proves it is alive, not that its work is shared.",
      });
    }
  }

  return {
    home,
    storePresent,
    mode,
    ...(unlockHint !== undefined ? { unlockHint } : {}),
    ...(keySources !== undefined ? { keySources } : {}),
    ...(ttlHours !== undefined ? { sessionKeyCacheTtlHours: ttlHours } : {}),
    mcp,
    rules,
    index,
    indexRepair,
    lastRead,
    lastReadBySource,
    ...(divergence !== undefined ? { divergence } : {}),
    shim,
    grok,
    shimAudit,
    capture,
    content,
    sync,
    findings,
    healthy: !findings.some((f) => f.level === "fail"),
  };
}
