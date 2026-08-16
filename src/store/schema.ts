/**
 * Store format schema version (Phase B — CROSS-MACHINE-PLAN-MERGED §8.2 / §9 P5).
 *
 * Plaintext `schema.json` at the store root so a client can refuse to write
 * without unlocking. Reads stay permissive. Absent file = implicit version 1
 * (every store that existed before this gate).
 *
 * Do not put this in config.json (operator knobs) or keyring.json (gitignored
 * KDF wrap metadata).
 */
import { existsSync, readFileSync } from "node:fs";
import { GestaltError } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";

/** Highest store format this client knows how to write. */
export const CLIENT_SCHEMA_VERSION = 1;

export interface StoreSchemaFile {
  schema_version: number;
  /** Optional: lowest reader version that can still read (unused for refuse-write). */
  min_reader?: number;
}

/**
 * Resolve the store's schema_version. Missing or unparsable file → 1 (legacy).
 * Never throws for a missing file — cold paths and old stores must open.
 */
export function readStoreSchemaVersion(home: string): number {
  const p = storePaths(home).schema;
  try {
    if (!existsSync(fsPath(p))) return 1;
    const raw = readFileSync(fsPath(p), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreSchemaFile>;
    const v = parsed.schema_version;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return 1;
    return v;
  } catch {
    // Corrupt schema.json: treat as legacy-compatible for *reads*; writes still
    // need a known integer. Prefer refuse only when we can prove the store is
    // newer — corrupt/absent defaults to 1 so a bad file does not lock everyone
    // out of a working store. Doctor can flag parse failure separately later.
    return 1;
  }
}

/** Serialize the schema file body (always pretty + trailing newline). */
export function serializeSchemaFile(version: number = CLIENT_SCHEMA_VERSION): string {
  const body: StoreSchemaFile = { schema_version: version, min_reader: 1 };
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * Refuse writes when this client is older than the store format.
 * Call from every mutating path (centralized in `withLock`).
 */
export function assertStoreWritable(home: string): void {
  const storeVersion = readStoreSchemaVersion(home);
  if (CLIENT_SCHEMA_VERSION < storeVersion) {
    throw new GestaltError(
      "E_SCHEMA",
      `This client understands store format ${CLIENT_SCHEMA_VERSION}, but the store is format ${storeVersion}. Writing would risk corruption.`,
      `Upgrade FIMemory / gestalt-runtime so CLIENT_SCHEMA_VERSION >= ${storeVersion}, then retry.`,
    );
  }
}
