import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsPath } from "../paths.js";

/**
 * Read-only inspection of the git state a store sits in.
 *
 * LIFTED from `migrateDecrypt.ts`'s `probeGit`/`assertGitSafe`, which have gated
 * the whole-store rewrite since encryption shipped. The pull contract needs the
 * same facts, and it must not learn them from a second, subtly different
 * inspector: two implementations that disagree is exactly how a guard holds on
 * one code path and quietly misses on the other.
 *
 * Two rules this module keeps:
 *
 *   1. **It returns plain data and throws for nothing an ordinary store can be
 *      in.** Not-a-repo, dirty, mid-rebase, conflicted, no identity — all of
 *      those are ANSWERS, not exceptions. The caller owns policy (what to
 *      refuse, what to repair, what to say); this module owns only the facts.
 *      A predicate that threw would force every call site to wrap it, and the
 *      one that forgot would crash instead of refusing.
 *
 *   2. **It is offline by construction.** No `fetch`, no network, ever. A guard
 *      whose answer depends on a network round trip either blocks the command on
 *      an offline laptop or — worse — gets skipped on failure and silently
 *      downgrades itself. Same reasoning `probeGit` states at length.
 *
 * Every git invocation carries `--no-optional-locks`. This store is written by
 * two MCP hosts, an office daemon and an hourly scheduled task; a plain `git
 * status` refreshes and rewrites `.git/index`, so an inspector that inspects
 * would be taking a lock against the peers it is inspecting for.
 */

/**
 * The `.gitattributes` a synced store must have, and the ONE place it is
 * written down. `init` creates it and `pull` repairs it, so both must agree.
 *
 * Each line earns its place:
 *
 *   `* -text`  pins line endings OFF. Without it, git decides per-machine from
 *   `core.autocrlf`, and a store cloned on a box whose global config says one
 *   thing and read on a box that says another reports every file MODIFIED while
 *   `git status` on the first box says clean. Measured, not theorised: a probe
 *   store lacking this line returned `["topics/shared.md"]` from `dirty()` on a
 *   worktree git itself called clean. A pull that refuses on phantom changes
 *   refuses forever, which is worse than a pull that fails loudly once.
 *
 *   The two `merge=union` lines are why `pull` uses merge and not rebase: union
 *   is a MERGE driver, so a rebase bypasses it and a dual append to one log
 *   conflicts instead of merging. They are also why a same-note conflict is the
 *   only conflict a user should ever have to think about.
 *
 * Repair is ADDITIVE. A store may carry lines of the user's own, and this is
 * their repository, not ours.
 */
export const STORE_GITATTRIBUTES_REQUIRED = [
  "* -text",
  "logs/*.log.md merge=union",
  "ledgers/*.jsonl merge=union",
] as const;

export const STORE_GITATTRIBUTES_HEADER = "# FIMemory store — dual-machine merge rules (Phase 0).";

/** A half-finished git operation, in the three flavours the pull contract acts on. */
export type GitOperation = "merge" | "rebase" | "cherry-pick";

/**
 * What git will and will not let this machine commit as.
 *
 * Split into two booleans on purpose, because they answer different questions
 * and the pull contract needs both:
 *
 *   - `canCommit` is whether `git commit` would SUCCEED. It is the answer that
 *     decides whether finishing a merge wedges the store half-resolved.
 *   - `configured` is whether an identity was actually configured, as opposed to
 *     guessed by git from the username and hostname.
 *
 * They come apart across platforms, which is the trap. On Windows with nothing
 * configured, git refuses outright (`unable to auto-detect email address`) and
 * both are false. On many Linux/macOS boxes git happily invents
 * `runner@fv-az123.(none)`, so `canCommit` is TRUE while `configured` is false —
 * the merge commit lands, signed by a name nobody recognises, in a store two
 * machines share. Collapsing these into one boolean makes the CI leg and the
 * laptop disagree about the same store.
 */
export interface GitIdentity {
  /** `git commit` would succeed. THE answer for "can this machine finish a merge". */
  canCommit: boolean;
  /** Both `user.name` and `user.email` are set in config (any scope) — not guessed. */
  configured: boolean;
  /** `user.name` as configured, or null when unset in every scope. */
  name: string | null;
  /** `user.email` as configured, or null when unset in every scope. */
  email: string | null;
  /** git's own refusal text when `canCommit` is false, so a caller can quote it. */
  reason: string | null;
}

// ── running git ──────────────────────────────────────────────────────────────

/**
 * `env` is threaded through every export rather than read from `process.env`
 * once. The identity-absent case cannot be built any other way: the only honest
 * way to test a machine that has never had `user.email` set is to hide the
 * global and system config from a child process (`GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_NOSYSTEM`), and a module that closed over `process.env` would make
 * that test depend on the developer's own machine having no global identity.
 */
type GitEnv = NodeJS.ProcessEnv;

interface GitRun {
  ok: boolean;
  /** Trimmed stdout. */
  out: string;
  /** Trimmed stderr, or the spawn error — git's own words, kept for the caller. */
  err: string;
}

function spawnGit(
  cwd: string,
  args: string[],
  env: GitEnv | undefined,
): { status: number | null; stdout: string; stderr: string; failed: boolean } {
  const r = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    // The default 1 MB would TRUNCATE a large `status` into a shorter file list
    // and report it as the whole truth — a wrong answer, not a failure.
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    failed: Boolean(r.error) || r.status !== 0,
  };
}

/** Run git for a scalar answer. Output is trimmed; never use for `-z` parsing. */
function runGit(cwd: string, args: string[], env?: GitEnv): GitRun {
  const r = spawnGit(cwd, args, env);
  return {
    ok: !r.failed,
    out: r.stdout.trim(),
    err: (r.stderr.trim() || (r.failed ? `git exited ${String(r.status)}` : "")).trim(),
  };
}

/**
 * Run git for NUL-separated output and return the non-empty fields, UNTRIMMED.
 *
 * Untrimmed matters: `git status --porcelain -z` prefixes each entry with a
 * two-character status code, and the first character is a space for the common
 * unstaged case (` M topics/foo.md`). Trimming eats it, `slice(3)` then eats
 * three characters off the front of the filename, and the guard reports dirt in
 * a file that does not exist. `-z` is used instead of the default so git does
 * not C-quote paths with spaces or non-ASCII in them.
 */
function runGitZ(cwd: string, args: string[], env?: GitEnv): string[] {
  const r = spawnGit(cwd, args, env);
  if (r.failed) return [];
  return r.stdout.split("\0").filter((f) => f.length > 0);
}

/**
 * Compare two paths as the filesystem sees them.
 *
 * `git rev-parse --show-toplevel` prints a realpathed, forward-slashed path. On
 * macOS the system temp dir is `/var/folders/...`, a symlink to
 * `/private/var/folders/...`, so a naive string compare says a fixture repo is
 * not its own top level and every predicate returns the empty answer — a whole
 * test file passing while proving nothing. On Windows the same compare trips on
 * drive-letter case and 8.3 short names.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = path.resolve(p);
    try {
      r = realpathSync.native(fsPath(r)).replace(/^\\\\\?\\/, "");
    } catch {
      // Not there / not readable: the resolved form is the best available answer,
      // and the compare below will simply say "different", which is the safe side.
    }
    r = path.normalize(r);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// ── is git even here ─────────────────────────────────────────────────────────

/**
 * Whether a `git` executable can be run at all.
 *
 * Exists because `isRepo` cannot distinguish "this store is not under git" from
 * "git is not installed" — spawnSync reports ENOENT for both — and the two want
 * opposite handling. A pull contract that treats a missing git as "no repo,
 * nothing to sync" exits 0 having synced nothing, which is precisely the
 * 0.2-era "exits 0, does the wrong git" class this work exists to kill.
 *
 * Probed from the OS temp dir, never from the store: a `home` that does not
 * exist also produces ENOENT, and blaming that on the git install would send
 * the user off to reinstall a working tool.
 */
export function gitAvailable(env?: GitEnv): boolean {
  return runGit(os.tmpdir(), ["--version"], env).ok;
}

// ── is this a repo ───────────────────────────────────────────────────────────

/**
 * Whether `home` is the ROOT of a git work tree.
 *
 * Deliberately stricter than "is inside a work tree". A store that merely sits
 * SOMEWHERE UNDER a repo — say `~/notes/store` inside a repo rooted at `~` —
 * would answer yes to the loose question, and then every other predicate here
 * would report the enclosing repo's state as the store's, and a pull would pull
 * somebody else's project on top of it. `probeGit` guards the same case by
 * requiring `.git` beside the store; this is the same rule, expressed so that a
 * `.git` FILE (worktree or submodule gitlink) still counts.
 *
 * A bare repo is not a work tree and answers false, which is correct: there is
 * nothing to pull into.
 */
export function isRepo(home: string, env?: GitEnv): boolean {
  if (!existsSync(fsPath(home))) return false;
  const top = runGit(home, ["rev-parse", "--show-toplevel"], env);
  if (!top.ok || top.out.length === 0) return false;
  return samePath(top.out, home);
}

/** The resolved `.git` directory, or null when `home` is not a repo we can read. */
function gitDir(home: string, env?: GitEnv): string | null {
  if (!existsSync(fsPath(home))) return null;
  const r = runGit(home, ["rev-parse", "--git-dir"], env);
  if (!r.ok || r.out.length === 0) return null;
  // Relative (plain `.git` beside the work tree) or absolute (worktree /
  // submodule gitlink) depending on the layout — `resolve` handles both.
  return path.resolve(home, r.out);
}

// ── half-finished operations ─────────────────────────────────────────────────

/**
 * The operation git has half-finished in this store, or null.
 *
 * Read off the markers in the git dir rather than from `status` text, because
 * the markers are what `--abort` and `--continue` themselves key on, and they do
 * not change wording between git versions or locales.
 *
 * NOTE FOR A REWIRE: this union covers the three states the pull contract can
 * act on. `probeGit` in `migrateDecrypt.ts` additionally flags `REVERT_HEAD`
 * and `BISECT_LOG`; whoever points that guard at this module must keep those
 * two, or `decrypt` silently stops refusing mid-revert and mid-bisect.
 */
export function inProgress(home: string, env?: GitEnv): GitOperation | null {
  // Same isRepo guard as `dirty` and `conflicted`, and for the same reason —
  // gitDir() resolves UPWARD by design, so a store that is merely nested inside
  // a larger repo reports that repo's half-finished operation as its own.
  // This predicate is the dangerous one to get wrong: callers turn its answer
  // into a remedy, and `git merge --abort` run against a misattributed state
  // aborts the ENCLOSING repo's operation. Destructive, from a fact that was
  // never about this store.
  if (!isRepo(home, env)) return null;
  const dir = gitDir(home, env);
  if (dir === null) return null;
  const marker = (rel: string): boolean => existsSync(fsPath(path.join(dir, rel)));

  // ORDER IS PRECEDENCE, and it is deliberate. Verified on git 2.55: a stopped
  // rebase — plain OR interactive — leaves `rebase-merge/` and `REBASE_HEAD`
  // and NOT `CHERRY_PICK_HEAD`, so on this version the three cases do not in
  // fact overlap. The order is kept anyway because the sequencer drives rebase,
  // cherry-pick and revert through the same machinery and has left
  // CHERRY_PICK_HEAD alongside a rebase in other versions. Getting it backwards
  // is not a cosmetic bug: the caller turns this name into a remedy, and
  // `git cherry-pick --abort` does not get anyone out of a rebase. A test pins
  // the precedence against a real mid-rebase repo carrying both markers.
  if (marker("rebase-merge") || marker("rebase-apply")) return "rebase";
  if (marker("MERGE_HEAD")) return "merge";
  if (marker("CHERRY_PICK_HEAD")) return "cherry-pick";
  return null;
}

// ── uncommitted work ─────────────────────────────────────────────────────────

/**
 * Repo-relative paths of TRACKED files that differ from HEAD — staged or not.
 *
 * The `--untracked-files=no` is the whole point of this function, not a detail.
 * `init` gitignores `index.json` (derived), `keyring.json` and `machine-id`
 * (per-machine) and `.gestalt.lock`, and git already hides ignored files from
 * `status` — but plain `--porcelain` still lists UNTRACKED ones as `?? path`.
 * A store whose `.gitignore` has not been repaired yet, or that carries any
 * scratch file the user dropped in, would therefore report as dirty and every
 * single pull would refuse on a perfectly healthy store. Refusing constantly is
 * how a guard gets switched off.
 *
 * The cost of that choice, stated rather than hidden: an untracked file that
 * the incoming merge wants to write is NOT reported here, and git will stop the
 * merge itself with "would be overwritten by merge". That is a git refusal with
 * a clear message, not a wedge — an acceptable trade for a guard that only
 * fires on real uncommitted work.
 *
 * Unmerged paths appear here too (git reports them as `UU` and friends), so a
 * conflicted tree is also a dirty tree. Callers wanting the precise state should
 * test `inProgress`/`conflicted` first — they produce the more useful message.
 */
export function dirty(home: string, env?: GitEnv): string[] {
  // Guarded by isRepo, not left to `status` failing on its own: from a store
  // nested inside a larger repo `status` succeeds and reports the ENCLOSING
  // repo's modifications as this store's.
  if (!isRepo(home, env)) return [];
  const fields = runGitZ(
    home,
    ["status", "--porcelain", "-z", "--untracked-files=no"],
    env,
  );

  const files: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] ?? "";
    // "XY " plus at least one character of path.
    if (entry.length < 4) continue;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    files.push(entry.slice(3));
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // A rename/copy is TWO NUL fields: the new path in the status entry, the
      // original in a bare field straight after it. Not consuming that second
      // field reads the original as the next status entry, and `slice(3)` then
      // silently eats three characters off the front of a real filename.
      // Both paths are dirt — the old one vanished, the new one appeared — so
      // both are reported.
      const from = fields[i + 1];
      if (from !== undefined && from.length > 0) files.push(from);
      i += 1;
    }
  }
  return [...new Set(files)].sort();
}

// ── conflicts ────────────────────────────────────────────────────────────────

/**
 * Repo-relative paths git has left unmerged (index stages 2 and 3 both present).
 *
 * This is the list the resolver walks, so it is read from the INDEX via
 * `--diff-filter=U` rather than by scanning worktree files for `<<<<<<<`
 * markers: a conflicted binary or whole-file JSON has no markers to find, and a
 * note whose body legitimately quotes a marker is not a conflict.
 */
export function conflicted(home: string, env?: GitEnv): string[] {
  if (!isRepo(home, env)) return [];
  const fields = runGitZ(home, ["diff", "--name-only", "--diff-filter=U", "-z"], env);
  return [...new Set(fields)].sort();
}

// ── committer identity ───────────────────────────────────────────────────────

function readConfig(cwd: string, key: string, env?: GitEnv): string | null {
  const r = runGit(cwd, ["config", "--get", key], env);
  return r.ok && r.out.length > 0 ? r.out : null;
}

/**
 * Whether this machine can commit, and whether it has been told who it is.
 *
 * A clone does not need an identity. FINISHING A MERGE DOES — and that asymmetry
 * is the whole reason this exists. A stranger who has just installed FIMemory,
 * never set `user.email`, and runs `pull` into a diverged store gets git's
 * merge, git's conflict, the resolver's rewrite, and then a `commit` that fails
 * at the very last step: a half-resolved wedge in the store they were trying to
 * sync, with rewritten files on disk and no commit to hold them. The pull
 * contract asks this BEFORE it starts the merge so that case is a clean refusal
 * naming `git config user.email`.
 *
 * `canCommit` comes from `git var GIT_COMMITTER_IDENT`, not from reading config,
 * because that is the exact call `git commit` makes to build its committer line
 * — same strict mode, same auto-detection, same refusal text. Deciding from
 * config alone would miss `EMAIL` / `GIT_AUTHOR_*` in the environment (a false
 * refusal) and would miss git's own hostname guessing (a false pass).
 *
 * Asked from the OS temp dir when `home` does not exist, so a mistyped path
 * cannot masquerade as a missing identity.
 */
export function hasIdentity(home: string, env?: GitEnv): GitIdentity {
  const cwd = existsSync(fsPath(home)) ? home : os.tmpdir();
  const name = readConfig(cwd, "user.name", env);
  const email = readConfig(cwd, "user.email", env);
  const ident = runGit(cwd, ["var", "GIT_COMMITTER_IDENT"], env);
  return {
    canCommit: ident.ok,
    configured: name !== null && email !== null,
    name,
    email,
    reason: ident.ok ? null : ident.err || "git could not resolve a committer identity",
  };
}

/**
 * Make sure this store's `.gitattributes` carries the lines a synced store
 * needs, adding only what is missing. Returns the lines it added.
 *
 * Called by `pull` BEFORE any git command and before the dirty check, because
 * the very failure this prevents — a clean worktree reported as modified — would
 * otherwise trip the dirty guard and make the store permanently unpullable.
 * Idempotent: a store already carrying the lines is not rewritten at all.
 */
export function ensureGitAttributes(home: string): string[] {
  const p = fsPath(path.join(home, ".gitattributes"));
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = STORE_GITATTRIBUTES_REQUIRED.filter((req) => !lines.includes(req));
  if (missing.length === 0) return [];

  const head = existing === "" ? `${STORE_GITATTRIBUTES_HEADER}\n` : ensureTrailingNewline(existing);
  writeFileSync(p, `${head}${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return [...missing];
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}