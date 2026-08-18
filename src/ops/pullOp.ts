import { spawnSync } from "node:child_process";
import { resolveHome } from "../paths.js";
import { GestaltError } from "../errors.js";
import { reindexStore } from "./reindexOp.js";
import { ensureStoreUnlocked } from "./unlockOp.js";
import {
  conflicted,
  dirty,
  ensureGitAttributes,
  gitAvailable,
  hasIdentity,
  inProgress,
  isRepo,
  type GitOperation,
} from "./gitState.js";
import type { StoreIndex } from "../store/index.js";
import type { Warning } from "../errors.js";

/**
 * `fimemory pull` — bring a peer's writes into this store, then rebuild the
 * derived catalog. index.json is gitignored, so a bare `git pull` leaves search
 * blind and lets the next log entry reuse a timestamp that already arrived.
 *
 * WHY THIS IS NOT `git pull --rebase --autostash` ANY MORE.
 *
 * It used to be exactly that, and it had two failure modes that a user could
 * not see. First, rebase is the wrong strategy for this store: the union merge
 * drivers in .gitattributes are MERGE drivers, so a rebase does not use them
 * and a dual append to one log conflicts instead of merging. Second, and worse,
 * `--autostash` returns exit 0 when the rebase fast-forwards but re-applying
 * the stash conflicts. The old runner only read stderr on the non-zero branch,
 * so git's "your local changes are stashed, however applying them resulted in
 * conflicts" went in the bin, the command printed a cheerful "Pulled store",
 * and the note on disk now contained <<<<<<< markers that `get` would hand to a
 * model as authoritative memory.
 *
 * So: merge, never rebase. Refuse a dirty tree rather than stashing it. And
 * never trust the exit code alone — the post-conditions are checked directly.
 */
export interface PullOptions {
  home?: string;
  /** Skip the git step (tests that already simulated a pull). */
  skipGit?: boolean;
  /** Injected git runner for tests. */
  gitPull?: (home: string) => { ok: boolean; message: string };
  env?: NodeJS.ProcessEnv;
  /** Abort a half-finished merge or rebase instead of pulling. */
  abort?: boolean;
}

export interface PullResult {
  home: string;
  pulled: boolean;
  gitMessage: string;
  index: StoreIndex;
  warnings: Warning[];
  steps: string[];
  /** Paths git could not merge on its own, after any resolution ran. */
  unresolved: string[];
  /** True when a merge commit was created locally and is not yet pushed. */
  needsPush: boolean;
}

/** Everything git printed, both streams, because either can carry the reason. */
function runGit(
  home: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: home, encoding: "utf8", env });
  const out = [r.stdout ?? "", r.stderr ?? ""].join("").trim();
  return { status: r.status ?? 1, out };
}

function abortRemedy(op: GitOperation): string {
  return `fimemory pull --abort  (runs git ${op} --abort)`;
}

/**
 * Undo a half-finished merge/rebase/cherry-pick and say what was left behind.
 *
 * Deliberately mentions any leftover stash: an older build of this command used
 * --autostash, so a user upgrading into this one can be carrying uncommitted
 * notes inside a stash entry that nothing else will ever mention to them.
 */
export function abortPull(home: string, env: NodeJS.ProcessEnv): string[] {
  const steps: string[] = [];
  const op = inProgress(home, env);
  if (op === null) {
    steps.push("nothing to abort — no merge, rebase or cherry-pick in progress");
  } else {
    const r = runGit(home, [op, "--abort"], env);
    if (r.status !== 0) {
      throw new GestaltError(
        "E_IO",
        `git ${op} --abort failed in ${home}: ${r.out}`,
        "Inspect the repository by hand; the store was left as git found it.",
      );
    }
    steps.push(`aborted the in-progress ${op}`);
  }
  const stash = runGit(home, ["stash", "list"], env);
  if (stash.status === 0 && stash.out) {
    steps.push(
      `NOTE: this store has stashed changes that no FIMemory command created:\n${stash.out}\n` +
        `Recover them with \`git -C ${home} stash pop\` before they are forgotten.`,
    );
  }
  return steps;
}

export async function pullStore(opts: PullOptions = {}): Promise<PullResult> {
  const home = opts.home ?? resolveHome();
  const env = opts.env ?? process.env;
  const steps: string[] = [];
  let pulled = false;
  let gitMessage = "skipped";
  let needsPush = false;
  let unresolved: string[] = [];

  if (opts.abort) {
    steps.push(...abortPull(home, env));
    const { index, warnings } = await reindexStore(home);
    return { home, pulled: false, gitMessage: "aborted", index, warnings, steps, unresolved: [], needsPush: false };
  }

  if (!opts.skipGit && !opts.gitPull) {
    // 1 — unlock BEFORE git. A resolver that runs without a DEK on a sealed
    // store either writes plaintext into ciphertext or dies mid-merge with
    // markers already on disk. Refusing here costs the user nothing: git has
    // not been touched yet, so there is no half-state to explain.
    ensureStoreUnlocked(home);

    if (!gitAvailable(env)) {
      throw new GestaltError(
        "E_IO",
        "git is not on PATH, so this store cannot be synced.",
        "Install git, or copy the store directory by hand.",
      );
    }

    // 2 — a store that was never a git repo is not an error worth a stack
    // trace. Say the true thing: there is nothing to pull.
    if (!isRepo(home, env)) {
      throw new GestaltError(
        "E_IO",
        `${home} is not a git repository, so there is nothing to pull.`,
        "Multi-machine sync is opt-in: `fimemory join <git-url>` on the second machine, " +
          "or `git init` + a remote here if this is the first.",
      );
    }

    // 3 — refuse to start on top of a half-finished operation.
    const op = inProgress(home, env);
    if (op !== null) {
      throw new GestaltError(
        "E_IO",
        `this store is in the middle of a ${op}, so pulling would compound it.`,
        abortRemedy(op),
      );
    }

    // 4 — refuse a dirty tree instead of stashing it. Stash-on-a-failed-merge
    // is how people lose uncommitted notes, and the store's own gitignored
    // files (index.json, keyring.json, machine-id) must not count as dirty or
    // every pull on a healthy store would refuse.
    //
    // This runs BEFORE the .gitattributes repair, and the order is load-bearing.
    // Repairing first was measured making the store dirty: adding `* -text` to a
    // worktree that git checked out under core.autocrlf=true — the Windows
    // default — switches comparison to literal bytes, so every CRLF-on-disk file
    // instantly differs from its LF blob. The repair meant to prevent phantom
    // dirt was manufacturing it, and the guard below then refused every pull
    // forever. Read the tree under the rules it was checked out with.
    const modified = dirty(home, env);
    if (modified.length > 0) {
      throw new GestaltError(
        "E_IO",
        `this store has uncommitted changes, so pulling could bury them:\n  ${modified.join("\n  ")}`,
        "Commit them first (`git -C " +
          home +
          " add -A && git commit -m \"local notes\"`), then pull again.",
      );
    }

    // 5 — finishing a merge needs an author, and cloning does not. A stranger
    // whose git identity is unset would otherwise get a resolved worktree, a
    // failed commit, and the exact wedge this command exists to prevent.
    // canCommit, not `configured`: it is the module's own answer to "could this
    // machine finish a merge", and it carries git's refusal text when it cannot.
    const id = hasIdentity(home, env);
    if (!id.canCommit) {
      throw new GestaltError(
        "E_IO",
        "git has no author identity here, so a merge could not be committed." +
          (id.reason ? `\ngit says: ${id.reason}` : ""),
        `Set one, then pull again:\n  git -C ${home} config user.name "Your Name"\n` +
          `  git -C ${home} config user.email "you@example.com"`,
      );
    }

    // 6 — NOW repair .gitattributes, with the tree known clean. The union
    // drivers must be in place before the merge below, or a dual append to one
    // log conflicts instead of union-merging — that is the whole reason this
    // step exists.
    //
    // Adding `* -text` can flip a worktree checked out under core.autocrlf to
    // "modified" (see the note on the dirty guard above). Because we have just
    // proven the tree was clean, any difference that appears now is purely the
    // line-ending reinterpretation and nothing of the user's is at stake — so
    // renormalize and commit it, rather than leaving a store that reads dirty
    // to every future pull and can never sync again.
    const repaired = ensureGitAttributes(home);
    if (repaired.length > 0) {
      steps.push(`repaired .gitattributes (added: ${repaired.join(", ")})`);
      runGit(home, ["add", "--renormalize", "."], env);
      runGit(home, ["add", ".gitattributes"], env);
      const staged = runGit(home, ["diff", "--cached", "--name-only"], env);
      if (staged.status === 0 && staged.out) {
        const c = runGit(
          home,
          ["commit", "-m", "fimemory: add store merge rules and normalize line endings"],
          env,
        );
        steps.push(
          c.status === 0
            ? "committed the merge rules (and any line endings they renormalized)"
            : `could not commit the merge rules: ${c.out}`,
        );
      }
    }
  }

  if (!opts.skipGit) {
    const runner =
      opts.gitPull ??
      ((h: string) => {
        // MERGE, not rebase: the union drivers in .gitattributes are merge
        // drivers, and a rebase silently bypasses them.
        const r = runGit(h, ["pull", "--no-rebase", "--no-edit"], env);
        return { ok: r.status === 0, message: r.out || (r.status === 0 ? "pulled" : `git pull failed (${r.status})`) };
      });
    const result = runner(home);
    gitMessage = result.message;

    // Post-conditions, checked directly rather than inferred from the exit
    // code. This is the lesson of the --autostash bug: git can exit 0 having
    // left the worktree in a state no user would call success.
    unresolved = opts.gitPull ? [] : conflicted(home, env);

    // Resolve rather than refuse. Until this was wired the command threw here
    // and left <<<<<<< on disk, which made the product rule — never drop a
    // side, never leave a marker, a human picks — true of the resolver and
    // false of the only command anybody runs.
    //
    // The resolver reads both sides from git's INDEX STAGES, never the
    // conflicted worktree file (which by now has markers spliced through it,
    // and on a sealed store is two ciphertext blobs wrapped around them). It
    // keeps the note with the newer `updated:` and mints the loser as an
    // ordinary pending proposal. Its refusals are GestaltErrors with
    // copy-pastable hints, so they propagate untouched.
    let resolvedConflicts = false;
    if (unresolved.length > 0) {
      const { resolveConflicts } = await import("./resolveConflicts.js");
      const res = await resolveConflicts(home, { env });
      steps.push(...res.steps);
      // Advisories carry the things a user cannot discover on their own — most
      // importantly that a proposal whose owner-notes differ needs
      // --allow-owner-notes, because the YAML bit on the proposal is advisory
      // and approve gates on the option.
      steps.push(...res.advisories);

      const commit = runGit(home, ["commit", "--no-edit"], env);
      if (commit.status !== 0) {
        throw new GestaltError(
          "E_IO",
          `resolved every conflict but could not commit the merge: ${commit.out}`,
          `The resolution is staged and nothing is lost. Commit it by hand, or undo the ` +
            `whole pull with \`${abortRemedy("merge")}\`.`,
        );
      }
      unresolved = conflicted(home, env);
      resolvedConflicts = true;
    }

    // Whatever git or the resolver left behind, say so rather than reporting
    // success over it.
    const stillStuck = opts.gitPull ? null : inProgress(home, env);
    if (unresolved.length > 0 || stillStuck !== null) {
      throw new GestaltError(
        "E_IO",
        `pull left this store mid-${stillStuck ?? "merge"} with ${unresolved.length} file(s) that could not be merged:\n  ` +
          unresolved.join("\n  "),
        `Undo the whole pull with \`${abortRemedy(stillStuck ?? "merge")}\`. ` +
          `Nothing you had already committed is lost either way.`,
      );
    }

    // `git pull` exits NON-ZERO on a conflict, which is now an ordinary outcome
    // rather than a failure: the resolver has just handled it and committed the
    // merge. Treating that exit code as fatal here would refuse a pull that in
    // fact succeeded — the mirror image of the --autostash bug, where a zero
    // exit was trusted over a broken worktree. The exit code is evidence, not a
    // verdict, in both directions; the verdict is whether anything is still
    // unmerged, which was just checked.
    if (!result.ok && !resolvedConflicts) {
      throw new GestaltError(
        "E_IO",
        `git pull failed in ${home}: ${result.message}`,
        "Fix the error above, then re-run `fimemory pull`.",
      );
    }

    pulled = true;
    steps.push(`git pull: ${gitMessage}`);

    // A merge commit lives only here until somebody pushes it. There is no
    // `fimemory push` and that is fine, but silence here is how two machines
    // sit "merged" and still disagree.
    if (!opts.gitPull) {
      const ahead = runGit(home, ["rev-list", "--count", "@{upstream}..HEAD"], env);
      needsPush = ahead.status === 0 && (Number(ahead.out) || 0) > 0;
      if (needsPush) {
        steps.push(`local commits not yet shared — run: git -C ${home} push`);
      }
    }
  } else {
    steps.push("git pull skipped");
  }

  // Reindex LAST, and only over a clean tree: a catalog built from unparsable
  // notes makes search lie, which is worse than search being stale.
  const { index, warnings } = await reindexStore(home);
  steps.push(
    `reindex: ${Object.keys(index.topics).length} topic(s), lastTimestamp=${index.lastTimestamp ?? "null"}`,
  );

  return { home, pulled, gitMessage, index, warnings, steps, unresolved, needsPush };
}
