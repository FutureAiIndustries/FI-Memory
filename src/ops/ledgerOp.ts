/**
 * Ledger ops — WS-3 seam + Phase 0 dual-machine + F3 sealed lines.
 *
 * `appendLedgerLine` / `readLedgerSince` / `readLedgerAll` — JSON-per-line event
 * bus. On encrypted stores each line is sealed (`gestalt-enc:1:…`) — intentional
 * codec path for kind `ledger` (line-oriented, merge=union-safe). Plain stores
 * stay plaintext JSONL.
 *
 * `seq` is per-machineId; stamp `machineId` on every append. Global entry id =
 * `machineId:seq` (Scheduler cursors must not use bare numeric seq — C3).
 */
import { promises as fsp } from "node:fs";
import { isoFromMs, nextMonotonic, systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import { assertValidId } from "../id.js";
import { ledgerPath, storePaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import {
  advanceGlobal,
  globalLastMs,
  loadIndexOrEmpty,
  writeIndex,
} from "../store/index.js";
import {
  assertLedgerEventWritable,
  maxSeqForMachine,
  parseLedger,
  serializeLedger,
  type LedgerEvent,
} from "../store/ledger.js";
import { withLock } from "../store/lock.js";
import { readText } from "../store/read.js";

export interface AppendLedgerOptions {
  now?: Clock;
  /** Replica id — stamped when the event omits machineId. */
  machineId?: string;
}

export type LedgerEventInput = Omit<LedgerEvent, "seq" | "ts" | "machineId"> & {
  machineId?: string;
};

/**
 * Append one event to `ledgers/<topic>.jsonl`. Assigns per-machine `seq` + `ts`
 * + `machineId`. Creates the ledgers dir and file on first write.
 */
export async function appendLedgerLine(
  home: string,
  topic: string,
  event: LedgerEventInput,
  opts: AppendLedgerOptions = {},
): Promise<LedgerEvent> {
  assertValidId(topic);
  const machineId = event.machineId ?? opts.machineId ?? "local";
  const withMachine = { ...event, machineId };
  try {
    assertLedgerEventWritable(withMachine);
  } catch (e) {
    throw new GestaltError(
      "E_SCHEMA",
      e instanceof Error ? e.message : "Invalid ledger event.",
      "Fix from/to/agent/machineId fields (no control chars) and retry.",
    );
  }

  const { config } = loadConfig(storePaths(home).config);
  const now = opts.now ?? systemClock;

  return withLock(home, config.lockWaitMs, async () => {
    const paths = storePaths(home);
    await fsp.mkdir(paths.ledgersDir, { recursive: true });

    const file = ledgerPath(home, topic);
    // Line-oriented seal on encrypted stores (F3). readText is identity for
    // kind "ledger" (not whole-file); parseLedger decodes each sealed line and
    // still opens pre-F3 whole-file sealed blobs via coerceLedgerPlaintext.
    const existingText = (await readText(file)) ?? "";
    const events = parseLedger(existingText, file);

    const index = await loadIndexOrEmpty(home, { underLock: true });
    const ts = isoFromMs(nextMonotonic(now(), globalLastMs(index)));
    // Per-replica counter (Phase 0 HLC) — not max across all machines.
    const seq = maxSeqForMachine(events, machineId) + 1;

    const written: LedgerEvent = {
      ...event,
      machineId,
      seq,
      ts,
    };
    events.push(written);
    await writeFileAtomic(file, serializeLedger(events));

    advanceGlobal(index, ts);
    await writeIndex(home, index);

    return written;
  });
}

/**
 * Return events with `seq > afterSeq` for a **single machine** (legacy helper).
 * Cross-machine ingest must use `readLedgerAll` + entry-id cursors (C3).
 */
export async function readLedgerSince(
  home: string,
  topic: string,
  afterSeq = 0,
): Promise<LedgerEvent[]> {
  assertValidId(topic);
  const file = ledgerPath(home, topic);
  const text = await readText(file);
  if (text === null) return [];
  return parseLedger(text, file).filter((e) => e.seq > afterSeq);
}

/** Read the entire ledger (Phase 0 dual-machine ingest). */
export async function readLedgerAll(
  home: string,
  topic: string,
): Promise<LedgerEvent[]> {
  assertValidId(topic);
  const file = ledgerPath(home, topic);
  const text = await readText(file);
  if (text === null) return [];
  return parseLedger(text, file);
}
