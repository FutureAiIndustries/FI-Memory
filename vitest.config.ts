import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // setup.ts sandboxes every test run into a temp GESTALT_HOME and refuses
    // to run if that sandbox is not in effect — see the store-isolation proof.
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // No parallel file isolation issues: each test uses its own temp dir, but
    // keep the global sandbox guard authoritative regardless.
    globals: false,
    // Vitest's 5000ms default is too tight for this suite on Windows.
    //
    // Measured 2026-08-06, not guessed. Across four full runs on one Windows 11
    // box, three different files timed out at least once — session-key-cache,
    // join, contention-gitsync-fixes — and every one of them passed on a serial
    // re-run, once at 5604ms against the 5000ms limit. They are the tests that
    // shell out to `git` and derive an Argon2id key, so they are slow by nature
    // and slower still when 70 files run in parallel next to them.
    //
    // This weakens nothing. A timeout is a limit on the harness, not an
    // assertion about the product: every expectation in those tests still runs
    // and still has to pass. What it removes is a false FAIL that reports the
    // machine's load as if it were a defect, which is worse than useless on the
    // one leg of CI that is currently red for exactly this reason.
    testTimeout: 30_000,
  },
});
