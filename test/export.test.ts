import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GestaltError } from "../src/errors.js";
import { runInit } from "../src/commands/init.js";
import { fsPath, storePaths, topicLogPath, topicNotePath } from "../src/paths.js";
import { catNote } from "../src/ops/cat.js";
import { SEALED_TOKEN_FLOOR } from "../src/ops/exportDecode.js";
import { exportPlaintext } from "../src/ops/exportOp.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { updateTopic } from "../src/ops/update.js";
import { activateDek, clearActiveKey, decryptFile, encodeLogEntry, encryptFile } from "../src/store/codec.js";
import { ENCRYPTED_LINE_RE, parseLog, serializeLogPlain } from "../src/store/log.js";
import { storeHasSealedContent, unlockWithPassphrase } from "../src/store/keyring.js";
import { expectGestaltErrorAsync, freshHome, tsxEntry } from "./helpers.js";

/**
 * E2b — the ownership escape hatch (ENCRYPTION-BUILD-PLAN gate **G1**).
 * Encryption at rest makes the store opaque; `export --plaintext` is what keeps
 * invariant §0.1's *spirit* ("a user with a text editor can read everything")
 * true, and it must exist before the §0.1 reword / encrypted-default flip. These
 * tests are that guarantee's regression net: it works on both store modes, it
 * refuses to write into the store, it never overwrites anything, it fails CLOSED
 * on a key problem, and — the whole reason it exists — it is never SILENTLY
 * incomplete.
 */

// Tiny Argon2 params so the suite stays fast (real default is 64 MiB / t=3).
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a solid test passphrase here";
const SECRET = "the acquisition closes on tuesday";

afterEach(() => clearActiveKey());

/** A store with one real topic + one real log entry. Encrypted or not. */
async function seed(label: string, encrypted: boolean): Promise<string> {
  const home = freshHome(label);
  const r = runInit(
    encrypted
      ? { home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true }
      : { home },
  );
  if (encrypted) activateDek(unlockWithPassphrase(r.home, PASS));
  await createTopic(home, "deal-notes", "Deal notes");
  await appendLog(home, "deal-notes", {
    type: "decision",
    project: "acme",
    agent: "cli",
    summary: SECRET,
  });
  return home;
}

const read = (p: string): string => readFileSync(fsPath(p), "utf8");

/** Flip a byte in a sealed file's base64 body → AEAD open fails (bit rot). */
function corrupt(p: string): void {
  const text = read(p);
  const at = text.length - 5;
  const flipped = text[at] === "A" ? "B" : "A";
  writeFileSync(fsPath(p), text.slice(0, at) + flipped + text.slice(at + 1), "utf8");
}

describe("export --plaintext — the §0.1 ownership guarantee (E2b)", () => {
  it("ENCRYPTED store: on-disk files are opaque, the export is readable plaintext and round-trips", async () => {
    const home = await seed("exp-enc", true);

    // Precondition: the store really is opaque on disk.
    expect(read(topicNotePath(home, "deal-notes")).startsWith("gestalt-enc:1:")).toBe(true);
    expect(read(topicLogPath(home, "deal-notes"))).not.toContain(SECRET);

    const dest = path.join(freshHome("exp-enc-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.mode).toBe("encrypted");
    expect(r.files).toContain("topics/deal-notes.md");
    expect(r.files).toContain("logs/deal-notes.log.md");

    // The whole point: plain, greppable text a human can open in any editor.
    const note = read(path.join(dest, "topics", "deal-notes.md"));
    expect(note).not.toContain("gestalt-enc:1:");
    expect(note).toContain("id: deal-notes");
    expect(note).toContain(`title: "Deal notes"`);
    expect(note).toContain("## Owner notes");

    const log = read(path.join(dest, "logs", "deal-notes.log.md"));
    expect(log).toContain("# deal-notes log");
    expect(log).toContain(SECRET); // the entry body decrypted
    expect(log).toContain("| decision | acme | cli");
    expect(log).not.toMatch(/^\d{4}-\d{2}-\d{2}T\S+ [A-Za-z0-9_-]{40,}$/m); // no encoded lines

    // Round-trip: the exported note is byte-for-byte the note the runtime reads.
    expect(note).toBe((await catNote(home, "deal-notes")).text);
    // The example topic init wrote comes along too — "every note + log".
    expect(existsSync(fsPath(path.join(dest, "topics", "gestalt-example.md")))).toBe(true);
    expect(read(path.join(dest, "logs", "gestalt-example.log.md"))).toContain("### 20");
  });

  it("PLAINTEXT store: export is a verbatim copy of the files themselves", async () => {
    const home = await seed("exp-plain", false);
    const dest = path.join(freshHome("exp-plain-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.mode).toBe("plaintext");
    expect(r.notes).toBe(2); // gestalt-example + deal-notes
    expect(r.logs).toBe(2);
    expect(r.proposals).toBe(1); // the example's pending suggested edit
    expect(r.failed).toBe(0);
    // Byte-identical, hand edits and all — nothing is re-serialized.
    expect(read(path.join(dest, "topics", "deal-notes.md"))).toBe(read(topicNotePath(home, "deal-notes")));
    expect(read(path.join(dest, "logs", "deal-notes.log.md"))).toBe(read(topicLogPath(home, "deal-notes")));
  });

  it("REFUSES a destination inside the store — never exports into ~/.gestalt itself", async () => {
    const home = await seed("exp-inside", false);
    for (const dest of [
      home, // the store itself
      path.join(home, "topics"), // an existing store dir
      path.join(home, "export"), // a new dir inside the store
      path.join(home, "a", "b", "c"), // nested, not yet created
      path.join(home, "topics", "..", "logs"), // normalizes back inside
    ]) {
      await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_SCHEMA");
    }
    // …and nothing was created by the refusals.
    expect(existsSync(fsPath(path.join(home, "export")))).toBe(false);
    expect(existsSync(fsPath(path.join(home, "a")))).toBe(false);
    expect(readdirSync(fsPath(path.join(home, "topics"))).sort()).toEqual([
      "deal-notes.md",
      "gestalt-example.md",
    ]);
  });

  it("FAILS CLOSED on an encrypted store with no key — no ciphertext, no partial export", async () => {
    const home = await seed("exp-nokey", true);
    clearActiveKey(); // the user never unlocked

    const dest = path.join(freshHome("exp-nokey-out"), "export");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_STORE_MODE");
    // The destination must not even exist: the check runs before any write.
    expect(existsSync(fsPath(dest))).toBe(false);
  });

  it("export refuses cleanly when there is no store", async () => {
    const home = freshHome("exp-nostore");
    await expectGestaltErrorAsync(
      () => exportPlaintext(home, path.join(freshHome("exp-nostore-out"), "x")),
      "E_NOT_FOUND",
    );
  });

});

/**
 * THE FOOTGUN GUARD — the destination must be FRESH (absent, or an existing
 * EMPTY dir) and export NEVER overwrites (`wx`).
 *
 * This is not an anti-attacker measure; it is what makes an export a single
 * coherent snapshot from one moment. Re-exporting ON TOP of an older export
 * (which the previous cut allowed, and called "refreshing") silently produces a
 * MIXED-VINTAGE tree: today's healthy files next to last month's copy of a file
 * that failed today — with nothing on disk to tell them apart, and the user
 * backing the whole thing up believing it is one thing. It also makes the
 * "it is NOT in this export" warning a LIE, because the stale copy is right
 * there for the user to find and trust.
 */
describe("export --plaintext — a fresh destination, and never an overwrite", () => {
  it("REFUSES a destination that is not empty — no --force, and it writes nothing", async () => {
    const home = await seed("exp-notempty", false);
    const dest = path.join(freshHome("exp-notempty-out"), "export");
    mkdirSync(fsPath(dest), { recursive: true });
    writeFileSync(fsPath(path.join(dest, "unrelated.txt")), "the user's own file", "utf8");

    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_SCHEMA");

    // The refusal is actionable, and it did not touch what was already there.
    expect(readdirSync(fsPath(dest))).toEqual(["unrelated.txt"]);
    expect(read(path.join(dest, "unrelated.txt"))).toBe("the user's own file");
  });

  it("REFUSES to re-export over a PREVIOUS export — mixed vintages are the whole hazard", async () => {
    const home = await seed("exp-again", false);
    const dest = path.join(freshHome("exp-again-out"), "export");
    await exportPlaintext(home, dest); // a good, complete export
    const first = read(path.join(dest, "logs", "deal-notes.log.md"));

    await appendLog(home, "deal-notes", {
      type: "gotcha",
      project: "acme",
      agent: "cli",
      summary: "a second entry that must NOT be merged into the old export",
    });

    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_SCHEMA");
    // Untouched — not half-refreshed into a tree of two different vintages.
    expect(read(path.join(dest, "logs", "deal-notes.log.md"))).toBe(first);
  });

  it("ACCEPTS an existing but EMPTY directory — the user's own mkdir is fine", async () => {
    const home = await seed("exp-empty-ok", false);
    const dest = path.join(freshHome("exp-empty-ok-out"), "export");
    mkdirSync(fsPath(dest), { recursive: true });
    const r = await exportPlaintext(home, dest);
    expect(r.failed).toBe(0);
    expect(r.notes).toBe(2);
  });

  it("REFUSES a destination that is a FILE, not a folder", async () => {
    const home = await seed("exp-destfile", false);
    const dest = path.join(freshHome("exp-destfile-out"), "notadir");
    mkdirSync(fsPath(path.dirname(dest)), { recursive: true });
    writeFileSync(fsPath(dest), "i am a file", "utf8");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_SCHEMA");
    expect(read(dest)).toBe("i am a file");
  });

  it("creates every file EXCLUSIVELY (wx) — export has no code path that overwrites", async () => {
    const home = await seed("exp-wx-flag", false);
    const dest = path.join(freshHome("exp-wx-flag-out"), "export");
    const spy = vi.spyOn(fsp, "writeFile");
    try {
      await exportPlaintext(home, dest);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      // EVERY write, without exception — one plain write is one clobbered file.
      for (const call of spy.mock.calls) {
        expect(call[2]).toEqual({ flag: "wx" });
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT overwrite a file that appears at a write target — it fails that item loudly", async () => {
    const home = await seed("exp-wx-collide", false);
    const dest = path.join(freshHome("exp-wx-collide-out"), "export");
    const target = path.join(dest, "topics", "deal-notes.md");

    // The destination passed the freshness check, so a file at a write target is
    // by definition unpredicted. Simulate that race deterministically: plant the
    // file immediately before the real write runs, then let the REAL write
    // proceed. `wx` must lose the race, not clobber.
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, "writeFile");
    spy.mockImplementationOnce(async (p, data, opts) => {
      writeFileSync(fsPath(target), "PRECIOUS - not ours to destroy", "utf8");
      return realWriteFile(p, data as string, opts as { flag: string });
    });
    try {
      const r = await exportPlaintext(home, dest);

      // The planted bytes survive — that is the entire promise of `wx`.
      expect(read(target)).toBe("PRECIOUS - not ours to destroy");
      // …and it is accounted for, not thrown and not silently skipped.
      expect(r.failed).toBe(1);
      expect(r.files).not.toContain("topics/deal-notes.md");
      const f = r.failures[0]!;
      expect(f.rel).toBe("topics/deal-notes.md");
      expect(f.phase).toBe("write");
      expect(f.reason).toBe("EEXIST");
      // The FACT: it is missing, and here is what the OS said. Not a word about
      // the bytes — a write failure says nothing about the source note, which is
      // exactly what the old class-based message got wrong (it had no phase).
      expect(f.message).toBe(
        "could not include topics/deal-notes.md — EEXIST. Not in this export.",
      );
      // Counts report what was WRITTEN — the collided note is not counted.
      expect(r.notes).toBe(1);
      // The other topics still exported: partial recovery is preserved.
      expect(r.files).toContain("topics/gestalt-example.md");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * "A failed export must not block its own re-run" was keyed on what DECODED, not
 * on what was WRITTEN — so it held for the store-side failures it was written
 * for and broke on the destination-side ones. Everything decodes, the tree is
 * created, every WRITE is refused (Controlled Folder Access / AV shield / full
 * disk all permit mkdir and deny file creation), and the empty tree stays. The
 * user fixes the folder permission, re-runs into the same folder, and the
 * freshness rule answers "That folder isn't empty" — the failed export is now
 * the thing standing between them and the retry.
 */
describe("export --plaintext — a failed export never blocks its own retry", () => {
  /** Deny every file write, the way a Windows folder shield does. */
  const denyWrites = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(fsp, "writeFile").mockImplementation(async () => {
      const e = new Error("operation not permitted") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    }) as ReturnType<typeof vi.spyOn>;

  it("every WRITE fails ⇒ no tree is left behind, and the re-run is not refused", async () => {
    const home = await seed("exp-retry", false);
    const dest = path.join(freshHome("exp-retry-out"), "export");

    const spy = denyWrites();
    let r: Awaited<ReturnType<typeof exportPlaintext>>;
    try {
      r = await exportPlaintext(home, dest);
    } finally {
      spy.mockRestore();
    }

    // The store read perfectly; the destination refused everything.
    expect(r.files).toEqual([]);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.failures.every((f) => f.phase === "write")).toBe(true);
    // Nothing written ⇒ nothing left behind, whichever side failed.
    expect(existsSync(fsPath(dest))).toBe(false);

    // The retry the user actually performs, after fixing the folder.
    const r2 = await exportPlaintext(home, dest);
    expect(r2.failed).toBe(0);
    expect(r2.files.length).toBeGreaterThan(0);
  });

  it("the user's OWN empty folder survives the cleanup — empty, and still theirs", async () => {
    const home = await seed("exp-retry-own", false);
    const dest = path.join(freshHome("exp-retry-own-out"), "export");
    mkdirSync(fsPath(dest), { recursive: true }); // the user's own mkdir

    const spy = denyWrites();
    try {
      await exportPlaintext(home, dest);
    } finally {
      spy.mockRestore();
    }

    // We may remove what THIS run created, never the folder we were handed.
    expect(existsSync(fsPath(dest))).toBe(true);
    expect(readdirSync(fsPath(dest))).toEqual([]); // fresh again ⇒ the retry runs
    const r2 = await exportPlaintext(home, dest);
    expect(r2.failed).toBe(0);
    expect(r2.files.length).toBeGreaterThan(0);
  });

  /**
   * FINDING 3 — the cleanup was keyed on the wrong half of the write. `wx` does
   * two things: it CREATES the file, then it writes the bytes. A full disk (the
   * case the op's own comment names), a quota, or a USB stick pulled mid-export
   * lets the create SUCCEED and fails the write — so the old code, which keyed
   * cleanup on the open, left zero-byte files behind. Two harms: the export
   * contains `topics/deal-notes.md` (empty — the most convincing possible lie
   * about a note that is in fact still safe in the store) while the CLI says
   * "Nothing was exported"; and the leftovers are non-empty content, so the
   * `rmdir`-based cleanup below could not remove the tree — and the retry that
   * cleanup exists to protect hit "That folder isn't empty".
   */
  const failWriteAfterOpen = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(fsp, "writeFile").mockImplementation(async (p) => {
      writeFileSync(p as string, "", { flag: "wx" }); // the create succeeded…
      const e = new Error("no space left on device") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e; // …and the bytes never landed
    }) as ReturnType<typeof vi.spyOn>;

  it("the write fails AFTER the open ⇒ no zero-byte file wears a real name, and the retry runs", async () => {
    const home = await seed("exp-enospc", false);
    const dest = path.join(freshHome("exp-enospc-out"), "export");

    const spy = failWriteAfterOpen();
    let r: Awaited<ReturnType<typeof exportPlaintext>>;
    try {
      r = await exportPlaintext(home, dest);
    } finally {
      spy.mockRestore();
    }

    // Nothing was written, and it is accounted for by name.
    expect(r.files).toEqual([]);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.failures.every((f) => f.phase === "write")).toBe(true);
    expect(r.failures.every((f) => f.reason === "ENOSPC")).toBe(true);

    // THE BUG: a zero-byte `topics/deal-notes.md` sat here, inside a folder the
    // user is invited to trust, while the CLI reported nothing was exported.
    expect(existsSync(fsPath(dest))).toBe(false);

    // …and the leftovers blocked the tree's removal, so this retry — the one the
    // user actually performs after freeing disk space — was refused outright.
    const r2 = await exportPlaintext(home, dest);
    expect(r2.failed).toBe(0);
    expect(r2.files.length).toBeGreaterThan(0);
    expect(read(path.join(dest, "topics", "deal-notes.md"))).toContain("id: deal-notes");
  });

  it("the user's OWN folder survives a failed-after-open write — empty, and still theirs", async () => {
    const home = await seed("exp-enospc-own", false);
    const dest = path.join(freshHome("exp-enospc-own-out"), "export");
    mkdirSync(fsPath(dest), { recursive: true }); // the user's own mkdir

    const spy = failWriteAfterOpen();
    try {
      await exportPlaintext(home, dest);
    } finally {
      spy.mockRestore();
    }

    // We remove OUR debris, never the folder we were handed — and never
    // recursively: an export that deletes things on its way out is worse than a
    // blocked retry.
    expect(existsSync(fsPath(dest))).toBe(true);
    expect(readdirSync(fsPath(dest))).toEqual([]);
    const r2 = await exportPlaintext(home, dest);
    expect(r2.failed).toBe(0);
    expect(r2.files.length).toBeGreaterThan(0);
  });
});

/**
 * FINDING 1 — proposals/ is the store's THIRD content dir, and it was never
 * exported. Proposals are whole-file encrypted and embed FULL note bodies (Old +
 * New), so a PENDING proposal's proposed text exists nowhere else on disk until
 * someone approves it. An export that omits them while printing "yours to read,
 * grep, edit, or back up" invites exactly the reliance that destroys the data.
 */
describe("export --plaintext — proposals are content, not metadata (finding 1)", () => {
  // Lives ONLY inside the example's pending proposal (`## New`), never in the
  // note itself — the note on disk is still the OLD version (src/example.ts).
  const ONLY_IN_PROPOSAL =
    "When you approve that edit, the runtime replaces this note with the approved version";

  it("ENCRYPTED store: a pending proposal's body is opaque on disk and round-trips into the export", async () => {
    const home = await seed("exp-prop-enc", true);
    const proposalFile = readdirSync(fsPath(storePaths(home).proposalsDir))[0]!;
    const onDisk = read(path.join(storePaths(home).proposalsDir, proposalFile));

    // Precondition: sealed on disk, and the proposed body is nowhere in the clear.
    expect(onDisk.startsWith("gestalt-enc:1:")).toBe(true);
    expect(onDisk).not.toContain(ONLY_IN_PROPOSAL);

    const dest = path.join(freshHome("exp-prop-enc-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.proposals).toBe(1);
    expect(r.files).toContain(`proposals/${proposalFile}`);

    const exported = read(path.join(dest, "proposals", proposalFile));
    expect(exported).not.toContain("gestalt-enc:1:");
    expect(exported).toContain("status: pending");
    expect(exported).toContain("## Old");
    expect(exported).toContain("## New");
    // THE point of the finding: this text survives ONLY because proposals ship.
    expect(exported).toContain(ONLY_IN_PROPOSAL);

    // Prove it: no exported NOTE carries it. Drop proposals/ and it is gone.
    const notes = readdirSync(fsPath(path.join(dest, "topics"))).map((f) =>
      read(path.join(dest, "topics", f)),
    );
    expect(notes.some((n) => n.includes(ONLY_IN_PROPOSAL))).toBe(false);
  });

  it("exports a proposal an agent just created, with its proposed body intact", async () => {
    const home = await seed("exp-prop-new", true);
    // Splice into the main body, above the protected ## Owner notes section.
    const proposed = (await catNote(home, "deal-notes")).text.replace(
      "## Owner notes",
      "the board seat goes to the founder\n\n## Owner notes",
    );
    const { seq } = await updateTopic(home, "deal-notes", proposed, { proposer: "grok" });

    const dest = path.join(freshHome("exp-prop-new-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.proposals).toBe(2); // the example's + this one
    // Proposals are machine-scoped (`{machineId}-{seq}-{id}.md`); match by seq+id.
    const propFiles = readdirSync(fsPath(path.join(dest, "proposals")));
    const match = propFiles.find(
      (f) => f.endsWith(`-${seq}-deal-notes.md`) || f === `${seq}-deal-notes.md`,
    );
    expect(match, `expected a proposal file for seq=${seq} deal-notes in ${propFiles.join(",")}`).toBeTruthy();
    const exported = read(path.join(dest, "proposals", match!));
    expect(exported).toContain("the board seat goes to the founder");
    expect(exported).toContain("proposer: grok");
  });
});

/**
 * The containment check resolves LINKS, because "I exported into a folder that
 * turned out to be the store" is a mistake people actually make (a junction or
 * symlink they set up months ago and forgot). This is the ordinary-footgun case,
 * not an adversary: export has none, and does not try to defeat one. Aliasing
 * and TOCTOU games are deliberately NOT defended here — anyone who can plant a
 * reparse point in your export directory already runs as you and can read the
 * store directly. See ops/exportOp.ts's header.
 */
describe("export --plaintext — a link into the store is still the store", () => {
  /** `mklink /J` (no elevation needed). Returns false if unavailable. */
  function junction(link: string, target: string): boolean {
    if (process.platform !== "win32") return false;
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `skipIf`, not an early `return`. The body needs `mklink /J`, so on Linux and
   * macOS it did nothing at all — and an empty body that returns is reported by
   * vitest as PASSED, not skipped. On the two legs whose entire purpose is to
   * measure platforms nobody here owns, this test used to render as a green tick
   * over zero assertions, and run-suite.mjs's skip listing (which exists so that
   * "a skip you cannot see is the same thing as a test that does not exist")
   * could not name it, because it was not a skip. Now it is one.
   */
  it.skipIf(process.platform !== "win32")("REFUSES when the destination resolves through a junction onto the store", async () => {
    const home = await seed("exp-junction-root", false);
    const dest = path.join(freshHome("exp-junction-root-out"), "export");
    mkdirSync(fsPath(path.dirname(dest)), { recursive: true });
    // Still conditional: Windows without reparse-point support (a mapped drive,
    // an exotic filesystem) cannot make the junction either.
    if (!junction(dest, home)) return;

    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_SCHEMA");
    expect(readdirSync(fsPath(storePaths(home).topicsDir)).sort()).toEqual([
      "deal-notes.md",
      "gestalt-example.md",
    ]);
  });
});

/**
 * FINDING 4 — export inherited the write path's fail-closed throw, so ONE
 * undecodable byte (bit rot, a truncated sync, a `.gitattributes` miss rewriting
 * line endings) disabled the escape hatch for the ENTIRE store. In a read-only
 * last-resort recovery tool, all-or-nothing turns partial recovery into ZERO
 * recovery. Now: export everything that decodes, name what does not, exit
 * non-zero. Never silently incomplete; never all-or-nothing.
 */
describe("export --plaintext — partial recovery beats no recovery (finding 4)", () => {
  it("one corrupt NOTE does not withhold the healthy topics — and is named, not skipped", async () => {
    const home = await seed("exp-rot-note", true);
    corrupt(topicNotePath(home, "deal-notes"));

    const dest = path.join(freshHome("exp-rot-note-out"), "export");
    const r = await exportPlaintext(home, dest);

    // The healthy topic is RECOVERED — the whole point.
    expect(r.files).toContain("topics/gestalt-example.md");
    expect(read(path.join(dest, "topics", "gestalt-example.md"))).toContain("id: gestalt-example");
    // Its log came through too; only the one bad file is missing.
    expect(r.files).toContain("logs/deal-notes.log.md");
    expect(existsSync(fsPath(path.join(dest, "topics", "deal-notes.md")))).toBe(false);

    // …and the loss is stated precisely, by name.
    expect(r.failed).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.id).toBe("topics/deal-notes.md");
    expect(r.warnings[0]!.message).toContain("topics/deal-notes.md");
    expect(r.warnings[0]!.message).toContain("Not in this export");
  });

  it("one corrupt LOG line does not withhold that topic's note, nor any other topic", async () => {
    const home = await seed("exp-rot-log", true);
    corrupt(topicLogPath(home, "deal-notes"));

    const dest = path.join(freshHome("exp-rot-log-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(r.warnings[0]!.id).toBe("logs/deal-notes.log.md");
    // The note itself is fine and still recovered, as is the example topic.
    expect(r.files).toContain("topics/deal-notes.md");
    expect(r.files).toContain("logs/gestalt-example.log.md");
    expect(r.notes).toBe(2);
    expect(r.logs).toBe(1);
  });

  it("a corrupt PROPOSAL is reported but never silently dropped", async () => {
    const home = await seed("exp-rot-prop", true);
    const file = readdirSync(fsPath(storePaths(home).proposalsDir))[0]!;
    corrupt(path.join(storePaths(home).proposalsDir, file));

    const r = await exportPlaintext(home, path.join(freshHome("exp-rot-prop-out"), "export"));
    expect(r.proposals).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.warnings[0]!.id).toBe(`proposals/${file}`);
  });

  /**
   * THE DELETED GATE. Export used to re-derive "your key is wrong" from its own
   * failures and refuse outright. That diagnosis ALREADY EXISTS UPSTREAM, is
   * correct, and runs first: the keyring unlock answers "Wrong passphrase for
   * this store" and `assertEnvKeyMatchesStore` binds `GESTALT_KEY` to the store's
   * own ciphertext — so at the CLI this state is unreachable. The gate was a
   * redundant re-derivation from worse evidence, and it was wrong three times
   * (v1 `pending.length === 0`, defeated by an empty log; v2 "all failures are
   * KEY"; v3 "all KEY and nothing proved the key", which bricked a PLAINTEXT
   * store whenever GESTALT_KEY was set).
   *
   * Now: no verdict on the key, per item or overall. Facts, and a non-zero exit.
   */
  it("a wrong key at the API level reports FACTS per item — no verdict on the key, no destructive advice", async () => {
    const home = await seed("exp-wrongkey", true);
    clearActiveKey();
    activateDek(new Uint8Array(32).fill(7)); // a valid-shaped key, but not this store's

    const dest = path.join(freshHome("exp-wrongkey-out"), "export");
    const r = await exportPlaintext(home, dest);

    // Nothing could be read — and that is reported by NAME, not diagnosed.
    expect(r.files).toEqual([]);
    expect(r.failed).toBeGreaterThan(0);
    for (const f of r.failures) {
      expect(f.message).toContain("Not in this export");
      expect(f.message).not.toMatch(/damaged|restore|backup/i);
    }
    // Nothing decoded and something failed ⇒ no tree at all: an empty shell is
    // worth nothing, and it would make a retry into this folder non-fresh.
    expect(existsSync(fsPath(dest))).toBe(false);
  });

  /**
   * The v1 gate's verified regression, kept as a test of the CURRENT contract:
   * an EMPTY log "decodes" under ANY key (there are no entries to open). It is
   * genuinely readable, so it EXPORTS — and every sealed file that did not open
   * is named. What made the old behavior a bug was never the exported log; it
   * was the claim of an overall verdict the evidence could not support.
   */
  it("an EMPTY log exports even under a wrong key — and every unreadable file is still named", async () => {
    const home = await seed("exp-wrongkey-emptylog", true);
    // A brand-new topic: note + a log with a header and ZERO entries.
    await createTopic(home, "no-entries-yet", "No entries yet");
    expect(read(topicLogPath(home, "no-entries-yet"))).toBe("# no-entries-yet log\n");

    clearActiveKey();
    activateDek(new Uint8Array(32).fill(7)); // not this store's key

    const dest = path.join(freshHome("exp-wrongkey-emptylog-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.files).toEqual(["logs/no-entries-yet.log.md"]);
    expect(read(path.join(dest, "logs", "no-entries-yet.log.md"))).toBe("# no-entries-yet log\n");
    // The sealed notes/logs/proposals are all accounted for, none silently gone.
    expect(r.failed).toBe(6); // 3 notes + 2 logs + 1 proposal
    expect(r.failures.every((f) => f.message.includes("Not in this export"))).toBe(true);
  });
});

/**
 * TASK 2 / THE SILENT SIN — `listFiles` did `catch { return [] }`, so an ACL, an
 * EIO, a lock, or a clobbered `logs/` made the ENTIRE directory vanish from the
 * export with **exit 0, failed: 0, warnings: []**. A store with 50 logged topics
 * reported as a store with none — silently, successfully. That is precisely the
 * "silently incomplete" failure this whole op exists to prevent, and it survived
 * the first cut. An empty directory and an unreadable directory must NEVER be
 * indistinguishable.
 */
describe("export --plaintext — an unreadable directory is a FAILURE, not an empty one", () => {
  it("reports a whole unreadable content dir as a classified failure, and still exports the rest", async () => {
    const home = await seed("exp-baddir", false);
    // Replace logs/ with a FILE: readdir then fails ENOTDIR, exactly the shape of
    // an ACL/EIO/lock — the directory is there and we cannot enumerate it.
    rmSync(fsPath(storePaths(home).logsDir), { recursive: true, force: true });
    writeFileSync(fsPath(storePaths(home).logsDir), "not a directory", "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-baddir-out"), "export"));

    // NOT silence: named, counted, and non-zero-exit-worthy.
    expect(r.failed).toBe(1);
    expect(r.logs).toBe(0);
    const f = r.failures[0]!;
    expect(f.rel).toBe("logs/");
    expect(f.phase).toBe("list");
    expect(f.reason).toBe("ENOTDIR");
    expect(f.message).toBe("could not include the logs/ directory — ENOTDIR. Not in this export.");
    expect(r.warnings[0]!.code).toBe("E_IO");
    // …and the readable dirs still came through — partial recovery holds.
    expect(r.notes).toBe(2);
    expect(r.proposals).toBe(1);
  });

  it("a genuinely ABSENT dir is still empty, not a failure — the two stay distinct", async () => {
    const home = await seed("exp-nodir", false);
    rmSync(fsPath(storePaths(home).proposalsDir), { recursive: true, force: true });
    const r = await exportPlaintext(home, path.join(freshHome("exp-nodir-out"), "export"));
    expect(r.proposals).toBe(0);
    expect(r.failed).toBe(0); // no proposals yet is a fact about the store, not a fault
  });
});

/**
 * THE CONTRACT (Eric, 2026-07-15): **export reports FACTS, never CAUSES — the
 * tool must never be the CAUSE of a data loss.**
 *
 * If a user loses their key or skips their backups, that is theirs to own. But
 * if export tells them a healthy note is "damaged, restore it from a backup" and
 * they do, WE destroyed their work. Three adversarial audits (151 agents) found
 * the KEY/IO/CORRUPT classifier unsound the same way three times: it inferred a
 * cause it had not earned, and its fallback guess was the destructive one. So it
 * is DELETED, not tuned. Every failure now says what is missing and what the
 * failing layer said — and nothing else.
 */
describe("export --plaintext — facts, never causes", () => {
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  it("a note that cannot be read is stated as a FACT — no diagnosis, no advice", async () => {
    const home = await seed("exp-fact-io", true);
    // A note that exists but cannot be read as a file (EISDIR) — the portable
    // stand-in for the editor/antivirus/indexer lock that store/atomic.ts
    // already retries for.
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true });

    const r = await exportPlaintext(home, path.join(freshHome("exp-fact-io-out"), "export"));

    const f = r.failures.find((x) => x.rel === "topics/wedged.md")!;
    expect(f.reason).toBe("EISDIR");
    expect(f.phase).toBe("read");
    expect(f.message).toBe("could not include topics/wedged.md — EISDIR. Not in this export.");
    expect(r.warnings.find((w) => w.id === "topics/wedged.md")!.code).toBe("E_IO");
    // One unreadable file never withholds the rest.
    expect(r.notes).toBe(2);
    expect(r.files).toContain("topics/deal-notes.md");
  });

  /**
   * DEFECT 2, the inverted default. `classify()` defaulted to CORRUPT — whose
   * sentence was "restore it from a backup" — and IO was a 13-entry allowlist.
   * So ANY errno nobody thought of (EDQUOT on a quota'd NFS home, ESTALE,
   * ENAMETOOLONG, ELOOP, libuv's UNKNOWN from an AV filter driver or a OneDrive
   * placeholder that would not hydrate) told the user their healthy note was
   * damaged and to overwrite it with an old copy. The unknown case must be the
   * SAFE case.
   */
  it("an UNRECOGNIZED errno gets no destructive advice — the safe default is not a guess", async () => {
    const home = await seed("exp-fact-unknown", false);
    const spy = vi.spyOn(fsp, "readFile");
    spy.mockImplementationOnce(async () => {
      const e = new Error("quota exceeded") as NodeJS.ErrnoException;
      e.code = "EDQUOT"; // not in any allowlist anyone wrote
      throw e;
    });
    try {
      const r = await exportPlaintext(home, path.join(freshHome("exp-fact-unknown-out"), "export"));
      expect(r.failed).toBe(1);
      expect(r.failures[0]!.reason).toBe("EDQUOT");
      expect(r.failures[0]!.message).toContain("EDQUOT");
      expect(rendered(r)).not.toMatch(/damaged|restore|backup/i);
      expect(r.warnings[0]!.code).toBe("E_IO"); // unknown ⇒ "we could not read it"
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Same defect, worse trigger: an error with NO errno at all — a TypeError or a
   * RangeError thrown by a bug in OUR decode path — also fell through to CORRUPT
   * and told the user their file was damaged. Our bug, their backup restore.
   */
  it("an error with NO errno (a bug in our own code) does not become 'your data is damaged'", async () => {
    const home = await seed("exp-fact-bug", false);
    const spy = vi.spyOn(fsp, "readFile");
    spy.mockImplementationOnce(async () => {
      throw new TypeError("cannot read properties of undefined (reading 'slice')");
    });
    try {
      const r = await exportPlaintext(home, path.join(freshHome("exp-fact-bug-out"), "export"));
      expect(r.failed).toBe(1);
      expect(r.failures[0]!.message).toContain("cannot read properties of undefined");
      expect(rendered(r)).not.toMatch(/damaged|restore|backup/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed AEAD open gets export's OWN two observations — the codec's key verdict never surfaces", async () => {
    const home = await seed("exp-fact-aead", true);
    corrupt(topicNotePath(home, "deal-notes")); // AEAD open fails on this file only

    const r = await exportPlaintext(home, path.join(freshHome("exp-fact-aead-out"), "export"));

    expect(r.failed).toBe(1);
    const f = r.failures[0]!;
    expect(f.rel).toBe("topics/deal-notes.md");
    // Export's own sentence: the two observations it actually made, and no
    // more. The codec's message for this failure — "wrong key or tampered
    // data" — is the STORE layer's, where a failed open blocks a write; export
    // repeating it delivers a key verdict the rename case (aad binds the
    // basename) plainly disproves. This used to pin the codec wording as
    // export output; it now pins that the wording CANNOT surface here.
    expect(f.message).toBe(
      "could not include topics/deal-notes.md — neither parses as a note nor opens with the active key. Not in this export.",
    );
    expect(f.code).toBe("E_SCHEMA");
    expect(rendered(r)).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
    // Partial recovery holds: the healthy topics still come out.
    expect(r.notes).toBe(1);
    expect(r.files).toContain("topics/gestalt-example.md");
  });

  it("an entry that DECRYPTS but will not parse reports THAT fact, and still never says 'restore'", async () => {
    const home = await seed("exp-fact-corrupt", true);
    // A log line sealed with the RIGHT key whose plaintext is not a valid entry
    // (only 2 header fields, not 4). It opens — the AEAD tag verifies — and then
    // fails to parse. "Decrypted but unparsable" is a strictly better FACT than
    // "failed to decrypt", which is why store/log.ts keeps the distinction — but
    // it is still a fact, not a prescription.
    const bad = encodeLogEntry(
      "deal-notes",
      "### 2026-07-15T00:00:00.000Z | oops\nnot a real entry",
    );
    writeFileSync(fsPath(topicLogPath(home, "deal-notes")), `# deal-notes log\n\n${bad}\n`, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-fact-corrupt-out"), "export"));

    const f = r.failures.find((x) => x.rel === "logs/deal-notes.log.md")!;
    expect(f.message).toContain("decrypted but is unparsable");
    expect(rendered(r)).not.toMatch(/damaged|restore|backup/i);
    // The better fact survives into --json, distinct from a decrypt failure.
    expect(r.warnings.find((w) => w.id === "logs/deal-notes.log.md")!.code).toBe("E_CORRUPT_SKIPPED");
    expect(f.code).toBe("E_CORRUPT_SKIPPED");
    // Not all-or-nothing: the note itself and every other topic still export.
    expect(r.files).toContain("topics/deal-notes.md");
  });

  /**
   * THE PROHIBITION, asserted over the whole rendered surface rather than one
   * string: no message export can emit may tell the user their data is damaged,
   * that they should restore a backup, or deliver a verdict on their key
   * ("wrong key", "tampered", "relocated"). Those words are instructions and
   * diagnoses; following them on a healthy file destroys it.
   */
  it("NO message anywhere carries a banned word — every failure shape at once", async () => {
    const home = await seed("exp-fact-grep", true);
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true }); // EISDIR
    corrupt(topicNotePath(home, "deal-notes")); // failed AEAD open
    writeFileSync(fsPath(path.join(storePaths(home).topicsDir, "hand-written.md")), "# mine\n", "utf8"); // plaintext under a key
    const bad = encodeLogEntry("deal-notes", "### 2026-07-15T00:00:00.000Z | oops\nnope");
    writeFileSync(fsPath(topicLogPath(home, "deal-notes")), `# deal-notes log\n\n${bad}\n`, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-fact-grep-out"), "export"));

    expect(r.failed).toBeGreaterThanOrEqual(3);
    expect(rendered(r)).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
    // …and every failure still names its file and says where it isn't.
    for (const f of r.failures) {
      expect(f.message).toContain(f.rel);
      expect(f.message).toContain("Not in this export");
    }
  });
});

/**
 * DEFECT 1, at the root. A plaintext file in an encrypted store is **readable**:
 * the user owns those bytes, and export writes plaintext anyway. Failing it was
 * how the KEY sentence — "if the rest of this export decrypted correctly, then
 * the key is right and this file is damaged — restore it from a backup" — got
 * pointed at a file whose own `reason` said "found plaintext". For a plaintext
 * file the rest ALWAYS decrypts, so the advice ALWAYS resolved to "overwrite
 * this healthy note with an old copy". The codec is right to be strict (a WRITER
 * must never re-serialize over bytes it could not decrypt); export is read-only
 * and writes elsewhere, so it can be tolerant.
 */
describe("export --plaintext — a readable file is exportable, whatever mode it is in", () => {
  it("a PLAINTEXT note in an ENCRYPTED store EXPORTS verbatim — it is not a failure", async () => {
    const home = await seed("exp-mixed-note", true);
    // A note the user dropped in by hand, or one left behind by a partial
    // migration — plaintext, sitting in a store with a key.
    const plain = "---\nid: hand-written\ntitle: \"Hand written\"\n---\n\nmy own bytes\n";
    writeFileSync(fsPath(path.join(storePaths(home).topicsDir, "hand-written.md")), plain, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-mixed-note-out"), "export"));

    expect(r.failed).toBe(0);
    expect(r.files).toContain("topics/hand-written.md");
    expect(read(path.join(r.dest, "topics", "hand-written.md"))).toBe(plain);
    // The sealed notes decrypted in the same run — tolerance costs nothing.
    expect(read(path.join(r.dest, "topics", "deal-notes.md"))).toContain("id: deal-notes");
  });

  it("a PLAINTEXT log in an ENCRYPTED store EXPORTS verbatim, and sealed logs still decrypt", async () => {
    const home = await seed("exp-mixed-log", true);
    const plainLog = "# hand-written log\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nby hand\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-written")), plainLog, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-mixed-log-out"), "export"));

    expect(r.failed).toBe(0);
    expect(read(path.join(r.dest, "logs", "hand-written.log.md"))).toBe(plainLog);
    // The REAL encrypted log still decrypts in the same export — the tolerance
    // must not swallow the decode path (a log never carries the whole-file
    // magic, so "does it start with gestalt-enc:" is the wrong question here).
    expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });

  /**
   * DEFECT 4 — the escape hatch, BRICKED for a store that needs no key at all.
   * `GESTALT_KEY` is a documented power-user path (store/codec.ts), so a stray
   * one in the environment is ordinary. It flipped `keyState()` to encrypted, so
   * every plaintext file raised the codec's mode mismatch, every failure classed
   * KEY, nothing "proved the key" — and the v3 gate refused the whole export:
   * exit 1, nothing written, and a claim of N "sealed file(s)" that do not exist.
   */
  it("a PLAINTEXT store with a stray GESTALT_KEY set still EXPORTS — the gate is gone", async () => {
    const home = await seed("exp-stray-key", false);
    const before = process.env.GESTALT_KEY;
    process.env.GESTALT_KEY = "a".repeat(64); // valid shape; this store needs no key
    try {
      const r = await exportPlaintext(home, path.join(freshHome("exp-stray-key-out"), "export"));
      expect(r.failed).toBe(0);
      expect(r.notes).toBe(2);
      expect(r.logs).toBe(2);
      expect(r.proposals).toBe(1);
      // Byte-verbatim, exactly as if no key had been set.
      expect(read(path.join(r.dest, "topics", "deal-notes.md"))).toBe(read(topicNotePath(home, "deal-notes")));
      expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toBe(read(topicLogPath(home, "deal-notes")));
    } finally {
      if (before === undefined) delete process.env.GESTALT_KEY;
      else process.env.GESTALT_KEY = before;
    }
  });
});

/**
 * THE CRITICAL (43-agent audit) — "it does not start with `gestalt-enc:1:`,
 * therefore it is plaintext, therefore copy it out as the user's note" is
 * absence of evidence used as proof: the exact mistake the deleted classifier
 * died for, in the one place it still lived. And the event that trips it is
 * ROUTINE, not exotic — encrypted-yet-git-mergeable is this product's headline
 * feature and the store has a remote, but a NOTE is a whole-file blob, so the
 * same note edited on two machines CONFLICTS and git writes `<<<<<<< HEAD` at
 * the top of `topics/my-secrets.md`, ahead of the sealed blob.
 *
 * The op already had the right standard written down for LOGS ("isPlaintextIn is
 * the WRONG test for a log — a log never carries the whole-file magic, so it
 * would call every encrypted log plaintext"). These tests apply it to whole
 * files: plaintext is PROVED by a parse, never inferred from a missing prefix.
 */
describe("export --plaintext — plaintext is PROVED, never assumed", () => {
  it("a git-CONFLICTED note is NOT exported as the user's note — the conflict is named", async () => {
    const home = await seed("exp-conflict", true);

    // Exactly what git leaves in a synced store: markers around two sealed
    // blobs, so offset 0 no longer carries the magic.
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      `<<<<<<< HEAD\n${sealed}=======\n${sealed}>>>>>>> origin/main\n`,
      "utf8",
    );
    // …and a genuinely plaintext note, in the same run, must still come through:
    // proving plaintext must not become refusing it.
    const plain = '---\nid: hand-written\ntitle: "Hand written"\n---\n\nmy own bytes\n';
    writeFileSync(fsPath(path.join(storePaths(home).topicsDir, "hand-written.md")), plain, "utf8");

    const dest = path.join(freshHome("exp-conflict-out"), "export");
    const r = await exportPlaintext(home, dest);

    // THE BUG: this used to export the conflict markers AND the raw base64
    // ciphertext, verbatim, as `topics/deal-notes.md` — with green success,
    // failed: 0 and exit 0. The user believes they are holding their memory.
    expect(r.files).not.toContain("topics/deal-notes.md");
    expect(existsSync(fsPath(path.join(dest, "topics", "deal-notes.md")))).toBe(false);

    // The fact, named: WHICH file, and what is in it. A git-synced store WILL
    // produce this, and "which file" is the whole of what the user needs.
    expect(r.failed).toBe(1);
    const f = r.failures[0]!;
    expect(f.rel).toBe("topics/deal-notes.md");
    expect(f.message).toContain("git conflict markers");
    expect(f.message).toContain("Not in this export");
    // A fact about the bytes, still never a cause — and never the instruction
    // that would overwrite a note the user can still resolve by hand.
    expect(f.message).not.toMatch(/damaged|restore|backup/i);

    // Partial recovery holds, and the PROVEN-plaintext note exports verbatim.
    expect(r.files).toContain("topics/gestalt-example.md");
    expect(read(path.join(dest, "topics", "hand-written.md"))).toBe(plain);
    // Nothing in this export is ciphertext wearing a note's filename.
    for (const rel of r.files) {
      expect(read(path.join(dest, rel))).not.toContain("gestalt-enc:1:");
    }
  });

  it("a sealed blob with junk prepended is not exported as plaintext", async () => {
    const home = await seed("exp-junk", true);
    // A stray line from an editor, a half-written sync, a partial fetch: the
    // blob is still THERE, it is just no longer at offset 0.
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(fsPath(topicNotePath(home, "deal-notes")), `stray line\n${sealed}`, "utf8");

    const dest = path.join(freshHome("exp-junk-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(r.files).not.toContain("topics/deal-notes.md");
    expect(existsSync(fsPath(path.join(dest, "topics", "deal-notes.md")))).toBe(false);
    const f = r.failures[0]!;
    expect(f.rel).toBe("topics/deal-notes.md");
    // The other fact: two tests, both came back no. No conflict claim (there are
    // no markers), no diagnosis of the bytes.
    expect(f.message).toContain("does not parse as a note");
    expect(f.message).not.toContain("git conflict markers");
    expect(f.message).not.toMatch(/damaged|restore|backup/i);
  });

  it("a conflicted PROPOSAL is held to the same proof — its bodies live nowhere else", async () => {
    const home = await seed("exp-conflict-prop", true);
    const file = readdirSync(fsPath(storePaths(home).proposalsDir))[0]!;
    const p = path.join(storePaths(home).proposalsDir, file);
    const sealed = read(p);
    writeFileSync(fsPath(p), `<<<<<<< HEAD\n${sealed}=======\n${sealed}>>>>>>> origin/main\n`, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-conflict-prop-out"), "export"));

    // A PENDING proposal's proposed text exists nowhere else on disk, so handing
    // the user ciphertext under its filename is the same loss as a note's.
    expect(r.proposals).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe(`proposals/${file}`);
    expect(r.failures[0]!.message).toContain("git conflict markers");
    expect(existsSync(fsPath(path.join(r.dest, "proposals", file)))).toBe(false);
  });

  /**
   * `isPlainLog` tested EVERY line against the sealed `<ts> <base64url>` shape,
   * body lines included — so one ordinary body line disqualified a 100%-plaintext
   * log from the escape hatch. A timestamp-led body line is an ordinary thing to
   * type and must not be read as ciphertext.
   *
   * The line here used to be `2026-07-14T09:30:00.000Z deployed`: a BARE
   * `<ts> <token>`, i.e. byte-for-byte the shape of a sealed entry, which only
   * exported because a length floor guessed an 8-char token was too short to be
   * ciphertext. That guess is deleted, so a bare token is now ambiguous and fails
   * closed. Prose is not ambiguous — a sealed token contains no spaces — so this
   * covers the real hand edit with something that is PROVABLY the user's text.
   */
  it("a plaintext log whose BODY holds an ISO-timestamp-shaped line still exports", async () => {
    const home = await seed("exp-log-body", true);
    // An ordinary thing for a person to type, led by a timestamp.
    const plainLog =
      "# hand-written log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n" +
      "2026-07-14T09:30:00.000Z deployed the new build to prod\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-written")), plainLog, "utf8");

    // …while a genuinely MIXED log — a union-merged sealed append landing after
    // plaintext entries — must still NOT be waved through as plaintext. This is
    // what a body-blind scan would have dumped verbatim.
    const sealedLine = encodeLogEntry(
      "mixed",
      "### 2026-07-16T00:00:00.000Z | decision | acme | cli\nsealed one",
    );
    writeFileSync(
      fsPath(topicLogPath(home, "mixed")),
      `# mixed log\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain one\n${sealedLine}\n`,
      "utf8",
    );

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-body-out"), "export"));

    // In the export, verbatim, body line and all.
    expect(r.files).toContain("logs/hand-written.log.md");
    expect(read(path.join(r.dest, "logs", "hand-written.log.md"))).toBe(plainLog);

    // The mixed log is the only failure, and its sealed line is not dumped.
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe("logs/mixed.log.md");
    expect(existsSync(fsPath(path.join(r.dest, "logs", "mixed.log.md")))).toBe(false);
    // The real sealed log still decrypts in the same run.
    expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });
});

/**
 * ROUND 5 — the positive-proof rule was applied to notes and to proposals, and
 * never to LOGS. That is the worst place to have missed it: per-entry encoding +
 * `merge=union` is this product's headline feature, so a log is the one file git
 * will hand back HALF-MERGED, and `isPlainLog` still proved plaintext the old,
 * deleted way — by ABSENCE of evidence.
 *
 * Every export path now goes through ONE contract (`ops/exportDecode.ts`), so
 * there is no fourth surface to forget: positive proof, the conflict-marker
 * fact, and the factual failure live in a single module that notes, logs and
 * proposals all pass through.
 */
describe("export --plaintext — a LOG is proved like everything else", () => {
  /** The union-merge that a real store produces, as a log's raw bytes. */
  const mixedLog = (sealedLine: string): string =>
    "# deploys log\n\n" +
    "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
    "appended on the laptop, on an old build\n" +
    `${sealedLine}\n`;

  it("a MIXED log is NOT exported — half the user's text and half opaque is not a log", async () => {
    const home = await seed("exp-log-mix-open", true);
    // Exactly the auditor's shape, with real git mechanics behind it: base is a
    // plaintext-era log, the laptop appended plaintext on an old build, the
    // desktop migrated and appended SEALED, and merge=union concatenated both.
    const sealed = encodeLogEntry(
      "deploys",
      `### 2026-07-16T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    writeFileSync(fsPath(topicLogPath(home, "deploys")), mixedLog(sealed), "utf8");

    const dest = path.join(freshHome("exp-log-mix-open-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);

    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;
    // The FACT: mixed, and where. Not "This log is plaintext but a key is set" —
    // a causal claim, aimed at the user's key, that the file itself disproves.
    expect(f.message).toContain("mixes plaintext and sealed entries");
    expect(f.message).toContain("Not in this export");
    expect(f.message).not.toMatch(/key is set|wrong key|damaged|restore|backup/i);
  });

  /**
   * THE LEAK. `isPlainLog` asked the AEAD whether a sealed-shaped body line
   * opened, and treated "it did not open" as PROOF the line was body text — so a
   * sealed line that does not open under THIS log's id (a relocated entry, a
   * bit-rotted one, one sealed under a key the store no longer holds) was waved
   * straight through, and export copied the whole file out **as the user's log**:
   * raw base64, `failed: 0`, exit 0. Absence of evidence as proof, one last time.
   */
  it("a sealed line that does NOT open is not 'therefore body text' — no ciphertext escapes", async () => {
    const home = await seed("exp-log-mix-foreign", true);
    // Sealed under ANOTHER topic's id, so the AEAD refuses it under `deploys` —
    // which is precisely what store/log.ts detects as a relocated log, and what
    // export used to read as "just some text the user typed".
    const foreign = encodeLogEntry(
      "another-topic",
      `### 2026-07-16T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    const token = foreign.slice(foreign.indexOf(" ") + 1);
    writeFileSync(fsPath(topicLogPath(home, "deploys")), mixedLog(foreign), "utf8");

    const dest = path.join(freshHome("exp-log-mix-foreign-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(r.files).not.toContain("logs/deploys.log.md");
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;
    // The fact, not a cause: line 5 did not read as an entry and did not open.
    // Which of those two it IS, we do not claim — that is the whole point.
    expect(f.message).toContain("line 5 is neither a readable log entry nor openable");
    expect(f.message).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);

    // Nothing in this export is ciphertext wearing a log's filename.
    for (const rel of r.files) {
      expect(read(path.join(dest, rel))).not.toContain(token);
    }
  });

  /**
   * FINDINGS 2 + 4 — the conflict-marker fact was wired only into the whole-file
   * path, so a git-conflicted LOG fell through to `parseLog` and was reported as
   * **"wrong key, tampered data, or a relocated log"**: the exact key verdict
   * this rebuild exists to delete, aimed at a user whose key is fine and whose
   * log is one `git checkout` from resolved. Not hypothetical — DEV_LOG.md:94
   * records this very store hitting "both machines appended to gestalt-dogfood
   * between syncs → rebase conflict".
   */
  it("a git-conflicted LOG names the conflict, and renders NO verdict on the key", async () => {
    const home = await seed("exp-log-conflict", true);
    const ours = encodeLogEntry("deploys", "### 2026-07-16T00:00:00.000Z | decision | acme | cli\nours");
    const theirs = encodeLogEntry("deploys", "### 2026-07-17T00:00:00.000Z | decision | acme | cli\ntheirs");
    // A log without merge=union set conflicts, and git writes this into it.
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      `# deploys log\n\n<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> origin/main\n`,
      "utf8",
    );

    const dest = path.join(freshHome("exp-log-conflict-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;
    // WHICH file, and what is in it — the one thing the user needs. A note and a
    // log now get the identical sentence, because they go through one contract.
    expect(f.message).toBe(
      "could not include logs/deploys.log.md — contains git conflict markers. Not in this export.",
    );
    expect(f.message).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
  });

  it("a header that only LOOKS like an entry header is not proof — the store's own parser answers", async () => {
    const home = await seed("exp-log-badhdr", true);
    // `### <ts> | ` is the entry-header SHAPE, and shape is not proof: the store
    // writes `### <ts> | type | project | agent`, and this is not that. Export
    // used to copy the file out as the user's log on the strength of the prefix.
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      "# deploys log\n\n### 2026-07-15T00:00:00.000Z | onlytwo\nbody\n",
      "utf8",
    );

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-badhdr-out"), "export"));

    expect(r.failed).toBe(1);
    expect(r.files).not.toContain("logs/deploys.log.md");
    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;
    expect(f.message).toContain("not a well-formed entry header");
    expect(f.message).not.toMatch(/damaged|restore|backup/i);
  });

  it("a genuinely plaintext log STILL exports, byte-identical — proving it must not become refusing it", async () => {
    const home = await seed("exp-log-plain-ok", true);
    // Every shape the prover has to accept at once: the `# <id> log` H1, blank
    // separators, a multi-line body, an entry with the optional `supersedes:`
    // field, and a timestamp-led body line an ordinary person would type.
    //
    // That last line USED to be `2026-07-14T09:30:00.000Z deployed`, which is a
    // bare `<ISO-ts> <token>` — the sealed-line shape, exactly. It exported only
    // because a length floor guessed that an 8-char token was too short to be
    // ciphertext. The floor is gone (shape never proves sealed, and it never
    // disproves it either), so that line is now AMBIGUOUS and refused: it is the
    // same bytes as a sealed entry that does not open here, and the export cannot
    // tell them apart without guessing. Prose cannot collide — a sealed token has
    // no spaces in it — so a sentence is both the realistic hand edit and the one
    // that is PROVABLY the user's.
    const plainLog =
      "# hand-kept log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n" +
      "2026-07-14T09:30:00.000Z we cut over the primary database this morning\n" +
      "\n" +
      "### 2026-07-16T00:00:00.000Z | supersede | acme | eric | supersedes:2026-07-15T00:00:00.000Z\n" +
      "changed my mind\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), plainLog, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-plain-ok-out"), "export"));

    expect(r.failed).toBe(0);
    // §0.1: byte-identical, hand edits and all.
    expect(read(path.join(r.dest, "logs", "hand-kept.log.md"))).toBe(plainLog);
    // …and an empty log, and the real sealed log, in the same run.
    expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });
});

/**
 * ROUND 6 — the module wrote its own rule down ("it only ever asserts NOT-sealed,
 * never sealed, and drifts safe", `MIN_SEALED_TOKEN`) and then broke it one line
 * later. `sealedByShape = looksLikeEncryptedLog(raw)` asserted SEALED from a
 * PREFIX match with no length bound (`ENCRYPTED_LINE_PREFIX_RE`, store/log.ts) —
 * bypassing the very floor that exists because shape cannot prove sealedness.
 *
 * Both bugs fire on §0.1-sanctioned acts — hand-editing a file, renaming a file —
 * and both were reported with sentences that were not true.
 */
describe("export --plaintext — shape NEVER proves sealed, and a stated line is a real one", () => {
  /**
   * BUG A, in its sharpest form: a log the user kept BY HAND, in an encrypted
   * store, containing nothing sealed at all. The prefix test fired on the
   * one-liner, the log was handed to `parseLog` as SEALED, and the AEAD's failure
   * to open a line that is not ciphertext was reported as **"wrong key, tampered
   * data, or a relocated log"** — a verdict on the user's key, delivered by the
   * escape hatch, about a key that is fine and a file that disproves it. That
   * sentence is the exact thing this rebuild deleted, and shape alone re-derived
   * it.
   */
  it("a hand-kept plaintext log renders NO verdict on the key — an 8-char token is not ciphertext", async () => {
    const home = await seed("exp-log-shape-key", true);
    // `2026-07-14T09:30:00.000Z deployed` is the line this suite already
    // canonises as "an ordinary thing for a person to type" — and an exact
    // ENCRYPTED_LINE_RE match. `deployed` is 8 chars; the shortest token this
    // codec can emit is 54, so it is PROVABLY not sealed.
    writeFileSync(
      fsPath(topicLogPath(home, "hand-kept")),
      "# hand-kept log\n\n2026-07-14T09:30:00.000Z deployed\n",
      "utf8",
    );

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-shape-key-out"), "export"));
    const f = r.failures.find((x) => x.rel === "logs/hand-kept.log.md")!;

    expect(f.message).not.toMatch(
      /wrong key|tampered|relocated|key is set|damaged|restore|backup/i,
    );
    // Nothing here is sealed, so it is not "mixed" either.
    expect(f.message).not.toContain("mixes plaintext and sealed entries");
    expect(f.message).toContain("line 3 is neither a readable log entry nor openable");
    expect(f.code).toBe("E_SCHEMA");
    // The sealed log in the same store still decrypts — the floor did not blunt
    // the real thing.
    expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });

  /**
   * BUG A + BUG B together, which is how a user actually meets them: the same
   * one-liner typed ABOVE the first entry. Shape fired, the log was judged MIXED
   * on the strength of it — and the message then named line 5 as BOTH the
   * plaintext entry and the sealed one, because no sealed line existed to name.
   */
  it("a timestamped one-liner ABOVE the first entry is not 'therefore sealed' — the log is not MIXED", async () => {
    const home = await seed("exp-log-shape-mix", true);
    const plainLog =
      "# hand-kept log\n\n" +
      "2026-07-14T09:30:00.000Z deployed\n" +
      "\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), plainLog, "utf8");

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-shape-mix-out"), "export"));
    const f = r.failures.find((x) => x.rel === "logs/hand-kept.log.md")!;

    // Was: "mixes plaintext and sealed entries (a plaintext entry on line 5, a
    // sealed one on line 5)". Nothing in this file is sealed, and line 5 is one
    // thing, not two.
    expect(f.message).not.toContain("mixes plaintext and sealed entries");
    expect(f.message).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
    const named = [...f.message.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
    expect(new Set(named).size).toBe(named.length);
  });

  /**
   * BUG B's own trigger, with no hand-edit involved: the user RENAMES
   * `logs/deploys.log.md` to `logs/releases.log.md` in a file manager — §0.1 says
   * they may. The AEAD's aad is derived from the filename, so not one sealed line
   * opens under the new id and `sealedAt` is -1 — while the sealed line is real,
   * and is on line 3. The old fallback reported the PLAINTEXT entry's line as the
   * sealed one's location.
   */
  it("a RENAMED log names no line it does not have — and never one line as two", async () => {
    const home = await seed("exp-log-renamed", true);
    const sealed = encodeLogEntry(
      "deploys",
      `### 2026-07-16T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    const token = sealed.slice(sealed.indexOf(" ") + 1);
    // Line 1 `# deploys log`, 2 blank, 3 the sealed entry, 4 the plaintext entry.
    writeFileSync(
      fsPath(topicLogPath(home, "releases")),
      `# deploys log\n\n${sealed}\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain one\n`,
      "utf8",
    );

    const dest = path.join(freshHome("exp-log-renamed-out"), "export");
    const r = await exportPlaintext(home, dest);
    const f = r.failures.find((x) => x.rel === "logs/releases.log.md")!;

    // THE FABRICATION: line 4 is the plaintext entry. It was also reported as the
    // sealed entry's line, so one line was two things and the sealed line's real
    // location (3) was never stated.
    expect(f.message).not.toContain("a sealed one on line 4");
    const named = [...f.message.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
    expect(new Set(named).size).toBe(named.length); // no line named twice
    // Nothing in this file opens under `releases`, so it is not MIXED — and the
    // file is no longer described in terms of a sealed entry we cannot prove is
    // there. Line 3 — the line we actually stopped on — is named, and only it.
    expect(named).toEqual([3]);
    expect(f.message).toContain("line 3 is neither a readable log entry nor openable");
    expect(f.message).not.toContain("mixes plaintext and sealed entries");
    // And no verdict on the key: the aad changed because the FILE was renamed,
    // which §0.1 permits, and the key was never involved.
    expect(f.message).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);

    // Still refused, and still no ciphertext anywhere in the export.
    expect(r.files).not.toContain("logs/releases.log.md");
    for (const rel of r.files) expect(read(path.join(dest, rel))).not.toContain(token);
  });

  /**
   * NO REGRESSION. The floor must not blunt the real thing: a genuinely mixed log
   * — a union-merged sealed append landing beside plaintext entries, both located
   * — is still refused, both lines are still named, and they are different lines.
   */
  it("a genuinely MIXED log is still refused, both lines named, and no ciphertext escapes", async () => {
    const home = await seed("exp-log-mix-keep", true);
    const sealed = encodeLogEntry(
      "deploys",
      `### 2026-07-16T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    const token = sealed.slice(sealed.indexOf(" ") + 1);
    // Line 3 the plaintext entry, line 5 the sealed one.
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      `# deploys log\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain one\n${sealed}\n`,
      "utf8",
    );

    const dest = path.join(freshHome("exp-log-mix-keep-out"), "export");
    const r = await exportPlaintext(home, dest);
    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;

    expect(f.message).toContain("mixes plaintext and sealed entries");
    expect(f.message).toContain("a plaintext entry on line 3");
    expect(f.message).toContain("a sealed one on line 5");
    // Both claims in that sentence are now PROVED, not shaped: each line number
    // is somewhere the prover actually located the thing it names, and they are
    // different lines.
    const named = [...f.message.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
    expect(named).toEqual([3, 5]);
    expect(r.files).not.toContain("logs/deploys.log.md");
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
    for (const rel of r.files) expect(read(path.join(dest, rel))).not.toContain(token);
  });
});

/**
 * ROUND 7 — the guess is DELETED, not re-tuned.
 *
 * Rounds 4, 5 and 6 each found the same root cause and each answered it by
 * adjusting the discriminator: a floor, then a floor applied to a different line,
 * then a floor plus a prefix test. The floor was never the bug. The bug was that
 * `proveLog` concluded SEALED from what a line LOOKED like, and "sealed" routes to
 * `parseLog`, whose refusal is the one sentence this whole module exists to never
 * say: **"wrong key, tampered data, or a relocated log."**
 *
 * Sealed now means one thing: it OPENED under the AEAD. Everything that neither
 * opens nor parses is reported as the two observations we actually made.
 */
describe("export --plaintext — sealed means it OPENED, and nothing else", () => {
  /**
   * THE test. The line the length floor could never handle: an ordinary sentence
   * a person typed, led by a timestamp. `looksLikeEncryptedLog` matches its
   * PREFIX (a timestamp, a space, a word character), and `couldBeSealed` then
   * measured `line.length - line.indexOf(" ") - 1` — the WHOLE remainder of the
   * line, not a token — so any prose long enough cleared the 54-char floor and was
   * declared ciphertext. Shape said "sealed", `parseLog` got it, and the AEAD's
   * failure to open an English sentence reached the user as a verdict on their key.
   *
   * 70 chars of plain English here. The floor cannot be raised to exclude prose —
   * people write long sentences — nor lowered. There is no length at which this
   * becomes ciphertext, which is why the predicate is gone rather than retuned.
   */
  it("a hand-typed timestamped SENTENCE renders NO verdict on the key", async () => {
    const home = await seed("exp-log-sentence", true);
    // 70 chars after the timestamp — over the old floor, and obviously prose.
    const sentence =
      "2026-07-14T09:30:00.000Z we cut over the primary database this morning and everything went fine";
    writeFileSync(
      fsPath(topicLogPath(home, "hand-kept")),
      `# hand-kept log\n\n${sentence}\n`,
      "utf8",
    );

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-sentence-out"), "export"));
    const f = r.failures.find((x) => x.rel === "logs/hand-kept.log.md")!;

    // THE assertion.
    expect(f.message).not.toMatch(
      /wrong key|tampered|relocated|key is set|damaged|restore|backup/i,
    );
    // What it says instead: the two things we observed about line 3, and no cause.
    expect(f.message).toContain("line 3 is neither a readable log entry nor openable");
    expect(f.message).not.toContain("mixes plaintext and sealed entries");
    expect(f.code).toBe("E_SCHEMA");
    // The real sealed log in the same store still opens and still exports.
    expect(read(path.join(r.dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });

  /**
   * The `plainAt === -1` path — a log kept ENTIRELY by hand, with not one
   * conforming `### <ts> | ...` entry in it. This is where the literal key verdict
   * was reported: nothing to prove plaintext with, shape said sealed, `parseLog`
   * delivered the sentence. It is still REFUSED (a file with no entries is not a
   * log we can prove, and relaxing that would let a pre-entry `gestalt-enc:1:`
   * blob out as "the user's log") — but the refusal is now a fact about a line.
   */
  it("a log with NO entries at all is refused as a FACT, never as a key verdict", async () => {
    const home = await seed("exp-log-nohdr", true);
    writeFileSync(
      fsPath(topicLogPath(home, "hand-kept")),
      "# hand-kept log\n\nnotes from the cutover\nnothing broke\n",
      "utf8",
    );

    const r = await exportPlaintext(home, path.join(freshHome("exp-log-nohdr-out"), "export"));
    const f = r.failures.find((x) => x.rel === "logs/hand-kept.log.md")!;

    expect(f.message).not.toMatch(
      /wrong key|tampered|relocated|key is set|damaged|restore|backup/i,
    );
    expect(f.message).toContain("line 3 is neither a readable log entry nor openable");
    expect(f.code).toBe("E_SCHEMA");
  });

  /**
   * The other half of the deletion: what OPENS is still sealed, still decrypts,
   * still exports. Removing the guess must not blunt the proof.
   */
  it("a real sealed log still opens and exports as plaintext", async () => {
    const home = await seed("exp-log-sealed-ok", true);
    const dest = path.join(freshHome("exp-log-sealed-ok-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    const out = read(path.join(dest, "logs", "deal-notes.log.md"));
    expect(out).toContain(SECRET);
    // Re-emitted as canonical plaintext entries, with no ciphertext left in it.
    expect(out).toMatch(/^### \d{4}-\d{2}-\d{2}T/m);
    expect(out).not.toContain("gestalt-enc:");
  });
});

/**
 * THE 2026-07-16 KNOWN GAP (SPEC §5.1), CLOSED — the LAST cause-naming sentence.
 *
 * `proveLog` concludes a whole log is SEALED from ONE line opening; the decode
 * then handed the ENTIRE file to `parseLog`, which requires EVERY line to open
 * and whose refusal is **"wrong key, tampered data, or a relocated log"**. In
 * the gap between "one line opens" and "all lines open" lived the verdict: a
 * sealed log with one bit-rotted line, or one line carried in by `merge=union`
 * from another topic's file, drew a key verdict about a key that had JUST
 * OPENED the line proving the file sealed. The refusal was right; the reason
 * was a lie. Export now decodes a proven-sealed log per LINE under its own
 * contract (`decodeSealedLog`) and reports its own fact — and `parseLog` is no
 * longer reachable from the export decode path at all.
 */
describe("export --plaintext — a sealed log that does not FULLY open is a fact, never a verdict (the 2026-07-16 gap)", () => {
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;

  /**
   * (1) THE ticketed shape: a healthy key, a proven-sealed log, ONE rotted
   * line. Line 3 opens — the key demonstrably works on this very file — and
   * line 4 does not. The old path reported that as a three-cause key verdict.
   */
  it("ONE bit-rotted line in an otherwise-healthy sealed log: the per-line FACT, and no verdict anywhere", async () => {
    const home = await seed("exp-gap-rot-line", true);
    await appendLog(home, "deal-notes", {
      type: "gotcha",
      project: "acme",
      agent: "cli",
      summary: "a second entry, so a healthy line remains beside the rot",
    });
    // Line 1 `# deal-notes log`, 2 blank, 3 sealed entry one, 4 sealed entry
    // two. `corrupt` flips a byte near EOF — inside line 4's token only — so
    // line 3 still opens (proving the file sealed and the key healthy) and
    // line 4's AEAD tag no longer verifies.
    corrupt(topicLogPath(home, "deal-notes"));

    const dest = path.join(freshHome("exp-gap-rot-line-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "logs/deal-notes.log.md")!;
    // Export's OWN fact — the sentence every other unprovable line already gets.
    expect(f.message).toContain(
      "line 4 is neither a readable log entry nor openable with the active key",
    );
    expect(f.code).toBe("E_SCHEMA");
    // …and the banned sentence appears NOWHERE in the rendered output.
    expect(rendered(r)).not.toMatch(VERDICTS);
    // Refused whole — partial export of a sealed log is not offered, and no
    // ciphertext reaches the export wearing the log's filename.
    expect(r.files).not.toContain("logs/deal-notes.log.md");
    expect(existsSync(fsPath(path.join(dest, "logs", "deal-notes.log.md")))).toBe(false);
    // Partial recovery holds: the topic's note and the other topics still export.
    expect(r.files).toContain("topics/deal-notes.md");
    expect(r.files).toContain("logs/gestalt-example.log.md");
  });

  /**
   * (2a) One line OPENS, one does not — no rot involved: the non-opening line
   * is sealed under ANOTHER topic's id (union-merge debris). `sealedAt` finds
   * line 3, so the file takes the SEALED path — the gap's exact route.
   */
  it("a sealed log holding ONE line sealed under another topic's id: the same fact, still no verdict", async () => {
    const home = await seed("exp-gap-foreign-line", true);
    const ours = encodeLogEntry(
      "deploys",
      "### 2026-07-16T00:00:00.000Z | decision | acme | cli\nours, and it opens",
    );
    const foreign = encodeLogEntry(
      "another-topic",
      `### 2026-07-17T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    const token = foreign.slice(foreign.indexOf(" ") + 1);
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      `# deploys log\n\n${ours}\n${foreign}\n`,
      "utf8",
    );

    const dest = path.join(freshHome("exp-gap-foreign-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "logs/deploys.log.md")!;
    expect(f.message).toContain(
      "line 4 is neither a readable log entry nor openable with the active key",
    );
    expect(rendered(r)).not.toMatch(VERDICTS);
    // Refused whole; the foreign ciphertext escapes under NO filename.
    expect(r.files).not.toContain("logs/deploys.log.md");
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
    for (const rel of r.files) expect(read(path.join(dest, rel))).not.toContain(token);
  });

  /**
   * (2b) The rename, in its ALL-SEALED form. The AEAD's aad derives from the
   * FILENAME, so after a rename NOTHING opens — `sealedAt === -1` — and the
   * file takes the provePlainLines path, not the sealed one. That path was
   * already factual; this pins it so the two rename shapes never diverge.
   */
  it("a RENAMED all-sealed log (nothing opens under the new id) stays on the factual path", async () => {
    const home = await seed("exp-gap-renamed-all", true);
    const a = encodeLogEntry(
      "deploys",
      "### 2026-07-16T00:00:00.000Z | decision | acme | cli\nentry one",
    );
    const b = encodeLogEntry(
      "deploys",
      `### 2026-07-17T00:00:00.000Z | decision | acme | cli\n${SECRET}`,
    );
    const token = b.slice(b.indexOf(" ") + 1);
    // The user renamed deploys.log.md → releases.log.md in a file manager —
    // §0.1 says they may. Line 3 is the first line that neither parses nor opens.
    writeFileSync(
      fsPath(topicLogPath(home, "releases")),
      `# deploys log\n\n${a}\n${b}\n`,
      "utf8",
    );

    const dest = path.join(freshHome("exp-gap-renamed-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "logs/releases.log.md")!;
    expect(f.message).toContain(
      "line 3 is neither a readable log entry nor openable with the active key",
    );
    expect(f.message).not.toContain("mixes plaintext and sealed entries");
    expect(rendered(r)).not.toMatch(VERDICTS);
    expect(r.files).not.toContain("logs/releases.log.md");
    for (const rel of r.files) expect(read(path.join(dest, rel))).not.toContain(token);
  });

  /**
   * (3) The happy sealed path is BYTE-IDENTICAL: the per-line decode emits
   * exactly what the pre-fix formula — `serializeLogPlain(id, parseLog(raw,
   * id).entries)` — emitted, asserted against that very formula.
   */
  it("a fully healthy sealed log still exports BYTE-IDENTICAL to the pre-fix decode", async () => {
    const home = await seed("exp-gap-happy", true);
    await appendLog(home, "deal-notes", {
      type: "pattern",
      project: "acme",
      agent: "cli",
      summary: "a second entry with a body",
      body: "line one of the body\nline two of the body",
    });
    const rawOnDisk = read(topicLogPath(home, "deal-notes"));
    const expected = serializeLogPlain("deal-notes", parseLog(rawOnDisk, "deal-notes").entries);

    const dest = path.join(freshHome("exp-gap-happy-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "logs", "deal-notes.log.md"))).toBe(expected);
    expect(expected).toContain(SECRET); // and it really is the decrypted content
  });

  /**
   * (4) The neighbors do not move: a MIXED log still fails with both lines
   * named, and a hand-kept plaintext log still exports byte-identical — in the
   * same run as each other.
   */
  it("MIXED and plaintext logs are untouched by the per-line decode — the same facts as before", async () => {
    const home = await seed("exp-gap-neighbors", true);
    // Lines: 1 header, 2 blank, 3 plaintext entry header, 4 body, 5 sealed.
    const sealed = encodeLogEntry(
      "mixedlog",
      "### 2026-07-16T00:00:00.000Z | decision | acme | cli\nsealed side",
    );
    writeFileSync(
      fsPath(topicLogPath(home, "mixedlog")),
      `# mixedlog log\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain side\n${sealed}\n`,
      "utf8",
    );
    const plainLog =
      "# hand-kept log\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nby hand\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), plainLog, "utf8");

    const dest = path.join(freshHome("exp-gap-neighbors-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "logs/mixedlog.log.md")!;
    expect(f.message).toContain("mixes plaintext and sealed entries");
    expect(f.message).toContain("a plaintext entry on line 3");
    expect(f.message).toContain("a sealed one on line 5");
    expect(read(path.join(dest, "logs", "hand-kept.log.md"))).toBe(plainLog);
    expect(rendered(r)).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
  });
});

/**
 * THE LOG FIX'S MIRROR IMAGE on the WHOLE-FILE path, plus the one place where
 * classification and decode still measured DIFFERENT bytes.
 *
 * (1) `decodeWholeFile` handed a magic-prefixed note/proposal straight to
 * `decryptFile` and let the codec's refusal — "Could not decrypt <file> —
 * wrong key or tampered data." — ride verbatim into `failures[]`,
 * `warnings[]`, stderr and `--json`. That wording is right at the STORE layer,
 * where a failed open blocks a write; through export it is a key verdict, and
 * the trigger is §0.1-sanctioned: the AEAD's aad binds the BASENAME, so
 * renaming a sealed file in a file manager makes a HEALTHY key draw it.
 * Export now states its own two observations — "neither parses as a <kind>
 * nor opens with the active key" — exactly as the log path already does.
 *
 * (2) `proveLog` classifies on the TRIMMED line while the sealed-log decode
 * tried the line as-is. A sealed line carrying editor-added leading
 * whitespace therefore proved the file SEALED and then failed its own decode,
 * refused with "neither a readable log entry nor openable with the active
 * key" — FALSE, it opens when trimmed. The decode now tries as-is, then
 * trimmed, and recovers the entry: the fact stays true and the user gets
 * their log.
 */
describe("export --plaintext — the whole-file mirror of the log fix, and trim agreement", () => {
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;

  it("a RENAMED sealed NOTE draws export's own fact — the codec's key verdict surfaces nowhere, --json included", async () => {
    const home = await seed("exp-mirror-note", true);
    const sealed = read(topicNotePath(home, "deal-notes"));
    expect(sealed.startsWith("gestalt-enc:1:")).toBe(true);
    // The user renamed it in a file manager — §0.1 says they may. The aad binds
    // the basename, so these healthy bytes no longer open under the new name.
    rmSync(fsPath(topicNotePath(home, "deal-notes")));
    writeFileSync(fsPath(topicNotePath(home, "meeting-notes")), sealed, "utf8");

    const dest = path.join(freshHome("exp-mirror-note-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "topics/meeting-notes.md")!;
    // Export's OWN sentence — both observations actually made, no cause chosen.
    expect(f.message).toBe(
      "could not include topics/meeting-notes.md — neither parses as a note nor opens with the active key. Not in this export.",
    );
    expect(f.code).toBe("E_SCHEMA");
    // The banned sentence appears NOWHERE a user can see: rendered output or
    // the full structured result (`--json` prints exactly JSON.stringify(r)).
    expect(rendered(r)).not.toMatch(VERDICTS);
    expect(JSON.stringify(r)).not.toMatch(VERDICTS);
    // Refused, not exported — and no ciphertext escapes under any name.
    expect(r.files).not.toContain("topics/meeting-notes.md");
    expect(existsSync(fsPath(path.join(dest, "topics", "meeting-notes.md")))).toBe(false);
    // Partial recovery holds: the rest of the store still comes out.
    expect(r.files).toContain("topics/gestalt-example.md");
    expect(read(path.join(dest, "logs", "deal-notes.log.md"))).toContain(SECRET);
  });

  it("a RENAMED sealed PROPOSAL gets the same fact — the mirror covers both whole-file kinds", async () => {
    const home = await seed("exp-mirror-prop", true);
    const dir = storePaths(home).proposalsDir;
    const file = readdirSync(fsPath(dir))[0]!;
    const sealed = read(path.join(dir, file));
    expect(sealed.startsWith("gestalt-enc:1:")).toBe(true);
    rmSync(fsPath(path.join(dir, file)));
    writeFileSync(fsPath(path.join(dir, "9-renamed.md")), sealed, "utf8");

    const dest = path.join(freshHome("exp-mirror-prop-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    const f = r.failures.find((x) => x.rel === "proposals/9-renamed.md")!;
    expect(f.message).toBe(
      "could not include proposals/9-renamed.md — neither parses as a proposal nor opens with the active key. Not in this export.",
    );
    expect(f.code).toBe("E_SCHEMA");
    expect(rendered(r)).not.toMatch(VERDICTS);
    expect(JSON.stringify(r)).not.toMatch(VERDICTS);
    expect(r.proposals).toBe(0);
    expect(existsSync(fsPath(path.join(dest, "proposals", "9-renamed.md")))).toBe(false);
  });

  it("a sealed log line with LEADING WHITESPACE decodes — classification and decode agree, the file exports whole", async () => {
    const home = await seed("exp-trim-agree", true);
    const p = topicLogPath(home, "deal-notes");
    const disk = read(p);
    // The §0.1 hand edit: an editor auto-indents the sealed line. `proveLog`
    // classifies on the trimmed line, so this file is (correctly) SEALED —
    // and the decode must then open what classification opened, because the
    // alternative is refusing the file with a sentence ("nor openable with
    // the active key") that the trimmed line disproves.
    const indented = disk.replace(/^(\d{4}-\d{2}-\d{2}T)/m, "  $1");
    expect(indented).not.toBe(disk); // the sealed line really was indented
    writeFileSync(fsPath(p), indented, "utf8");

    const dest = path.join(freshHome("exp-trim-agree-out"), "export");
    const r = await exportPlaintext(home, dest);

    // It IS the user's entry, and it comes out — no failure, no false fact.
    expect(r.failed).toBe(0);
    expect(r.files).toContain("logs/deal-notes.log.md");
    const out = read(path.join(dest, "logs", "deal-notes.log.md"));
    expect(out).toContain(SECRET);
    expect(out).toMatch(/^### \d{4}-\d{2}-\d{2}T/m); // canonical plaintext entries
    expect(out).not.toContain("gestalt-enc:");
    expect(rendered(r)).toBe("");
  });
});

/**
 * DEFECT 5 — `isDir()` was `try { ...stat... } catch { return false }`, so a
 * store the OS merely would not talk about (a lock, an ACL, an EIO, a libuv
 * UNKNOWN from a filter driver) was reported as **"No FIMemory store at ~/.gestalt"**
 * with the hint `fimemory init` — i.e. the recovery tool invited the user to
 * initialize a NEW store on top of the one they still had. Answering "unknown"
 * with "absent" is how the tool becomes the cause of the loss.
 */
describe("export --plaintext — 'I cannot see it' is not 'it is not there'", () => {
  it("a store dir that cannot be STATted reports E_IO — never 'no store', never 'init'", async () => {
    const home = await seed("exp-stat-locked", false);
    const spy = vi.spyOn(fsp, "stat");
    spy.mockImplementationOnce(async () => {
      const e = new Error("permission denied") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    });
    try {
      const err = await expectGestaltErrorAsync(
        () => exportPlaintext(home, path.join(freshHome("exp-stat-locked-out"), "export")),
        "E_IO",
      );
      expect(err.message).not.toMatch(/No FIMemory store/i);
      expect(err.hint).not.toMatch(/fimemory init/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("a genuinely ABSENT store still answers E_NOT_FOUND with the init hint — the two stay distinct", async () => {
    const home = freshHome("exp-stat-absent");
    const err = await expectGestaltErrorAsync(
      () => exportPlaintext(home, path.join(freshHome("exp-stat-absent-out"), "x")),
      "E_NOT_FOUND",
    );
    expect(err.hint).toMatch(/fimemory init/i);
  });
});

/**
 * THE EXIT-CODE CONTRACT, which had no test at all.
 *
 * "Exit non-zero on an incomplete export" is not a nicety — it is the promise a
 * BACKUP SCRIPT relies on: `fimemory export --plaintext "$d" && rm -rf ~/.gestalt`
 * is the exact command this feature invites people to write, and if an
 * incomplete export exits 0 that script deletes the only copy of the files it
 * failed to export. So it is asserted end-to-end through the real CLI, not
 * through the op — the op returning `failed: 1` is worth nothing if `cli.ts`
 * returns 0 anyway.
 */
describe("export --plaintext — the exit code is a contract (CLI, end to end)", () => {
  const TSX = tsxEntry();
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  /**
   * Run the REAL cli.ts in a child process. Returns the exit code; never throws.
   *
   * `preload` is an ESM module loaded before the CLI (used to make the
   * destination refuse writes the way a folder shield does). It goes through
   * NODE_OPTIONS, not a bare `--import` argv: tsx's cli.mjs RE-SPAWNS node for
   * the actual script, so an argv flag lands on the wrapper and never reaches
   * the process that runs `cli.ts` — NODE_OPTIONS is inherited by the child.
   */
  function spawnCli(
    args: string[],
    opts: { preload?: string; env?: Record<string, string> } = {},
  ): { status: number; stdout: string; stderr: string } {
    const preloadEnv = opts.preload
      ? { NODE_OPTIONS: `--import "${pathToFileURL(opts.preload).href}"` }
      : {};
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...preloadEnv, ...opts.env },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("exits 0 on a complete export and NON-ZERO on an incomplete one", async () => {
    const home = await seed("exp-exit", false);

    // Complete → 0.
    const ok = path.join(freshHome("exp-exit-ok"), "export");
    const good = spawnCli(["export", "--plaintext", ok, "--home", home]);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("Exported");

    // Incomplete (one unreadable note) → non-zero, itemized on stderr.
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true });
    const bad = path.join(freshHome("exp-exit-bad"), "export");
    const r = spawnCli(["export", "--plaintext", bad, "--home", home]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MISSING from this export");
    expect(r.stderr).toContain("topics/wedged.md");
    // The fact survives the trip through the CLI's reporting — and the words
    // that would talk the user into destroying the note never appear.
    expect(r.stderr).toContain("could not include topics/wedged.md — EISDIR");
    expect(r.stderr).not.toMatch(/damaged|restore|backup/i);
    expect(r.stderr).not.toMatch(/could NOT be decoded/i);
    // Something DID export, so the footer may say so.
    expect(r.stderr).toContain("Everything else exported fine");
  });

  /**
   * DEFECT 6 — "Everything else exported fine." printed unconditionally, so a
   * run where NOTHING could be read still claimed a fine export of everything
   * else. There was no "else".
   */
  it("when NOTHING exports: exit 1, an honest count, and no claim that anything was fine", async () => {
    const home = await seed("exp-exit-nothing", false);
    // topics/ still enumerates (so the store is plainly THERE), but its only
    // note cannot be read; logs/ and proposals/ are replaced by files, so
    // readdir fails ENOTDIR on both. Result: 3 failures, 0 files written.
    for (const f of readdirSync(fsPath(storePaths(home).topicsDir))) {
      rmSync(fsPath(path.join(storePaths(home).topicsDir, f)), { force: true });
    }
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true }); // EISDIR on read
    for (const dir of [storePaths(home).logsDir, storePaths(home).proposalsDir]) {
      rmSync(fsPath(dir), { recursive: true, force: true });
      writeFileSync(fsPath(dir), "not a directory", "utf8");
    }

    const dest = path.join(freshHome("exp-exit-nothing-out"), "export");
    const r = spawnCli(["export", "--plaintext", dest, "--home", home]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could be read");
    expect(r.stderr).toContain("Nothing was exported");
    expect(r.stderr).not.toContain("Everything else exported fine");
    expect(r.stdout).not.toContain("Exported"); // no success line at all
    expect(r.stderr).not.toMatch(/damaged|restore|backup/i);
  });

  it("--json carries the failures with the raw error, and still exits non-zero", async () => {
    const home = await seed("exp-exit-json", false);
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true });
    const dest = path.join(freshHome("exp-exit-json-out"), "export");

    const r = spawnCli(["export", "--plaintext", dest, "--home", home, "--json"]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as {
      failed: number;
      notes: number;
      failures: { rel: string; phase: string; code: string; reason: string; message: string }[];
    };
    expect(out.failed).toBe(1);
    expect(out.failures[0]!.rel).toBe("topics/wedged.md");
    expect(out.failures[0]!.phase).toBe("read");
    expect(out.failures[0]!.code).toBe("E_IO");
    expect(out.failures[0]!.reason).toBe("EISDIR"); // the raw error, machine-readable
    expect(out.notes).toBe(2); // written, not attempted
    expect(JSON.stringify(out)).not.toMatch(/damaged|restore|backup/i);
  });

  /**
   * "0 of N items could be read" is a claim about the STORE, and it was printed
   * whenever nothing was WRITTEN — including the case where every item read
   * perfectly and the DESTINATION refused every file. Windows Controlled Folder
   * Access, an AV shield and a full disk all permit `mkdir` and deny file
   * creation, so this is the ordinary Windows shape of the failure: the user's
   * memory is completely intact and the footer sent them looking for damage in
   * it. `ExportFailure.phase` already carried the truth.
   */
  it("when every WRITE fails: the footer says WRITE, not 'could not be read'", async () => {
    const home = await seed("exp-write-phase", false);
    const dest = path.join(freshHome("exp-write-phase-out"), "export");

    // Controlled Folder Access in one preloaded module: deny file creation under
    // the destination, leave everything else (mkdir, every store read) working.
    const shim = path.join(freshHome("exp-write-phase-shim"), "deny-writes.mjs");
    mkdirSync(fsPath(path.dirname(shim)), { recursive: true });
    writeFileSync(
      fsPath(shim),
      [
        `import { promises as fsp } from "node:fs";`,
        `const deny = process.env.GESTALT_TEST_DENY_WRITES_UNDER;`,
        `const real = fsp.writeFile.bind(fsp);`,
        `fsp.writeFile = async (file, data, options) => {`,
        `  if (deny && String(file).includes(deny)) {`,
        `    const e = new Error("operation not permitted");`,
        `    e.code = "EPERM";`,
        `    throw e;`,
        `  }`,
        `  return real(file, data, options);`,
        `};`,
      ].join("\n"),
      "utf8",
    );

    const r = spawnCli(["export", "--plaintext", dest, "--home", home], {
      preload: shim,
      env: { GESTALT_TEST_DENY_WRITES_UNDER: path.basename(path.dirname(dest)) },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("EPERM"); // the underlying error, verbatim
    // The truth: the writes failed, and here is the folder they failed into.
    expect(r.stderr).toContain("could be written");
    expect(r.stderr).toContain(dest);
    // NOT a word about reading the store — nothing about it went wrong.
    expect(r.stderr).not.toContain("could be read");
    expect(r.stdout).not.toContain("Exported");
    expect(r.stderr).not.toMatch(/damaged|restore|backup/i);
  });

  /**
   * DEFECT — the success block was gated on `r.files.length > 0`, so an EMPTY
   * store printed ZERO bytes on stdout, zero on stderr, and exited 0:
   * indistinguishable from a no-op. That is the run someone makes to decide
   * whether the escape hatch is real BEFORE they trust it with anything.
   */
  it("an EMPTY store confirms the export and names the destination — exit 0, not silence", async () => {
    const home = await seed("exp-empty", false);
    for (const dir of [
      storePaths(home).topicsDir,
      storePaths(home).logsDir,
      storePaths(home).proposalsDir,
    ]) {
      for (const f of readdirSync(fsPath(dir))) {
        rmSync(fsPath(path.join(dir, f)), { force: true });
      }
    }

    const dest = path.join(freshHome("exp-empty-out"), "export");
    const r = spawnCli(["export", "--plaintext", dest, "--home", home]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Exported 0 notes + 0 logs + 0 suggested edits");
    expect(r.stdout).toContain(dest); // always confirm WHERE
    expect(r.stderr).toBe("");
    // The export completed, so the folder is the truth about the store.
    expect(existsSync(fsPath(path.join(dest, "topics")))).toBe(true);
  });

  it("refusing a non-empty destination exits non-zero with an actionable message", async () => {
    const home = await seed("exp-exit-notempty", false);
    const dest = path.join(freshHome("exp-exit-notempty-out"), "export");
    mkdirSync(fsPath(dest), { recursive: true });
    writeFileSync(fsPath(path.join(dest, "something.txt")), "x", "utf8");

    const r = spawnCli(["export", "--plaintext", dest, "--home", home]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/isn't empty/i);
    expect(r.stderr).toMatch(/fresh folder/i);
  });
});

describe("cat <id> — decode one note to stdout (E2b)", () => {
  it("decodes an encrypted note; the on-disk bytes are opaque", async () => {
    const home = await seed("cat-enc", true);
    const r = await catNote(home, "deal-notes");
    expect(r.text).toContain("id: deal-notes");
    expect(r.text).not.toContain("gestalt-enc:1:");
    expect(read(topicNotePath(home, "deal-notes")).startsWith("gestalt-enc:1:")).toBe(true);
  });

  it("prints a plaintext store's note verbatim", async () => {
    const home = await seed("cat-plain", false);
    expect((await catNote(home, "deal-notes")).text).toBe(read(topicNotePath(home, "deal-notes")));
  });

  it("fails closed with no key, and rejects unknown / traversal-shaped ids", async () => {
    const home = await seed("cat-nokey", true);
    clearActiveKey();
    await expectGestaltErrorAsync(() => catNote(home, "deal-notes"), "E_STORE_MODE");

    activateDek(unlockWithPassphrase(home, PASS));
    await expectGestaltErrorAsync(() => catNote(home, "no-such-topic"), "E_NOT_FOUND");
    await expectGestaltErrorAsync(() => catNote(home, "../../etc/passwd"), "E_INVALID_ID");
  });

  /**
   * FINDING 5 — `readText` collapsed EACCES/EBUSY/EISDIR to null, so a note that
   * plainly EXISTS but is momentarily unreadable (a Windows antivirus or indexer
   * holding it open is routine — store/atomic.ts already retries for exactly
   * this) was reported as `E_NOT_FOUND` "No topic <id>". Telling someone their
   * memory is gone when it is merely locked is the worst answer cat can give.
   */
  it("says UNREADABLE, not 'no topic', for a note that exists but cannot be read", async () => {
    const home = await seed("cat-unreadable", false);
    // Stand in for a locked file with one that cannot be read as a file at all:
    // the read fails with something other than ENOENT, which is the distinction.
    mkdirSync(fsPath(topicNotePath(home, "wedged")), { recursive: true });

    await expectGestaltErrorAsync(() => catNote(home, "wedged"), "E_IO");
    // The absent case must still answer E_NOT_FOUND — the two stay distinct.
    await expectGestaltErrorAsync(() => catNote(home, "not-here"), "E_NOT_FOUND");
  });
});

/**
 * GROK FINDING 1 (independent review, 2026-07-16) — the MODE GATE could dump
 * ciphertext as content, exit 0.
 *
 * On a PLAINTEXT-mode store (no keyring, no marker, no key), export copied
 * every file out byte-verbatim — which is §0.1's promise for the user's OWN
 * text, and a catastrophe for sealed bytes the mode gate could not see. The
 * gate (`storeHasSealedContent`) read file HEADS positively: whole-file magic
 * at offset 0, or a sealed-shaped FIRST log line. So the very masking the
 * positive-proof work was built for — a git conflict's `<<<<<<< HEAD` ahead of
 * the magic — hid a sealed note from the gate, and a union-merged sealed log
 * line behind a plaintext entry hid a log. Export then wrote the ciphertext
 * out AS THE USER'S CONTENT: green success, `failed: 0`, exit 0.
 *
 * Verified before fixing (real CLI, keyring-less fixtures): a conflict-wrapped
 * sealed note, a conflict-masked sealed log and a mixed log all exported
 * verbatim with exit 0. (A PURE sealed log did NOT reproduce — the gate's
 * first-line shape check already caught it.)
 *
 * The fix is layered, facts-only at both layers:
 *  - `storeHasSealedContent` now also sees CONFLICT-MASKED sealed content
 *    (line-start magic in a head that ALSO carries git conflict-marker lines —
 *    the masking case the finder exists for; a log head that reads sealed once
 *    git's marker lines are stepped over) — store-level refusal, before any
 *    write. Without conflict evidence a line-start magic is a plaintext file
 *    that merely mentions the format, and it must NOT lock the store out
 *    (that false positive shipped first and is pinned below).
 *  - `decodeForExport` refuses PER FILE, in plaintext mode, any file that
 *    visibly carries sealed material — the magic anywhere in a note/proposal,
 *    or a full sealed-shaped log line whose token is long enough to be this
 *    codec's sealed output (`SEALED_TOKEN_FLOOR`), in either entry position —
 *    as the observation it is: "matches the sealed format …" / "line N
 *    matches the sealed log-entry shape (token long enough to be sealed
 *    content) …". Everything else still exports byte-verbatim; hand edits are
 *    NOT parse-proofed, and a shape-matching one-liner with a sub-floor token
 *    (the canonized hand edit) is provably NOT sealed, in any position.
 */
describe("export --plaintext — a PLAINTEXT-mode store never exports sealed material (Grok finding 1)", () => {
  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  /** Genuinely sealed bytes from a real encrypted store; leaves the process
   * KEY-LESS, so the plaintext-mode fixture is measured exactly as a real
   * keyring-less store would be. */
  async function harvest(label: string): Promise<{ note: string; line: string }> {
    const home = await seed(label, true);
    const note = read(topicNotePath(home, "deal-notes"));
    const line = read(topicLogPath(home, "deal-notes"))
      .split("\n")
      .find((l) => /^\d{4}-/.test(l))!;
    clearActiveKey();
    expect(note.startsWith("gestalt-enc:1:")).toBe(true);
    expect(line).toBeTruthy();
    return { note, line };
  }

  it("a conflict-MASKED sealed note is SEEN by the gate — store-level refusal, nothing written", async () => {
    const { note } = await harvest("f1-mask-note-src");
    const home = await seed("f1-mask-note", false);
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      `<<<<<<< HEAD\n${note}=======\n${note}>>>>>>> origin/main\n`,
      "utf8",
    );

    // THE BUG's first half: the same masking that bit isPlaintextIn also blinded
    // the gate — the magic is no longer at offset 0, so this returned false and
    // export dumped the conflict markers + ciphertext verbatim, exit 0.
    expect(storeHasSealedContent(home)).toBe(true);

    const dest = path.join(freshHome("f1-mask-note-out"), "export");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_STORE_MODE");
    expect(existsSync(fsPath(dest))).toBe(false); // refused before any write
  });

  it("A2: a conflict-MASKED sealed note with a BOM/indent before the magic is still SEEN — BOM-hardened, uniformly with the unmasked finders", async () => {
    const { note } = await harvest("f1-mask-bom-src");
    const home = await seed("f1-mask-bom", false);
    // A git conflict pushes the sealed blob's magic to a LATER line start, and a
    // restore/copy/editor round-trip prepends a BOM (U+FEFF) right before it.
    // The old masked finder required a raw "\n" + magic, so the BOM hid the blob:
    // storeHasSealedContent returned FALSE and the CLI read a sealed store as
    // plaintext (export still refused via includes(magic), but the gate lied).
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      `<<<<<<< HEAD\n\uFEFF${note}=======\ndesktop plaintext wording\n>>>>>>> origin/main\n`,
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(true);
    // The same for a plain INDENT before the magic.
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      `<<<<<<< HEAD\n   ${note}=======\ndesktop plaintext wording\n>>>>>>> origin/main\n`,
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(true);
    // The critical INVERSE stays green: a documenting note (line-start magic,
    // NO conflict markers) is NOT a masked blob and must not lock the store out.
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      "a sealed file starts with a marker like this:\n\uFEFFgestalt-enc:1:eyJ2IjoxfQ.AAAA\n",
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(false);
  });

  it("a conflict-MASKED sealed LOG is seen by the gate too — no whole-file magic to find", async () => {
    const { line } = await harvest("f1-mask-log-src");
    const home = await seed("f1-mask-log", false);
    writeFileSync(
      fsPath(topicLogPath(home, "masked")),
      `<<<<<<< HEAD\n# masked log\n\n${line}\n=======\n# masked log\n>>>>>>> origin/main\n`,
      "utf8",
    );

    expect(storeHasSealedContent(home)).toBe(true);
    await expectGestaltErrorAsync(
      () => exportPlaintext(home, path.join(freshHome("f1-mask-log-out"), "export")),
      "E_STORE_MODE",
    );
  });

  it("sealed material PAST the head-limited gate still never exports — the per-file fact, and partial recovery", async () => {
    const { note, line } = await harvest("f1-deep-src");
    const home = await seed("f1-deep", false);
    // 700+ bytes of ordinary text ahead of the sealed blob: the gate's cheap
    // head sniff cannot see it, so the per-file decode contract is the last
    // line of defense — and it sees every byte.
    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(16);
    writeFileSync(fsPath(topicNotePath(home, "deep-note")), `${filler}\n${note}`, "utf8");
    // A REAL sealed line, so its token clears SEALED_TOKEN_FLOOR — sealed
    // content cannot be ruled out, in any position. (A full shape match with
    // a sub-floor token is provably NOT this codec's output and exports; that
    // side of the floor is pinned in its own tests below.)
    writeFileSync(
      fsPath(topicLogPath(home, "deep-log")),
      `# deep-log log\n\n${filler}\n${line}\n`,
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(false); // the gate genuinely cannot see these

    const dest = path.join(freshHome("f1-deep-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(2);
    const fn = r.failures.find((x) => x.rel === "topics/deep-note.md")!;
    expect(fn.message).toContain(
      'matches the sealed format (the "gestalt-enc:1:" marker), but this store has no key configured',
    );
    const fl = r.failures.find((x) => x.rel === "logs/deep-log.log.md")!;
    expect(fl.message).toContain(
      "line 4 matches the sealed log-entry shape (token long enough to be sealed content) and this store has no key configured",
    );
    // Refused, not copied: no ciphertext wears the user's filenames…
    expect(existsSync(fsPath(path.join(dest, "topics", "deep-note.md")))).toBe(false);
    expect(existsSync(fsPath(path.join(dest, "logs", "deep-log.log.md")))).toBe(false);
    // …or anyone else's.
    const token = line.slice(line.indexOf(" ") + 1);
    for (const rel of r.files) {
      const t = read(path.join(dest, rel));
      expect(t).not.toContain("gestalt-enc:1:");
      expect(t).not.toContain(token);
    }
    // Partial recovery holds, and the facts carry no verdict.
    expect(r.files).toContain("topics/deal-notes.md");
    expect(rendered(r)).not.toMatch(VERDICTS);
  });

  it("a sealed line union-merged in ABOVE any entry refuses per-file, with the line named", async () => {
    const { line } = await harvest("f1-mixed-src");
    const home = await seed("f1-mixed", false);
    // Line 1 header, 2 blank, 3 prose, 4 the sealed line — a real token, so
    // it clears the floor and cannot be ruled out. The gate is structurally
    // blind to this shape (the first content line is plaintext), at ANY
    // depth — the per-file contract is what catches it.
    writeFileSync(
      fsPath(topicLogPath(home, "mixed")),
      `# mixed log\n\nnotes from the cutover\n${line}\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain one\n`,
      "utf8",
    );

    const dest = path.join(freshHome("f1-mixed-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe("logs/mixed.log.md");
    expect(r.failures[0]!.message).toContain(
      "line 4 matches the sealed log-entry shape (token long enough to be sealed content) and this store has no key configured",
    );
    expect(existsSync(fsPath(path.join(dest, "logs", "mixed.log.md")))).toBe(false);
    expect(r.files).toContain("topics/deal-notes.md"); // the rest still exports
    expect(rendered(r)).not.toMatch(VERDICTS);
  });

  /**
   * FIX 3 (2026-07-16 verified round) — the other side of the line. The first
   * cut of the plaintext-store check refused EVERY sealed-shape match, so the
   * one-liner this suite canonises as "a real thing to type"
   * (`2026-07-14T09:30:00.000Z deployed`), typed INSIDE a real entry of a
   * hand-kept log, had the whole file refused — an over-refusal of exactly
   * the §0.1 hand edit a plaintext store exists to hand back byte-verbatim.
   * Its 8-char token is below `SEALED_TOKEN_FLOOR`, so it is provably NOT
   * this codec's output and the file exports whole. (The grammar-accounting
   * rule that briefly replaced the first cut got this case right for the
   * wrong reason — position — and reopened the in-entry ciphertext leak; the
   * floor keeps this canon AND the leak closed. Both positions are pinned in
   * the physics-not-position suite below.)
   */
  it("a hand-kept PLAINTEXT-store log with a bare sealed-shaped one-liner INSIDE an entry exports byte-verbatim", async () => {
    const home = await seed("f1-inentry", false);
    const handLog =
      "# hand-kept log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n" +
      "2026-07-14T09:30:00.000Z deployed\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), handLog, "utf8");

    const dest = path.join(freshHome("f1-inentry-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "logs", "hand-kept.log.md"))).toBe(handLog);
  });

  /**
   * FIX 1 (2026-07-16 verified round) — the store gate's masked-sealed finder
   * fired on ANY line-start `gestalt-enc:1:` in a file head, with none of the
   * conflict evidence its own docstring scopes it to. A plaintext store whose
   * note merely DOCUMENTS the sealed format with an example line was declared
   * encrypted, and with no keyring.json that locked the ENTIRE store out of
   * the CLI — every command exited 1 with "This store is encrypted but
   * keyring.json is missing". The magic at a line start counts only alongside
   * git conflict-marker lines (the masking case the finder exists for; the
   * conflict-masked tests above stay green — the critical inverse). The
   * documenting note itself falls through to the per-file contract, which
   * refuses that ONE file as the observation it is; the store works.
   */
  it("a plaintext store whose note DOCUMENTS the sealed format is not locked out — one file refused, the store works", async () => {
    const home = await seed("f1-docs-note", false);
    const docNote =
      '---\nid: format-docs\ntitle: "Format docs"\n---\n\n' +
      "A sealed file begins with a marker line like this one:\n" +
      "gestalt-enc:1:eyJ2IjoxfQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
    writeFileSync(fsPath(path.join(storePaths(home).topicsDir, "format-docs.md")), docNote, "utf8");

    // THE BUG: this returned true — and cli.ts then demanded a keyring that
    // never existed, on every command, for a store that is wholly plaintext.
    expect(storeHasSealedContent(home)).toBe(false);

    // The CLI is not locked out: a plain command works end to end.
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const env = { ...process.env };
    delete env.GESTALT_KEY;
    delete env.GESTALT_PASSPHRASE;
    const r1 = spawnSync(process.execPath, [TSX, CLI, "list", "--home", home], {
      encoding: "utf8",
      env,
    });
    expect(r1.status).toBe(0);
    expect(r1.stderr ?? "").not.toContain("keyring.json is missing");

    // Only the per-file behavior applies to that file (fix 3's wording): the
    // marker was SEEN, so that one file is withheld — everything else exports.
    const r = await exportPlaintext(home, path.join(freshHome("f1-docs-note-out"), "export"));
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe("topics/format-docs.md");
    expect(r.failures[0]!.message).toContain(
      'matches the sealed format (the "gestalt-enc:1:" marker), but this store has no key configured',
    );
    expect(r.files).toContain("topics/deal-notes.md");
    expect(rendered(r)).not.toMatch(VERDICTS);
  });

  it("A1: a plaintext store whose FIRST log line is the canonized sub-floor one-liner is NOT locked out — the gate applies export's floor", async () => {
    const home = await seed("a1-brick", false);
    // A hand-kept log (§0.1) whose FIRST content line is the canonized short
    // one-liner — an 8-char token, provably NOT this codec's sealed output. The
    // GATE had no floor, so `looksLikeEncryptedLog` read this as encrypted and,
    // keyring-less, cli.ts demanded a keyring that never existed, on EVERY
    // command: "This store is encrypted but keyring.json is missing", exit 1.
    writeFileSync(
      fsPath(topicLogPath(home, "deploys")),
      "# deploys log\n\n2026-07-14T09:30:00.000Z deployed\n",
      "utf8",
    );
    // The gate now agrees with export: a sub-floor token is not sealed.
    expect(storeHasSealedContent(home)).toBe(false);

    // The CLI is not bricked — a plain read command runs end to end, exit 0.
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const env = { ...process.env };
    delete env.GESTALT_KEY;
    delete env.GESTALT_PASSPHRASE;
    const r = spawnSync(process.execPath, [TSX, CLI, "list", "--home", home], {
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stderr ?? "").not.toContain("keyring.json is missing");
  });

  it("the INVERSE harm is not introduced: hand edits in a PLAINTEXT store still export byte-verbatim", async () => {
    const home = await seed("f1-hand", false);
    // Conflict markers around the user's OWN plaintext halves — both sides are
    // readable text the user can resolve; there is no ciphertext hazard, so
    // §0.1 wins and the bytes are copied as-is. No parse-proof runs.
    const conflictedPlain =
      "<<<<<<< HEAD\n---\nid: notes\ntitle: mine\n---\n\nlaptop wording\n=======\n---\nid: notes\ntitle: mine\n---\n\ndesktop wording\n>>>>>>> origin/main\n";
    writeFileSync(fsPath(topicNotePath(home, "notes")), conflictedPlain, "utf8");
    // A hand-kept log the store's parsers would refuse: prose above the first
    // entry, a malformed header, a timestamped SENTENCE (spaces — provably not
    // a sealed token). All of it is the user's own text.
    const handLog =
      "# hand-kept log\n\nnotes from the cutover\n### 2026-07-15T00:00:00.000Z | onlytwo\n2026-07-14T09:30:00.000Z we cut over the primary database this morning\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), handLog, "utf8");

    const dest = path.join(freshHome("f1-hand-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "topics", "notes.md"))).toBe(conflictedPlain);
    expect(read(path.join(dest, "logs", "hand-kept.log.md"))).toBe(handLog);
  });

  it("CLI, end to end: the masked store exits non-zero with the store-level fact; the mixed log exits non-zero with the per-file fact", async () => {
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
      const env = { ...process.env };
      delete env.GESTALT_KEY;
      delete env.GESTALT_PASSPHRASE;
      const r = spawnSync(process.execPath, [TSX, CLI, ...args], { encoding: "utf8", env });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    const { note, line } = await harvest("f1-cli-src");

    // The masked store: caught at the gate, before export even starts.
    const masked = await seed("f1-cli-masked", false);
    writeFileSync(
      fsPath(topicNotePath(masked, "deal-notes")),
      `<<<<<<< HEAD\n${note}=======\n${note}>>>>>>> origin/main\n`,
      "utf8",
    );
    const dest1 = path.join(freshHome("f1-cli-masked-out"), "export");
    const r1 = run(["export", "--plaintext", dest1, "--home", masked]);
    expect(r1.status).not.toBe(0); // was: exit 0, "Exported 2 notes + 3 logs…"
    expect(r1.stderr).toContain("encrypted"); // the store-level fact
    expect(r1.stderr).not.toMatch(VERDICTS);
    expect(existsSync(fsPath(dest1))).toBe(false);

    // The mixed log: gate-blind by shape (plaintext first content line), the
    // sealed line OUTSIDE any entry — refused per file, partial recovery.
    const mixed = await seed("f1-cli-mixed", false);
    writeFileSync(
      fsPath(topicLogPath(mixed, "mixed")),
      `# mixed log\n\nnotes from the cutover\n${line}\n\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain one\n`,
      "utf8",
    );
    const dest2 = path.join(freshHome("f1-cli-mixed-out"), "export");
    const r2 = run(["export", "--plaintext", dest2, "--home", mixed]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("MISSING from this export");
    expect(r2.stderr).toContain("matches the sealed log-entry shape");
    expect(r2.stderr).not.toMatch(VERDICTS);
    expect(existsSync(fsPath(path.join(dest2, "logs", "mixed.log.md")))).toBe(false);
    expect(existsSync(fsPath(path.join(dest2, "topics", "deal-notes.md")))).toBe(true);
    expect(read(path.join(dest2, "topics", "deal-notes.md"))).not.toContain("gestalt-enc:1:");
  });
});

/**
 * THE REOPENED LEAK (2026-07-16, verified 2/3 with a real git-merge-file
 * repro) — the verified-round rewrite traded one wrong rule for another. Its
 * grammar accounting waved through EVERY sealed-shape match inside a parsed
 * entry as "body text", and a union merge's DEFAULT order lands the sealed
 * side exactly there: base = the shared plaintext-era history, one machine
 * appends plaintext (still on an old build), the other appends SEALED (it
 * migrated) — `git merge-file --union` puts the sealed line directly after a
 * plaintext entry in BOTH merge orders. Real ciphertext then exported
 * byte-verbatim from a keyring-less store: exit 0, `failed: 0`, raw base64url
 * wearing the log's filename. The parent commit had pinned exactly this shape
 * as a refusal; the rewrite replaced that pin instead of keeping BOTH
 * positions.
 *
 * The one sound middle is PHYSICS, not position. This codec's sealed line is
 * `<ts> base64url(nonce24 ‖ ct‖tag16)` — even a zero-length plaintext seals
 * to 40 bytes = 54 unpadded base64url chars (`SEALED_TOKEN_FLOOR`, pinned
 * against the real codec below). In a plaintext-mode log, in BOTH entry
 * positions: a full shape match with a sub-floor token is provably NOT this
 * codec's output ⇒ the user's own text ⇒ exports byte-verbatim; a match at or
 * above the floor cannot be ruled out without a key ⇒ the per-file factual
 * refusal. The floor only ever asserts NOT-sealed — asserting sealed from
 * length is the deleted `proveLog` misuse (rounds 4–7), and it stays deleted.
 */
describe("export --plaintext — the plaintext-store log rule is physics, not position", () => {
  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  /** A genuinely sealed log line from a real encrypted store; leaves the
   * process KEY-LESS, so the plaintext-mode fixture is measured exactly as a
   * real keyring-less store would be. */
  async function harvestLine(label: string): Promise<string> {
    const home = await seed(label, true);
    const line = read(topicLogPath(home, "deal-notes"))
      .split("\n")
      .find((l) => /^\d{4}-/.test(l))!;
    clearActiveKey();
    expect(line).toBeTruthy();
    return line;
  }

  // The product's own migration flow, as git mechanics: BASE is the shared
  // plaintext-era history; one side appends a plaintext entry, the other a
  // sealed line; `merge=union` concatenates the two appends.
  const BASE =
    "# deploys log\n\n### 2026-07-14T00:00:00.000Z | decision | acme | eric\nshared history\n";
  const PLAIN_APPEND =
    BASE + "\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain append\n";

  /** `git merge-file --union -p ours base theirs`, or null if git is absent. */
  function gitUnion(dir: string, ours: string, base: string, theirs: string): string | null {
    mkdirSync(fsPath(dir), { recursive: true });
    const w = (name: string, text: string): string => {
      const p = path.join(dir, name);
      writeFileSync(fsPath(p), text, "utf8");
      return fsPath(p);
    };
    const r = spawnSync(
      "git",
      ["merge-file", "--union", "-p", w("ours.md", ours), w("base.md", base), w("theirs.md", theirs)],
      { encoding: "utf8" },
    );
    if (r.error || r.status !== 0 || !r.stdout) return null;
    return r.stdout;
  }

  it("REAL ciphertext union-merged AFTER a plaintext entry is refused — BOTH merge orders, no ciphertext in any exported file", async () => {
    const line = await harvestLine("leak-union-src");
    const token = line.slice(line.indexOf(" ") + 1);
    expect(token.length).toBeGreaterThanOrEqual(SEALED_TOKEN_FLOOR); // the real thing clears the floor
    const sealedAppend = BASE + `${line}\n`;

    // Union output is ours-then-theirs per hunk, so the two orders place the
    // sealed line after the PLAIN APPEND or after the SHARED HISTORY — inside
    // a parsed entry either way, which is exactly what the grammar-accounting
    // rule waved through. Where git exists, prove the fixtures ARE its output.
    const handA = PLAIN_APPEND + `${line}\n`;
    const handB =
      sealedAppend + "\n### 2026-07-15T00:00:00.000Z | decision | acme | eric\nplain append\n";
    const scratch = freshHome("leak-union-git");
    const gitA = gitUnion(path.join(scratch, "a"), PLAIN_APPEND, BASE, sealedAppend);
    const gitB = gitUnion(path.join(scratch, "b"), sealedAppend, BASE, PLAIN_APPEND);
    if (gitA !== null) expect(gitA).toBe(handA);
    if (gitB !== null) expect(gitB).toBe(handB);

    for (const [label, merged] of [
      ["after-plain-append", gitA ?? handA],
      ["after-shared-history", gitB ?? handB],
    ] as const) {
      const home = await seed(`leak-union-${label}`, false);
      writeFileSync(fsPath(topicLogPath(home, "deploys")), merged, "utf8");
      // The head's first content line is a plaintext header in both orders —
      // the store gate is blind; the per-file contract is the only defense.
      expect(storeHasSealedContent(home)).toBe(false);

      const dest = path.join(freshHome(`leak-union-${label}-out`), "export");
      const r = await exportPlaintext(home, dest);

      // THE REOPENED BUG: this exported verbatim — exit 0, failed: 0, the raw
      // token wearing logs/deploys.log.md. Refused per file, the line named.
      expect(r.failed).toBe(1);
      const f = r.failures[0]!;
      expect(f.rel).toBe("logs/deploys.log.md");
      const at = merged.split("\n").indexOf(line) + 1;
      expect(f.message).toContain(
        `line ${at} matches the sealed log-entry shape (token long enough to be sealed content) and this store has no key configured`,
      );
      // Ciphertext in NO exported file…
      expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
      for (const rel of r.files) expect(read(path.join(dest, rel))).not.toContain(token);
      // …healthy files exported, and no verdict anywhere.
      expect(r.files).toContain("topics/deal-notes.md");
      expect(r.files).toContain("logs/deal-notes.log.md");
      expect(rendered(r)).not.toMatch(VERDICTS);
    }
  });

  it("CLI, end to end: the union-merged leak exits 1, names the line, and the healthy files are written", async () => {
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const line = await harvestLine("leak-cli-src");
    const token = line.slice(line.indexOf(" ") + 1);

    const home = await seed("leak-cli", false);
    writeFileSync(fsPath(topicLogPath(home, "deploys")), PLAIN_APPEND + `${line}\n`, "utf8");

    const env = { ...process.env };
    delete env.GESTALT_KEY;
    delete env.GESTALT_PASSPHRASE;
    const dest = path.join(freshHome("leak-cli-out"), "export");
    const r = spawnSync(
      process.execPath,
      [TSX, CLI, "export", "--plaintext", dest, "--home", home],
      { encoding: "utf8", env },
    );

    expect(r.status).toBe(1); // was: exit 0 with the token in the export
    expect(r.stderr ?? "").toContain(
      "matches the sealed log-entry shape (token long enough to be sealed content)",
    );
    expect(r.stderr ?? "").not.toMatch(VERDICTS);
    expect(existsSync(fsPath(path.join(dest, "logs", "deploys.log.md")))).toBe(false);
    // Healthy files land; the token lands nowhere.
    expect(read(path.join(dest, "topics", "deal-notes.md"))).toContain("id: deal-notes");
    expect(read(path.join(dest, "logs", "deal-notes.log.md"))).not.toContain(token);
  });

  it("the canonized short one-liner exports byte-verbatim in BOTH positions — in-entry AND above the first entry", async () => {
    const home = await seed("floor-short-both", false);
    const inEntry =
      "# hand-kept log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n" +
      "2026-07-14T09:30:00.000Z deployed\n";
    // ABOVE the first entry — the DELIBERATE relaxation: the position rule
    // refused this exact §0.1 hand edit, and the 8-char token is provably not
    // this codec's output, so it now exports. (The prose line above it is the
    // hand note; it also keeps the file out of the store gate's head sniff,
    // whose prefix-shape question is a separate, unchanged concern.)
    const preEntry =
      "# hand-kept log\n\n" +
      "notes from the cutover\n" +
      "2026-07-14T09:30:00.000Z deployed\n" +
      "\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "cutover notes\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-in-entry")), inEntry, "utf8");
    writeFileSync(fsPath(topicLogPath(home, "hand-pre-entry")), preEntry, "utf8");

    const dest = path.join(freshHome("floor-short-both-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "logs", "hand-in-entry.log.md"))).toBe(inEntry);
    expect(read(path.join(dest, "logs", "hand-pre-entry.log.md"))).toBe(preEntry);
  });

  it("SEALED_TOKEN_FLOOR is the real codec's minimum — an EMPTY payload still seals to a floor-length token", () => {
    activateDek(new Uint8Array(32).fill(7));
    try {
      // The two smallest payloads a sealer can be asked for. Both codecs share
      // one seal frame — base64url(nonce ‖ ciphertext‖tag) — and the log
      // encoder cannot seal an empty block (it requires the `### <ts> |`
      // header), so the whole-file sealer probes the frame's true minimum.
      const tokens = ["", "x"].map((payload) =>
        encryptFile("topics/floor-probe.md", payload).trim().slice("gestalt-enc:1:".length),
      );
      for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(SEALED_TOKEN_FLOOR);
      // PINNED, not just bounded: the empty payload IS the floor. If the codec
      // ever changes nonce or tag size this fails loudly, and the constant must
      // be RE-DERIVED from the codec — never hand-adjusted to green the test.
      expect(Math.min(...tokens.map((t) => t.length))).toBe(SEALED_TOKEN_FLOOR);
      // …and a real minimal sealed LOG line is a full shape match that clears it.
      const sealed = encodeLogEntry("t", "### 2026-07-15T00:00:00.000Z | d | p | a\ns");
      expect(ENCRYPTED_LINE_RE.test(sealed)).toBe(true);
      expect(sealed.slice(sealed.indexOf(" ") + 1).length).toBeGreaterThanOrEqual(
        SEALED_TOKEN_FLOOR,
      );
    } finally {
      clearActiveKey();
    }
  });
});

/**
 * THE MISPLACED BLOB (2026-07-16, verified MEDIUM) — a WHOLE-FILE sealed blob
 * (`gestalt-enc:1:` magic) that lands AT a log path exported byte-verbatim
 * from a keyring-less plaintext store. Realistic trigger: a restore/copy
 * mishap — the codec itself never writes the magic under `logs/` (logs are
 * per-entry), which is exactly why BOTH layers were blind to it there:
 *
 *  - the per-file contract's log branch tested only the sealed LINE shape
 *    (`ENCRYPTED_LINE_RE` + `SEALED_TOKEN_FLOOR`) and never the magic, so the
 *    blob rode the verbatim copy out as the user's log — exit 0, `failed: 0`;
 *  - the store gate's magic scans (`findWholeFileSealed`, `findMaskedSealed`)
 *    covered home/topics/proposals but not logsDir, so even a HEAD-VISIBLE
 *    blob at a log path never tripped the store-level refusal.
 *
 * The fix mirrors what already exists for notes, at both layers: the gate's
 * magic scans now cover logsDir (same head-read pattern, same conflict gating
 * for the masked variant), and the log branch refuses a line-START magic —
 * offset 0 or right after a newline, exactly where the codec writes it — with
 * the SAME marker wording the note/proposal branch uses. A mid-line mention
 * in prose is the user's own text and still exports; the floor and line-shape
 * rules are untouched.
 */
describe("export --plaintext — a whole-file sealed blob at a LOG path never exports (misplaced-blob fix)", () => {
  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;
  /** Every string a human could read out of a result, rendered. */
  const rendered = (r: Awaited<ReturnType<typeof exportPlaintext>>): string =>
    [...r.failures.map((f) => f.message), ...r.warnings.map((w) => w.message)].join("\n");

  /** A genuinely sealed whole-file blob from a real encrypted store; leaves
   * the process KEY-LESS, so the plaintext-mode fixture is measured exactly
   * as a real keyring-less store would be. */
  async function harvestBlob(label: string): Promise<string> {
    const home = await seed(label, true);
    const note = read(topicNotePath(home, "deal-notes"));
    clearActiveKey();
    expect(note.startsWith("gestalt-enc:1:")).toBe(true);
    return note;
  }

  it("HEAD-VISIBLE at a log path: the store gate sees it — store-level refusal, nothing written", async () => {
    const note = await harvestBlob("blob-log-gate-src");
    const home = await seed("blob-log-gate", false);
    writeFileSync(fsPath(topicLogPath(home, "misplaced")), note, "utf8");

    // THE BUG's gate half: findWholeFileSealed scanned home/topics/proposals
    // but never logs, and a blob's head is no encrypted-log SHAPE — so this
    // returned false and export byte-copied the ciphertext out, exit 0.
    expect(storeHasSealedContent(home)).toBe(true);

    const dest = path.join(freshHome("blob-log-gate-out"), "export");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_STORE_MODE");
    expect(existsSync(fsPath(dest))).toBe(false); // refused before any write
  });

  it("conflict-MASKED at a log path: the gate sees that too — same conflict gating as a note's blob", async () => {
    const note = await harvestBlob("blob-log-mask-src");
    const home = await seed("blob-log-mask", false);
    writeFileSync(
      fsPath(topicLogPath(home, "masked-blob")),
      `<<<<<<< HEAD\n${note}=======\n# masked-blob log\n>>>>>>> origin/main\n`,
      "utf8",
    );

    expect(storeHasSealedContent(home)).toBe(true);
    await expectGestaltErrorAsync(
      () => exportPlaintext(home, path.join(freshHome("blob-log-mask-out"), "export")),
      "E_STORE_MODE",
    );
  });

  it("DEEP at a log path — past the 512-byte head, behind plaintext lines: per-file refusal, the bytes in NO exported file", async () => {
    const note = await harvestBlob("blob-log-deep-src");
    const home = await seed("blob-log-deep", false);
    // 700+ bytes of ordinary text ahead of the blob: the gate's cheap head
    // sniff cannot see it — the per-file decode contract is the last line of
    // defense, and it sees every byte.
    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(16);
    writeFileSync(
      fsPath(topicLogPath(home, "deep-blob")),
      `# deep-blob log\n\n${filler}\n${note}`,
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(false); // the gate genuinely cannot see it

    const dest = path.join(freshHome("blob-log-deep-out"), "export");
    const r = await exportPlaintext(home, dest);

    // THE BUG's per-file half: the log branch tested only the sealed LINE
    // shape, never the magic — this exported verbatim, failed: 0.
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe("logs/deep-blob.log.md");
    // The marker wording — the same observation the note/proposal branch states.
    expect(r.failures[0]!.message).toContain(
      'matches the sealed format (the "gestalt-enc:1:" marker), but this store has no key configured',
    );
    // Refused, not copied: the blob's bytes wear no filename in this export…
    expect(existsSync(fsPath(path.join(dest, "logs", "deep-blob.log.md")))).toBe(false);
    const token = note.trim().slice("gestalt-enc:1:".length);
    for (const rel of r.files) {
      const t = read(path.join(dest, rel));
      expect(t).not.toContain("gestalt-enc:1:");
      expect(t).not.toContain(token);
    }
    // …the rest still exports, and the facts carry no verdict.
    expect(r.files).toContain("topics/deal-notes.md");
    expect(r.files).toContain("logs/deal-notes.log.md");
    expect(rendered(r)).not.toMatch(VERDICTS);
  });

  it("UNREGRESSED: a hand-kept log mentioning gestalt-enc:1: MID-LINE (plus the canonized one-liner) exports byte-verbatim", async () => {
    const home = await seed("blob-log-hand", false);
    // Prose that MENTIONS the magic mid-line is the user's own text — only a
    // line-START magic (where the codec writes it) is the blob's evidence.
    // The canonized sub-floor one-liner stays exactly as exportable as before.
    const handLog =
      "# hand-kept log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "sealed files start with gestalt-enc:1: — never split one by hand\n" +
      "2026-07-14T09:30:00.000Z deployed\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), handLog, "utf8");
    expect(storeHasSealedContent(home)).toBe(false); // the mid-line mention trips no gate

    const dest = path.join(freshHome("blob-log-hand-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "logs", "hand-kept.log.md"))).toBe(handLog);
  });

  /**
   * THE BOM/WHITESPACE BYPASS (2026-07-16, verified MEDIUM) — the magic test
   * was `startsWith(gestalt-enc:1:)` UNtrimmed at both layers (the per-file log
   * branch and the gate's head scan). A leading BOM (U+FEFF) or indentation on
   * the blob's first line — a restore/copy/editor round-trip — bypassed both,
   * and the ciphertext exported byte-verbatim, exit 0, `failed: 0`. The
   * detection now strips a leading BOM/indent (`stripLeadingBomWs`) BEFORE the
   * magic test, at both layers; the strip is for DETECTION only — a genuinely
   * plaintext line is still byte-verbatim in the output.
   */
  it("BOM-prefixed blob at a log path: the gate strips the BOM and SEES it — refused, nothing written", async () => {
    const note = await harvestBlob("blob-log-bom-src");
    const home = await seed("blob-log-bom", false);
    // A leading BOM on the blob's first line: `readHead(p).startsWith(magic)`
    // was false, so the gate read the store as plaintext and the ciphertext
    // rode the verbatim copy out.
    writeFileSync(fsPath(topicLogPath(home, "bom-blob")), "\uFEFF" + note, "utf8");

    expect(storeHasSealedContent(home)).toBe(true);
    const dest = path.join(freshHome("blob-log-bom-out"), "export");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_STORE_MODE");
    expect(existsSync(fsPath(dest))).toBe(false); // refused before any write
  });

  it("whitespace-INDENTED blob at a log path: the gate strips the indent and SEES it — refused, nothing written", async () => {
    const note = await harvestBlob("blob-log-indent-src");
    const home = await seed("blob-log-indent", false);
    writeFileSync(fsPath(topicLogPath(home, "indent-blob")), "   " + note, "utf8");

    expect(storeHasSealedContent(home)).toBe(true);
    const dest = path.join(freshHome("blob-log-indent-out"), "export");
    await expectGestaltErrorAsync(() => exportPlaintext(home, dest), "E_STORE_MODE");
    expect(existsSync(fsPath(dest))).toBe(false);
  });

  it("BOM-prefixed blob DEEP at a log path (past the gate's head): the per-file contract strips the BOM and refuses — bytes in NO exported file", async () => {
    const note = await harvestBlob("blob-log-bomdeep-src");
    const home = await seed("blob-log-bomdeep", false);
    // Past the 512-byte head so the gate is blind, AND a BOM on the blob's
    // line: the per-file log branch's magic test is the only defense, and it
    // must strip the BOM too.
    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(16);
    writeFileSync(
      fsPath(topicLogPath(home, "deep-bom-blob")),
      `# deep-bom-blob log\n\n${filler}\n\uFEFF${note}`,
      "utf8",
    );
    expect(storeHasSealedContent(home)).toBe(false); // deep: the gate cannot see it

    const dest = path.join(freshHome("blob-log-bomdeep-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(1);
    expect(r.failures[0]!.rel).toBe("logs/deep-bom-blob.log.md");
    expect(r.failures[0]!.message).toContain(
      'matches the sealed format (the "gestalt-enc:1:" marker), but this store has no key configured',
    );
    expect(existsSync(fsPath(path.join(dest, "logs", "deep-bom-blob.log.md")))).toBe(false);
    const token = note.trim().slice("gestalt-enc:1:".length);
    for (const rel of r.files) {
      const t = read(path.join(dest, rel));
      expect(t).not.toContain("gestalt-enc:1:");
      expect(t).not.toContain(token);
    }
    expect(rendered(r)).not.toMatch(VERDICTS);
  });

  it("UNREGRESSED: an INDENTED hand-kept log line that MENTIONS the magic mid-line still exports byte-verbatim — the strip is detection-only", async () => {
    const home = await seed("blob-log-indent-prose", false);
    // Indented prose whose content, once the indent is stripped, does NOT start
    // with the magic — the strip must not turn a mid-line mention into evidence.
    const handLog =
      "# hand-kept log\n\n" +
      "### 2026-07-15T00:00:00.000Z | decision | acme | eric\n" +
      "    a sealed file uses the gestalt-enc:1: prefix — do not hand-split it\n" +
      "2026-07-14T09:30:00.000Z deployed\n";
    writeFileSync(fsPath(topicLogPath(home, "hand-kept")), handLog, "utf8");
    expect(storeHasSealedContent(home)).toBe(false);

    const dest = path.join(freshHome("blob-log-indent-prose-out"), "export");
    const r = await exportPlaintext(home, dest);

    expect(r.failed).toBe(0);
    expect(read(path.join(dest, "logs", "hand-kept.log.md"))).toBe(handLog);
  });

  it("CLI, end to end: a wrong GESTALT_KEY on a store with a misplaced log-path blob makes `status` exit non-zero — the fail-closed verify gate", async () => {
    const note = await harvestBlob("blob-log-status-src");
    const home = await seed("blob-log-status", false);
    writeFileSync(fsPath(topicLogPath(home, "misplaced")), note, "utf8");

    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const env = { ...process.env };
    delete env.GESTALT_PASSPHRASE;
    env.GESTALT_KEY = "00".repeat(32); // a valid 64-hex key that is not this store's
    const r = spawnSync(process.execPath, [TSX, CLI, "status", "--home", home], {
      encoding: "utf8",
      env,
    });
    // Pre-fix: the identity-pass "verified" the wrong key and status ran, exit 0.
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/does not open|encrypted/i);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/wrong key|tampered|relocated|damaged|restore|backup/i);
  });
});

/**
 * GROK FINDING 2 (independent review, 2026-07-16) — `cat` never adopted the
 * decode contract.
 *
 * `catNote` called the codec's `decryptFile` directly, so the sibling command
 * still spoke every sentence export spent nine rounds deleting: a RENAMED
 * sealed note (the aad binds the basename; §0.1 sanctions the rename) drew
 * "wrong key or tampered data" with the hint "…or restore the file from
 * backup" — the literal banned instruction, in plain output AND `--json`; a
 * git-CONFLICTED sealed note was misreported as "found plaintext"; and a
 * plaintext note in an encrypted store was REFUSED while export exported it —
 * the two ownership commands contradicting each other on the same file.
 *
 * `cat` now reads through `decodeForExport` — the one contract — and the codec
 * hint that carried "restore the file from backup" (reachable from other
 * layers too) is rewritten cause-free.
 */
describe("cat <id> — speaks the decode contract, exactly like export (Grok finding 2)", () => {
  const VERDICTS = /wrong key|tampered|relocated|key is set|damaged|restore|backup/i;

  it("a RENAMED sealed note gets export's fact — the codec's verdict and its hint surface nowhere, --json included", async () => {
    const home = await seed("f2-renamed", true);
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(fsPath(topicNotePath(home, "meeting-notes")), sealed, "utf8");

    const err = await expectGestaltErrorAsync(() => catNote(home, "meeting-notes"), "E_SCHEMA");
    // Export's fact, re-anchored to cat's subject — identical observations.
    expect(err.message).toBe(
      'Topic "meeting-notes" could not be printed — neither parses as a note nor opens with the active key.',
    );
    // Was: "Could not decrypt meeting-notes.md — wrong key or tampered data."
    // with the hint "…or restore the file from backup." — message, hint and the
    // full --json payload must all be free of it.
    expect(`${err.message} ${err.hint}`).not.toMatch(VERDICTS);
    expect(JSON.stringify(err.toJSON())).not.toMatch(VERDICTS);
  });

  it("a git-CONFLICTED sealed note names the conflict — never 'found plaintext'", async () => {
    const home = await seed("f2-conflicted", true);
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(
      fsPath(topicNotePath(home, "conflicted")),
      `<<<<<<< HEAD\n${sealed}=======\n${sealed}>>>>>>> origin/main\n`,
      "utf8",
    );

    const err = await expectGestaltErrorAsync(() => catNote(home, "conflicted"), "E_SCHEMA");
    expect(err.message).toContain("contains git conflict markers");
    // Was: "Expected encrypted content in conflicted.md but found plaintext." —
    // a false statement about bytes that are demonstrably ciphertext.
    expect(err.message).not.toMatch(/found plaintext/i);
    expect(`${err.message} ${err.hint}`).not.toMatch(VERDICTS);
  });

  it("a PLAINTEXT note in an ENCRYPTED store PRINTS — cat and export give the same answer to the same file", async () => {
    const home = await seed("f2-plain-in-enc", true);
    const plain = '---\nid: hand-written\ntitle: "Hand written"\n---\n\nmy own bytes\n';
    writeFileSync(fsPath(path.join(storePaths(home).topicsDir, "hand-written.md")), plain, "utf8");

    // Was: cat refused this file ("found plaintext") while export exported it —
    // the two ownership commands contradicting each other.
    expect((await catNote(home, "hand-written")).text).toBe(plain);
    const r = await exportPlaintext(home, path.join(freshHome("f2-plain-in-enc-out"), "export"));
    expect(r.files).toContain("topics/hand-written.md");
    expect(read(path.join(r.dest, "topics", "hand-written.md"))).toBe(plain);
  });

  it("a sealed note in a PLAINTEXT-mode store states the no-key fact — never ciphertext on stdout", async () => {
    const home = await seed("f2-nokey-lib", false);
    const src = await seed("f2-nokey-src", true);
    const sealed = read(topicNotePath(src, "deal-notes"));
    clearActiveKey();
    writeFileSync(
      fsPath(topicNotePath(home, "deal-notes")),
      `<<<<<<< HEAD\n${sealed}=======\n${sealed}>>>>>>> origin/main\n`,
      "utf8",
    );

    // The library-level answer (the CLI gate intercepts head-visible cases
    // upstream): the same per-file fact export states, and no ciphertext.
    const err = await expectGestaltErrorAsync(() => catNote(home, "deal-notes"), "E_STORE_MODE");
    expect(err.message).toContain('matches the sealed format (the "gestalt-enc:1:" marker)');
    expect(err.message).toContain("but this store has no key configured");
    expect(`${err.message} ${err.hint}`).not.toMatch(VERDICTS);
  });

  /**
   * FIX 2 (2026-07-16 verified round) — the contract's hint ends in "then
   * re-run: fimemory export --plaintext …", and cat passed it through verbatim:
   * wrong advice inside a different command. Cat re-anchors the hint the same
   * way it re-anchors the message — the retry it names is cat, on the file cat
   * was asked about.
   */
  it("cat's hint names cat and the file — never 'fimemory export'", async () => {
    const home = await seed("f2-hint", true);
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(fsPath(topicNotePath(home, "meeting-notes")), sealed, "utf8");

    const err = await expectGestaltErrorAsync(() => catNote(home, "meeting-notes"), "E_SCHEMA");
    expect(err.hint).not.toContain("fimemory export");
    expect(err.hint).toContain("gestalt cat meeting-notes");
    expect(err.hint).toContain("meeting-notes.md"); // names the actual file to open
  });

  it("CLI, end to end: cat's rendered output — plain AND --json — carries no banned word", async () => {
    const TSX = tsxEntry();
    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const home = await seed("f2-cli", true);
    const sealed = read(topicNotePath(home, "deal-notes"));
    writeFileSync(fsPath(topicNotePath(home, "meeting-notes")), sealed, "utf8");
    clearActiveKey();

    const run = (args: string[]): { status: number; stdout: string; stderr: string } => {
      const env: NodeJS.ProcessEnv = { ...process.env, GESTALT_PASSPHRASE: PASS };
      delete env.GESTALT_KEY;
      const r = spawnSync(process.execPath, [TSX, CLI, ...args], { encoding: "utf8", env });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    const plain = run(["cat", "meeting-notes", "--home", home]);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain("neither parses as a note nor opens with the active key");
    expect(plain.stderr + plain.stdout).not.toMatch(VERDICTS);

    const json = run(["cat", "meeting-notes", "--home", home, "--json"]);
    expect(json.status).toBe(1);
    expect(json.stderr + json.stdout).not.toMatch(VERDICTS); // the hint rides --json too

    // The healthy note still prints — the contract did not blunt the command.
    const ok = run(["cat", "deal-notes", "--home", home]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("id: deal-notes");
    expect(ok.stdout).not.toContain("gestalt-enc:1:");
  });

  it("the codec's own hint (reachable from layers export/cat no longer surface) is cause-free — no 'restore', no 'backup'", () => {
    // Seal under one key, open under another: the codec's E_STORE_MODE fires.
    activateDek(new Uint8Array(32).fill(1));
    const sealed = encryptFile("topics/x.md", "hello");
    clearActiveKey();
    activateDek(new Uint8Array(32).fill(2));
    try {
      decryptFile("topics/x.md", sealed);
      throw new Error("expected decryptFile to throw");
    } catch (err) {
      const e = err as GestaltError;
      expect(e).toBeInstanceOf(GestaltError);
      // The codec may state what failed (its message is the store layer's);
      // its HINT may not instruct the user to destroy anything. It keeps the
      // GESTALT_KEY pointer and loses "restore the file from backup".
      expect(e.hint).toContain("GESTALT_KEY");
      expect(e.hint).not.toMatch(/restore|backup|damaged/i);
    } finally {
      clearActiveKey();
    }
  });
});
