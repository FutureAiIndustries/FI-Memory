import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { GestaltError } from "../src/errors.js";
import type { ErrorCode } from "../src/errors.js";
import { fsPath, topicLogPath, topicNotePath } from "../src/paths.js";
import { serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";

let counter = 0;

/**
 * A unique, not-yet-created store path under the test run-root (set by
 * setup.ts). Callers pass it to `runInit`/`runStatus` as `home`. Cleanup is
 * handled wholesale by removing the run-root in setup.ts's afterAll.
 */
export function freshHome(label = "store"): string {
  const root = process.env.GESTALT_TEST_ROOT;
  if (!root) throw new Error("test setup did not run (GESTALT_TEST_ROOT unset)");
  counter += 1;
  return path.join(root, `${label}-${counter}-${randomUUID()}`);
}

/**
 * The tsx entry point that every CLI-spawning test runs `src/cli.ts` through.
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING. Twelve test files each hardcoded
 * `../node_modules/tsx/dist/cli.mjs`, which is a PRIVATE path inside a
 * dependency rather than anything tsx promises. On 2026-08-01 an interrupted
 * `npm ci` left that tree half-written, and the result was 78 failures across
 * 12 files whose every message was a variant of:
 *
 *     AssertionError: expected 1 to be +0
 *
 * Not one of them said "tsx is missing". The spawned process died on a module
 * resolution error, the helper reported only its exit code, and the assertion
 * compared that code to zero — so a broken TOOLCHAIN was indistinguishable
 * from the product returning the wrong status, and reading the failures led
 * straight into the product code where nothing was wrong.
 *
 * Two fixes, both here so no test file can forget them:
 *   1. Resolve tsx through node's own resolver, so a layout change inside the
 *      package cannot silently break every spawn.
 *   2. If it cannot be found, throw a message that NAMES THE CAUSE and the
 *      remedy. A test suite is allowed to fail; it is not allowed to lie about
 *      why.
 */
export function tsxEntry(): string {
  const req = createRequire(import.meta.url);
  // `tsx/package.json` is an explicitly exported path, unlike dist/cli.mjs.
  let pkgJson: string;
  try {
    pkgJson = req.resolve("tsx/package.json");
  } catch {
    throw new Error(
      "tsx is not installed, so every CLI-spawning test would fail with a bare " +
        "non-zero exit and no explanation. Run `npm ci` in this package (and let " +
        "it finish — an interrupted install leaves a half-written node_modules " +
        "that fails exactly this way).",
    );
  }
  const root = path.dirname(pkgJson);
  // 4.x ships dist/cli.mjs; keep a couple of known alternates so a minor bump
  // degrades into a clear error rather than 78 mystery assertions.
  const candidates = [
    path.join(root, "dist", "cli.mjs"),
    path.join(root, "dist", "esm", "cli.mjs"),
    path.join(root, "dist", "cli.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `tsx is installed at ${root} but none of its known CLI entry points exist ` +
        `(tried: ${candidates.map((c) => path.relative(root, c)).join(", ")}). ` +
        "Either the install is incomplete — re-run `npm ci` and let it finish — " +
        "or tsx changed its layout and this resolver needs a new candidate.",
    );
  }
  return found;
}

/**
 * Assert a call throws a GestaltError with a specific code, and hand the error
 * back — same reason as the async variant below: `message`/`hint` are
 * user-facing recovery text, and pointing someone at `fimemory init` while their
 * real store sits beside the home under a temp name is itself the defect.
 */
export function expectGestaltError(fn: () => unknown, code: ErrorCode): GestaltError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GestaltError);
    expect((err as GestaltError).code).toBe(code);
    return err as GestaltError;
  }
  throw new Error(`expected GestaltError ${code}, but nothing was thrown`);
}

/**
 * Assert an async call rejects with a GestaltError of a specific code, and hand
 * the error back — the `message`/`hint` are user-facing text, and some of them
 * (e.g. "No FIMemory store …" + `fimemory init`, aimed at a store that is merely
 * locked) are themselves the defect worth asserting on.
 */
export async function expectGestaltErrorAsync(
  fn: () => Promise<unknown>,
  code: ErrorCode,
): Promise<GestaltError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GestaltError);
    expect((err as GestaltError).code).toBe(code);
    return err as GestaltError;
  }
  throw new Error(`expected GestaltError ${code}, but nothing was thrown`);
}

/** A fixed clock (epoch ms) for deterministic timestamps in tests. */
export function clockAt(ms: number): () => number {
  return () => ms;
}

/** A monotonically increasing clock from `startMs`, one ms per call. */
export function tickingClock(startMs: number): () => number {
  let t = startMs;
  return () => t++;
}

/**
 * Seed a topic's note + empty log files directly (bypassing `create`'s fuzzy
 * check and `update`'s proposal gate) so read-op tests can set a known body.
 * The store's `topics/` and `logs/` dirs must already exist (run `init` first).
 */
export function writeNote(
  home: string,
  id: string,
  opts: {
    title?: string;
    body?: string;
    aliases?: string[];
    tags?: string[];
    updated?: string;
  } = {},
): void {
  const note: TopicNote = {
    id,
    title: opts.title ?? id,
    aliases: opts.aliases ?? [],
    tags: opts.tags ?? [],
    projects: [],
    updated: opts.updated ?? "2026-07-11T00:00:00.000Z",
    compactedThrough: null,
    mergedInto: null,
    body: opts.body ?? `\n${opts.title ?? id}\n\n## Owner notes\n`,
  };
  writeFileSync(fsPath(topicNotePath(home, id)), serializeNote(note), "utf8");
  writeFileSync(fsPath(topicLogPath(home, id)), `# ${id} log\n`, "utf8");
}

/** What the real CLI did: its exit code and both streams, verbatim. */
export interface CliRun {
  /** The child's exit code. -1 means it died on a signal instead of exiting. */
  code: number;
  stdout: string;
  stderr: string;
  /** The store home the child resolved to, so callers can inspect it after. */
  home: string;
}

export interface CliRunOptions {
  /**
   * The store the child resolves by DEFAULT (via GESTALT_HOME) — i.e. with no
   * `--home` flag, which is how every real user runs it. Defaults to a fresh,
   * not-yet-created path so a test that forgets to seed a store gets an empty
   * one of its own rather than whatever the last test left behind.
   */
  home?: string;
  /** Working directory of the child. Defaults to the runtime package root. */
  cwd?: string;
  /** Extra env for the child. `undefined` as a value DELETES that variable. */
  env?: Record<string, string | undefined>;
  /** Text piped to the child's stdin (for `ingest`, `update -`, the hooks). */
  stdin?: string;
  /** Wall-clock ceiling; exceeding it is a harness failure, not a test result. */
  timeoutMs?: number;
}

/**
 * Spawn the REAL `src/cli.ts` as a child process and hand back what it did.
 *
 * WHY THIS EXISTS. Every op in this runtime is tested by calling it directly,
 * and that is a lie of omission about a whole layer. `pullStore` is the clearest
 * case: the suite only ever calls it with `skipGit: true`, so the git invocation
 * the CLI actually issues — the argv, the cwd, whether a failure is even
 * awaited — is executed by NOTHING in 989 passing tests. A defect that lives in
 * dispatch (wrong verb wiring, a dropped `await`, an exit code that reports
 * success for an operation that failed, an unhandled throw that dumps a Node
 * stack where a hint belongs) is invisible from inside the process. That class
 * has already shipped here once. The only way to see it is to be a different
 * process and look at the exit code and the two streams, which is all this does.
 *
 * Isolation is enforced, not hoped for. The child inherits the vitest sandbox
 * env, then GESTALT_HOME is REPLACED with this call's home, GESTALT_KEY and
 * GESTALT_PASSPHRASE are cleared (a developer with either exported would
 * otherwise unlock stores the test believes are locked), and the resolved home
 * is asserted to live under GESTALT_TEST_ROOT before a process is spawned at
 * all. Test code cannot reach the developer's real ~/.gestalt through here even
 * by passing it deliberately.
 */
export function runCli(args: string[], opts: CliRunOptions = {}): CliRun {
  const root = process.env.GESTALT_TEST_ROOT;
  if (!root) throw new Error("test setup did not run (GESTALT_TEST_ROOT unset)");

  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GESTALT_HOME: opts.home ?? freshHome("cli-spawn"),
    // Cleared, not sandboxed: a developer (or a CI box) with either of these
    // exported would silently unlock stores a test believes are locked, and the
    // test would pass here and fail for everyone else. Tests that WANT a key
    // pass it through `env` explicitly.
    GESTALT_KEY: "",
    GESTALT_PASSPHRASE: "",
    // The child's stdout is a pipe, so `useColor` is already false — but be
    // explicit, because an assertion that fails only under FORCE_COLOR is the
    // kind of flake nobody reproduces.
    NO_COLOR: "1",
  };
  // Caller overrides land BEFORE the sandbox check, never after: `env` is a
  // second route to GESTALT_HOME, and a guard that only inspected `opts.home`
  // would wave through exactly the spelling that reaches the real store.
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const home = env.GESTALT_HOME ?? "";
  const resolved = path.resolve(home);
  if (
    !home ||
    (resolved !== path.resolve(root) &&
      !resolved.startsWith(path.resolve(root) + path.sep))
  ) {
    // Deliberately a throw and not an assertion: a spawned CLI writes for real,
    // and "the test failed" is the wrong outcome for "we were about to edit the
    // developer's own store".
    throw new Error(
      `runCli refuses to spawn against ${resolved || "(no GESTALT_HOME)"}: it is ` +
        `outside the test run-root ${root}. Pass a freshHome() path.`,
    );
  }

  const timeout = opts.timeoutMs ?? 20_000;
  const r = spawnSync(process.execPath, [tsxEntry(), cli, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? fileURLToPath(new URL("..", import.meta.url)),
    env,
    input: opts.stdin ?? "",
    timeout,
    killSignal: "SIGKILL",
    windowsHide: true,
    // pack/export/brief can print more than spawnSync's 1 MB default, and a
    // truncated stream would read as a product defect rather than a clipped buffer.
    maxBuffer: 32 * 1024 * 1024,
  });

  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(
      `runCli: \`${args.join(" ")}\` was still running after ${timeout}ms and was killed. ` +
        "That is a hang in the CLI (or a prompt waiting on stdin), not a slow assertion.",
    );
  }
  if (r.error) throw r.error;

  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    home,
  };
}
