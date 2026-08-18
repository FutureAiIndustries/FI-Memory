/**
 * The git state inspector the 0.3.0 pull contract is built on.
 *
 * Every fixture here is a REAL git repository under the system temp dir, driven
 * by the real `git` binary into the real state being asserted — a mid-rebase
 * repo is produced by rebasing until git stops, not by touching
 * `.git/rebase-merge` into existence. A hand-faked marker proves the inspector
 * can read a file; it does not prove the inspector recognises what git actually
 * leaves behind, and the whole value of this module is that it agrees with git.
 *
 * Every remote is `git init --bare -b main`. The missing `-b main` is what made
 * an earlier proof in this project false-pass: the clone and the remote sat on
 * differently-named branches, so the operations under test were no-ops against
 * an unrelated ref and reported success.
 *
 * Each predicate is asserted against BOTH the fixture that should trip it and a
 * fixture that should not, so an implementation that hardcodes either answer
 * fails. See the negative-proof run in the unit's report: each predicate was
 * inverted in turn and the failures observed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  conflicted,
  dirty,
  gitAvailable,
  hasIdentity,
  inProgress,
  isRepo,
} from "../src/ops/gitState.js";
import { freshHome } from "./helpers.js";

// ── fixture plumbing ─────────────────────────────────────────────────────────

/**
 * Run git in a fixture and THROW with git's own stderr if it fails.
 *
 * A fixture that half-builds is worse than one that does not build at all: the
 * assertions still run, against a repo in a state nobody chose, and whatever
 * they report is noise. `expectFail` marks the calls that are supposed to
 * fail — the merge and rebase that produce the conflicts.
 */
function git(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; expectFail?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  if (r.error) {
    throw new Error(`fixture: could not run git ${args.join(" ")} in ${cwd}: ${r.error.message}`);
  }
  if (!opts.expectFail && r.status !== 0) {
    throw new Error(
      `fixture: git ${args.join(" ")} failed in ${cwd} (exit ${String(r.status)}): ` +
        `${(r.stderr || r.stdout).trim()}`,
    );
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Pin the settings a developer's or CI runner's GLOBAL config could otherwise
 * change underneath these fixtures. Each one has bitten a git-driving test
 * suite somewhere:
 *   - identity, so nothing here depends on the machine having one (and so the
 *     identity-absent case is the only fixture without one);
 *   - `core.autocrlf`, which is ON by default in Git for Windows and reports
 *     freshly-checked-out files as modified;
 *   - `commit.gpgsign`, which makes every fixture commit hang or fail on a box
 *     that signs by default;
 *   - `core.hooksPath`, which on a box with a global pre-commit hook runs that
 *     hook against these throwaway repos.
 */
function pinLocalConfig(repo: string, opts: { identity?: boolean } = {}): void {
  if (opts.identity !== false) {
    git(repo, ["config", "user.name", "Fixture Machine"]);
    git(repo, ["config", "user.email", "fixture@example.invalid"]);
  }
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.hooksPath", path.join(repo, "no-such-hooks-dir")]);
}

/** A bare `-b main` remote — the shape every fixture clone is taken from. */
function makeRemote(label: string): string {
  const remote = `${freshHome(label)}-remote.git`;
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "-b", "main"]);
  return remote;
}

/**
 * A store-shaped clone of a fresh bare `-b main` remote, with one commit on
 * `main`: a tracked note, and the `.gitignore` `init` writes for the derived and
 * per-machine files.
 */
function makeStoreClone(
  label: string,
  opts: { identity?: boolean; gitignore?: boolean } = {},
): string {
  const remote = makeRemote(label);
  const work = freshHome(label);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-b", "main"]);
  pinLocalConfig(work, opts);
  git(work, ["remote", "add", "origin", remote]);

  mkdirSync(path.join(work, "topics"), { recursive: true });
  writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nbase body\n", "utf8");
  if (opts.gitignore !== false) {
    writeFileSync(
      path.join(work, ".gitignore"),
      [".gestalt.lock", "keyring.json", "index.json", "machine-id", ""].join("\n"),
      "utf8",
    );
  }
  git(work, ["add", "-A"]);
  // `-c` covers the identity-absent clone, whose whole point is that no identity
  // is configured — the fixture still needs its base commit.
  git(work, [
    "-c",
    "user.name=Fixture Setup",
    "-c",
    "user.email=setup@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  return work;
}

/**
 * A clone whose `main` and `other` branches both changed `topics/alpha.md`, so
 * merging, rebasing or cherry-picking one onto the other conflicts on demand.
 */
function makeDivergedClone(label: string): string {
  const work = makeStoreClone(label);
  git(work, ["checkout", "-q", "-b", "other"]);
  writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\ntheir body\n", "utf8");
  git(work, ["commit", "-q", "-am", "theirs"]);
  git(work, ["checkout", "-q", "main"]);
  writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nour body\n", "utf8");
  git(work, ["commit", "-q", "-am", "ours"]);
  return work;
}

/**
 * An environment in which git can see NO identity at all.
 *
 * How it is achieved, because it is not obvious and it is the difference between
 * a real proof and a test that passes only on a machine that happens to have no
 * global identity: the fixture repo simply never sets `user.name`/`user.email`
 * locally, and the child git process is handed `GIT_CONFIG_GLOBAL` pointed at an
 * empty file plus `GIT_CONFIG_NOSYSTEM=1`, which git documents as "read no
 * global / system configuration". The four `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * variables and `EMAIL` are deleted from the environment too, since git reads an
 * identity from those before it ever looks at config.
 */
function envWithoutIdentity(repo: string): NodeJS.ProcessEnv {
  const emptyGlobal = path.join(repo, "empty-global-gitconfig");
  writeFileSync(emptyGlobal, "", "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.EMAIL;
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  env.GIT_CONFIG_GLOBAL = emptyGlobal;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

// ── the tool itself ──────────────────────────────────────────────────────────

describe("gitAvailable", () => {
  it("finds the git binary this suite's own fixtures are built with", () => {
    // If this is false the rest of the file is meaningless, so it is asserted
    // rather than assumed — a missing git would otherwise turn every predicate
    // into its empty answer and the file would pass green having proved nothing.
    expect(gitAvailable()).toBe(true);
  });

  it("reports git as unavailable when PATH cannot reach it", () => {
    // The distinction this function exists for: "no git" must not be readable as
    // "no repo", or a pull contract exits 0 having synced nothing.
    const blinded: NodeJS.ProcessEnv = { ...process.env, PATH: "", Path: "" };
    expect(gitAvailable(blinded)).toBe(false);
  });
});

describe("isRepo", () => {
  it("says no to a directory that has never seen git", () => {
    const plain = freshHome("not-a-repo");
    mkdirSync(path.join(plain, "topics"), { recursive: true });
    writeFileSync(path.join(plain, "topics", "alpha.md"), "# alpha\n", "utf8");
    expect(isRepo(plain)).toBe(false);
  });

  it("says no to a path that does not exist", () => {
    expect(isRepo(path.join(freshHome("missing"), "nowhere"))).toBe(false);
  });

  it("says yes to a store clone of a bare -b main remote", () => {
    const work = makeStoreClone("clean");
    expect(isRepo(work)).toBe(true);
    // The -b main guard, asserted rather than trusted: a fixture whose clone and
    // remote disagree about the branch name is the false-pass this file exists
    // to avoid repeating.
    expect(git(work, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("main");
  });

  it("says no to a bare repo, which has no work tree to pull into", () => {
    expect(isRepo(makeRemote("bare"))).toBe(false);
  });

  it("says no to a plain directory that merely sits INSIDE a repo", () => {
    // The loose question ("are we inside a work tree?") answers yes here, and a
    // caller acting on that would report the enclosing repo's state as this
    // store's and pull someone else's project on top of it.
    const outer = makeStoreClone("enclosing");
    const nested = path.join(outer, "nested-store");
    mkdirSync(nested, { recursive: true });
    expect(isRepo(nested)).toBe(false);
    expect(isRepo(outer)).toBe(true);
  });
});

describe("inProgress", () => {
  it("reports null on a clean store with nothing half-finished", () => {
    expect(inProgress(makeStoreClone("clean"))).toBeNull();
  });

  it("reports null on a directory that is not a repo at all", () => {
    const plain = freshHome("not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(inProgress(plain)).toBeNull();
  });

  // The flavour that actually bit. The loose-directory case above passes even
  // without the isRepo guard, because there is no enclosing repo to misread —
  // so it states the invariant while pinning only the half where the code was
  // already right. A store nested inside a repo that git stopped mid-operation
  // is the half that was wrong, and it is the dangerous one: the caller turns
  // this answer into `--abort`, which would then abort the ENCLOSING repo's
  // operation. Both flavours are pinned here so the guard cannot be dropped.
  it("does not report an ENCLOSING repo's half-finished operation as its own", () => {
    for (const op of ["merge", "rebase"] as const) {
      const outer = makeDivergedClone(`nested-outer-${op}`);
      const r = git(outer, [op, "other"], { expectFail: true });
      expect(r.status).not.toBe(0);
      expect(inProgress(outer)).toBe(op);

      // A plain directory inside that stopped repo. It is not a store, and
      // nothing half-finished belongs to it.
      const nested = path.join(outer, "nested-store");
      mkdirSync(nested, { recursive: true });
      expect(isRepo(nested)).toBe(false);
      expect(inProgress(nested)).toBeNull();
    }
  });

  it("reports a rebase that git stopped on a conflict", () => {
    const work = makeDivergedClone("mid-rebase");
    const r = git(work, ["rebase", "other"], { expectFail: true });
    expect(r.status).not.toBe(0);
    // Proof the fixture is genuinely mid-operation and not merely asserted to be.
    expect(existsSync(path.join(work, ".git", "rebase-merge"))).toBe(true);
    expect(inProgress(work)).toBe("rebase");
  });

  it("reports a merge that git stopped on a conflict", () => {
    const work = makeDivergedClone("mid-merge");
    const r = git(work, ["merge", "other"], { expectFail: true });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(work, ".git", "MERGE_HEAD"))).toBe(true);
    expect(inProgress(work)).toBe("merge");
  });

  it("reports a cherry-pick that git stopped on a conflict", () => {
    const work = makeDivergedClone("mid-cherry-pick");
    const r = git(work, ["cherry-pick", "other"], { expectFail: true });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(work, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
    expect(inProgress(work)).toBe("cherry-pick");
  });

  it("names the rebase, not the cherry-pick, when a repo carries both markers", () => {
    // Precedence, pinned. The repo really is mid-rebase — git put it there — and
    // CHERRY_PICK_HEAD is then added by hand, because git 2.55 does not produce
    // that overlap itself (checked, for both `rebase` and `rebase -i`) while
    // other versions driving the same sequencer have. The wrong answer here is
    // not cosmetic: it sends the user to `git cherry-pick --abort`, which will
    // not get them out of a rebase.
    const work = makeDivergedClone("rebase-over-cherry-pick");
    git(work, ["rebase", "other"], { expectFail: true });
    expect(existsSync(path.join(work, ".git", "rebase-merge"))).toBe(true);
    writeFileSync(
      path.join(work, ".git", "CHERRY_PICK_HEAD"),
      `${git(work, ["rev-parse", "other"]).stdout.trim()}\n`,
      "utf8",
    );
    expect(inProgress(work)).toBe("rebase");
  });

  it("goes back to null once the half-finished operation is aborted", () => {
    const work = makeDivergedClone("aborted");
    git(work, ["merge", "other"], { expectFail: true });
    expect(inProgress(work)).toBe("merge");
    git(work, ["merge", "--abort"]);
    expect(inProgress(work)).toBeNull();
  });
});

describe("dirty", () => {
  it("reports nothing on a freshly committed store", () => {
    expect(dirty(makeStoreClone("clean"))).toEqual([]);
  });

  it("reports a tracked note that was edited in the work tree", () => {
    const work = makeStoreClone("dirty-tracked");
    writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nedited\n", "utf8");
    expect(dirty(work)).toEqual(["topics/alpha.md"]);
  });

  it("reports a tracked change that has been staged but not committed", () => {
    const work = makeStoreClone("dirty-staged");
    writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nstaged\n", "utf8");
    git(work, ["add", "topics/alpha.md"]);
    expect(dirty(work)).toEqual(["topics/alpha.md"]);
  });

  it("reports both sides of a rename without eating the original filename", () => {
    // The rename entry is two NUL fields, not one. Mis-parsed, the second field
    // is read as another status entry and three characters vanish off the front
    // of the old path — a refusal naming a file that does not exist.
    const work = makeStoreClone("dirty-rename");
    git(work, ["mv", "topics/alpha.md", "topics/beta.md"]);
    expect(dirty(work)).toEqual(["topics/alpha.md", "topics/beta.md"]);
  });

  it("does not call a store dirty when the derived and per-machine files are absent from .gitignore", () => {
    // THE case that would make every pull refuse on a healthy store, and the
    // one that actually discriminates `--untracked-files=no`. A store whose
    // `.gitignore` predates those lines — which is why the pull contract repairs
    // it — still has index.json, keyring.json and machine-id sitting in the work
    // tree. Nothing ignores them, so plain `--porcelain` lists all three as `??`
    // and the guard refuses on a store with no uncommitted work whatsoever.
    const work = makeStoreClone("dirty-no-gitignore", { gitignore: false });
    expect(existsSync(path.join(work, ".gitignore"))).toBe(false);
    writeFileSync(path.join(work, "index.json"), '{"topics":{}}\n', "utf8");
    writeFileSync(path.join(work, "keyring.json"), '{"kid":"deadbeef"}\n', "utf8");
    writeFileSync(path.join(work, "machine-id"), "windows-box\n", "utf8");
    expect(dirty(work)).toEqual([]);
  });

  it("does not call a store dirty when only gitignored per-machine files changed", () => {
    // The healthy-store version of the same thing: index.json is derived,
    // keyring.json and machine-id are per-machine, and `init` gitignores all
    // three precisely because they are never synced.
    const work = makeStoreClone("dirty-ignored-only");
    writeFileSync(path.join(work, "index.json"), '{"topics":{}}\n', "utf8");
    writeFileSync(path.join(work, "keyring.json"), '{"kid":"deadbeef"}\n', "utf8");
    writeFileSync(path.join(work, "machine-id"), "windows-box\n", "utf8");
    writeFileSync(path.join(work, ".gestalt.lock"), "", "utf8");
    expect(dirty(work)).toEqual([]);
    // And the same store WITH a real tracked edit still reports, so the empty
    // answer above is the gitignore working and not the predicate giving up.
    writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nreal edit\n", "utf8");
    expect(dirty(work)).toEqual(["topics/alpha.md"]);
  });

  it("does not count an untracked file, so a stray scratch file cannot block a pull", () => {
    const work = makeStoreClone("dirty-untracked");
    writeFileSync(path.join(work, "topics", "brand-new.md"), "# new\n", "utf8");
    expect(dirty(work)).toEqual([]);
  });

  it("reports nothing for a directory that is not a repo", () => {
    const plain = freshHome("not-a-repo");
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(plain, "loose.md"), "not under git\n", "utf8");
    expect(dirty(plain)).toEqual([]);
  });

  it("does not report the ENCLOSING repo's changes for a store nested inside it", () => {
    const outer = makeStoreClone("enclosing-dirty");
    writeFileSync(path.join(outer, "topics", "alpha.md"), "# alpha\n\nouter edit\n", "utf8");
    const nested = path.join(outer, "nested-store");
    mkdirSync(nested, { recursive: true });
    expect(dirty(outer)).toEqual(["topics/alpha.md"]);
    expect(dirty(nested)).toEqual([]);
  });
});

describe("conflicted", () => {
  it("reports nothing on a clean store", () => {
    expect(conflicted(makeStoreClone("clean"))).toEqual([]);
  });

  it("reports the unmerged path git left behind after a failed merge", () => {
    const work = makeDivergedClone("conflicted");
    git(work, ["merge", "other"], { expectFail: true });
    expect(conflicted(work)).toEqual(["topics/alpha.md"]);
    // The same file is uncommitted work too — the two predicates overlap on
    // purpose, and a caller that only asked `dirty` would still refuse.
    expect(dirty(work)).toEqual(["topics/alpha.md"]);
  });

  it("reports the unmerged path during a stopped rebase as well as a merge", () => {
    const work = makeDivergedClone("conflicted-rebase");
    git(work, ["rebase", "other"], { expectFail: true });
    expect(conflicted(work)).toEqual(["topics/alpha.md"]);
  });

  it("goes back to empty once the conflict is resolved and staged", () => {
    const work = makeDivergedClone("conflict-resolved");
    git(work, ["merge", "other"], { expectFail: true });
    expect(conflicted(work)).toEqual(["topics/alpha.md"]);
    writeFileSync(path.join(work, "topics", "alpha.md"), "# alpha\n\nresolved\n", "utf8");
    git(work, ["add", "topics/alpha.md"]);
    expect(conflicted(work)).toEqual([]);
    // Still mid-merge, though — resolving is not finishing, and the pull
    // contract must not read an empty conflict list as "nothing to do".
    expect(inProgress(work)).toBe("merge");
  });

  it("reports nothing for a directory that is not a repo", () => {
    const plain = freshHome("not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(conflicted(plain)).toEqual([]);
  });
});

describe("hasIdentity", () => {
  it("reads back the identity configured on the store repo", () => {
    const work = makeStoreClone("identity-present");
    const id = hasIdentity(work);
    expect(id.name).toBe("Fixture Machine");
    expect(id.email).toBe("fixture@example.invalid");
    expect(id.configured).toBe(true);
    expect(id.canCommit).toBe(true);
    expect(id.reason).toBeNull();
  });

  it("reports no configured identity when neither config nor environment has one", () => {
    const work = makeStoreClone("identity-absent", { identity: false });
    const id = hasIdentity(work, envWithoutIdentity(work));
    expect(id.name).toBeNull();
    expect(id.email).toBeNull();
    expect(id.configured).toBe(false);
  });

  it("agrees with whether git will actually let this machine commit", () => {
    // The assertion that cannot false-pass on any platform. `canCommit` is NOT
    // portable as a constant: on Windows an unconfigured git refuses outright,
    // while many Linux and macOS boxes let it invent `user@host.(none)` and
    // commit anyway. Asserting `false` here would be a Windows-only truth that
    // goes green-but-wrong on the CI legs. So the test pins the predicate to
    // git's own behaviour instead: whatever `canCommit` says, a real commit
    // attempted in the same repo with the same environment must do the same.
    const work = makeStoreClone("identity-vs-commit", { identity: false });
    const env = envWithoutIdentity(work);
    const id = hasIdentity(work, env);

    const attempt = git(work, ["commit", "--allow-empty", "-q", "-m", "probe"], {
      env,
      expectFail: true,
    });
    const gitLetItCommit = attempt.status === 0;
    expect(id.canCommit).toBe(gitLetItCommit);
    if (!id.canCommit) {
      // A refusal is only useful if it can be quoted back at the user.
      expect(id.reason).toBeTruthy();
      expect(attempt.stderr + attempt.stdout).toMatch(/identity|user\.email/i);
    }
  });

  it("says a machine git refuses to commit as cannot commit, on every platform", () => {
    // Engineered for portability on purpose. The test above pins `canCommit` to
    // whatever git does HERE, which is the honest thing to assert — but its
    // power to catch a wrong answer is not portable: on Windows an
    // unconfigured git refuses outright, while many Linux and macOS boxes
    // invent `user@host.(none)` and commit happily, so on those legs
    // `gitLetItCommit` is true and an implementation that hardcoded
    // `canCommit: true` would sail through. (Measured, not assumed: that mutant
    // is caught by exactly one test on this box.)
    //
    // `user.useConfigOnly` is git's own switch for "never guess an identity",
    // so this fixture is a machine git will refuse to commit as no matter which
    // OS or hostname the suite runs on, and the assertion is a flat `false`.
    const work = makeStoreClone("identity-no-autodetect", { identity: false });
    git(work, ["config", "user.useConfigOnly", "true"]);
    const env = envWithoutIdentity(work);

    const id = hasIdentity(work, env);
    expect(id.canCommit).toBe(false);
    expect(id.configured).toBe(false);
    expect(id.reason).toBeTruthy();

    // And it is git's refusal being reported, not one this module invented:
    // the real commit fails too. Without this pairing the assertion above only
    // proves the fixture was built as described.
    const attempt = git(work, ["commit", "--allow-empty", "-q", "-m", "probe"], {
      env,
      expectFail: true,
    });
    expect(attempt.status).not.toBe(0);
  });

  it("says a machine WITH a configured identity can commit even when git may not guess", () => {
    // The other direction of the same fixture, so the assertion above is the
    // identity being absent and not `useConfigOnly` making everything false.
    const work = makeStoreClone("identity-config-only", { identity: false });
    git(work, ["config", "user.useConfigOnly", "true"]);
    git(work, ["config", "user.name", "Config Only"]);
    git(work, ["config", "user.email", "configonly@example.invalid"]);
    const id = hasIdentity(work, envWithoutIdentity(work));
    expect(id.canCommit).toBe(true);
    expect(id.configured).toBe(true);
    expect(id.email).toBe("configonly@example.invalid");
  });

  it("honours an identity supplied through the environment rather than config", () => {
    // Config-only reading would refuse a machine that git is perfectly happy
    // with — a false refusal is as damaging to a guard's credibility as a miss.
    const work = makeStoreClone("identity-from-env", { identity: false });
    const env = envWithoutIdentity(work);
    env.GIT_AUTHOR_NAME = "Env Person";
    env.GIT_AUTHOR_EMAIL = "env@example.invalid";
    env.GIT_COMMITTER_NAME = "Env Person";
    env.GIT_COMMITTER_EMAIL = "env@example.invalid";
    const id = hasIdentity(work, env);
    expect(id.canCommit).toBe(true);
    // ...and it is still reported as UNCONFIGURED, because nothing was written
    // to config. The pull contract wants both facts: it may commit, but it
    // should still be told to set `user.email` for the next machine.
    expect(id.configured).toBe(false);
  });

  it("answers for a path that does not exist without pretending the identity is missing", () => {
    // A mistyped home must not be reported as "you never set user.email" and
    // send the user off to fix a setting that was never wrong.
    const missing = path.join(freshHome("identity-missing-home"), "nowhere");
    const id = hasIdentity(missing);
    expect(typeof id.canCommit).toBe("boolean");
    expect(id.configured).toBe(id.name !== null && id.email !== null);
  });
});
