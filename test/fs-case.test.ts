import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldPathForFs, isCaseInsensitiveFs, resetFsCaseCacheForTests } from "../src/fsCase.js";
import { freshHome } from "./helpers.js";

/**
 * src/fsCase.ts decides whether two spellings of one path are one identity. It
 * exists because three digest sites — the session key cache (which holds a
 * plaintext DEK), telemetry, and the shim audit — used to fold case when
 * `process.platform === "win32"`, which is a claim about an operating system
 * standing in for a fact about a filesystem. It is wrong on a default macOS
 * volume in one direction and would be wrong on Linux in the other.
 *
 * Everything below runs on every platform. The expected VALUE comes from an
 * independent measurement of the filesystem the test is standing on, so this
 * file asserts agreement with reality rather than agreement with an assumption.
 */

/** Independent of the module under test: create one spelling, look for the other. */
function measureFold(under: string): boolean {
  mkdirSync(under, { recursive: true });
  writeFileSync(path.join(under, "Probe.txt"), "x", "utf8");
  return existsSync(path.join(under, "probe.txt"));
}

describe("fsCase — the case-sensitivity probe", () => {
  it("agrees with a real create-then-stat measurement of this filesystem", () => {
    const dir = freshHome("fscase-agree");
    const truth = measureFold(dir);
    resetFsCaseCacheForTests();
    expect(isCaseInsensitiveFs(dir)).toBe(truth);
  });

  it("answers for a path that does not exist yet, via its nearest existing ancestor", () => {
    const dir = freshHome("fscase-ghost");
    const truth = measureFold(dir);
    resetFsCaseCacheForTests();
    // `init` asks this question about a store home BEFORE creating it.
    expect(isCaseInsensitiveFs(path.join(dir, "not", "created", "yet"))).toBe(truth);
  });

  it("folds a key only when the filesystem folds the name", () => {
    const dir = freshHome("fscase-Fold");
    const truth = measureFold(dir);
    resetFsCaseCacheForTests();
    const folded = foldPathForFs(dir);
    expect(folded).toBe(truth ? dir.toLowerCase() : dir);
    // The identity that matters: two spellings, one key, iff the FS says so.
    resetFsCaseCacheForTests();
    const variant = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
    expect(foldPathForFs(variant) === folded).toBe(truth);
  });

  it("does not merge two genuinely different directories on a case-sensitive filesystem", () => {
    const base = freshHome("fscase-two");
    const truth = measureFold(base);
    if (truth) return expect(truth).toBe(true); // one directory here, nothing to separate
    const lower = path.join(base, "store-a");
    const upper = path.join(base, "STORE-A");
    mkdirSync(lower, { recursive: true });
    mkdirSync(upper, { recursive: true });
    resetFsCaseCacheForTests();
    // Two real, distinct stores must keep two distinct keys — folding here would
    // let them cross-unlock through a single shared session-cache entry.
    expect(foldPathForFs(lower)).not.toBe(foldPathForFs(upper));
  });

  it("honours the GESTALT_FS_CASE_INSENSITIVE diagnostic override, both ways", () => {
    const dir = freshHome("fscase-override");
    mkdirSync(dir, { recursive: true });
    resetFsCaseCacheForTests();
    expect(isCaseInsensitiveFs(dir, { GESTALT_FS_CASE_INSENSITIVE: "1" })).toBe(true);
    expect(isCaseInsensitiveFs(dir, { GESTALT_FS_CASE_INSENSITIVE: "0" })).toBe(false);
    expect(foldPathForFs(dir, { GESTALT_FS_CASE_INSENSITIVE: "1" })).toBe(dir.toLowerCase());
    expect(foldPathForFs(dir, { GESTALT_FS_CASE_INSENSITIVE: "false" })).toBe(dir);
  });

  it("never throws on a path it cannot inspect", () => {
    resetFsCaseCacheForTests();
    expect(() => isCaseInsensitiveFs("")).not.toThrow();
    expect(() => isCaseInsensitiveFs(path.join(freshHome("fscase-nodir"), "a", "b"))).not.toThrow();
  });
});
