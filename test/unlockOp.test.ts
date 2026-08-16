import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStoreUnlocked } from "../src/ops/unlockOp.js";
import { clearActiveKey } from "../src/store/codec.js";

describe("ensureStoreUnlocked (Harness / store-as-bus)", () => {
  let home: string;
  afterEach(() => {
    clearActiveKey();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("plaintext store unlocks as no-op", () => {
    home = mkdtempSync(path.join(tmpdir(), "unlock-plain-"));
    mkdirSync(path.join(home, "topics"), { recursive: true });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        noteTokenCap: 1000,
        noteTokenWarn: 600,
        entryTokenCap: 200,
        maxTopicsPerGet: 3,
        maxTokensPerGet: 2000,
        maxTokensPerCompact: 6000,
        maxSearchHits: 10,
        maxPendingProposals: 20,
        lockWaitMs: 5000,
        sessionKeyCacheTtlHours: 8,
        editor: null,
      }),
    );
    writeFileSync(
      path.join(home, "index.json"),
      JSON.stringify({ version: 1, lastTimestamp: null, topics: {} }),
    );
    const r = ensureStoreUnlocked(home);
    expect(r.encrypted).toBe(false);
    expect(r.unlocked).toBe(true);
    expect(r.source).toBe("plaintext");
  });
});
