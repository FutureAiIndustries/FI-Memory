import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { pullStore } from "../src/ops/pullOp.js";
import { freshHome, runCli } from "./helpers.js";

/**
 * THE DISPATCH LAYER, TESTED FROM OUTSIDE THE PROCESS.
 *
 * Everything else in this suite calls ops directly. That is fast and it is also
 * a blind spot with a shape: whatever `cli.ts` does BETWEEN the argv and the op
 * — pick the verb, await it, translate a throw into an exit code and a sentence
 * a human can act on — is executed by no test at all. `pullStore` is the exhibit:
 * its single test passes `skipGit: true`, so the git command the CLI actually
 * issues has never run in CI, and neither has the failure path around it.
 *
 * These tests are slower than unit tests by two orders of magnitude (~0.4 s of
 * process startup each, ~10 spawns in this file) and that is the whole price of
 * admission — you cannot observe an exit code from inside the process that sets
 * it. The count is kept deliberately small; add a spawn here only for something
 * an in-process call genuinely cannot see.
 */

/** A store created WITHOUT the CLI, so the CLI stays the thing under test. */
function seeded(label = "cli-spawn"): string {
  const home = freshHome(label);
  runInit({ home });
  return home;
}

/**
 * The fingerprint of an error that escaped to Node's default handler: the
 * `at fn (file:line:col)` frames and the `Node.js vNN` footer it prints on the
 * way out. Either one on stderr means the CLI threw rather than reported — the
 * user gets a stack where a remedy belongs, and worse, the exit code stops being
 * something the CLI chose.
 */
function readsAsNodeCrash(stderr: string): boolean {
  return /^\s+at .+:\d+:\d+\)?/m.test(stderr) || /\bNode\.js v\d+/.test(stderr);
}

describe("CLI spawn harness — isolation is enforced, not assumed", () => {
  it("refuses to spawn against a home outside the test run-root, however it is spelled", () => {
    const realStore = path.resolve(os.homedir(), ".gestalt");
    // Both routes to a home, because a guard that only checked the first one
    // would wave through the second — and the second is a plain `env` override,
    // the spelling a test reaches for when it wants to simulate a real user.
    expect(() => runCli(["status"], { home: realStore })).toThrow(/outside the test run-root/);
    expect(() => runCli(["status"], { env: { GESTALT_HOME: realStore } })).toThrow(
      /outside the test run-root/,
    );
    expect(() => runCli(["status"], { env: { GESTALT_HOME: undefined } })).toThrow(
      /outside the test run-root/,
    );
  });

  it("clears an ambient GESTALT_PASSPHRASE so a developer's exported secret cannot decide a test", () => {
    const home = seeded();
    const ambient = process.env.GESTALT_PASSPHRASE;
    process.env.GESTALT_PASSPHRASE = "an ambient passphrase this box happens to export";
    try {
      // `encrypt` reads GESTALT_PASSPHRASE when no --passphrase is given. If the
      // parent's value leaked in, this store would come back ENCRYPTED with a
      // secret the test never chose — and every later assertion about a
      // plaintext store would be measuring the developer's environment.
      const r = runCli(["encrypt"], { home });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Encrypting a store needs a passphrase.");
    } finally {
      if (ambient === undefined) delete process.env.GESTALT_PASSPHRASE;
      else process.env.GESTALT_PASSPHRASE = ambient;
    }
  });

  it("passes an explicit env override through to the child (so the clearing above is not vacuous)", () => {
    const home = seeded();
    // Same verb, same store, one variable set — and it changes the answer. A
    // deliberately too-short value so this costs a validation check rather than
    // a 1.5 s Argon2id derivation.
    const r = runCli(["encrypt"], { home, env: { GESTALT_PASSPHRASE: "abc" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("too weak");
  });
});

describe("CLI dispatch — exit codes and streams the in-process suite cannot see", () => {
  it("a verb that succeeds exits 0, names what it did on stdout, and leaves the store on disk", () => {
    const home = freshHome("cli-init");
    const r = runCli(["init", "--no-seed", "--plaintext"], { home });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`Created your store at ${home}`);
    // The exit code is a claim about the world; check the world separately.
    // "exit 0 while nothing happened" is precisely the defect class this file
    // exists for, and it is invisible to a test that only reads the op's return.
    expect(existsSync(path.join(home, "config.json"))).toBe(true);
  });

  it("0.5: bare `init` with no TTY and no passphrase fails CLOSED naming both remedies — never a silent plaintext store", () => {
    const home = freshHome("cli-init-refuse");
    const r = runCli(["init", "--no-seed"], { home });

    expect(r.code).not.toBe(0);
    expect(readsAsNodeCrash(r.stderr)).toBe(false);
    expect(r.stderr).toContain("encrypted by default");
    expect(r.stderr).toContain("--plaintext");
    expect(r.stderr).toContain("GESTALT_PASSPHRASE");
    // Fail closed means NOTHING on disk — a refusal that leaves a skeleton is
    // the store_half_created defect all over again.
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
  });

  it("0.5: bare `init` with FIMEMORY_PASSPHRASE in the env creates an ENCRYPTED store and prints the phrase once", { timeout: 30_000 }, () => {
    // The new name, end to end: before 0.5 the one verb that CREATES a store
    // honoured only the legacy GESTALT_PASSPHRASE. Full Argon2id here (~1.5 s)
    // — the CLI exposes no tiny-params override, by design.
    const home = freshHome("cli-init-envpass");
    const r = runCli(["init", "--no-seed"], {
      home,
      env: { FIMEMORY_PASSPHRASE: "a perfectly sturdy spawn passphrase" },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Created your ENCRYPTED store");
    expect(r.stdout).toContain("WRITE THIS DOWN");
    expect(existsSync(path.join(home, "keyring.json"))).toBe(true);
    expect(existsSync(path.join(home, "store.enc"))).toBe(true);
  });

  it("0.5: --encrypted --plaintext is refused as the contradiction it is", () => {
    const home = freshHome("cli-init-contradict");
    const r = runCli(["init", "--encrypted", "--plaintext", "--no-seed"], { home });

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("contradict");
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
  });

  it("0.5: `setup --plaintext` still says the plaintext cost out loud in next steps", { timeout: 60_000 }, () => {
    // setup's fork surface, spawned: the opt-out works AND the standing cost
    // is stated (the old world nudged plaintext users toward encrypt as an
    // upsell; the new world names what they chose). Every host-config path a
    // spawned setup could write goes through the redirected user home — a
    // bare spawn would edit the DEVELOPER'S real host configs.
    const home = freshHome("cli-setup-plain");
    const userHome = freshHome("cli-setup-plain-user");
    mkdirSync(userHome, { recursive: true });
    const r = runCli(["setup", "--plaintext", "--no-seed"], {
      home,
      timeoutMs: 55_000,
      env: {
        HOME: userHome,
        USERPROFILE: userHome,
        APPDATA: path.join(userHome, "AppData"),
        LOCALAPPDATA: path.join(userHome, "AppData", "Local"),
        CODEX_HOME: path.join(userHome, ".codex"),
        GEMINI_CLI_HOME: path.join(userHome, ".gemini"),
        GROK_HOME: path.join(userHome, ".grok"),
      },
    });

    expect(existsSync(path.join(home, "config.json"))).toBe(true);
    expect(existsSync(path.join(home, "keyring.json"))).toBe(false);
    expect(r.stdout).toContain("PLAINTEXT");
  });

  it("resolves a relative --plaintext destination against the CHILD's cwd, not the test runner's", () => {
    const home = seeded();
    const work = path.join(freshHome("cli-cwd"), "work");
    mkdirSync(work, { recursive: true });

    // Every op-level export test passes an absolute dest, so "what does a
    // relative path mean here" is answered only by the process's cwd — which
    // only exists once there IS a process.
    const r = runCli(["export", "--plaintext", "out"], { home, cwd: work });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(path.join(work, "out"));
    expect(readdirSync(path.join(work, "out")).sort()).toEqual(["logs", "proposals", "topics"]);
  });

  it("a verb given a bad argument exits non-zero with a message and a remedy, not a stack trace", () => {
    const home = seeded();
    const r = runCli(["cat", "no-such-topic"], { home });

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('No topic "no-such-topic".');
    // The hint is the actionable half, and it is the half a raw throw loses.
    expect(r.stderr).toContain("fimemory list");
    expect(readsAsNodeCrash(r.stderr)).toBe(false);
  });

  it("an unknown verb exits non-zero and prints the usage block, not a stack trace", () => {
    const r = runCli(["frobnicate"], { home: seeded() });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown command: frobnicate");
    expect(r.stderr).toContain("FIMemory — your shared memory for AI tools");
    expect(r.stderr).toContain("search <words...>"); // the usage block, not just its title
    expect(readsAsNodeCrash(r.stderr)).toBe(false);
  });

  it("FINDING (unowned): `review` drops its await, so its errors escape as raw Node stack traces", () => {
    const home = seeded();
    // `case "review": return reviewCommand(args, homePath);` — cli.ts:1155.
    // `return promise` inside a `try` does NOT run the catch: the rejection is
    // adopted by main's caller, which is the bare `process.exit(await main(...))`
    // at cli.ts:2380. So main's error handler (cli.ts:2079, the one that renders
    // `message` + `→ hint` and returns 1) never sees a review failure. Every
    // other verb in the switch is awaited; this one is not.
    //
    // Confirmed live: the frames printed are `notFoundProposal` → `reviewShow` →
    // `reviewCommand` → `<anonymous>` — main is ABSENT from the stack, which is
    // the missing `await` showing itself.
    //
    // NOT FIXED HERE — it belongs to another work package. When the `await`
    // lands, this test flips to the two lines commented below and the `it` name
    // loses its FINDING prefix.
    const r = runCli(["review", "show", "abc"], { home });

    expect(r.code).not.toBe(0);
    expect(readsAsNodeCrash(r.stderr)).toBe(true);
    expect(r.stderr).toContain("GestaltError: No proposal #NaN.");
    // After the fix:
    //   expect(readsAsNodeCrash(r.stderr)).toBe(false);
    //   expect(r.stderr).toContain("fimemory review list");   // the hint, rendered
  });
});

describe("op vs CLI — the same store, two verdicts (the reason this file exists)", () => {
  it("`pullStore(skipGit)` reports success on a store the real `pull` verb cannot pull at all", async () => {
    const home = seeded("cli-pull");

    // (1) THE OP, called exactly as the suite's only pullStore test calls it.
    // Green: no throw, an index rebuilt, no warnings. Nothing here suggests the
    // verb is broken for this store, because `skipGit` deletes the only part
    // that could be.
    const op = await pullStore({ home, skipGit: true });
    expect(op.pulled).toBe(false);
    expect(op.gitMessage).toBe("skipped");
    expect(op.warnings).toEqual([]);
    expect(Object.keys(op.index.topics).length).toBeGreaterThan(0);

    // (2) THE VERB, same store, same moment. Non-zero, because a store created
    // by `fimemory init` is not a git repository and `pull` shells out to one.
    // The op cannot express this outcome — with `skipGit` the git runner is
    // never constructed — so no in-process test can reach it.
    const cli = runCli(["pull"], { home });
    expect(cli.code).toBe(1);
    // UPDATED when the pull contract landed. This assertion used to pin
    // `git pull failed in <home>` plus a "fimemory reindex" remedy — a relayed
    // git complaint that told the reader the command had failed without telling
    // them why, and offered a remedy for the wrong problem. The verb now names
    // the actual situation: this store was never a git repository, so there is
    // nothing to pull, and the remedy is how to opt into sync. The
    // characterisation test did its job — it went red the moment the behaviour
    // it documented changed.
    expect(cli.stderr).toContain("is not a git repository");
    expect(cli.stderr).toContain("fimemory join"); // the remedy that actually applies

    // Matched loosely on purpose: WHICH git complaint comes back depends on
    // where the run-root lands (a bare temp dir vs. one that happens to sit
    // under a repo). What matters is that a real `git` ran and said no —
    // pullOp's own "git pull failed (null)" placeholder, which is what appears
    // when git never started at all, is excluded by this pattern.
    expect(cli.stderr).toMatch(/not a git repository|no tracking information/i);
  });

  it("`pull --json` breaks the machine-readable error contract every other verb keeps", () => {
    const home = seeded("cli-pull-json");

    // The contract, demonstrated on a verb that keeps it: main's handler
    // (cli.ts:2081) emits `{code, message, hint}` on stderr whenever --json is set.
    const control = runCli(["status", "--json"], { home: freshHome("cli-absent") });
    expect(control.code).toBe(1);
    expect(JSON.parse(control.stderr)).toMatchObject({
      code: "E_NOT_FOUND",
      hint: expect.stringContaining("fimemory init"),
    });

    // `pull` catches its own GestaltError first (cli.ts:2042) and hard-codes the
    // human rendering, so --json is silently ignored on the failure path. An
    // agent or script that parses stderr gets a sentence with an arrow in it.
    // `join` (cli.ts:2011) has the identical shape.
    const r = runCli(["pull", "--json"], { home });
    expect(r.code).toBe(1);
    expect(() => JSON.parse(r.stderr) as unknown).toThrow();
    // The message moved when the pull contract landed (it now names the real
    // situation instead of relaying a git complaint), but the FINDING is
    // unchanged and still unowned: --json is ignored on this failure path, so a
    // script parsing stderr gets prose either way. Assert the current text so
    // this keeps failing the day someone fixes the contract.
    expect(r.stderr).toContain("is not a git repository");
  });
});
