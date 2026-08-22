/**
 * Rename contention under many readers (2026-07-28, found by dogfooding).
 *
 * The product's premise is that several AI tools share ONE store. On Windows a
 * rename over a file another process holds open fails with EPERM, and Node
 * opens files for reading without FILE_SHARE_DELETE, so every concurrent
 * reader is a chance for a write to lose the race. With ten MCP servers on one
 * store the old 3 x 50 ms budget lost often enough to break the cockpit's
 * Mark reviewed button with a hard E_LOCKED.
 *
 * These tests pin the two properties that matter: a write survives a transient
 * holder, and a permanent holder still fails loudly (never hangs, never
 * silently drops the write).
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileAtomicPlain } from "../src/store/atomic.js";
import { GestaltError } from "../src/errors.js";

function freshFile(name = "target.md"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "atomic-contention-"));
  const file = path.join(dir, name);
  writeFileSync(file, "original\n", "utf8");
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("atomic write under rename contention", () => {
  it("survives a holder that lets go after a few attempts (the many-readers case)", async () => {
    const file = freshFile();
    const real = fsp.rename.bind(fsp);
    let attempts = 0;
    // Fail the first four renames the way Windows does with a reader holding
    // the target, then let it through — the shape of a transient overlap.
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (attempts <= 4) {
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(from, to);
    });

    await writeFileAtomicPlain(file, "written through contention\n");

    expect(attempts).toBeGreaterThan(4);
    expect(readFileSync(file, "utf8")).toBe("written through contention\n");
  });

  it("still fails loudly when the holder never lets go (never hangs, never silently drops)", async () => {
    const file = freshFile();
    let attempts = 0;
    vi.spyOn(fsp, "rename").mockImplementation(async () => {
      attempts += 1;
      const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });

    const started = Date.now();
    await expect(writeFileAtomicPlain(file, "never lands\n")).rejects.toBeInstanceOf(GestaltError);
    const elapsed = Date.now() - started;

    // Deadline-based wait (~30 s): retried many times, still bounded so a stuck
    // store reports rather than wedging the caller forever.
    expect(attempts).toBeGreaterThanOrEqual(10);
    expect(elapsed).toBeGreaterThanOrEqual(25_000);
    expect(elapsed).toBeLessThan(45_000);
    // The original content is untouched: a failed write is never a lost file.
    expect(readFileSync(file, "utf8")).toBe("original\n");
  }, 50_000);

  it("names the real cause so a user can act on it", async () => {
    const file = freshFile();
    vi.spyOn(fsp, "rename").mockImplementation(async () => {
      const e = new Error("EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    const err = await writeFileAtomicPlain(file, "x\n").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GestaltError);
    const g = err as GestaltError;
    expect(g.code).toBe("E_LOCKED");
    // Points at the actual common cause (a second tool on the same store),
    // not just the antivirus guess the old copy led with.
    expect(`${g.message} ${g.hint ?? ""}`.toLowerCase()).toContain("store");
  }, 50_000);

  it("a READ-ONLY target fails immediately, and is not diagnosed as a peer reader", async () => {
    // `attrib +R` on Windows makes rename fail EPERM permanently. Treating that
    // as contention meant a silent 30-second hang per file — up to 2.5 minutes
    // across the five-host install-rules sweep — then "another program is
    // holding the file open", which sends the user chasing nothing.
    const file = freshFile("readonly.md");
    // A REAL read-only file: on Windows this is FILE_ATTRIBUTE_READONLY, which
    // is what `attrib +R` sets. Rename is mocked to EPERM so the test is
    // deterministic on POSIX too, where rename over a read-only file succeeds.
    chmodSync(file, 0o444);
    let attempts = 0;
    vi.spyOn(fsp, "rename").mockImplementation(async () => {
      attempts += 1;
      const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });

    const started = Date.now();
    const err = await writeFileAtomicPlain(file, "x\n").catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(GestaltError);
    const g = err as GestaltError;
    expect(g.code).toBe("E_IO"); // not E_LOCKED — a different problem, said differently
    expect(`${g.message} ${g.hint}`).toMatch(/read-only|not writable|permissions/i);
    expect(`${g.message} ${g.hint}`).not.toMatch(/holding the file open/i);
    expect(attempts).toBe(1); // no retry storm
    expect(elapsed).toBeLessThan(5_000); // no 30-second wait
    expect(readFileSync(file, "utf8")).toBe("original\n"); // untouched
  });
});

describe("verify-after-write (0.4) — the ACKed-write-that-vanished class", () => {
  // renameWithRetry's contract "never returns success without the new bytes at
  // `to`" previously held by construction only: nothing exercised a rename
  // that REPORTS success while the target ends up wrong. These do.

  it("a rename that lies (reports success, leaves the old bytes) is caught, not ACKed", async () => {
    const file = freshFile();
    // The lying filesystem: rename resolves fine and does nothing.
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    await expect(
      writeFileAtomicPlain(file, "the new content\n", { verify: "strict" }),
    ).rejects.toMatchObject({ code: "E_IO" });
    // And the caller was told the truth: the old bytes are still there.
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });

  it("racedOk reports the loss quietly instead of throwing — the lock-free repair contract", async () => {
    const file = freshFile();
    vi.spyOn(fsp, "rename").mockResolvedValue(undefined);
    await expect(
      writeFileAtomicPlain(file, "the new content\n", { verify: "racedOk" }),
    ).resolves.toBe(false);
  });

  it("an honest rename verifies clean and returns true", async () => {
    const file = freshFile();
    await expect(
      writeFileAtomicPlain(file, "the new content\n", { verify: "strict" }),
    ).resolves.toBe(true);
    expect(readFileSync(file, "utf8")).toBe("the new content\n");
  });
});
