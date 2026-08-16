import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
