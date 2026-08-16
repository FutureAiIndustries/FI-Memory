import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { search } from "../src/ops/search.js";
import { fsPath, topicLogPath, topicNotePath } from "../src/paths.js";
import { freshHome } from "./helpers.js";

/**
 * `create` writes three things: the note, the log, then the index. Only the
 * third can meaningfully fail on its own — `index.json` is the hottest file in
 * the store, so it is the likeliest of the three to lose a rename race to a
 * peer reader or a virus scanner.
 *
 * When it did, the note and log stayed on disk with nothing pointing at them.
 * Nothing was permanently lost (the next mutating op rebuilds a stale index),
 * but what the user saw was: a hang, then E_LOCKED telling them to retry, then
 * on retry a flat "Topic already exists" — for a topic search could not find.
 * A tool contradicting itself about whether your note exists is exactly the
 * kind of thing that ends a beta.
 */
describe("create rolls back when the index write fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function store(label: string): string {
    const home = freshHome(label);
    runInit({ home });
    return home;
  }

  it("leaves no note or log behind, and no half-topic for search to miss", async () => {
    const home = store("create-rollback");

    // Fail ONLY the index write. Targeting by filename rather than call order
    // keeps this honest if the write sequence is ever reordered: the property
    // under test is "a failed index write leaves nothing behind", not "the
    // third call throws".
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("index.json")) {
        // ENOSPC rather than EPERM on purpose: EPERM is in the retriable set,
        // so writeFileAtomic would wait the full 30 s RENAME_WAIT_MS before
        // giving up and the test would just time out. The property under test
        // is "a failed index write rolls back", not which errno caused it.
        const e = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
      return realRename(from as string, to as string);
    });

    await expect(createTopic(home, "orphan", "Orphan")).rejects.toThrow();

    // The rollback: neither file may survive a create that did not commit.
    expect(existsSync(fsPath(topicNotePath(home, "orphan")))).toBe(false);
    expect(existsSync(fsPath(topicLogPath(home, "orphan")))).toBe(false);
  });

  it("a retry after a failed create succeeds instead of claiming it exists", async () => {
    const home = store("create-rollback-retry");

    const realRename = fsp.rename.bind(fsp);
    let failIndex = true;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (failIndex && String(to).endsWith("index.json")) {
        // ENOSPC rather than EPERM on purpose: EPERM is in the retriable set,
        // so writeFileAtomic would wait the full 30 s RENAME_WAIT_MS before
        // giving up and the test would just time out. The property under test
        // is "a failed index write rolls back", not which errno caused it.
        const e = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
      return realRename(from as string, to as string);
    });

    await expect(createTopic(home, "retryable", "Retryable")).rejects.toThrow();

    // The contradiction this fixes: before the rollback, THIS call threw
    // E_EXISTS ("Topic already exists") because the note file was still on
    // disk, while search returned nothing for it.
    failIndex = false;
    const r = await createTopic(home, "retryable", "Retryable");
    expect(r.entry.id).toBe("retryable");

    // …and the retry is a real topic, not a repaired ghost.
    const hits = await search(home, "Retryable");
    expect(hits.hits.some((h) => h.id === "retryable")).toBe(true);
  });

  it("surfaces the ORIGINAL write error, not a cleanup error", async () => {
    const home = store("create-rollback-original-error");

    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("index.json")) {
        // ENOSPC rather than EPERM on purpose: EPERM is in the retriable set,
        // so writeFileAtomic would wait the full 30 s RENAME_WAIT_MS before
        // giving up and the test would just time out. The property under test
        // is "a failed index write rolls back", not which errno caused it.
        const e = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
      return realRename(from as string, to as string);
    });
    // Cleanup itself fails too. The user still needs to hear about the WRITE.
    vi.spyOn(fsp, "unlink").mockRejectedValue(
      Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }),
    );

    await expect(createTopic(home, "noisy", "Noisy")).rejects.toThrow(/ENOSPC|space/i);
  });
});
