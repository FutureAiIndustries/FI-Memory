/**
 * Doctor's cross-machine merge health checks (0.3.0 W-H).
 *
 * These four findings exist because 0.3.0 makes the store MERGE between
 * machines, and every half-merged state it can land in looks healthy from the
 * inside: a note carrying `<<<<<<<` still parses, still indexes, and still
 * comes back out of `search` as settled memory.
 *
 * Every fixture here is a REAL store built by `runInit` and, where git is
 * involved, a REAL repository driven by the real `git` binary into the state
 * being asserted — the mid-merge repo is produced by merging until git stops,
 * not by touching `.git/MERGE_HEAD` into existence. A hand-faked marker proves
 * the check can read a file; it does not prove it recognises what git leaves
 * behind. Every remote is `git init --bare -b main`: a missing `-b main` is
 * what made an earlier proof in this project false-pass, because the clone and
 * the remote sat on differently-named branches and the operation under test
 * was a no-op against an unrelated ref.
 *
 * Each finding is asserted against BOTH a fixture that must trip it and a
 * fixture that must not, so an implementation that hardcodes either answer
 * fails. See the negative-proof run in this unit's report: each check was
 * removed in turn and the resulting failures observed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runDoctor } from "../src/ops/doctor.js";
import type { DoctorFinding, DoctorOptions } from "../src/ops/doctor.js";
import { rulesBlock } from "../src/ops/installRules.js";
import type { InstallTarget } from "../src/ops/installMcp.js";
import { topicNotePath } from "../src/paths.js";
import { clearActiveKey } from "../src/store/codec.js";
import { freshHome } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
/** No ambient credentials: a real machine's GESTALT_PASSPHRASE must never leak
 * into these assertions (same guard doctor.test.ts uses). */
const CLEAN_ENV = {} as NodeJS.ProcessEnv;

// ── isolation plumbing (mirrors doctor.test.ts) ──────────────────────────────

/** Fixture host configs in a temp dir — doctor must never read the real ones. */
function hostFixtures(label: string): Partial<Record<InstallTarget, string>> {
  const dir = freshHome(`dc-hosts-${label}`);
  mkdirSync(dir, { recursive: true });
  const cursor = path.join(dir, "cursor-mcp.json");
  writeFileSync(
    cursor,
    JSON.stringify({ mcpServers: { fimemory: { command: "node", args: [] } } }),
    "utf8",
  );
  return {
    "claude-code": path.join(dir, "absent-claude.json"),
    "claude-desktop": path.join(dir, "absent-desktop.json"),
    cursor,
    codex: path.join(dir, "absent-codex.toml"),
    gemini: path.join(dir, "absent-gemini.json"),
    grok: path.join(dir, "absent-grok.toml"),
    windsurf: path.join(dir, "absent-windsurf.json"),
  };
}

/** A rules file carrying the block, so unrelated findings stay quiet. */
function rulesFixtures(label: string): { host: string; file: string }[] {
  const dir = freshHome(`dc-rules-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "CLAUDE.md");
  writeFileSync(file, "mine\n\n" + rulesBlock() + "\n", "utf8");
  return [{ host: "claude", file }];
}

function baseOpts(label: string, home: string): DoctorOptions {
  return {
    home,
    env: CLEAN_ENV,
    hostConfigPaths: hostFixtures(label),
    rulesPaths: rulesFixtures(label),
    shimSettingsPath: path.join(freshHome(`dc-shim-${label}`), "settings.json"),
  };
}

/** The finding with this code, or undefined — the shape every test asserts on. */
function finding(label: string, home: string, code: string): DoctorFinding | undefined {
  return runDoctor(baseOpts(label, home)).findings.find((f) => f.code === code);
}

// ── git fixture plumbing (lifted from git-state.test.ts) ─────────────────────

/**
 * Run git in a fixture and THROW with git's own stderr if it fails. A fixture
 * that half-builds is worse than one that does not build at all: the assertions
 * still run, against a repo in a state nobody chose. `expectFail` marks the
 * calls that are SUPPOSED to fail — the merge that produces the conflict.
 */
function git(cwd: string, args: string[], opts: { expectFail?: boolean } = {}): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error) {
    throw new Error(`fixture: could not run git ${args.join(" ")} in ${cwd}: ${r.error.message}`);
  }
  if (!opts.expectFail && r.status !== 0) {
    throw new Error(
      `fixture: git ${args.join(" ")} failed in ${cwd} (exit ${String(r.status)}): ` +
        `${(r.stderr || r.stdout).trim()}`,
    );
  }
}

/**
 * Settings a developer's or CI runner's GLOBAL config could otherwise change
 * underneath these fixtures: an identity (so nothing depends on the machine
 * having one), `core.autocrlf` (ON by default in Git for Windows, and it
 * reports freshly checked-out files as modified), `commit.gpgsign` (a box that
 * signs by default would hang), and `core.hooksPath` (a global pre-commit hook
 * would run against these throwaway repos).
 */
function pinLocalConfig(repo: string): void {
  git(repo, ["config", "user.name", "Fixture Machine"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
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

/** A real store that is also a real git work tree on `main`, pushed to a bare
 * `-b main` remote. */
function makeGitStore(label: string): string {
  const home = freshHome(label);
  runInit({ home });
  git(home, ["init", "-b", "main"]);
  pinLocalConfig(home);
  git(home, ["remote", "add", "origin", makeRemote(label)]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "base"]);
  git(home, ["push", "-q", "-u", "origin", "main"]);
  return home;
}

/**
 * Drive a real store's repo into a stopped merge by conflicting on `file`
 * (store-relative). Returns the store home.
 */
function makeMidMerge(label: string, file: string): string {
  const home = makeGitStore(label);
  const target = path.join(home, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "base line\n", "utf8");
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "add target"]);
  git(home, ["checkout", "-q", "-b", "other"]);
  writeFileSync(target, "their line\n", "utf8");
  git(home, ["commit", "-q", "-am", "theirs"]);
  git(home, ["checkout", "-q", "main"]);
  writeFileSync(target, "our line\n", "utf8");
  git(home, ["commit", "-q", "-am", "ours"]);
  git(home, ["merge", "other"], { expectFail: true });
  return home;
}

/** What git writes into a file it could not merge. */
function conflictedText(): string {
  return [
    "# alpha",
    "",
    "<<<<<<< HEAD",
    "our version of the fact",
    "=======",
    "their version of the fact",
    ">>>>>>> other",
    "",
  ].join("\n");
}

// ── 1. conflict markers in the store (FAIL) ──────────────────────────────────

describe("doctor — conflict markers in the store", () => {
  it("clean store: none of the merge-health findings fire, and it stays healthy", () => {
    const home = freshHome("dc-clean");
    runInit({ home });
    const r = runDoctor(baseOpts("clean", home));
    for (const code of [
      "store_conflict_markers",
      "store_mixed_mode",
      "conflicts_pending",
      "use_fimemory_pull",
    ]) {
      expect(r.findings.find((f) => f.code === code)).toBeUndefined();
    }
    expect(r.healthy).toBe(true);
  });

  it("a note with conflict markers: FAIL, and the file is NAMED", () => {
    const home = freshHome("dc-marked");
    runInit({ home });
    writeFileSync(topicNotePath(home, "gestalt-example"), conflictedText(), "utf8");
    const f = finding("marked", home, "store_conflict_markers");
    expect(f?.level).toBe("fail");
    // The path, not just a count: "1 file has markers" sends someone grepping.
    expect(f?.message).toContain("topics/gestalt-example.md");
    expect(runDoctor(baseOpts("marked2", home)).healthy).toBe(false);
  });

  it("markers in config.json and in a state/ heartbeat are found too", () => {
    const home = freshHome("dc-marked-else");
    runInit({ home });
    writeFileSync(path.join(home, "config.json"), conflictedText(), "utf8");
    mkdirSync(path.join(home, "state"), { recursive: true });
    writeFileSync(path.join(home, "state", "box-1.json"), conflictedText(), "utf8");
    const f = finding("marked-else", home, "store_conflict_markers");
    expect(f?.level).toBe("fail");
    expect(f?.message).toContain("config.json");
    expect(f?.message).toContain("state/box-1.json");
  });

  it("a note that merely QUOTES one marker line is not a conflict", () => {
    // The store is full of prose about this product. A fail that fires on a
    // note explaining merge markers teaches the owner to stop believing the
    // check, so both ends of a hunk are required.
    const home = freshHome("dc-prose");
    runInit({ home });
    writeFileSync(
      topicNotePath(home, "gestalt-example"),
      "# merge notes\n\nA conflicted file starts with a <<<<<<< line.\n",
      "utf8",
    );
    expect(finding("prose", home, "store_conflict_markers")).toBeUndefined();
  });
});

// ── 2. mixed mode: sealed content beside plaintext store files (FAIL) ────────

describe("doctor — mixed store mode", () => {
  it("sealed store with a plaintext note beside it: FAIL, names the file, no dead-end remedy", () => {
    const home = freshHome("dc-mixed");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey(); // never leave a live DEK behind for the next fixture
    // Exactly what a keyring restored onto a tree written plaintext while
    // locked leaves: sealed notes from before, a readable one beside them.
    writeFileSync(
      topicNotePath(home, "written-while-locked"),
      "---\nid: written-while-locked\ntitle: Written while locked\n---\n\nplain text at rest\n",
      "utf8",
    );
    const f = finding("mixed", home, "store_mixed_mode");
    expect(f?.level).toBe("fail");
    expect(f?.message).toContain("topics/written-while-locked.md");
    // The remedy must not be the one that dead-ends. `decrypt` refuses on a
    // locked store and then throws on the plaintext files; `encrypt` refuses
    // outright ("already encrypted"); unsetting the key hides the sealed half.
    expect(f?.hint).toContain("manual inspection");
    expect(f?.hint).toContain("export --plaintext");
    expect(f?.hint).not.toMatch(/^Unset/);
  });

  it("a fully sealed store does not read as mixed", () => {
    const home = freshHome("dc-sealed");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    expect(finding("sealed", home, "store_mixed_mode")).toBeUndefined();
  });

  it("a fully plaintext store does not read as mixed", () => {
    const home = freshHome("dc-plain");
    runInit({ home });
    expect(finding("plain", home, "store_mixed_mode")).toBeUndefined();
  });

  it("an empty log in a sealed store is not evidence of plaintext", () => {
    // Every fresh encrypted store carries logs with no entries yet; treating
    // the `# <id> log` header as plaintext content would fail every one.
    const home = freshHome("dc-emptylog");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    writeFileSync(path.join(home, "logs", "fresh-topic.log.md"), "# fresh-topic log\n", "utf8");
    expect(finding("emptylog", home, "store_mixed_mode")).toBeUndefined();
  });
});

// ── 3. the conflicts/ sidecar (WARN) ─────────────────────────────────────────

describe("doctor — conflicts/ sidecar", () => {
  it("a non-empty conflicts/ warns and names what is parked there", () => {
    const home = freshHome("dc-parked");
    runInit({ home });
    mkdirSync(path.join(home, "conflicts"), { recursive: true });
    writeFileSync(path.join(home, "conflicts", "config.json.theirs"), "{}\n", "utf8");
    const f = finding("parked", home, "conflicts_pending");
    expect(f?.level).toBe("warn");
    expect(f?.message).toContain("conflicts/config.json.theirs");
    // Warn, never fail: the data is intact and the store works.
    expect(runDoctor(baseOpts("parked2", home)).healthy).toBe(true);
  });

  it("an EMPTY conflicts/ directory says nothing", () => {
    const home = freshHome("dc-parked-empty");
    runInit({ home });
    mkdirSync(path.join(home, "conflicts"), { recursive: true });
    expect(finding("parked-empty", home, "conflicts_pending")).toBeUndefined();
  });
});

// ── 4. half-finished git (WARN) ──────────────────────────────────────────────

describe("doctor — half-finished git", () => {
  it("a store left mid-merge warns and points at fimemory pull", () => {
    // The conflict is on a file OUTSIDE the scanned store directories, so this
    // asserts the git check on its own rather than riding on the marker scan.
    const home = makeMidMerge("dc-midmerge", "scratch.md");
    const f = finding("midmerge", home, "use_fimemory_pull");
    expect(f?.level).toBe("warn");
    expect(f?.message).toContain("mid-merge");
    expect(f?.message).toContain("scratch.md");
    expect(f?.hint).toContain("pull --abort");
    expect(runDoctor(baseOpts("midmerge2", home)).healthy).toBe(true);
  });

  it("a conflicted NOTE mid-merge trips both the git warning and the marker FAIL", () => {
    const home = makeMidMerge("dc-midmerge-note", path.join("topics", "alpha.md"));
    const r = runDoctor(baseOpts("midmerge-note", home));
    expect(r.findings.find((f) => f.code === "use_fimemory_pull")?.level).toBe("warn");
    const marks = r.findings.find((f) => f.code === "store_conflict_markers");
    expect(marks?.level).toBe("fail");
    expect(marks?.message).toContain("topics/alpha.md");
  });

  it("a clean git store says nothing about git", () => {
    const home = makeGitStore("dc-gitclean");
    expect(finding("gitclean", home, "use_fimemory_pull")).toBeUndefined();
  });

  it("a store that is not a git repo at all: no git finding, no crash", () => {
    const home = freshHome("dc-nogit");
    runInit({ home });
    const r = runDoctor(baseOpts("nogit", home));
    expect(r.findings.find((f) => f.code === "use_fimemory_pull")).toBeUndefined();
    expect(r.healthy).toBe(true);
  });
});

// ── 5. which build is answering (INFO) ───────────────────────────────────────

describe("doctor — CLI version", () => {
  it("reports the version of the package this build was loaded from", () => {
    const home = freshHome("dc-version");
    runInit({ home });
    const f = finding("version", home, "cli_version");
    expect(f?.level).toBe("info");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    expect(f?.message).toContain(`${pkg.name} ${pkg.version}`);
    // The PATH matters as much as the number: a global install, an npx run and
    // a repo checkout all answer to the same command.
    expect(f?.message).toContain("package.json");
  });

  it("is reported on a broken store too — it is the one fact a bug report cannot reconstruct", () => {
    const home = freshHome("dc-version-absent"); // never created
    const r = runDoctor(baseOpts("version-absent", home));
    expect(r.findings.find((f) => f.code === "store_missing")?.level).toBe("fail");
    expect(r.findings.find((f) => f.code === "cli_version")?.level).toBe("info");
  });
});
