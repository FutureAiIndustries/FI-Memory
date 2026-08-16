/**
 * Rename-deadline probes from the server lane (fix/reader-starvation, f37030a).
 * Kept in their own file so they sit ALONGSIDE the audit probes in
 * contention-readers.test.ts rather than replacing them: those cover read
 * consistency and crash recovery, these cover the 30s rename deadline.
 */
/**
 * Cross-process reader pressure vs atomic rename (Windows shape).
 *
 * On Windows a rename over a file another process holds open fails with EPERM.
 * Node opens for reading without FILE_SHARE_DELETE, so concurrent peer readers
 * turn every write into a race. The old ~2.5 s rename budget lost often enough
 * that a write returned E_LOCKED and the intended mutation was dropped — nothing
 * above the store lock retried.
 *
 * These probes pin the property that matters for (d): under reader pressure a
 * write is DELAYED until the target is free, never dropped into a hard E_LOCKED
 * while readers are still transient. A permanent holder still fails loudly
 * (see atomic-rename-contention.test.ts).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomicPlain } from "../src/store/atomic.js";
import { GestaltError } from "../src/errors.js";

function freshFile(name = "target.md"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "contention-readers-"));
  const file = path.join(dir, name);
  writeFileSync(file, "original\n", "utf8");
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readers vs atomic write (Windows rename shape)", () => {
  it("readers do not starve a write into E_LOCKED (pressure longer than the old 2.5s budget)", async () => {
    const file = freshFile();
    const real = fsp.rename.bind(fsp);
    let attempts = 0;
    // Hold the rename off for ~4 s — longer than the old ~2.5 s budget that
    // used to throw E_LOCKED and drop the write. Then let it through, the
    // shape of many short-lived peer readers overlapping the rename window.
    const holdUntil = Date.now() + 4_000;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (Date.now() < holdUntil) {
        const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(from, to);
    });

    await writeFileAtomicPlain(file, "written through reader pressure\n");

    expect(attempts).toBeGreaterThan(4);
    expect(readFileSync(file, "utf8")).toBe("written through reader pressure\n");
  }, 40_000);

  it("many concurrent reader-shaped renames still land every write (no silent drop)", async () => {
    // N writers, each seeing a burst of EPERM then success. Every write must
    // land with its own content — never E_LOCKED, never the original bytes.
    const dir = mkdtempSync(path.join(tmpdir(), "contention-readers-many-"));
    const real = fsp.rename.bind(fsp);
    let failBudget = 80; // shared pool of simulated reader collisions
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (failBudget > 0) {
        failBudget -= 1;
        const e = new Error("EPERM") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return real(from, to);
    });

    const files = Array.from({ length: 6 }, (_, i) => {
      const file = path.join(dir, `t${i}.md`);
      writeFileSync(file, "original\n", "utf8");
      return file;
    });

    await Promise.all(
      files.map((file, i) => writeFileAtomicPlain(file, `content-${i}\n`)),
    );

    for (let i = 0; i < files.length; i++) {
      expect(readFileSync(files[i]!, "utf8")).toBe(`content-${i}\n`);
    }
  }, 40_000);

  it("a permanent reader still fails loud with E_LOCKED (never hangs forever)", async () => {
    const file = freshFile();
    vi.spyOn(fsp, "rename").mockImplementation(async () => {
      const e = new Error("EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });

    const started = Date.now();
    const err = await writeFileAtomicPlain(file, "never\n").catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(GestaltError);
    expect((err as GestaltError).code).toBe("E_LOCKED");
    expect(elapsed).toBeGreaterThanOrEqual(25_000);
    expect(elapsed).toBeLessThan(45_000);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  }, 50_000);
});
