import { msFromIso } from "../clock.js";
import { GestaltError } from "../errors.js";
import { maxTimestampMs, parseLog } from "./log.js";

/**
 * Validate a proposed `compactedThrough` watermark (Gate #1 #7). It must be
 * null, or a timestamp no later than the newest log entry — never a *future*
 * watermark (which would hide un-folded log entries from future `compact`
 * packets) — and never move backward from the note's current value.
 */
export function assertValidCompactedThrough(
  proposed: string | null,
  current: string | null,
  logText: string,
): void {
  if (proposed === null) return;
  const proposedMs = msFromIso(proposed);
  if (Number.isNaN(proposedMs)) {
    throw new GestaltError(
      "E_SCHEMA",
      `compactedThrough "${proposed}" is not a valid timestamp.`,
      "Use a log entry timestamp, or null.",
    );
  }
  const maxMs = maxTimestampMs(parseLog(logText).entries);
  if (maxMs === null || proposedMs > maxMs) {
    throw new GestaltError(
      "E_SCHEMA",
      `compactedThrough "${proposed}" is beyond the newest log entry — it can't cover entries that don't exist yet.`,
      "Fold up to an existing log timestamp, or use null.",
    );
  }
  if (current !== null && proposedMs < msFromIso(current)) {
    throw new GestaltError(
      "E_SCHEMA",
      `compactedThrough can't move backward (currently ${current}).`,
      "Keep or advance the fold watermark.",
    );
  }
}
