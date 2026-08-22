import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hookAlreadyServed } from "../src/ops/hookDedupe.js";

/**
 * The double-hook guard (plugin un-hold, 0.3.1): a machine carrying the
 * retrieval hook on both surfaces (settings.json handler + plugin hooks.json)
 * fires hook-retrieve twice per prompt. The guard makes retrieval idempotent
 * per (session, prompt) — first caller wins, second exits empty — and fails
 * open on every surprise, because a starved injection is worse than a
 * duplicated one.
 */

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "hook-dedupe-test-"));
}

describe("double-hook guard — hookAlreadyServed", () => {
  it("first invocation proceeds, the immediate second is served", () => {
    const d = dir();
    expect(hookAlreadyServed("sess-1", "what did we decide?", { dir: d })).toBe(false);
    expect(hookAlreadyServed("sess-1", "what did we decide?", { dir: d })).toBe(true);
  });

  it("a different prompt in the same session proceeds", () => {
    const d = dir();
    expect(hookAlreadyServed("sess-1", "first prompt", { dir: d })).toBe(false);
    expect(hookAlreadyServed("sess-1", "second prompt", { dir: d })).toBe(false);
  });

  it("the same prompt in a different session proceeds — sessions never starve each other", () => {
    const d = dir();
    expect(hookAlreadyServed("sess-1", "same words", { dir: d })).toBe(false);
    expect(hookAlreadyServed("sess-2", "same words", { dir: d })).toBe(false);
  });

  it("outside the window the same (session, prompt) retrieves again — a genuinely resent prompt is not starved", () => {
    const d = dir();
    const t0 = Date.now();
    expect(hookAlreadyServed("sess-1", "resent later", { dir: d, now: t0 })).toBe(false);
    expect(hookAlreadyServed("sess-1", "resent later", { dir: d, now: t0 + 6_000 })).toBe(false);
  });

  it("sweeps markers older than the sweep age, leaves fresh ones", () => {
    const d = dir();
    const stale = path.join(d, "fimemory-hook-stale00000000000000000000");
    writeFileSync(stale, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    hookAlreadyServed("sess-1", "sweep trigger", { dir: d });
    const names = readdirSync(d);
    expect(names).not.toContain("fimemory-hook-stale00000000000000000000");
    expect(names.some((n) => n.startsWith("fimemory-hook-"))).toBe(true);
  });

  it("an unusable marker directory fails OPEN — retrieval must never be starved by the guard", () => {
    const missing = path.join(os.tmpdir(), "hook-dedupe-does-not-exist", "nested");
    expect(hookAlreadyServed("sess-1", "anything", { dir: missing })).toBe(false);
  });
});
