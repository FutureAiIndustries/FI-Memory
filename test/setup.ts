import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Store-isolation fixture (BUILD-PLAN B0 accept: "npm test never touches the
 * real store"). Every test run gets a private run-root under the OS temp dir,
 * and the DEFAULT store (GESTALT_HOME) is routed into it. This is the safety
 * net: even a test that forgets to pass an explicit `--home` lands here, never
 * in the user's real ~/.gestalt. Individual tests still use their own
 * `freshHome()` subdir so they don't collide.
 */
const runRoot = mkdtempSync(path.join(os.tmpdir(), "gestalt-test-"));
process.env.GESTALT_TEST_ROOT = runRoot;
process.env.GESTALT_HOME = path.join(runRoot, "_default_sandbox");
// The E2c session key cache lives OUTSIDE any store home (that is its whole
// point), so it needs its own sandbox: route it into the run-root too, or a
// test unlock would write a real key file into the user's real cache dir.
process.env.GESTALT_SESSION_DIR = path.join(runRoot, "_session_cache");
// Last-read telemetry also lives OUTSIDE any store home (trust surface): route
// it into the run-root too, or a test search/get would write a heartbeat into
// the user's real %LOCALAPPDATA%/~/.cache telemetry dir.
process.env.GESTALT_TELEMETRY_DIR = path.join(runRoot, "_telemetry");

/**
 * HOST-HOME OVERRIDES ARE CLEARED, not sandboxed.
 *
 * `install-rules`, `install-mcp` and `doctor` all resolve host locations
 * through `$CODEX_HOME`, `$GEMINI_CLI_HOME` and `$GROK_HOME` before falling
 * back to `<home>/.codex` etc. Several tests spawn the real CLI with
 * `{ ...process.env, HOME: fakeHome }` — HOME/USERPROFILE/APPDATA are
 * sandboxed there, these three were not, so on any machine (or CI box) that
 * sets one of them the sandbox was bypassed FOR THAT HOST. Verified: with HOME
 * pointed at an empty temp dir and GROK_HOME set elsewhere, `setup` wrote both
 * AGENTS.md (a rules file the user owns) and config.toml into the GROK_HOME
 * directory while the sandboxed home stayed empty.
 *
 * Deleting them is better than pointing them somewhere fake: the tests that
 * exercise these hosts assert paths under their own fake home, which is exactly
 * the fallback an unset variable produces.
 */
delete process.env.CODEX_HOME;
delete process.env.GEMINI_CLI_HOME;
delete process.env.GROK_HOME;

// Hard guard: refuse to run if the sandbox somehow resolves onto the real
// store. A misconfigured run must fail loudly, never silently touch real data.
const realStore = path.resolve(os.homedir(), ".gestalt");
if (
  path.resolve(process.env.GESTALT_HOME) === realStore ||
  path.resolve(runRoot) === realStore ||
  realStore.startsWith(path.resolve(runRoot) + path.sep)
) {
  throw new Error(
    `Refusing to run tests: sandbox ${runRoot} overlaps the real store ${realStore}`,
  );
}

afterAll(() => {
  rmSync(runRoot, { recursive: true, force: true });
});
