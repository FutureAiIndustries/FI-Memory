import { readFileSync } from "node:fs";
import type { Warning } from "./errors.js";
import { fsPath } from "./paths.js";

/** Store configuration (SPEC §5.9). */
export interface GestaltConfig {
  noteTokenCap: number;
  noteTokenWarn: number;
  entryTokenCap: number;
  maxTopicsPerGet: number;
  maxTokensPerGet: number;
  maxTokensPerCompact: number;
  maxSearchHits: number;
  maxPendingProposals: number;
  lockWaitMs: number;
  /** Session key cache TTL in hours (E2c). 0 disables the cache entirely —
   * every CLI command then pays the full Argon2id passphrase unlock. */
  sessionKeyCacheTtlHours: number;
  editor: string | null;
}

/** Frozen defaults (SPEC §5.9). `init` writes exactly these, pretty-printed. */
export const DEFAULT_CONFIG: GestaltConfig = {
  noteTokenCap: 1000,
  noteTokenWarn: 600,
  // 350 (was 200): refs count against the cap (ruling H3, 2026-08-12), so the
  // default grew to keep room for prose once provenance is attached.
  entryTokenCap: 350,
  maxTopicsPerGet: 3,
  maxTokensPerGet: 2000,
  maxTokensPerCompact: 6000,
  maxSearchHits: 10,
  maxPendingProposals: 20,
  lockWaitMs: 5000,
  sessionKeyCacheTtlHours: 8,
  editor: null,
};

/** Serialize config as pretty-printed JSON with a trailing newline (SPEC §1). */
export function serializeConfig(config: GestaltConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Read config.json, tolerating hand edits (invariant 1): any missing or
 * unparsable field falls back to the frozen default with a warning, so a
 * partly-mangled config never bricks the store.
 */
export function loadConfig(configPath: string): {
  config: GestaltConfig;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  let raw: unknown;
  try {
    // Codec-exempt on purpose: config.json is non-secret budgets and is read
    // synchronously before any key is available, so it stays plaintext even in
    // an encrypted store (see store/codec.ts). Do NOT route this through the codec.
    raw = JSON.parse(readFileSync(fsPath(configPath), "utf8"));
  } catch {
    warnings.push({
      code: "E_CORRUPT_SKIPPED",
      message: "config.json missing or unparsable; using default budgets",
    });
    return { config: { ...DEFAULT_CONFIG }, warnings };
  }

  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const merged = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof GestaltConfig)[]) {
    const value = source[key];
    if (key === "editor") {
      if (value === null || typeof value === "string") merged.editor = value;
      continue;
    }
    // Budgets/limits must be positive integers; lockWaitMs may be 0 (#21) and
    // sessionKeyCacheTtlHours may be 0 (0 = the cache opt-out, E2c).
    const min = key === "lockWaitMs" || key === "sessionKeyCacheTtlHours" ? 0 : 1;
    if (typeof value === "number" && Number.isInteger(value) && value >= min) {
      merged[key] = value;
    } else if (value !== undefined) {
      warnings.push({
        code: "E_CORRUPT_SKIPPED",
        message: `config.${key}=${JSON.stringify(value)} is invalid (need an integer ≥ ${min}); using default ${DEFAULT_CONFIG[key]}`,
      });
    }
  }
  return { config: merged, warnings };
}
