// Public API entry for gestalt-runtime — the ONLY surface the FI Harness sidebar
// (and any other in-process library consumer) may import. This file, plus the
// `exports` map in package.json that points to its build, is the deliverable of
// block HS3(a).
//
// It exposes the HS3 dependency register enumerated in HARNESS-SPEC-V1.md §4.4
// and — as a capability surface — "no more" (Gate #0, finding 11): the §4.1 ops
// the sidebar drives *as the human*, the human-surface full-note read, the token
// counter, and the label parameters that carry capture provenance. Alongside the
// register it re-exports a small NON-capability support surface (error types,
// `resolveHome`, and the closed validation constants — marked below) that
// carries no store capability, only what the route layer needs to locate the
// store, render runtime errors (§9/§10), and validate entry types. The daemon
// drives these library code paths as the human (H-I3); it registers no MCP
// server and extends no MCP tool list. Because package.json declares only `.`
// in its `exports` map, Node/TS refuse to resolve any deep import of an
// unexported path (ERR_PACKAGE_PATH_NOT_EXPORTED) — the import-boundary gate of
// acceptance criterion (a) is enforced at module resolution, and the harness's
// CI import-boundary check is belt-and-suspenders on top of it.
//
// DELIBERATELY NOT EXPORTED (agent-withheld or "Never in v0/v0.5", §4.1): the
// human-gated / maintenance ops `merge`, `ingest`, `pack`, `createTopic`
// (force-create), `installMcp`, and `compact`. `runInit` is exported for the
// Nexus first-run human surface only (same class as `ensureStoreUnlocked`).
// If the sidebar ever needs another withheld op it is an HS3-shaped Gestalt
// change with its own dated changelog entry, never a deep-import hack (§4.4).

import { GestaltError } from "./errors.js";
import { assertValidId } from "./id.js";
import { topicNotePath } from "./paths.js";
import { readText } from "./store/read.js";

// ── Read ops (§4.1, HB2 read block) ─────────────────────────────────────────
export { runStatus } from "./commands/status.js"; // "status"
export { list } from "./ops/list.js";
export { search } from "./ops/search.js";
export { get } from "./ops/get.js";
export type { StatusResult } from "./commands/status.js";
export type { ListRow } from "./ops/list.js";
export type { SearchHit, SearchOptions } from "./ops/search.js";
export type { GetOptions, GetResult, GetTopicResult } from "./ops/get.js";

// ── Review / approve library path + capture ops (§4.1, HB3 trust block) ──────
// The sidebar's approve/reject calls THESE SAME functions as `fimemory review
// approve|reject` — byte-identical results, the sidebar adds only rendering
// (§4.2). `appendLog` ("log") carries its agent/proposer label via the entry's
// `agent` field; `updateTopic` ("update") via `UpdateOptions.proposer` — the §7
// `harness-capture:<profile-slug>` stamp rides these, and nowhere near note
// bodies. The `--allow-owner-notes` override on approve stays CLI-only by
// construction (`ApproveOptions.allowOwnerNotes` is set only by the CLI; the
// sidebar route declares no field that maps to it), so a smuggled override is
// inert through the sidebar (§4.2 / HS3(b) test).
export { reviewList, reviewShow, reviewApprove, reviewReject } from "./ops/review.js";
export { appendLog } from "./ops/logOp.js"; // "log"
export { updateTopic } from "./ops/update.js"; // "update"
export { createTopic } from "./ops/create.js"; // "create" — Harness auto-files delegation records into per-project topics (7/23)
export type { ApproveOptions } from "./ops/review.js";
export type { LogOptions } from "./ops/logOp.js";
export type { UpdateOptions } from "./ops/update.js";
export type { NewEntry, LogEntry, LogType } from "./store/log.js";
export type { ProposalDoc, ProposalMeta } from "./store/proposals.js";
export type { TopicNote } from "./store/note.js";

// ── Task ledger (WS-3 / NEXUS-WS3-HANDOFF §2) ────────────────────────────────
// Raw JSON-per-line event bus for the delegation cascade. Bypasses the typed
// log's 5-type / 200-token schema. Additive — appendLog is unchanged.
export {
  appendLedgerLine,
  readLedgerSince,
  readLedgerAll,
} from "./ops/ledgerOp.js";
export type { AppendLedgerOptions, LedgerEventInput } from "./ops/ledgerOp.js";
export type {
  LedgerEvent,
  LedgerEventType,
  TaskStatus,
} from "./store/ledger.js";
export {
  LEDGER_EVENT_TYPES,
  isLedgerEventType,
  ledgerEntryId,
  compareLedgerHlc,
  maxSeqForMachine,
} from "./store/ledger.js";

// ── Trust surface (doctor / rules / telemetry — additive, Stream 2) ─────────
// `runDoctor` is the read-only "does my setup actually work?" report the Nexus
// UI can render; install/uninstall-rules manage the marker-delimited §2.5 rule
// block; `readTelemetry` answers "has any agent read the store lately?".
// All additive — nothing above this block changed shape.
export { runDoctor, humanMs, UNLOCK_HINT } from "./ops/doctor.js";
export type {
  DoctorOptions,
  DoctorReport,
  DoctorFinding,
  DoctorMcpCheck,
  DoctorRulesCheck,
  DoctorKeySources,
  StoreMode as DoctorStoreMode,
} from "./ops/doctor.js";
export {
  installRules,
  uninstallRules,
  installRulesAll,
  uninstallRulesAll,
  rulesBlock,
  rulesBlockWritten,
  defaultRulesPath,
  rulesHosts,
  rulesHostDetected,
  detectRulesHosts,
  geminiContextFile,
  geminiContextFileName,
  RULES_HOST_IDS,
  RULES_WRITABLE_HOST_IDS,
  RULES_MARKER_BEGIN,
  RULES_MARKER_END,
  RULES_BODY,
  RULES_BODY_SHIM,
} from "./ops/installRules.js";
export type {
  InstallRulesOptions,
  InstallRulesResult,
  InstallRulesAllOptions,
  InstallRulesAllResult,
  UninstallRulesResult,
  UninstallRulesAllResult,
  RulesHost,
  RulesHostId,
  RulesHostAction,
  RulesHostOutcome,
  RulesRegistryOptions,
  RulesMode,
} from "./ops/installRules.js";
// Shim hook install is CLI/trust-surface (like install-rules). Not a Harness
// library capability — agents must not deep-import it; the public surface
// only re-exports the doctor report fields that already include shim status.
export {
  installHooks,
  uninstallHooks,
  checkShimHooks,
  SHIM_ID,
} from "./ops/installHooks.js";
export type {
  InstallHooksOptions,
  InstallHooksResult,
  UninstallHooksResult,
  ShimHookCheck,
} from "./ops/installHooks.js";
export { readShimAudit } from "./ops/shimAudit.js";
export type { ShimAudit, ShimSkipReason } from "./ops/shimAudit.js";
// brief/context intentionally NOT exported — CLI/hook-only, same class as pack.
export { readTelemetry, recordRead, telemetryPath } from "./telemetry.js";
export type { ReadHeartbeat, TelemetryEntry } from "./telemetry.js";
export { peekSessionCache } from "./sessionKeyCache.js";
export type { SessionCachePeek } from "./sessionKeyCache.js";

// ── Store unlock for long-lived hosts (Harness daemon, WS-3 store-as-bus) ───
// Holds the DEK in-process after one passphrase/cache unlock so ledger writes
// succeed against E2d-encrypted stores. Same sources as the CLI.
export { ensureStoreUnlocked } from "./ops/unlockOp.js";
export type { UnlockOptions, UnlockResult } from "./ops/unlockOp.js";

// ── First-run onboarding (Harness Nexus wizard — human lane only) ────────────
// `runInit` + `migrateToEncrypted` create/encrypt a store and return the
// 24-word recovery mnemonic ONCE. Same ownership contract as the CLI
// (`fimemory init --encrypted` / `fimemory encrypt`). Absent from MCP; the
// harness control socket is the human surface. Never log the mnemonic.
export { runInit } from "./commands/init.js";
export type { InitOptions, InitResult } from "./commands/init.js";
// `recover` resets a forgotten passphrase with the 24-word phrase (Nexus in-app
// recovery — human lane only, like runInit). Refuses a phrase that can't open
// the store; re-keys with the new passphrase; wipes the old session cache.
export { recover } from "./store/keyring.js";
export { migrateToEncrypted } from "./ops/migrateEncrypt.js";
export type {
  MigrateEncryptOptions,
  MigrateEncryptResult,
} from "./ops/migrateEncrypt.js";
// `decrypt` is the inverse — "lock when needed" needs both directions. Human
// lane only, like the three above: it requires an UNLOCKED store (so it can only
// ever convert data the caller already reads) and an explicit acknowledgement
// that the store's git remote will hold plaintext from then on. Absent from MCP.
export { migrateToPlaintext, ARCHIVED_KEYRING_NAME } from "./ops/migrateDecrypt.js";
export type {
  MigrateDecryptOptions,
  MigrateDecryptResult,
  DecryptPlan,
} from "./ops/migrateDecrypt.js";
// ── Whole-file blob codec (Harness `work/` report mirror — the named "reports
// travel in plain text" launch rung). Same seam every store file already uses:
// identity when no key; fail-closed E_STORE_MODE on mode mismatch. The harness
// seals report blobs it mirrors INTO the store repo and decrypts on read; the
// DEK is whatever unlock activated in-process. Never a second crypto path.
export { encryptFile, decryptFile } from "./store/codec.js";

// ── Sync-seam human op (§4.1, HB7) ──────────────────────────────────────────
// `reindex` as the human (drift recovery + mandatory auto-reindex-after-pull).
// The sync status/pull/push ops of HB7 are not yet built in the runtime; when
// they land they join this same block.
export { reindexStore } from "./ops/reindexOp.js"; // "reindex"
export type { StoreIndex, IndexEntry } from "./store/index.js";

// ── Token counter (§4.4 / §7 live size meter) ───────────────────────────────
// `countTokens = ceil(chars/4)` over exactly the counted surface — never a UI
// re-implementation (H-I4). The composer meter counts the full serialized `###`
// block for log entries and the non-owner note body for suggested edits (§7);
// those counted surfaces are the caller's to assemble, this is the one counter.
export { countTokens } from "./tokens.js";

// ── Store location + error/validation surface (non-capability) ───────────────
// `resolveHome` lets the daemon hold one runtime instance against the real
// store path (`~/.gestalt` or `GESTALT_HOME`) the same way the CLI resolves it,
// so the two never drift (§4.4). The error class, closed code catalog, and
// log-type guard carry no store capability — they are what the route layer
// needs to build valid entries and render runtime errors per §9/§10.
export { resolveHome } from "./paths.js";
export { GestaltError, ERROR_CODES } from "./errors.js";
export { LOG_TYPES, isLogType } from "./store/log.js";
export type { HomeOpts } from "./paths.js";
export type { ErrorCode, Warning } from "./errors.js";

// ── Full-note read (§4.1 HB3 / §4.4, Gate #0 finding 10) ─────────────────────

/**
 * Result of the human-surface full-note read. `text` is the note's full
 * content, UTF-8-decoded — the composer's editing base (§7), verbatim for the
 * UTF-8 notes the store holds by construction (invariant 1). `bytes` is the
 * UTF-8 byte length of `text` — the size of the editing base itself — so the
 * harness route can enforce its own `noteFullReadMaxBytes` ceiling and raise
 * `H_NOTE_TOO_LARGE` rather than ever silently truncating (a truncated base
 * would silently delete the note's tail on approve). It bounds the size of what
 * the human actually edits and would write back, not raw on-disk bytes; the two
 * coincide for UTF-8 content.
 */
export interface NoteFullResult {
  id: string;
  text: string;
  bytes: number;
}

/**
 * Unbudgeted full-note read — the same class of read the CLI human performs by
 * opening the file, sanctioned by invariant 1 (plain files are the truth) and
 * exported for the sidebar as `readNoteFull` (HARNESS-SPEC §4.1, wire-named
 * `GET /api/gestalt/note/<id>/full`). It is a human surface: it charges no read
 * budget and is absent from MCP by construction (§12.15). Unlike `get`, it does
 * not clamp, truncate, or fold the log — it returns the note's full text so a
 * `update` proposal edits the complete current body, never a budgeted excerpt.
 * The route enforces the byte ceiling against `bytes`; this call itself is
 * unbounded, exactly as opening the file in an editor is. `text` is the
 * UTF-8-decoded note content (the store is UTF-8 by invariant 1); `bytes` is its
 * UTF-8 byte length.
 */
export async function readNoteFull(home: string, id: string): Promise<NoteFullResult> {
  assertValidId(id); // traversal guard — never join a path with an unvalidated id
  const text = await readText(topicNotePath(home, id));
  if (text === null) {
    throw new GestaltError(
      "E_NOT_FOUND",
      `No topic "${id}".`,
      `fimemory list   # see existing topics`,
    );
  }
  return { id, text, bytes: Buffer.byteLength(text, "utf8") };
}
