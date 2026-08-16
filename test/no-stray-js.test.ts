import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE HARNESS GUARD — this protects every other test in this repo.
 *
 * 70 stray compiled `.js` files were once sitting beside their `.ts` sources in
 * `src/` and `test/` (a `tsc` run without `outDir`, an old build, an editor's
 * "compile on save"). Every import in this codebase is written NodeNext-style —
 * `../store/log.js` — so vite resolved those specifiers to the STALE JAVASCRIPT
 * instead of the TypeScript beside it. The suite went green against code that no
 * longer existed.
 *
 * The second-order damage is worse than a stale pass, and it is why this is a
 * test and not a nice-to-have: the standard way to prove a regression test is
 * honest is `git stash push -- runtime/src`, re-run, and watch it FAIL. Stray
 * `.js` are untracked, so `stash` leaves them exactly where they are — the
 * "pre-fix" run silently keeps testing the compiled fix, the test passes, and
 * the proof reports success while proving NOTHING. A guard that fails loudly is
 * the only thing standing between that and a false green.
 */

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED_RE = /\.(js|cjs|mjs)$/;

/** Every compiled artifact under `dir`, store-relative, recursively. */
function compiledUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...compiledUnder(full));
    else if (COMPILED_RE.test(entry.name)) found.push(path.relative(RUNTIME, full));
  }
  return found;
}

describe("harness — the source tree is TypeScript, and only TypeScript", () => {
  it.each(["src", "test"])(
    "no compiled .js/.cjs/.mjs sits beside the .ts in %s/ — vite would resolve to it",
    (sub) => {
      // The message matters: whoever trips this is mid-debug on something else
      // and needs to know their last run may have been a lie.
      expect(compiledUnder(path.join(RUNTIME, sub))).toEqual([]);
    },
  );

  it("no vitest.config.js can shadow vitest.config.ts", () => {
    // vite picks a config by extension precedence, so a stray compiled config
    // silently WINS over the .ts one — taking `setupFiles` with it. That would
    // drop the store-isolation sandbox (test/setup.ts) from every run, which is
    // the one thing standing between this suite and the user's real ~/.gestalt.
    for (const ext of ["js", "cjs", "mjs"]) {
      for (const stem of ["vitest.config", "vite.config"]) {
        expect(existsSync(path.join(RUNTIME, `${stem}.${ext}`))).toBe(false);
      }
    }
    expect(existsSync(path.join(RUNTIME, "vitest.config.ts"))).toBe(true);
  });
});
