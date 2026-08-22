import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_STORE_DIRNAME, STORE_DIRNAME, readEnv } from "./brand.js";

/** Options that influence which store home we operate on. */
export interface HomeOpts {
  /** Value of the `--home` CLI flag, if provided. Highest precedence. */
  home?: string | undefined;
  /** Environment to read `FIMEMORY_HOME` (or legacy `GESTALT_HOME`) from. */
  env?: NodeJS.ProcessEnv;
  /** Home directory override, for tests. Defaults to `os.homedir()`. */
  userHome?: string;
}

const WIN = process.platform === "win32";
// Below Windows' classic 260-char MAX_PATH we leave paths untouched (normal
// semantics); at/above this we switch to the \\?\ extended-length form.
const LONG_PATH_THRESHOLD = 240;

/**
 * The default store path when no override is given: `~/.fimemory`.
 *
 * LEGACY AUTO-DETECT. A store that already exists at `~/.gestalt` keeps being
 * used, in place, forever. Nothing is moved, copied or migrated: the store is
 * the user's own folder of plain files, possibly a git working tree with a
 * remote, and silently relocating it would break every clone, every remote and
 * every `--home` path anybody wrote down. So the rename applies to stores
 * created from here on, and an existing one is simply opened where it is.
 *
 * Order matters. `~/.fimemory` wins when BOTH exist, because a user who has
 * both has already created a new-style store and that is the one they meant;
 * falling back to the legacy path there would silently reopen the old store
 * and make the new one look empty.
 */
export function defaultHome(userHome: string = os.homedir()): string {
  const current = path.join(userHome, STORE_DIRNAME);
  if (existsSync(current)) return current;
  const legacy = path.join(userHome, LEGACY_STORE_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return current;
}

/**
 * Which rule picked the home — the "which store am I in" provenance (R2,
 * ruled transparency UX 2026-08-19). `flag` covers both `--home` and its
 * `--store` alias; the env sources name the exact variable that won; the two
 * default forms distinguish a fresh `~/.fimemory` from an existing legacy
 * `~/.gestalt` opened in place.
 */
export type HomeSource =
  | "flag"
  | "FIMEMORY_STORE"
  | "GESTALT_STORE"
  | "FIMEMORY_HOME"
  | "GESTALT_HOME"
  | "default"
  | "default-legacy";

export interface ResolvedHome {
  home: string;
  source: HomeSource;
}

/**
 * Resolve the store home directory as an absolute, display-form path.
 * Precedence (SPEC §1, extended by R2): `--home`/`--store` flag >
 * `FIMEMORY_STORE` > `FIMEMORY_HOME` > (legacy `GESTALT_STORE` >
 * `GESTALT_HOME`) > `~/.fimemory` (or an existing `~/.gestalt`, see
 * `defaultHome`). `STORE` outranks `HOME` because it is the more specific
 * spelling, matching readEnv's new-name-then-legacy rationale.
 * Empty/whitespace overrides are ignored so a stray `FIMEMORY_HOME=` cannot
 * silently point the store at the filesystem root.
 */
export function resolveHomeWithSource(opts: HomeOpts = {}): ResolvedHome {
  const env = opts.env ?? process.env;
  const fromFlag = opts.home?.trim();
  if (fromFlag) return { home: path.resolve(fromFlag), source: "flag" };
  // readEnv prefers the new prefix and falls back per-suffix; name the exact
  // variable that won so the indicator never lies about provenance.
  for (const suffix of ["STORE", "HOME"] as const) {
    const value = readEnv(suffix, env);
    if (value) {
      const newName = `FIMEMORY_${suffix}` as HomeSource;
      const legacyName = `GESTALT_${suffix}` as HomeSource;
      const source = env[`FIMEMORY_${suffix}`]?.trim() ? newName : legacyName;
      return { home: path.resolve(value), source };
    }
  }
  const userHome = opts.userHome ?? os.homedir();
  const chosen = defaultHome(userHome);
  const source: HomeSource =
    path.basename(chosen) === LEGACY_STORE_DIRNAME ? "default-legacy" : "default";
  return { home: path.resolve(chosen), source };
}

export function resolveHome(opts: HomeOpts = {}): string {
  return resolveHomeWithSource(opts).home;
}

/** All the on-disk paths for a store (SPEC §1 layout), in display form. */
export interface StorePaths {
  home: string;
  config: string;
  index: string;
  /**
   * Plaintext store-format version (CROSS-MACHINE-PLAN Phase B). Readable
   * without a key. Absent ⇒ implicit schema_version 1.
   */
  schema: string;
  /** Authenticated store-mode marker — a small always-present sealed file that
   * is the canonical "this store is encrypted / does this DEK open it" oracle
   * (see store/keyring.ts). Absent in a plaintext store. */
  storeMarker: string;
  topicsDir: string;
  logsDir: string;
  proposalsDir: string;
  /** WS-3 task ledgers — JSONL event bus (appendLedgerLine / readLedgerSince). */
  ledgersDir: string;
  lockfile: string;
}

export function storePaths(home: string): StorePaths {
  return {
    home,
    config: path.join(home, "config.json"),
    index: path.join(home, "index.json"),
    schema: path.join(home, "schema.json"),
    storeMarker: path.join(home, "store.enc"),
    topicsDir: path.join(home, "topics"),
    logsDir: path.join(home, "logs"),
    proposalsDir: path.join(home, "proposals"),
    ledgersDir: path.join(home, "ledgers"),
    lockfile: path.join(home, ".gestalt.lock"),
  };
}

/** Path to a task ledger file (`ledgers/<topic>.jsonl`). Topic id validated by caller. */
export function ledgerPath(home: string, topic: string): string {
  return path.join(home, "ledgers", `${topic}.jsonl`);
}

export function topicNotePath(home: string, id: string): string {
  return path.join(home, "topics", `${id}.md`);
}

export function topicLogPath(home: string, id: string): string {
  return path.join(home, "logs", `${id}.log.md`);
}

/**
 * Proposal file path. New proposals are machine-scoped
 * (`{machineId}-{seq}-{id}.md`) so two clones never mint the same filename.
 * Legacy single-number paths (`{seq}-{id}.md`) are still accepted by the
 * proposal scanner for stores that predate the team-sync fix.
 */
export function proposalPath(
  home: string,
  seq: number,
  id: string,
  machineId?: string,
): string {
  if (machineId) {
    return path.join(home, "proposals", `${machineId}-${seq}-${id}.md`);
  }
  return path.join(home, "proposals", `${seq}-${id}.md`);
}

/**
 * Map a display-form absolute path to a filesystem-safe one.
 *
 * On Windows, paths at/above ~240 chars get the `\\?\` extended-length prefix
 * so `fs` calls succeed past MAX_PATH regardless of the machine's
 * `LongPathsEnabled` setting. Shorter paths and non-Windows platforms pass
 * through unchanged (so normal path semantics are preserved). Every `fs`
 * operation on a store path goes through this at the boundary; the display path
 * reported to the user never carries the prefix.
 */
export function fsPath(p: string): string {
  if (!WIN) return p;
  if (p.startsWith("\\\\?\\")) return p;
  const resolved = path.resolve(p);
  if (resolved.length < LONG_PATH_THRESHOLD) return resolved;
  if (resolved.startsWith("\\\\")) return "\\\\?\\UNC\\" + resolved.slice(2);
  return "\\\\?\\" + resolved;
}
