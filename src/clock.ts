/**
 * Injectable clock for server-assigned timestamps (SPEC §4). The store never
 * reads the wall clock directly — it takes a `Clock` — so tests can drive time
 * deterministically while the CLI uses the real one.
 */
export type Clock = () => number; // epoch milliseconds

export const systemClock: Clock = () => Date.now();

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function msFromIso(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Next timestamp for a topic: millisecond precision, bumped to `lastMs + 1` on
 * a same-ms-or-earlier collision so per-topic timestamps are strictly
 * increasing and usable as stable ids for `supersede` (SPEC §4).
 */
export function nextMonotonic(nowMs: number, lastMs: number | null): number {
  return lastMs !== null && nowMs <= lastMs ? lastMs + 1 : nowMs;
}
