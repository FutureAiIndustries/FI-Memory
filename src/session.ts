/**
 * Per-process read meter (SPEC §5.1/§6): `get`, `search`, and `compact` record
 * what they serve so `status` (and the MCP `fimemory_status` tool) can surface a
 * soft dogfood meter. It is *visibility, not enforcement* — the per-response
 * budget is the hard guarantee (invariant 3). Process-scoped by design: the
 * long-lived MCP server accumulates it; a one-shot CLI run cannot.
 *
 * Soft-warn thresholds (SPEC §6, rev 6): fixed numbers, surfaced as a gentle
 * line in `fimemory_status` only — never a hard session stop (a stop would brick
 * agents mid-task).
 */
export const SESSION_WARN_TOKENS = 50_000;
export const SESSION_WARN_TOKENS_STRONG = 200_000;

let topicsServed = 0;
let tokensServed = 0;

export function recordServed(topics: number, tokens: number): void {
  topicsServed += topics;
  tokensServed += tokens;
}

export function sessionMeter(): { topicsServed: number; tokensServed: number } {
  return { topicsServed, tokensServed };
}

/** The §6 soft-warn line for `fimemory_status`, or null when under the thresholds. */
export function sessionSoftWarning(): string | null {
  const n = tokensServed.toLocaleString("en-US");
  if (tokensServed >= SESSION_WARN_TOKENS_STRONG) {
    return `Heads up: this session has read ${n} of the read budget in total — that's a lot. Prefer narrower reads (fewer topics, shorter log tails).`;
  }
  if (tokensServed >= SESSION_WARN_TOKENS) {
    return `Note: this session has read ${n} of the read budget in total so far.`;
  }
  return null;
}

/** Reset the meter (used between tests). */
export function resetSession(): void {
  topicsServed = 0;
  tokensServed = 0;
}
