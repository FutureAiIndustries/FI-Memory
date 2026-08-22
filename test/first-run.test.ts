import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { GestaltError } from "../src/errors.js";
import { confirmMnemonic, planFirstRun, promptPassphrase } from "../src/ops/firstRun.js";
import type { FirstRunIO } from "../src/ops/firstRun.js";
import { fsPath } from "../src/paths.js";
import { freshHome } from "./helpers.js";
import { TINY_ARGON } from "./gitHarness.js";

/**
 * The 0.5 guided first run — encrypted-by-default at the CLI boundary.
 * planFirstRun decides mode + passphrase; these pin its whole contract with
 * scripted IO, because the load-bearing half of the flip is what happens when
 * nobody can answer a prompt: fail closed, never silently plaintext, never a
 * generated passphrase.
 */

function scriptedIO(answers: string[]): { io: FirstRunIO; lines: string[]; asked: string[] } {
  const queue = [...answers];
  const lines: string[] = [];
  const asked: string[] = [];
  const next = (q: string): Promise<string> => {
    asked.push(q);
    const a = queue.shift();
    if (a === undefined) throw new Error(`IO script exhausted at: ${q}`);
    return Promise.resolve(a);
  };
  return {
    io: {
      out: (l = "") => {
        lines.push(l);
      },
      ask: next,
      askHidden: next,
    },
    lines,
    asked,
  };
}

const STRONG = "a perfectly sturdy first-run passphrase";

describe("planFirstRun — the mode fork", () => {
  it("non-interactive with a FIMEMORY_PASSPHRASE env lands encrypted from the env, no questions asked", async () => {
    const { io, asked } = scriptedIO([]);
    const plan = await planFirstRun({
      explicitEncrypted: false,
      explicitPlaintext: false,
      env: { FIMEMORY_PASSPHRASE: STRONG },
      interactive: false,
      io,
      command: "init",
    });
    expect(plan).toEqual({ encrypted: true, passphrase: STRONG, source: "env" });
    expect(asked).toEqual([]);
  });

  it("non-interactive with NO passphrase source fails CLOSED, naming --plaintext and both env spellings' remedy", async () => {
    const { io } = scriptedIO([]);
    let err: GestaltError | null = null;
    try {
      await planFirstRun({
        explicitEncrypted: false,
        explicitPlaintext: false,
        env: {},
        interactive: false,
        io,
        command: "setup",
      });
    } catch (e) {
      err = e as GestaltError;
    }
    expect(err?.code).toBe("E_SCHEMA");
    expect(err?.message).toContain("encrypted by default");
    expect(err?.hint).toContain("--plaintext");
    expect(err?.hint).toContain("GESTALT_PASSPHRASE");
    // The hint names the verb the reader actually typed.
    expect(err?.hint).toContain("setup");
  });

  it("--plaintext opts out with no fork and no passphrase hunt", async () => {
    const { io, asked } = scriptedIO([]);
    const plan = await planFirstRun({
      explicitEncrypted: false,
      explicitPlaintext: true,
      env: { GESTALT_PASSPHRASE: STRONG }, // present and deliberately ignored
      interactive: true,
      io,
      command: "init",
    });
    expect(plan).toEqual({ encrypted: false, source: "plaintext" });
    expect(asked).toEqual([]);
  });

  it("the --passphrase flag outranks the env", async () => {
    const { io } = scriptedIO([]);
    const plan = await planFirstRun({
      explicitEncrypted: false,
      explicitPlaintext: false,
      passphraseFlag: "the flag passphrase wins here",
      env: { GESTALT_PASSPHRASE: STRONG },
      interactive: false,
      io,
      command: "init",
    });
    expect(plan.source).toBe("flag");
    expect(plan.passphrase).toBe("the flag passphrase wins here");
  });

  it("interactive fork: Enter continues encrypted and the guided prompt captures a passphrase", async () => {
    const { io, lines, asked } = scriptedIO([
      "", // Enter at the fork → encrypted
      STRONG, // passphrase
      STRONG, // confirm
    ]);
    const plan = await planFirstRun({
      explicitEncrypted: false,
      explicitPlaintext: false,
      env: {},
      interactive: true,
      io,
      command: "init",
    });
    expect(plan).toEqual({ encrypted: true, passphrase: STRONG, source: "prompt" });
    // The risk statement was shown at the fork — both costs, plain language.
    expect(lines.join("\n")).toContain("ENCRYPTED at rest");
    expect(lines.join("\n")).toContain("Plaintext: any person or program with file access");
    expect(asked.length).toBe(3);
  });

  it('interactive fork: typing "plaintext" is the one-word opt-out', async () => {
    const { io } = scriptedIO(["plaintext"]);
    const plan = await planFirstRun({
      explicitEncrypted: false,
      explicitPlaintext: false,
      env: {},
      interactive: true,
      io,
      command: "setup",
    });
    expect(plan).toEqual({ encrypted: false, source: "plaintext" });
  });

  it("an explicit --encrypted skips the fork entirely — the user already chose", async () => {
    const { io, asked } = scriptedIO([STRONG, STRONG]);
    const plan = await planFirstRun({
      explicitEncrypted: true,
      explicitPlaintext: false,
      env: {},
      interactive: true,
      io,
      command: "init",
    });
    expect(plan.source).toBe("prompt");
    // Two questions (passphrase + confirm) — no fork question before them.
    expect(asked.length).toBe(2);
    expect(asked[0]).toContain("passphrase");
  });
});

describe("promptPassphrase — floor, confirm, loop", () => {
  it("re-asks after a below-floor passphrase, then after a mismatched confirm, then succeeds", async () => {
    const { io, lines } = scriptedIO([
      "abc", // below the floor → rejected, loop
      STRONG,
      "not the same thing at all", // confirm mismatch → loop
      STRONG,
      STRONG, // match
    ]);
    const p = await promptPassphrase(io);
    expect(p).toBe(STRONG);
    const printed = lines.join("\n");
    expect(printed).toContain("not usable");
    expect(printed).toContain("did not match");
  });
});

describe("confirmMnemonic — the recorded-it drill", () => {
  const MNEMONIC =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima " +
    "mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray";

  it("the right two words confirm on the first attempt, case-insensitively", async () => {
    const { io } = scriptedIO(["  Charlie   KILO "]);
    const r = await confirmMnemonic(io, MNEMONIC, { pick: () => [2, 10] });
    expect(r).toEqual({ confirmed: true, attempts: 1 });
  });

  it("three misses give up LOUDLY instead of holding the store hostage", async () => {
    const { io, lines } = scriptedIO(["wrong words", "charlie lima", "kilo charlie"]);
    const r = await confirmMnemonic(io, MNEMONIC, { pick: () => [2, 10] });
    expect(r.confirmed).toBe(false);
    expect(r.attempts).toBe(3);
    expect(lines.join("\n")).toContain("NOT CONFIRMED");
  });
});

describe("the library seam under the flip", () => {
  it("runInit honours FIMEMORY_PASSPHRASE — the creating verb no longer disagrees with every opening verb", () => {
    const home = freshHome("first-run-envpass");
    const r = runInit({
      home,
      encrypted: true,
      env: { FIMEMORY_PASSPHRASE: STRONG } as NodeJS.ProcessEnv,
      argon2: TINY_ARGON,
      allowWeakParams: true,
    });
    expect(r.encrypted).toBe(true);
    expect(r.mnemonic?.split(/\s+/)).toHaveLength(24);
    expect(existsSync(fsPath(path.join(home, "keyring.json")))).toBe(true);
  });

  it("runInit's own default stays PLAINTEXT — the flip lives at the CLI boundary, not in the library", () => {
    const home = freshHome("first-run-libdefault");
    const r = runInit({ home });
    expect(r.encrypted).toBe(false);
    expect(existsSync(fsPath(path.join(home, "keyring.json")))).toBe(false);
    expect(existsSync(fsPath(path.join(home, "store.enc")))).toBe(false);
  });
});
