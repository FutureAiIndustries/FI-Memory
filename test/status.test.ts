import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { GestaltError } from "../src/errors.js";
import { fsPath } from "../src/paths.js";
import { withLock } from "../src/store/lock.js";
import { homeHasMemory, siblingHasMemory } from "../src/ops/migrateEncrypt.js";
import { expectGestaltError, freshHome } from "./helpers.js";

describe("status", () => {
  it("reports the store after init", () => {
    const home = freshHome();
    runInit({ home });
    const s = runStatus({ home });

    expect(s.home).toBe(path.resolve(home));
    expect(s.topicCount).toBe(1);
    expect(s.pendingProposals).toBe(1);
    expect(s.budget.maxTokensPerGet).toBe(2000);
    expect(s.budget.maxTopicsPerGet).toBe(3);
    expect(s.session).toEqual({ topicsRead: 0, readBudgetUsed: 0 });
    expect(s.warnings).toEqual([]);
  });

  it("errors with E_NOT_FOUND when there is no store", () => {
    const home = freshHome(); // never initialized
    expectGestaltError(() => runStatus({ home }), "E_NOT_FOUND");
  });

  // ── Grok GATE HIGH (commit-gap false-negative → total data loss): in the
  // commit-gap crash state — `home` ABSENT because a migration renamed it to
  // `.<base>.gestalt-plaintext-*` and planted `.<base>.gestalt-encrypting-*` —
  // status must NOT bail with E_NOT_FOUND + the `fimemory init` hint (following it
  // creates an empty store and steers the user into deleting their only real data).
  // It must emit the SAME recovery facts `encrypt` uses: name the temp paths, say
  // the data is intact, and NEVER suggest `fimemory init`. ─────────────────────────
  it("in a commit-gap crash (home absent, plaintext+encrypting siblings) names the temp paths and does NOT emit the `fimemory init` hint", () => {
    const home = freshHome("status-commit-gap"); // never initialized → home ABSENT
    const parent = path.dirname(home);
    const base = path.basename(home);
    // The exact on-disk state a commit-gap crash leaves: home renamed aside to the
    // plaintext backup + the interrupted ciphertext staging, home itself gone.
    const plaintext = path.join(parent, `.${base}.gestalt-plaintext-1234-5678`);
    const encrypting = path.join(parent, `.${base}.gestalt-encrypting-1234-5678`);
    mkdirSync(fsPath(plaintext), { recursive: true });
    writeFileSync(fsPath(path.join(plaintext, "config.json")), "{}", "utf8");
    mkdirSync(fsPath(encrypting), { recursive: true });

    let caught: GestaltError | undefined;
    try {
      runStatus({ home });
    } catch (e) {
      caught = e as GestaltError;
    }
    expect(caught).toBeInstanceOf(GestaltError);
    const text = `${caught!.message} ${caught!.hint ?? ""}`;
    // Names BOTH temp paths and tells the user their data is intact…
    expect(text).toContain(plaintext);
    expect(text).toContain(encrypting);
    // …points at the self-healing recovery (`fimemory encrypt`)…
    expect(text).toMatch(/fimemory encrypt/);
    // …and NEVER at the destructive `fimemory init` hint.
    expect(text).not.toMatch(/fimemory init/);
  });

  // ── FIX C (regression 6): the ENCRYPTING-ONLY variant — home absent, ONLY a
  // `.gestalt-encrypting-*` (ciphertext staging) dir, NO plaintext backup. The
  // recovery message must NOT name a nonexistent `.gestalt-plaintext-*` dir and must
  // NOT claim `fimemory encrypt` self-heals (it THROWS in this state). It must name
  // the actual encrypting path, say there is no plaintext backup, and never suggest
  // the destructive `fimemory init`. ───────────────────────────────────────────────
  it("in an encrypting-only crash (home absent, no plaintext backup) names the real path, does NOT claim self-heal, does NOT name a plaintext dir or init", () => {
    const home = freshHome("status-encrypting-only"); // never initialized → home ABSENT
    const parent = path.dirname(home);
    const base = path.basename(home);
    const encrypting = path.join(parent, `.${base}.gestalt-encrypting-1234-5678`);
    mkdirSync(fsPath(encrypting), { recursive: true });

    let caught: GestaltError | undefined;
    try {
      runStatus({ home });
    } catch (e) {
      caught = e as GestaltError;
    }
    expect(caught).toBeInstanceOf(GestaltError);
    const text = `${caught!.message} ${caught!.hint ?? ""}`;
    // Names the ACTUAL existing ciphertext staging path…
    expect(text).toContain(encrypting);
    // …says there is no plaintext backup…
    expect(text).toMatch(/no plaintext backup/i);
    // …does NOT claim `fimemory encrypt` self-heals this state…
    expect(text).not.toMatch(/self-heal/i);
    // …does NOT name a nonexistent `.gestalt-plaintext-*` dir…
    expect(text).not.toMatch(/gestalt-plaintext-/);
    // …and NEVER suggests the destructive `fimemory init`.
    expect(text).not.toMatch(/fimemory init/);
  });

  // ── FIX 3 (this round): status must claim `fimemory encrypt` self-heals ONLY in
  // the state where it actually does — home DIRECTORY absent + EXACTLY ONE
  // memory-bearing plaintext sibling. When 2+ plaintext siblings exist, encrypt
  // REFUSES (ambiguous), so status must give manual-recovery wording naming the
  // real paths and make NO false self-heal claim. ─────────────────────────────────
  it("claims self-heal ONLY for a single memory-bearing plaintext sibling; 2+ siblings get manual-recovery wording with real paths and NO self-heal claim", () => {
    // Case A: home absent + exactly ONE memory-bearing plaintext sibling → encrypt
    // self-heals, so status may say so.
    {
      const home = freshHome("status-single-sibling"); // never initialized → home ABSENT
      const parent = path.dirname(home);
      const base = path.basename(home);
      const plaintext = path.join(parent, `.${base}.gestalt-plaintext-1-1`);
      // Memory-bearing via LOGS ONLY (broadened predicate), no config.json.
      mkdirSync(fsPath(path.join(plaintext, "logs")), { recursive: true });
      writeFileSync(fsPath(path.join(plaintext, "logs", "x.log.md")), "# x log\n", "utf8");

      let caught: GestaltError | undefined;
      try {
        runStatus({ home });
      } catch (e) {
        caught = e as GestaltError;
      }
      expect(caught).toBeInstanceOf(GestaltError);
      const text = `${caught!.message} ${caught!.hint ?? ""}`;
      expect(text).toContain(plaintext); // names the real path
      expect(text).toMatch(/self-heal/i); // encrypt WOULD self-heal → allowed to say so
      expect(text).toMatch(/fimemory encrypt/);
      expect(text).not.toMatch(/fimemory init/);
    }

    // Case B: home absent + TWO memory-bearing plaintext siblings → encrypt REFUSES
    // (ambiguous). status must NOT claim self-heal; it names both and points at a
    // manual choose-which-to-keep recovery.
    {
      const home = freshHome("status-two-siblings"); // never initialized → home ABSENT
      const parent = path.dirname(home);
      const base = path.basename(home);
      const a = path.join(parent, `.${base}.gestalt-plaintext-1-1`);
      const b = path.join(parent, `.${base}.gestalt-plaintext-2-2`);
      for (const s of [a, b]) {
        mkdirSync(fsPath(s), { recursive: true });
        writeFileSync(fsPath(path.join(s, "config.json")), "{}", "utf8");
      }

      let caught: GestaltError | undefined;
      try {
        runStatus({ home });
      } catch (e) {
        caught = e as GestaltError;
      }
      expect(caught).toBeInstanceOf(GestaltError);
      const text = `${caught!.message} ${caught!.hint ?? ""}`;
      // Names BOTH real paths…
      expect(text).toContain(a);
      expect(text).toContain(b);
      // …makes NO false self-heal claim…
      expect(text).not.toMatch(/self-heal/i);
      // …and points at manual recovery, never the destructive init hint.
      expect(text).toMatch(/rename it back to/i);
      expect(text).not.toMatch(/fimemory init/);
    }
  });

  // ── M1 (false "missing"): a PARTIAL home (topics/ present, no config.json) is a
  // store to REPORT on — status must NOT claim it "is missing" nor advise renaming a
  // sibling back onto the occupied home. ──────────────────────────────────────────
  it("on a PARTIAL home (topics/, no config.json) reports the store — never says \"missing\" or advises rename-back", () => {
    const home = freshHome("status-partial-home");
    mkdirSync(fsPath(path.join(home, "topics")), { recursive: true });
    writeFileSync(fsPath(path.join(home, "topics", "x.md")), "---\nid: x\n---\n\nbody\n", "utf8");

    // topics/ present → recognized as a store → reports (never throws E_NOT_FOUND).
    const s = runStatus({ home });
    expect(s.home).toBe(path.resolve(home));
    expect(s.topicCount).toBe(1); // counted from note files (no index yet)
    // Surfaces the partial state via a config-missing warning, not a "missing"/rename claim.
    expect(s.warnings.some((w) => /config\.json/.test(w.message))).toBe(true);
    expect(s.warnings.some((w) => /is missing|rename it back/i.test(w.message))).toBe(false);
  });

  // ── M2 (config-less sealed store → "no store" + init footgun): a store recognized
  // ONLY by config.json reads a config-less but SEALED store (keyring + sealed topics
  // + store.enc) as E_NOT_FOUND with a `fimemory init` hint — steering the user to init
  // over real sealed data. Presence must be recognized by keyring/sealed content too. ─
  it("on a config-less SEALED home (keyring + sealed topics, no config.json) reports the store — no E_NOT_FOUND / fimemory init", () => {
    const home = freshHome("status-configless-sealed");
    runInit({
      home,
      encrypted: true,
      passphrase: "a solid passphrase for status here",
      argon2: { name: "argon2id", m: 256, t: 1, p: 1 },
      allowWeakParams: true,
    });
    // Remove config.json → config-less, but keyring.json + sealed content remain.
    rmSync(fsPath(path.join(home, "config.json")), { force: true });

    // Recognized as a store → reports without an E_NOT_FOUND / init hint (never throws).
    const s = runStatus({ home });
    expect(s.home).toBe(path.resolve(home));
  });

  // ── FIX 1 (store-presence disagreed with the memory predicate): a config-less home
  // holding ONLY logs/ was reported "not a FIMemory store" and steered to `fimemory init`
  // OVER real memory (migration re-encodes logs). Store-presence now routes through the
  // shared `homeHasMemory`, so logs/ alone is recognized. ───────────────────────────
  it("on a config-less LOGS-ONLY home reports the store — no E_NOT_FOUND / fimemory init", () => {
    const home = freshHome("status-logs-only");
    mkdirSync(fsPath(path.join(home, "logs")), { recursive: true });
    writeFileSync(
      fsPath(path.join(home, "logs", "auth.log.md")),
      "## entry\nsome log body\n",
      "utf8",
    );

    // logs/ present → recognized as a store → reports (never throws E_NOT_FOUND).
    const s = runStatus({ home });
    expect(s.home).toBe(path.resolve(home));
    // The shared predicate agrees with store-presence — a single source, no drift.
    expect(homeHasMemory(home)).toBe(true);
    expect(siblingHasMemory(home)).toBe(true);
  });

  // ── FIX 1 (companion): a config-less home holding ONLY proposals/ is likewise REAL
  // memory (migration re-encodes proposals) and must be reported, not init-footgunned. ─
  it("on a config-less PROPOSALS-ONLY home reports the store — no E_NOT_FOUND / fimemory init", () => {
    const home = freshHome("status-proposals-only");
    mkdirSync(fsPath(path.join(home, "proposals")), { recursive: true });
    writeFileSync(
      fsPath(path.join(home, "proposals", "1-x.md")),
      "---\nid: 1-x\n---\n\nproposed change\n",
      "utf8",
    );

    // proposals/ present → recognized as a store → reports (never throws E_NOT_FOUND).
    const s = runStatus({ home });
    expect(s.home).toBe(path.resolve(home));
    expect(homeHasMemory(home)).toBe(true);
    expect(siblingHasMemory(home)).toBe(true);
  });

  // ── L2 (overstated "intact data survives" for an EMPTY sibling): an empty
  // `.gestalt-plaintext-*` leftover (siblingHasMemory false) must NOT be described as a
  // PLAINTEXT copy readable in the clear — it holds no data. ───────────────────────
  it("wording for an EMPTY plaintext sibling does not claim intact/readable data (an empty leftover temp dir)", () => {
    const home = freshHome("status-empty-sibling");
    runInit({ home });
    const parent = path.dirname(home);
    const base = path.basename(home);
    const empty = path.join(parent, `.${base}.gestalt-plaintext-4242-9`);
    mkdirSync(fsPath(empty), { recursive: true }); // empty: no config/topics/logs/proposals

    const s = runStatus({ home });
    const w = s.warnings.find((x) => x.message.includes(empty));
    expect(w).toBeDefined();
    // Does NOT claim the data is intact / readable in the clear…
    expect(w!.message).not.toMatch(/readable in the clear/i);
    expect(w!.message).not.toMatch(/PLAINTEXT copy/);
    // …and describes it accurately as an empty leftover.
    expect(w!.message).toMatch(/empty/i);
  });

  it("tolerates a hand-mangled config.json (invariant 1): warns, falls back to defaults, never crashes", () => {
    const home = freshHome();
    runInit({ home });
    writeFileSync(path.join(home, "config.json"), "{ not valid json ", "utf8");

    const s = runStatus({ home });
    expect(s.budget.maxTokensPerGet).toBe(2000); // fell back to default
    expect(s.warnings.some((w) => w.code === "E_CORRUPT_SKIPPED")).toBe(true);
    expect(s.topicCount).toBe(1); // index still readable
  });

  it("counts pending proposals by their status field, not just by file presence", () => {
    const home = freshHome();
    runInit({ home });
    // A rejected proposal must not be counted as pending.
    writeFileSync(
      path.join(home, "proposals", "2-gestalt-example.md"),
      "---\nseq: 2\nid: gestalt-example\nstatus: rejected\n---\n\n## Old\n\n## New\n",
      "utf8",
    );
    const s = runStatus({ home });
    expect(s.pendingProposals).toBe(1); // still just the one pending
  });

  // ── RESIDUAL 2b: an interrupted `fimemory encrypt` can strand a scoped sibling
  // temp beside the store; a `.gestalt-plaintext-*` copy is the store's memory
  // readable in the CLEAR. `status` (routinely run) must surface it LOUDLY, naming
  // the path — even on an already-encrypted store `fimemory encrypt` never re-runs. ──
  it("surfaces interrupted-migration residue (a plaintext copy readable in the clear), naming the path", () => {
    const home = freshHome("status-residue");
    runInit({ home });
    const parent = path.dirname(home);
    const base = path.basename(home);
    // A crash-window plaintext copy + a stale encrypting-staging dir, both scoped.
    const plaintext = path.join(parent, `.${base}.gestalt-plaintext-4242-7`);
    const encrypting = path.join(parent, `.${base}.gestalt-encrypting-4242-8`);
    mkdirSync(fsPath(plaintext), { recursive: true });
    writeFileSync(fsPath(path.join(plaintext, "config.json")), "{}", "utf8");
    mkdirSync(fsPath(encrypting), { recursive: true });

    const s = runStatus({ home });
    expect(
      s.warnings.some((w) => w.message.includes(plaintext) && /PLAINTEXT/.test(w.message)),
    ).toBe(true);
    expect(s.warnings.some((w) => w.message.includes(encrypting))).toBe(true);
  });

  it("a store with no migration residue produces no residue warnings", () => {
    const home = freshHome("status-no-residue");
    runInit({ home });
    const s = runStatus({ home });
    expect(s.warnings.some((w) => /interrupted "fimemory encrypt"/.test(w.message))).toBe(false);
  });

  // ── FINDING 2 (status misreport): an ACTIVELY-RUNNING migration's live
  // `.gestalt-encrypting-*` staging dir is NOT deletable residue — status must not
  // flag it while the migration holds the store lock. But a `.gestalt-plaintext-*`
  // copy is real exposure and stays LOUD regardless. ──────────────────────────────
  it("does NOT flag an active migration's encrypting-staging dir as deletable residue, but still loudly flags plaintext residue", async () => {
    const home = freshHome("status-active-migration");
    runInit({ home });
    const parent = path.dirname(home);
    const base = path.basename(home);
    const encrypting = path.join(parent, `.${base}.gestalt-encrypting-4242-8`);
    const plaintext = path.join(parent, `.${base}.gestalt-plaintext-4242-7`);
    mkdirSync(fsPath(encrypting), { recursive: true });
    mkdirSync(fsPath(plaintext), { recursive: true });
    writeFileSync(fsPath(path.join(plaintext, "config.json")), "{}", "utf8");

    // Hold the store's write lock to simulate a migration in progress.
    await withLock(home, 1000, async () => {
      const s = runStatus({ home });
      // The encrypting-staging dir is NOT called out (it belongs to the live run)…
      expect(s.warnings.some((w) => w.message.includes(encrypting))).toBe(false);
      // …but the plaintext copy readable in the clear is STILL flagged loudly.
      expect(
        s.warnings.some((w) => w.message.includes(plaintext) && /PLAINTEXT/.test(w.message)),
      ).toBe(true);
    });

    // With NO migration holding the lock, the staging dir IS surfaced — worded as
    // transient ("in progress, or leftover"), never an unconditional "safe to delete".
    const after = runStatus({ home });
    const encWarn = after.warnings.find((w) => w.message.includes(encrypting));
    expect(encWarn).toBeDefined();
    expect(encWarn!.message).toMatch(/in progress|leftover/);
    // The plaintext copy remains loudly flagged too.
    expect(
      after.warnings.some((w) => w.message.includes(plaintext) && /PLAINTEXT/.test(w.message)),
    ).toBe(true);
  });
});
