/**
 * Task-ledger storage — WS-3 / NEXUS-WS3-HANDOFF + F3 sealed lines.
 *
 * JSON-per-line events under `ledgers/<topic>.jsonl`. Bypasses the typed log's
 * 5-type / 200-token schema (agents write the bus; humans write control verbs).
 *
 * **Sealing (F3 / NEXUS-PHASE0-FINDINGS):** on an encrypted store each event is
 * a PER-LINE deterministic AEAD seal (`gestalt-enc:1:…`) via `encodeLedgerLine`
 * — intentional fail-closed path that still keeps the file line-oriented so
 * `merge=union` concatenates cross-machine appends without the hub holding the
 * key. Plain stores stay plaintext JSONL. (Pre-F3 whole-file seal of the entire
 * jsonl as one blob is still readable via `decryptLegacyWholeFileLedger`.)
 *
 * `seq` is **per-machineId** (not global); global entry id = `machineId:seq`.
 * Ordering across boxes is HLC `(ts, machineId, seq)`.
 *
 * Author/addressee fields reject `|` and control characters (same spirit as
 * store/log.ts anti-injection). Values never include secrets — NAMES and URIs only.
 */
import {
  decodeLedgerLine,
  decryptLegacyWholeFileLedger,
  encodeLedgerLine,
  LEDGER_ENC_MAGIC,
} from "./codec.js";
function hasControl(s: string): boolean {
  for (const ch of s) if (ch.charCodeAt(0) < 0x20) return true;
  return false;
}

export interface LedgerEvent {
  /** Monotonic sequence number **per machineId** (assigned on append). */
  seq: number;
  /** ISO timestamp (assigned on append). */
  ts: string;
  /**
   * Replica that minted this line (Phase 0 HLC). Global entry id = machineId:seq.
   * Stamped by appendLedgerLine when omitted.
   */
  machineId: string;
  /** Fold key — all events sharing `task` fold into one task. */
  task: string;
  /** Root run id — present on every event of a cascade. */
  cascadeRoot: string;
  /** Idempotency key: hash(parent,slot,type,attempt) — fold dedups. */
  idem: string;
  type: LedgerEventType;
  from: string;
  to: string;
  parent: string | null;
  intent?: string;
  status?: TaskStatus;
  /** resultRef is always a work:// or mem:// pointer — never inline content. */
  resultRef?: string;
  /** Free-form but JSON-safe payload (no secrets). */
  payload?: Record<string, unknown>;
  /** Agent that wrote this line (attribution). */
  agent: string;
  /** Optional lease/heartbeat fields (Phase 0: owner = machineId:agentId). */
  lease?: { until: string; owner?: string };
  /** Depth of this assign in the cascade (0 = root). */
  depth?: number;
}

/** Global entry id for dual-machine cursors (Phase 0 C3). */
export function ledgerEntryId(e: { machineId?: string; seq: number }): string {
  return `${e.machineId ?? "local"}:${e.seq}`;
}

/** HLC compare: (ts, machineId, seq) lexicographic. */
export function compareLedgerHlc(a: LedgerEvent, b: LedgerEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const ma = a.machineId ?? "local";
  const mb = b.machineId ?? "local";
  if (ma !== mb) return ma < mb ? -1 : 1;
  return a.seq - b.seq;
}

export type LedgerEventType =
  | "assign"
  | "claim"
  | "delegate"
  | "plan"
  | "heartbeat"
  | "result"
  | "verify"
  | "gate"
  | "resolve"
  | "file"
  | "block"
  | "reassign"
  | "cancel"
  | "deadletter"
  | "note"
  /** Roster ledger (`ledgers/roster.jsonl`) — org chart + per-agent live flag. */
  | "roster-upsert"
  | "roster-set-live"
  | "roster-set-role"
  | "roster-set-parent"
  | "roster-remove"
  | "roster-default-root";

export type TaskStatus =
  | "assigned"
  | "claimed"
  | "in-progress"
  | "in-review"
  | "awaiting-approval"
  | "blocked"
  | "returned"
  | "filed"
  | "cancelled"
  | "dead-letter";

export const LEDGER_EVENT_TYPES: readonly LedgerEventType[] = [
  "assign",
  "claim",
  "delegate",
  "plan",
  "heartbeat",
  "result",
  "verify",
  "gate",
  "resolve",
  "file",
  "block",
  "reassign",
  "cancel",
  "deadletter",
  "note",
  "roster-upsert",
  "roster-set-live",
  "roster-set-role",
  "roster-set-parent",
  "roster-remove",
  "roster-default-root",
] as const;

const SAFE_ID_RE = /^[A-Za-z0-9_.:@/-]{1,128}$/;

/** Fields that must not carry control chars or pipe (injection surface). */
const SAFE_STRING_FIELDS = [
  "task",
  "cascadeRoot",
  "idem",
  "from",
  "to",
  "agent",
  "intent",
  "resultRef",
  "machineId",
] as const;

export function isLedgerEventType(s: string): s is LedgerEventType {
  return (LEDGER_EVENT_TYPES as readonly string[]).includes(s);
}

/**
 * Validate an inbound event *before* seq/ts assignment. Throws Error with a
 * short machine-readable message (callers wrap into GestaltError).
 */
export function assertLedgerEventWritable(
  partial: Omit<LedgerEvent, "seq" | "ts"> & { machineId?: string },
): void {
  if (!isLedgerEventType(partial.type)) {
    throw new Error(`invalid ledger event type: ${partial.type}`);
  }
  for (const key of SAFE_STRING_FIELDS) {
    const v = partial[key as keyof typeof partial];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    if (v.includes("|") || hasControl(v)) {
      throw new Error(`${key} contains forbidden characters`);
    }
    if (
      key === "from" ||
      key === "to" ||
      key === "agent" ||
      key === "task" ||
      key === "cascadeRoot" ||
      key === "machineId"
    ) {
      if (!SAFE_ID_RE.test(v) && v !== "") {
        throw new Error(`${key} has invalid shape`);
      }
    }
  }
  if (partial.parent !== null && partial.parent !== undefined) {
    if (typeof partial.parent !== "string" || partial.parent.includes("|") || hasControl(partial.parent)) {
      throw new Error("parent contains forbidden characters");
    }
  }
  if (partial.resultRef !== undefined) {
    if (
      !partial.resultRef.startsWith("work://") &&
      !partial.resultRef.startsWith("mem://")
    ) {
      throw new Error("resultRef must be work:// or mem://");
    }
  }
}

/**
 * Normalize on-disk ledger bytes before line parse: open a legacy whole-file
 * sealed blob (pre-F3) when present. `filePath` is needed for AAD.
 */
export function coerceLedgerPlaintext(filePath: string, text: string): string {
  if (!text.trim().startsWith(LEDGER_ENC_MAGIC)) return text;
  // Single-line whole-file blob → try legacy open; multi sealed lines stay as-is.
  const nonEmpty = text.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 1) {
    const legacy = decryptLegacyWholeFileLedger(filePath, text);
    if (legacy !== null) return legacy;
  }
  return text;
}

/** Parse a full ledger file into events (skips blank lines; bad lines dropped). */
export function parseLedger(text: string, filePath?: string): LedgerEvent[] {
  const body = filePath ? coerceLedgerPlaintext(filePath, text) : text;
  const out: LedgerEvent[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const plain = decodeLedgerLine(t);
      const obj = JSON.parse(plain) as LedgerEvent;
      if (typeof obj.seq === "number" && typeof obj.task === "string") {
        // Pre-Phase-0 lines lack machineId — treat as "local".
        if (!obj.machineId) obj.machineId = "local";
        out.push(obj);
      }
    } catch {
      /* skip corrupt / undecryptable line */
    }
  }
  return out;
}

/**
 * Serialize events to JSONL. On an encrypted store each line is sealed
 * (`encodeLedgerLine`) — byte-stable for identical events (E1-style).
 */
export function serializeLedger(events: LedgerEvent[]): string {
  if (events.length === 0) return "";
  return events.map((e) => encodeLedgerLine(JSON.stringify(e))).join("\n") + "\n";
}

/** Highest seq in a list (0 if empty). Prefer maxSeqForMachine for dual-machine. */
export function maxSeq(events: readonly LedgerEvent[]): number {
  let m = 0;
  for (const e of events) if (e.seq > m) m = e.seq;
  return m;
}

/** Highest seq minted by this machineId (per-replica counter). */
export function maxSeqForMachine(
  events: readonly LedgerEvent[],
  machineId: string,
): number {
  let m = 0;
  for (const e of events) {
    if ((e.machineId ?? "local") === machineId && e.seq > m) m = e.seq;
  }
  return m;
}
