import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runInit } from "../src/commands/init.js";
import { appendLog } from "../src/ops/logOp.js";
import { createTopic } from "../src/ops/create.js";
import { pullStore } from "../src/ops/pullOp.js";
import { fsPath } from "../src/paths.js";
import { activateDek } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { clockAt, freshHome } from "./helpers.js";

/**
 * Shared git fixture plumbing for multi-store gates (0.4). Lifted from the
 * resolve-conflicts harness (whose style — run-root fixtures, host gitconfig
 * held aside via GIT_CONFIG_GLOBAL/SYSTEM — is the one that cannot leak or be
 * skewed by the developer's machine; the OS-tmpdir + per-repo-config style in
 * contention-gitsync-fixes is deliberately NOT copied). The older pair-based
 * test files still carry their own copies; they migrate here over time.
 */

export const TINY_ARGON = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
export const TRIO_PASS = "a perfectly sturdy three-store passphrase";
/** Base wall clock — must postdate the seeded example's timestamps or the
 * monotonic watermark overrides injected clocks (see resolve-conflicts). */
export const T0 = 1_785_240_000_000;

export interface Trio {
  root: string;
  origin: string;
  /** Clone homes, in creation order. clones[0] made the store. */
  clones: string[];
  env: NodeJS.ProcessEnv;
}

export function gitEnvFor(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, "no-global-gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(root, "no-system-gitconfig"),
    GIT_AUTHOR_NAME: "fimemory test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "fimemory test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

export function git(env: NodeJS.ProcessEnv, dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${dir} (${String(r.status)}):\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

export function gitTry(
  env: NodeJS.ProcessEnv,
  dir: string,
  ...args: string[]
): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

export function commitAll(env: NodeJS.ProcessEnv, dir: string, message: string): void {
  git(env, dir, "add", "-A");
  git(env, dir, "commit", "-q", "-m", message);
}

/** The exact command pullStore issues, run by hand when a test wants the raw conflict. */
export function rawPull(env: NodeJS.ProcessEnv, dir: string): { ok: boolean; out: string } {
  return gitTry(env, dir, "pull", "--no-rebase", "--no-edit");
}

/** Every store-relative file path under `home`, `.git` excluded. */
export function storeFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(fsPath(dir), { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(home, "");
  return out.sort();
}

/** The gate's "no file anywhere in the store contains a conflict marker". */
export function filesWithMarkers(home: string): string[] {
  const bad: string[] = [];
  for (const rel of storeFiles(home)) {
    let text: string;
    try {
      text = readFileSync(fsPath(path.join(home, rel)), "utf8");
    } catch {
      continue;
    }
    if (/^(<{7}( |$)|={7}$|\|{7}( |$)|>{7}( |$))/m.test(text)) bad.push(rel);
  }
  return bad;
}

/** Content hash of every file — proof a refusal wrote nothing. */
export function hashTree(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of storeFiles(home)) {
    const buf = readFileSync(fsPath(path.join(home, rel)));
    out[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return out;
}

/**
 * One bare origin + N clones, seeded with two topics and baseline log entries.
 * `-b main` on the bare init is not optional — its absence false-passed an
 * earlier proof (resolve-conflicts header).
 */
export async function buildTrio(label: string, encrypted = false, n = 3): Promise<Trio> {
  const root = freshHome(label);
  mkdirSync(fsPath(root), { recursive: true });
  const env = gitEnvFor(root);
  const origin = path.join(root, "origin.git");
  git(env, root, "init", "--bare", "-q", "-b", "main", origin);

  const first = path.join(root, "clone-0");
  if (encrypted) {
    runInit({
      home: first,
      encrypted: true,
      passphrase: TRIO_PASS,
      argon2: TINY_ARGON,
      allowWeakParams: true,
    });
    activateDek(unlockWithPassphrase(first, TRIO_PASS));
  } else {
    runInit({ home: first });
  }
  await createTopic(first, "alpha", "Alpha pipeline", { now: clockAt(T0) });
  await createTopic(first, "beta", "Beta pipeline", { now: clockAt(T0 + 1_000) });
  await appendLog(
    first,
    "alpha",
    { type: "decision", project: "demo", agent: "clone-0", summary: "baseline alpha decision" },
    { now: clockAt(T0 + 2_000) },
  );

  git(env, first, "init", "-q", "-b", "main");
  git(env, first, "remote", "add", "origin", origin);
  commitAll(env, first, "baseline");
  git(env, first, "push", "-q", "-u", "origin", "main");

  const clones = [first];
  for (let i = 1; i < n; i++) {
    const c = path.join(root, `clone-${String(i)}`);
    git(env, root, "clone", "-q", origin, c);
    clones.push(c);
  }
  return { root, origin, clones, env };
}

/**
 * The push-race protocol no two-machine gate ever exercised: pull (real git,
 * resolver included) then push; a non-fast-forward rejection means someone
 * else pushed first — pull again and retry. Bounded, and a failure to
 * terminate is a loud failure, never a livelock.
 */
export async function syncUntilClean(
  env: NodeJS.ProcessEnv,
  home: string,
  maxRounds = 4,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    await pullStore({ home, env });
    const push = gitTry(env, home, "push", "-q", "origin", "main");
    if (push.ok) return;
    if (!/fetch first|non-fast-forward|rejected/i.test(push.out)) {
      throw new Error(`push failed for a non-race reason in ${home}:\n${push.out}`);
    }
  }
  throw new Error(`syncUntilClean did not terminate in ${String(maxRounds)} rounds for ${home}`);
}
