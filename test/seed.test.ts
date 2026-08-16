import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { search } from "../src/ops/search.js";
import { SEED_TOPIC_IDS, seedAfterInit, seedStarterTopics } from "../src/ops/seed.js";
import { topicLogPath, topicNotePath } from "../src/paths.js";
import { activateDek, clearActiveKey } from "../src/store/codec.js";
import { loadIndexOrEmpty } from "../src/store/index.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { parseLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { nonOwnerBody } from "../src/store/ownerNotes.js";
import { readText } from "../src/store/read.js";
import { countTokens } from "../src/tokens.js";
import { expectGestaltErrorAsync, freshHome, tickingClock } from "./helpers.js";

// Tiny Argon2 params so the suite stays fast (real default is 64 MiB / t=3).
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;

afterEach(() => clearActiveKey());

async function seededStore(): Promise<string> {
  const home = freshHome("seed");
  runInit({ home });
  await seedStarterTopics(home, { now: tickingClock(1e12) });
  return home;
}

describe("seed-on-install (Lane F, F-A)", () => {
  it("creates the three starter topics through the real write path", async () => {
    const home = await seededStore();

    const index = await loadIndexOrEmpty(home);
    for (const id of SEED_TOPIC_IDS) {
      expect(index.topics[id], id).toBeDefined();
      expect(await readText(topicNotePath(home, id)), id).not.toBeNull();
      expect(await readText(topicLogPath(home, id)), id).not.toBeNull();
    }
    // The worked example is untouched beside the seeds.
    expect(index.topics["gestalt-example"]).toBeDefined();
  });

  it("reports what it seeded (3 topics, 8 entries)", async () => {
    const home = freshHome("seed");
    runInit({ home });
    const r = await seedStarterTopics(home, { now: tickingClock(1e12) });
    expect(r.topics).toEqual([...SEED_TOPIC_IDS]);
    expect(r.entries).toBe(8);
  });

  it("every seed entry respects the entry token cap; every note respects the note cap", async () => {
    const home = await seededStore();
    for (const id of SEED_TOPIC_IDS) {
      const { entries, warnings } = parseLog(
        (await readText(topicLogPath(home, id)))!,
        id,
      );
      expect(warnings, id).toEqual([]);
      expect(entries.length, id).toBeGreaterThan(0);
      for (const e of entries) {
        expect(countTokens(e.raw), `${id} ${e.timestamp}`).toBeLessThanOrEqual(
          DEFAULT_CONFIG.entryTokenCap,
        );
      }
      const note = parseNote((await readText(topicNotePath(home, id)))!, id)!;
      expect(countTokens(nonOwnerBody(note.body)), id).toBeLessThanOrEqual(
        DEFAULT_CONFIG.noteTokenCap,
      );
    }
  });

  it("the decisions topic demonstrates a real supersede pair", async () => {
    const home = await seededStore();
    const { entries } = parseLog(
      (await readText(topicLogPath(home, "decisions")))!,
      "decisions",
    );
    expect(entries.map((e) => e.type)).toEqual(["decision", "supersede"]);
    // The supersede points at the decision's REAL server-assigned timestamp.
    expect(entries[1]!.supersedes).toBe(entries[0]!.timestamp);
  });

  it("makes minute-one retrieval real: the seeds are findable by search", async () => {
    const home = await seededStore();
    const decisions = await search(home, "decisions");
    expect(decisions.hits[0]!.id).toBe("decisions");
    const rhythms = await search(home, "working rhythms");
    expect(rhythms.hits[0]!.id).toBe("working-rhythms");
    const started = await search(home, "getting started");
    expect(started.hits.map((h) => h.id)).toContain("getting-started");
  });

  it("refuses to seed twice (E_EXISTS — seeding is init-time, not an upsert)", async () => {
    const home = await seededStore();
    await expectGestaltErrorAsync(() => seedStarterTopics(home), "E_EXISTS");
  });

  it("seeds an ENCRYPTED store when the DEK is active (the CLI's unlock-around-seed)", async () => {
    const home = freshHome("seed-enc");
    const pass = "a perfectly decent passphrase";
    runInit({ home, encrypted: true, passphrase: pass, argon2: TINY, allowWeakParams: true });
    activateDek(unlockWithPassphrase(home, pass));
    try {
      const r = await seedStarterTopics(home, { now: tickingClock(1e12) });
      expect(r.entries).toBe(8);
      // Entries decode + parse under the key (per-entry sealed lines).
      const { entries } = parseLog(
        (await readText(topicLogPath(home, "decisions")))!,
        "decisions",
      );
      expect(entries).toHaveLength(2);
    } finally {
      clearActiveKey();
    }
  });
});

describe("seedAfterInit (the CLI's fault-isolated init→seed composition)", () => {
  it("plaintext: seeds and reports the result", async () => {
    const home = freshHome("sai");
    runInit({ home });
    const r = await seedAfterInit(home, { encrypted: false, now: tickingClock(1e12) });
    expect(r.seedError).toBeUndefined();
    expect(r.seeded!.topics).toEqual([...SEED_TOPIC_IDS]);
  });

  it("encrypted: an EMPTY --passphrase flag + env passphrase seeds with the ENV passphrase (mirrors runInit's truthiness — the mnemonic-eating divergence)", async () => {
    const home = freshHome("sai-enc");
    const env = { GESTALT_PASSPHRASE: "the env passphrase" } as NodeJS.ProcessEnv;
    // runInit falls back to env for a falsy flag — the CLI passes the flag
    // through the same truthiness filter. The seed must pick the SAME one.
    runInit({ home, encrypted: true, argon2: TINY, allowWeakParams: true, env });
    const r = await seedAfterInit(home, {
      encrypted: true,
      passphraseFlag: "",
      env,
      now: tickingClock(1e12),
    });
    expect(r.seedError).toBeUndefined();
    expect(r.seeded!.entries).toBe(8);
  });

  it("CONTAINS a failed unlock as seedError instead of throwing (init output — the shown-once mnemonic — must survive)", async () => {
    const home = freshHome("sai-wrong");
    runInit({
      home, encrypted: true, passphrase: "the right passphrase",
      argon2: TINY, allowWeakParams: true,
    });
    const r = await seedAfterInit(home, {
      encrypted: true,
      passphraseFlag: "the wrong passphrase",
      now: tickingClock(1e12),
    });
    expect(r.seeded).toBeUndefined();
    expect(r.seedError).toMatch(/passphrase/i);
  });

  it("encrypted with no passphrase anywhere: graceful seedError, never a crash", async () => {
    const home = freshHome("sai-none");
    const env = { GESTALT_PASSPHRASE: "a passphrase used only at init" } as NodeJS.ProcessEnv;
    runInit({ home, encrypted: true, argon2: TINY, allowWeakParams: true, env });
    const r = await seedAfterInit(home, {
      encrypted: true,
      env: {} as NodeJS.ProcessEnv,
      now: tickingClock(1e12),
    });
    expect(r.seeded).toBeUndefined();
    expect(r.seedError).toMatch(/passphrase/i);
  });
});
