import { spawnSync } from "node:child_process";
import { resolveHome } from "../paths.js";
import { GestaltError } from "../errors.js";
import { reindexStore } from "./reindexOp.js";
import type { StoreIndex } from "../store/index.js";
import type { Warning } from "../errors.js";

/**
 * `fimemory pull` — git pull the store remote, then rebuild the derived
 * catalog + monotonic watermark. index.json is gitignored, so a plain
 * `git pull` alone leaves search blind and the next log entry able to
 * reuse a timestamp that already arrived from a peer.
 */
export interface PullOptions {
  home?: string;
  /** Skip the git step (tests that already simulated a pull). */
  skipGit?: boolean;
  /** Injected git runner for tests. */
  gitPull?: (home: string) => { ok: boolean; message: string };
  env?: NodeJS.ProcessEnv;
}

export interface PullResult {
  home: string;
  pulled: boolean;
  gitMessage: string;
  index: StoreIndex;
  warnings: Warning[];
  steps: string[];
}

export async function pullStore(opts: PullOptions = {}): Promise<PullResult> {
  const home = opts.home ?? resolveHome();
  const steps: string[] = [];
  let pulled = false;
  let gitMessage = "skipped";

  if (!opts.skipGit) {
    const runner =
      opts.gitPull ??
      ((h: string) => {
        const r = spawnSync("git", ["pull", "--rebase", "--autostash"], {
          cwd: h,
          encoding: "utf8",
          env: opts.env ?? process.env,
        });
        if (r.status !== 0) {
          return {
            ok: false,
            message: (r.stderr || r.stdout || `git pull failed (${r.status})`).trim(),
          };
        }
        return { ok: true, message: (r.stdout || "pulled").trim() };
      });
    const result = runner(home);
    if (!result.ok) {
      throw new GestaltError(
        "E_IO",
        `git pull failed in ${home}: ${result.message}`,
        "Resolve the git error, then re-run `fimemory pull` (or `git pull` + `fimemory reindex`).",
      );
    }
    pulled = true;
    gitMessage = result.message;
    steps.push(`git pull: ${gitMessage}`);
  } else {
    steps.push("git pull skipped");
  }

  // Always reindex: refreshes catalog + lastTimestamp watermark from logs.
  const { index, warnings } = await reindexStore(home);
  steps.push(
    `reindex: ${Object.keys(index.topics).length} topic(s), lastTimestamp=${index.lastTimestamp ?? "null"}`,
  );

  return { home, pulled, gitMessage, index, warnings, steps };
}
