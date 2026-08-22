/**
 * Store format schema version (Phase B — CROSS-MACHINE-PLAN-MERGED §8.2 / §9 P5;
 * migration scaffold added for 0.4 — the 8/17 finding was that schema_version
 * had never moved and the skew gate had never fired in anger, so a future
 * format change had no rehearsed path to ride on).
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
import { writeFileAtomicPlain } from "./atomic.js";

/** Highest store format this client knows how to write. */
export const CLIENT_SCHEMA_VERSION = 1;

export interface StoreSchemaFile {
  schema_version: number;
  /** Lowest reader version that can still read this store. Written since the
   * start; enforced (as a warning) by `warnStoreReadable` since 0.4. */
  min_reader?: number;
}

/** How the schema file read went — provenance for gates and doctor. */
export type SchemaFileState = "absent" | "ok" | "corrupt";

export interface StoreSchemaInfo {
  version: number;
  minReader: number;
  state: SchemaFileState;
}

/**
 * Read the store's schema state with provenance. Absent file → implicit v1
 * (every pre-gate store). A PRESENT-but-unparsable file is reported as
 * `corrupt` so writes can refuse it (0.4) — but the version still defaults to
 * 1 so reads stay open.
 */
export function readStoreSchema(home: string): StoreSchemaInfo {
  const p = storePaths(home).schema;
  try {
    if (!existsSync(fsPath(p))) return { version: 1, minReader: 1, state: "absent" };
  } catch {
    return { version: 1, minReader: 1, state: "absent" };
  }
  try {
    const raw = readFileSync(fsPath(p), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreSchemaFile>;
    const v = parsed.schema_version;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { version: 1, minReader: 1, state: "corrupt" };
    }
    const mr = parsed.min_reader;
    const minReader = typeof mr === "number" && Number.isInteger(mr) && mr >= 1 ? mr : 1;
    return { version: v, minReader, state: "ok" };
  } catch {
    return { version: 1, minReader: 1, state: "corrupt" };
  }
}

/**
 * Resolve the store's schema_version. Missing or unparsable file → 1 (legacy).
 * Never throws for a missing file — cold paths and old stores must open.
 */
export function readStoreSchemaVersion(home: string): number {
  return readStoreSchema(home).version;
}

/** Serialize the schema file body (always pretty + trailing newline). */
export function serializeSchemaFile(version: number = CLIENT_SCHEMA_VERSION): string {
  const body: StoreSchemaFile = { schema_version: version, min_reader: 1 };
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * Refuse writes when this client is older than the store format — or when the
 * schema file is PRESENT but unparsable (0.4; previously a corrupt file was
 * silently treated as v1 for writes too).
 *
 * The old permissiveness was a deliberate anti-lockout choice; what changed is
 * that a one-command repair now exists (`fimemory migrate`), so refusing a
 * corrupt version marker no longer strands anyone. Reads stay open either way.
 */
export function assertStoreWritable(home: string): void {
  const schema = readStoreSchema(home);
  if (schema.state === "corrupt") {
    // Conflict markers mid-pull also parse as corrupt; resolveConflicts
    // resolves schema.json FIRST (max of the two sides) so its own phase-3
    // writes never hit this. Everyone else gets the repair hint.
    throw new GestaltError(
      "E_SCHEMA",
      "The store's schema.json exists but cannot be parsed, so this client cannot prove the store format is writable.",
      "Run `fimemory migrate` to repair the version marker (it rewrites schema.json under the store lock), then retry. Reads still work meanwhile.",
    );
  }
  if (CLIENT_SCHEMA_VERSION < schema.version) {
    throw new GestaltError(
      "E_SCHEMA",
      `This client understands store format ${CLIENT_SCHEMA_VERSION}, but the store is format ${schema.version}. Writing would risk corruption.`,
      `Upgrade FIMemory / gestalt-runtime so CLIENT_SCHEMA_VERSION >= ${schema.version}, then retry.`,
    );
  }
}

/**
 * The read-side gate `min_reader` was always written for and never wired to:
 * returns a human warning when this client is BELOW the store's declared
 * minimum reader, else null. A warning, not a refusal — reads stay permissive
 * by design; what ends is the silence about possibly-misread content.
 */
export function warnStoreReadable(home: string): string | null {
  const schema = readStoreSchema(home);
  if (CLIENT_SCHEMA_VERSION < schema.minReader) {
    return (
      `This store declares min_reader ${schema.minReader} and this client reads format ${CLIENT_SCHEMA_VERSION} — ` +
      `content in newer shapes may be missing or misread. Upgrade FIMemory to read it faithfully.`
    );
  }
  return null;
}

/**
 * 0.4 MIGRATION SCAFFOLD — the rehearsed path a real format change rides on.
 *
 * Keyed by the version a step migrates TO. A real v2 adds an entry here, bumps
 * CLIENT_SCHEMA_VERSION, and ships; older clients then refuse writes via the
 * gate above, and `fimemory migrate` walks a store forward step by step,
 * bumping schema.json LAST so a kill mid-step leaves the store honestly
 * marked at the version it still is.
 *
 * v1 has no transform — migrate on a v1 store only backfills schema.json onto
 * implicit-v1 stores (pre-Phase-B stores never got one) and repairs a corrupt
 * marker file.
 */
export const MIGRATIONS: Record<number, (home: string) => Promise<void>> = {};

export interface MigrateResult {
  from: number;
  to: number;
  wroteSchemaFile: boolean;
  repairedCorrupt: boolean;
}

/**
 * Walk the store from its current version to CLIENT_SCHEMA_VERSION. Caller
 * holds the store lock (the CLI verb does). Refuses to "migrate" a store
 * NEWER than this client — that direction is an upgrade of the client, not
 * of the store.
 */
export async function migrateStore(home: string): Promise<MigrateResult> {
  const before = readStoreSchema(home);
  if (before.state !== "corrupt" && before.version > CLIENT_SCHEMA_VERSION) {
    throw new GestaltError(
      "E_SCHEMA",
      `The store is format ${before.version}; this client only knows up to ${CLIENT_SCHEMA_VERSION}.`,
      "Upgrade FIMemory instead — migrate only moves a store FORWARD to the client's version.",
    );
  }
  const from = before.state === "corrupt" ? 1 : before.version;
  for (let v = from + 1; v <= CLIENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new GestaltError(
        "E_SCHEMA",
        `No migration step exists for format ${v}.`,
        "This is a build defect: a version bump shipped without its migration. Report it.",
      );
    }
    await step(home);
    // Bump AFTER the step so a kill mid-step leaves the marker honest.
    await writeFileAtomicPlain(fsPath(storePaths(home).schema), serializeSchemaFile(v), {
      verify: "strict",
    });
  }
  const needsMarker =
    before.state === "absent" || before.state === "corrupt" || from < CLIENT_SCHEMA_VERSION;
  if (needsMarker) {
    await writeFileAtomicPlain(
      fsPath(storePaths(home).schema),
      serializeSchemaFile(CLIENT_SCHEMA_VERSION),
      { verify: "strict" },
    );
  }
  return {
    from,
    to: CLIENT_SCHEMA_VERSION,
    wroteSchemaFile: needsMarker,
    repairedCorrupt: before.state === "corrupt",
  };
}
