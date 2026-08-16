import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RULES_HOST_IDS,
  RULES_MARKER_BEGIN,
  RULES_WRITABLE_HOST_IDS,
  geminiContextFile,
  installRulesAll,
  rulesBlock,
  rulesHosts,
  uninstallRulesAll,
} from "../src/ops/installRules.js";
import type { RulesHost, RulesHostId, RulesHostOutcome } from "../src/ops/installRules.js";
import { defaultHostConfigFiles } from "../src/ops/installMcp.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * install-rules across HOSTS (2026-07-30).
 *
 * The single-host contract is covered by install-rules.test.ts; this file is
 * about the registry: who gets written to, who is left alone, and that every
 * host inherits the same marker safety Claude Code always had.
 *
 * The registry is always built with an injected `homeDir` under the test root —
 * no test here may look at, let alone write to, the real ~/.claude, ~/.codex,
 * ~/.gemini, ~/.grok or ~/.codeium. The CLI tests spawn with HOME/USERPROFILE
 * pointed at that same fake root, which is what keeps `installHooks` (whose
 * default target is the REAL ~/.claude/settings.json) off the developer's box.
 */

const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A fake user home under the test root. */
function fakeHome(label: string): string {
  const home = freshHome(`rules-hosts-${label}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function registryFor(home: string, env: NodeJS.ProcessEnv = {}): RulesHost[] {
  return rulesHosts({ homeDir: home, env });
}

function fileOf(registry: RulesHost[], id: RulesHostId): string {
  const host = registry.find((h) => h.id === id);
  if (!host?.file) throw new Error(`${id} has no rules file in this registry`);
  return host.file;
}

function outcome(results: RulesHostOutcome[], id: string): RulesHostOutcome | undefined {
  return results.find((r) => r.host === id);
}

function hostOf(registry: RulesHost[], id: RulesHostId): RulesHost {
  const host = registry.find((h) => h.id === id);
  if (!host) throw new Error(`${id} is not in this registry`);
  return host;
}

/** Mark a host as installed the way detection sees it: its directory exists. */
function pretendInstalled(registry: RulesHost[], id: RulesHostId): void {
  const dir = registry.find((h) => h.id === id)?.detectDir;
  if (!dir) throw new Error(`${id} has no detect dir`);
  mkdirSync(dir, { recursive: true });
}

describe("the host registry", () => {
  it("RULES_HOST_IDS cannot drift from the registry it names", () => {
    const reg = rulesHosts({ homeDir: fakeHome("ids"), env: {} });
    expect(reg.map((h) => h.id)).toEqual(RULES_HOST_IDS);
    // The suggestion list the CLI prints must be the WRITABLE subset — naming
    // cursor there tells the user to re-run the host that just refused.
    expect(reg.filter((h) => h.file !== null).map((h) => h.id)).toEqual(RULES_WRITABLE_HOST_IDS);
  });

  it("only Claude Code claims a retrieval hook, because only it gets one", () => {
    // `installHooks` writes exactly one settings file. Any other host marked
    // supportsHook would start receiving the §2.5b 'already injected' body for
    // a hook that never runs.
    const reg = rulesHosts({ homeDir: fakeHome("hookable"), env: {} });
    expect(reg.filter((h) => h.supportsHook).map((h) => h.id)).toEqual(["claude-code"]);
  });

  it("refuses a Gemini contextFileName that would escape the config directory", () => {
    // settings.json is a file we do NOT own — user-editable, team-synced, often
    // in a dotfiles repo. An unvalidated value becomes our write target, and
    // uninstall-rules later rewrites that same file wholesale.
    const home = fakeHome("gemini-traversal");
    const geminiDir = path.join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    for (const evil of ["../../.bashrc", ".", "..", "../../../../Windows/System32/drivers/etc/hosts"]) {
      writeFileSync(
        path.join(geminiDir, "settings.json"),
        JSON.stringify({ contextFileName: evil }),
        "utf8",
      );
      expect(fileOf(registryFor(home), "gemini")).toBe(path.join(geminiDir, "GEMINI.md"));
      expect(geminiContextFile(geminiDir).rejected).toMatch(/not a bare filename/);
    }
    // A legitimate rename is still honored.
    writeFileSync(
      path.join(geminiDir, "settings.json"),
      JSON.stringify({ contextFileName: "CONTEXT.md" }),
      "utf8",
    );
    expect(geminiContextFile(geminiDir).rejected).toBeUndefined();
  });

  it("says so on the gemini outcome when it fell back to GEMINI.md", async () => {
    const home = fakeHome("gemini-traversal-note");
    const geminiDir = path.join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      path.join(geminiDir, "settings.json"),
      JSON.stringify({ contextFileName: "../../.bashrc" }),
      "utf8",
    );
    const reg = registryFor(home);
    const r = await installRulesAll({ registry: reg, hosts: ["gemini"] });
    expect(outcome(r.results, "gemini")!.action).toBe("installed");
    expect(outcome(r.results, "gemini")!.notes.join(" ")).toMatch(/not a bare filename/);
    expect(readFileSync(path.join(geminiDir, "GEMINI.md"), "utf8")).toContain(RULES_MARKER_BEGIN);
    expect(existsSync(path.join(home, ".bashrc"))).toBe(false);
    expect(existsSync(path.join(path.dirname(home), ".bashrc"))).toBe(false);
  });

  it("puts each host's global rules file where that host actually reads it", () => {
    const home = fakeHome("paths");
    const reg = registryFor(home);
    expect(fileOf(reg, "claude-code")).toBe(path.join(home, ".claude", "CLAUDE.md"));
    // Codex reads AGENTS.md, not CLAUDE.md; Grok reads AGENTS.md and never GROK.md.
    expect(fileOf(reg, "codex")).toBe(path.join(home, ".codex", "AGENTS.md"));
    expect(fileOf(reg, "grok")).toBe(path.join(home, ".grok", "AGENTS.md"));
    expect(fileOf(reg, "gemini")).toBe(path.join(home, ".gemini", "GEMINI.md"));
    expect(fileOf(reg, "windsurf")).toBe(
      path.join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
    );
    // Hosts with no rules file are registered, not missing — so naming one
    // explains itself instead of failing as an unknown name.
    expect(reg.find((h) => h.id === "cursor")!.file).toBeNull();
    expect(reg.find((h) => h.id === "claude-desktop")!.file).toBeNull();
    // …and the explanation must never assert a limit nobody checked. These two
    // hosts are at DIFFERENT evidence levels and the test says which is which,
    // because collapsing them is how a guess gets laundered into a fact.
    //
    // claude-desktop: still unread. Not installed on any machine we have, no
    // vendor doc on this disk. It must keep saying so.
    const desktop = reg.find((h) => h.id === "claude-desktop")!.unsupported!;
    expect(desktop).toMatch(/UNVERIFIED/);
    expect(desktop).toMatch(/not installed on any machine we have checked/i);

    // cursor: READ 2026-08-01 from cursor.com/docs/rules, which is why this no
    // longer says UNVERIFIED. Cursor's global User Rules are entered in the app
    // (Customize -> Rules) and have no file underneath, so `file: null` is a
    // vendor fact rather than an admission. The text must cite the source and
    // hand over both real routes — the per-project .mdc and the paste — or it
    // is just a nicer-sounding dead end.
    const cursor = reg.find((h) => h.id === "cursor")!.unsupported!;
    expect(cursor).not.toMatch(/UNVERIFIED/);
    expect(cursor).toMatch(/cursor\.com\/docs\/rules/);
    expect(cursor).toMatch(/\.cursor\/rules\/fimemory\.mdc/);
    expect(cursor).toMatch(/--print/);
  });

  it("honors the host home overrides and Gemini's renamed context file", () => {
    const home = fakeHome("overrides");
    const codexHome = path.join(home, "elsewhere", "codex");
    const reg = registryFor(home, { CODEX_HOME: codexHome });
    expect(fileOf(reg, "codex")).toBe(path.join(codexHome, "AGENTS.md"));

    // A user who renamed the context file must not get a GEMINI.md nobody reads.
    const geminiDir = path.join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      path.join(geminiDir, "settings.json"),
      JSON.stringify({ contextFileName: "CONTEXT.md" }),
      "utf8",
    );
    expect(fileOf(registryFor(home), "gemini")).toBe(path.join(geminiDir, "CONTEXT.md"));
  });

  it("install-mcp and doctor resolve host homes exactly as install-rules does", () => {
    // `defaultHostConfigFiles` honoured GROK_HOME only, while this registry
    // honoured CODEX_HOME and GEMINI_CLI_HOME too. On a machine with CODEX_HOME
    // set, `setup` wrote the rule block where Codex reads it and the MCP entry
    // where Codex does not — the agent told to consult a store it has no server
    // for. Doctor builds ITS registry from the same function, so it agreed with
    // the wrong location and reported nothing amiss: half-wired and silent.
    // CODEX_HOME is real: the string appears 60 times in codex.exe 0.145.0,
    // including "CODEX_HOME was resolved without config".
    const home = fakeHome("mcp-overrides");
    const env = {
      CODEX_HOME: path.join(home, "elsewhere", "codex"),
      GEMINI_CLI_HOME: path.join(home, "elsewhere", "gemini"),
      GROK_HOME: path.join(home, "elsewhere", "grok"),
    };
    const mcp = new Map(defaultHostConfigFiles({ homeDir: home, env }).map((h) => [h.target, h.file]));
    expect(mcp.get("codex")).toBe(path.join(env.CODEX_HOME, "config.toml"));
    expect(mcp.get("gemini")).toBe(path.join(env.GEMINI_CLI_HOME, "settings.json"));
    expect(mcp.get("grok")).toBe(path.join(env.GROK_HOME, "config.toml"));

    // …and the rules registry lands in the SAME directories.
    const reg = registryFor(home, env);
    for (const [id, key] of [
      ["codex", "CODEX_HOME"],
      ["gemini", "GEMINI_CLI_HOME"],
      ["grok", "GROK_HOME"],
    ] as const) {
      expect(path.dirname(fileOf(reg, id))).toBe(env[key]);
    }
  });
});

describe("install-rules — every DETECTED host, and only those", () => {
  it("writes to detected hosts, preserves their existing text, and never creates a file for an undetected one", async () => {
    const home = fakeHome("detect");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");
    // The owner's real case: ~/.codex/AGENTS.md exists with content, no block.
    const codexOwn = "# my codex notes\n\n- keep this line\n";
    writeFileSync(fileOf(reg, "codex"), codexOwn, "utf8");
    // Gemini and Grok are NOT installed here.

    const r = await installRulesAll({ registry: reg });

    expect(outcome(r.results, "claude-code")!.action).toBe("installed");
    expect(readFileSync(fileOf(reg, "claude-code"), "utf8")).toContain(RULES_MARKER_BEGIN);

    expect(outcome(r.results, "codex")!.action).toBe("installed");
    const codexText = readFileSync(fileOf(reg, "codex"), "utf8");
    expect(codexText.startsWith(codexOwn)).toBe(true); // every other line untouched
    expect(codexText).toContain(RULES_MARKER_BEGIN);

    const gemini = outcome(r.results, "gemini")!;
    expect(gemini.action).toBe("skipped");
    expect(gemini.reason).toMatch(/not detected/);
    expect(existsSync(fileOf(reg, "gemini"))).toBe(false);
    expect(existsSync(path.join(home, ".gemini"))).toBe(false); // no dir invented either
    expect(existsSync(fileOf(reg, "grok"))).toBe(false);

    // Hosts with no rules file are not silently "skipped" noise in the default run.
    expect(outcome(r.results, "cursor")).toBeUndefined();
    expect(r.caveat).toMatch(/next session/i);
  });

  it("is idempotent: a second run reports 'unchanged' and writes nothing at all", async () => {
    const home = fakeHome("idempotent");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "grok");
    writeFileSync(fileOf(reg, "grok"), "grok rules I wrote by hand\n", "utf8");

    await installRulesAll({ registry: reg });
    const after1 = [fileOf(reg, "claude-code"), fileOf(reg, "grok")].map((f) =>
      readFileSync(f, "utf8"),
    );

    const second = await installRulesAll({ registry: reg });
    expect(second.results.filter((h) => h.action === "unchanged").map((h) => h.host)).toEqual([
      "claude-code",
      "grok",
    ]);
    const after2 = [fileOf(reg, "claude-code"), fileOf(reg, "grok")].map((f) =>
      readFileSync(f, "utf8"),
    );
    expect(after2).toEqual(after1); // byte-identical second run
  });

  it("replaces a HAND-WRITTEN block only when it carries markers, and never rewrites a plain file wholesale", async () => {
    const home = fakeHome("handwritten");
    const reg = registryFor(home);
    pretendInstalled(reg, "grok");
    // The owner's ~/.grok case: an older marked block, surrounded by his text.
    const before = "# Grok rules\n\n";
    const after = "\n\n## my own section\nstays\n";
    writeFileSync(
      fileOf(reg, "grok"),
      before + "<!-- squirl:begin -->\n## Shared memory store\nold hand copy\n<!-- squirl:end -->" + after,
      "utf8",
    );
    const r = await installRulesAll({ registry: reg });
    expect(outcome(r.results, "grok")!.action).toBe("replaced");
    expect(readFileSync(fileOf(reg, "grok"), "utf8")).toBe(before + rulesBlock() + after);
  });

  it("names hosts explicitly, writes only those, and creates the host dir it was told about", async () => {
    const home = fakeHome("named");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");

    const r = await installRulesAll({ registry: reg, hosts: ["gemini"] });
    expect(r.results.map((h) => h.host)).toEqual(["gemini"]);
    expect(outcome(r.results, "gemini")!.action).toBe("installed");
    expect(readFileSync(fileOf(reg, "gemini"), "utf8")).toContain(RULES_MARKER_BEGIN);
    expect(outcome(r.results, "gemini")!.notes.join(" ")).toMatch(/did not exist/);
    // The detected host we did NOT name is left alone.
    expect(existsSync(fileOf(reg, "claude-code"))).toBe(false);
  });

  // Found 2026-08-01 by walking the tester install on a scratch home. Cursor
  // took the MCP server in step 2 and then did not appear in the rules step at
  // ALL, because the default sweep filtered on `file !== null`. A Cursor user
  // finished `setup` with no reason to think anything was missing, and got the
  // weaker product: seven tools present, nothing telling the model to open
  // them. Silence about an installed host is the exact failure `setup` exists
  // to fix, so it must never come back.
  it("tells an INSTALLED host with no rules file what to do, without being named", async () => {
    const home = fakeHome("nullfile-detected");
    const reg = registryFor(home);
    // Cursor is detected by its directory, the same as every other host.
    mkdirSync(path.join(home, ".cursor"), { recursive: true });

    const r = await installRulesAll({ registry: reg });
    const o = outcome(r.results, "cursor");
    expect(o, "an installed Cursor must appear in the default sweep").toBeTruthy();
    expect(o!.action).toBe("skipped");
    // …and the skip has to carry the routes that WORK, or it is just a
    // politer silence.
    expect(o!.reason).toMatch(/\.cursor\/rules\/fimemory\.mdc/);
    expect(o!.reason).toMatch(/--print/);
  });

  it("stays silent about a host with no rules file that is NOT installed", async () => {
    // The other half of the rule above: surfacing every null-file host on every
    // machine would just be noise for software the user does not have.
    const home = fakeHome("nullfile-absent");
    const reg = registryFor(home);
    const r = await installRulesAll({ registry: reg });
    expect(outcome(r.results, "cursor")).toBeUndefined();
    // claude-desktop has no detectDir at all, so it can never be detected and
    // must stay out of the default sweep on every machine.
    expect(outcome(r.results, "claude-desktop")).toBeUndefined();
  });

  it("explains a host that has no rules file instead of pretending to write one", async () => {
    const home = fakeHome("unsupported");
    const reg = registryFor(home);
    const r = await installRulesAll({ registry: reg, hosts: ["cursor", "claude-desktop"] });
    for (const id of ["cursor", "claude-desktop"]) {
      const o = outcome(r.results, id)!;
      expect(o.action).toBe("skipped");
      expect(o.path).toBeNull();
      expect(o.reason).toBeTruthy();
    }
    // The refusal names the escape hatch and claims no vendor limit it did not
    // read — see the registry test above. For Cursor the limit IS now read
    // (cursor.com/docs/rules: global User Rules live in the app, not on disk),
    // so the skip must point at the two routes that work instead of stopping.
    expect(outcome(r.results, "cursor")!.reason).toMatch(/--file/);
    expect(outcome(r.results, "cursor")!.reason).toMatch(/Customize -> Rules/);
  });

  it("reports an unknown host name without touching anything", async () => {
    const home = fakeHome("unknown");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    const r = await installRulesAll({ registry: reg, hosts: ["emacs"] });
    expect(outcome(r.results, "emacs")!.action).toBe("skipped");
    expect(outcome(r.results, "emacs")!.reason).toMatch(/unknown host/);
    expect(existsSync(fileOf(reg, "claude-code"))).toBe(false);
  });

  it("--mode shim reaches ONLY the host that can run a retrieval hook", async () => {
    // The shipped quickstart is `install-rules --mode shim`. The §2.5b body
    // says "context may already be present, injected by the host retrieval
    // hook — do not re-search by default". Where our hook does not RUN, that
    // block SUPPRESSES the fimemory_search call this whole feature exists to
    // cause, in exchange for an injection that never arrives.
    //
    // This comment used to say "on Codex/Gemini/Grok/Windsurf no hook exists or
    // ever will". That was an unverified platform claim, and the Grok half of
    // it is FALSE (checked 2026-07-31: Grok scans ~/.claude/settings.json by
    // default and had our handlers loaded). The REASON is now per host and
    // evidence-backed, so the assertions test that instead of the old wording.
    //
    // NOTE the fake home here has NO ~/.grok. That matters: Grok also reads
    // ~/.claude/CLAUDE.md, so with Grok installed this file may not carry the
    // shim body at all — the test below this one covers that.
    const home = fakeHome("shim-scope");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");

    const r = await installRulesAll({ registry: reg, mode: "shim" });
    expect(r.mode).toBe("shim");

    const claude = readFileSync(fileOf(reg, "claude-code"), "utf8");
    expect(outcome(r.results, "claude-code")!.mode).toBe("shim");
    expect(claude).toContain("ALREADY-RETRIEVED");
    expect(claude).not.toContain("call `fimemory_search` first");

    {
      const o = outcome(r.results, "codex")!;
      expect(o.mode).toBe("rules"); // downgraded, and the outcome says so
      const notes = o.notes.join(" ");
      // The note describes the POLICY, not an action: the same notes array is
      // attached to a `failed` outcome, where nothing was written at all.
      expect(notes).toMatch(/search-first block applies/i);
      expect(notes).not.toMatch(/^wrote |wrote the search-first block instead/i);
      // …and WHY, in this host's own terms — never a blanket platform claim.
      expect(notes).toContain(hostOf(reg, "codex").hookNoteShort);
      expect(notes).not.toMatch(/hooks are claude code/i);
      const text = readFileSync(fileOf(reg, "codex"), "utf8");
      expect(text).toContain("call `fimemory_search` first");
      expect(text).not.toContain("ALREADY-RETRIEVED");
    }
  });

  it("a SHARED rules file never gets the shim body — Grok reads ~/.claude/CLAUDE.md", async () => {
    // THE defect this rule exists for, verified on the owner's real machine:
    // Grok CLI scans the home-level ~/.claude/ directory for CLAUDE.md by
    // default (~/.grok/docs/user-guide/12-project-rules.md:26,
    // 05-configuration.md `[compat.claude] agents = true`, and `grok inspect
    // --json` listing that exact path). So the shim body written "for Claude
    // Code" was ALSO reaching Grok, telling it not to search in exchange for
    // an injection that never arrives there. Writing the search-first block to
    // ~/.grok/AGENTS.md does not undo it: Grok loads both files.
    const home = fakeHome("shim-shared");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "grok");

    const r = await installRulesAll({ registry: reg, mode: "shim" });

    const o = outcome(r.results, "claude-code")!;
    expect(o.mode).toBe("rules");
    const claude = readFileSync(fileOf(reg, "claude-code"), "utf8");
    expect(claude).toContain("call `fimemory_search` first");
    expect(claude).not.toContain("ALREADY-RETRIEVED");
    // And it SAYS why, naming the host that shares the file — otherwise the
    // downgrade looks like a bug to whoever reads the output next.
    const notes = o.notes.join(" ");
    expect(notes).toMatch(/Grok CLI also reads it/i);
    expect(notes).toContain(hostOf(reg, "grok").hookNoteShort);

    // Removing Grok restores the shim body: this is about the FILE's readers,
    // not a permanent downgrade.
    const soloHome = fakeHome("shim-shared-solo");
    const soloReg = registryFor(soloHome);
    pretendInstalled(soloReg, "claude-code");
    const solo = await installRulesAll({ registry: soloReg, mode: "shim" });
    expect(outcome(solo.results, "claude-code")!.mode).toBe("shim");
  });

  it("naming a hookless host with --mode shim still writes the search-first block", async () => {
    const home = fakeHome("shim-named");
    const reg = registryFor(home);
    const r = await installRulesAll({ registry: reg, hosts: ["grok"], mode: "shim" });
    expect(outcome(r.results, "grok")!.mode).toBe("rules");
    expect(readFileSync(fileOf(reg, "grok"), "utf8")).toContain("call `fimemory_search` first");
  });

  it("a damaged block on one host does not stop the others", async () => {
    const home = fakeHome("damaged");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");
    writeFileSync(fileOf(reg, "claude-code"), `${RULES_MARKER_BEGIN}\nno end marker\n`, "utf8");

    const r = await installRulesAll({ registry: reg });
    expect(outcome(r.results, "claude-code")!.action).toBe("failed");
    expect(outcome(r.results, "claude-code")!.reason).toMatch(/end marker/);
    // The damaged file is left exactly as found.
    expect(readFileSync(fileOf(reg, "claude-code"), "utf8")).toBe(
      `${RULES_MARKER_BEGIN}\nno end marker\n`,
    );
    expect(outcome(r.results, "codex")!.action).toBe("installed");
  });

  it("a NON-GestaltError on one host is that host's failure, not the sweep's", async () => {
    // Registry order is claude-code, codex, gemini, grok, windsurf. A raw Node
    // error (EISDIR here — a directory where the rules file should be) used to
    // escape the loop, discard the claude-code result already collected, and
    // print a stack trace: "some written, some not, reported as neither".
    const home = fakeHome("hard-error");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");
    pretendInstalled(reg, "grok");
    mkdirSync(fileOf(reg, "codex"), { recursive: true }); // AGENTS.md is a DIRECTORY

    const r = await installRulesAll({ registry: reg });
    expect(outcome(r.results, "claude-code")!.action).toBe("installed");
    const codex = outcome(r.results, "codex")!;
    expect(codex.action).toBe("failed");
    expect(codex.reason).toBeTruthy();
    // The hosts AFTER the failure still ran.
    expect(outcome(r.results, "grok")!.action).toBe("installed");
    expect(readFileSync(fileOf(reg, "grok"), "utf8")).toContain(RULES_MARKER_BEGIN);

    // uninstall has the identical contract.
    const un = await uninstallRulesAll({ registry: reg });
    expect(outcome(un.results, "codex")!.action).toBe("failed");
    expect(outcome(un.results, "grok")!.action).toBe("removed");
  });

  it("--file still targets one exact file and bypasses the registry entirely", async () => {
    const home = fakeHome("file-flag");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");
    const custom = path.join(home, "somewhere", "RULES.md");

    const r = await installRulesAll({ registry: reg, file: custom });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.host).toBe("custom");
    expect(r.results[0]!.action).toBe("installed");
    expect(readFileSync(custom, "utf8")).toContain(RULES_MARKER_BEGIN);
    // No host file was written.
    expect(existsSync(fileOf(reg, "claude-code"))).toBe(false);
    expect(existsSync(fileOf(reg, "codex"))).toBe(false);

    const un = await uninstallRulesAll({ registry: reg, file: custom });
    expect(un.results[0]!.action).toBe("removed");
    expect(readFileSync(custom, "utf8")).toBe("");
  });
});

describe("install-rules — the gotchas that decide whether a written block is READ", () => {
  it("warns when Codex's AGENTS.override.md would shadow the file we wrote", async () => {
    const home = fakeHome("codex-override");
    const reg = registryFor(home);
    pretendInstalled(reg, "codex");
    writeFileSync(path.join(home, ".codex", "AGENTS.override.md"), "override wins\n", "utf8");
    const r = await installRulesAll({ registry: reg, hosts: ["codex"] });
    expect(outcome(r.results, "codex")!.action).toBe("installed");
    expect(outcome(r.results, "codex")!.notes.join(" ")).toMatch(/AGENTS\.override\.md/);
  });

  it("says so when a hand-written GROK.md is sitting there being ignored by Grok", async () => {
    const home = fakeHome("grok-md");
    const reg = registryFor(home);
    pretendInstalled(reg, "grok");
    writeFileSync(path.join(home, ".grok", "GROK.md"), "## Shared memory store\nby hand\n", "utf8");
    const r = await installRulesAll({ registry: reg, hosts: ["grok"] });
    expect(readFileSync(fileOf(reg, "grok"), "utf8")).toContain(RULES_MARKER_BEGIN);
    expect(outcome(r.results, "grok")!.notes.join(" ")).toMatch(/GROK\.md/);
    // We wrote AGENTS.md and did not touch the stale file.
    expect(readFileSync(path.join(home, ".grok", "GROK.md"), "utf8")).toBe(
      "## Shared memory store\nby hand\n",
    );
  });

  it("warns when Windsurf's 6,000-character global-rules cap is blown", async () => {
    const home = fakeHome("windsurf-cap");
    const reg = registryFor(home);
    pretendInstalled(reg, "windsurf");
    mkdirSync(path.dirname(fileOf(reg, "windsurf")), { recursive: true });
    writeFileSync(fileOf(reg, "windsurf"), "x".repeat(6_000) + "\n", "utf8");
    const r = await installRulesAll({ registry: reg });
    expect(outcome(r.results, "windsurf")!.action).toBe("installed");
    expect(outcome(r.results, "windsurf")!.notes.join(" ")).toMatch(/6,000 characters/);
  });
});

describe("uninstall-rules — an exit that works on every host", () => {
  it("removes only the marked block from every host that has one, and leaves the rest of each file alone", async () => {
    const home = fakeHome("uninstall-all");
    const reg = registryFor(home);
    pretendInstalled(reg, "claude-code");
    pretendInstalled(reg, "codex");
    pretendInstalled(reg, "grok");
    const codexOwn = "# codex\n\nkeep me\n";
    const grokOwn = "# grok\n\nkeep me too\n";
    writeFileSync(fileOf(reg, "codex"), codexOwn, "utf8");
    writeFileSync(fileOf(reg, "grok"), grokOwn, "utf8");
    await installRulesAll({ registry: reg });

    const r = await uninstallRulesAll({ registry: reg });
    expect(outcome(r.results, "codex")!.action).toBe("removed");
    expect(outcome(r.results, "grok")!.action).toBe("removed");
    expect(readFileSync(fileOf(reg, "codex"), "utf8")).toBe(codexOwn);
    expect(readFileSync(fileOf(reg, "grok"), "utf8")).toBe(grokOwn);

    // Second sweep: nothing left to remove, still no damage.
    const again = await uninstallRulesAll({ registry: reg });
    expect(again.results.every((h) => h.action === "absent")).toBe(true);
    expect(readFileSync(fileOf(reg, "codex"), "utf8")).toBe(codexOwn);
  });

  it("never creates a rules file for a host that has none", async () => {
    const home = fakeHome("uninstall-absent");
    const reg = registryFor(home);
    pretendInstalled(reg, "gemini");
    const r = await uninstallRulesAll({ registry: reg, hosts: ["gemini"] });
    expect(outcome(r.results, "gemini")!.action).toBe("absent");
    expect(existsSync(fileOf(reg, "gemini"))).toBe(false);
  });
});

describe("install-rules CLI — host arguments", () => {
  /**
   * The CLI is spawned with a FAKE HOME.
   *
   * `os.homedir()` honors USERPROFILE on win32 and HOME elsewhere, so this is
   * what keeps the registry — and `installHooks`, which always defaults to
   * `~/.claude/settings.json` — off the developer's real dotfiles. Without it
   * these tests were read-only only by luck of argument selection, and the
   * write paths below could not be exercised at all.
   */
  function spawnCli(
    args: string[],
    home: string,
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("--list-hosts prints every known host and where its rules file lives", () => {
    const home = fakeHome("cli-list");
    const r = spawnCli(["install-rules", "--list-hosts"], home);
    expect(r.status).toBe(0);
    for (const id of RULES_HOST_IDS) expect(r.stdout).toContain(id);
    expect(r.stdout).toMatch(/AGENTS\.md/);
    // The paths shown are the FAKE home's, proving the sandbox actually took.
    expect(r.stdout).toContain(path.join(home, ".codex", "AGENTS.md"));
  });

  it("rejects an unknown host name before writing anything", () => {
    const r = spawnCli(["install-rules", "emacs"], fakeHome("cli-unknown"));
    expect(r.status).toBe(1); // usage error, same exit code every other verb uses
    expect(r.stderr + r.stdout).toMatch(/unknown rules host/);
  });

  it("refuses to mix host names with --file", () => {
    const r = spawnCli(
      ["install-rules", "grok", "--file", "should-never-be-written.md"],
      fakeHome("cli-mix"),
    );
    expect(r.status).toBe(1);
    expect(existsSync("should-never-be-written.md")).toBe(false);
  });

  it("a host with no rules file is explained, and does not blame detection or exit 0", () => {
    const home = fakeHome("cli-cursor");
    const r = spawnCli(["install-rules", "cursor"], home);
    expect(r.stdout).toMatch(/cursor: skipped/);
    // Do NOT follow the refusal with "name one (… cursor …)" — that points the
    // user back at the host that just refused.
    expect(r.stdout).not.toMatch(/no known host detected here/);
    expect(r.status).toBe(1); // an explicit ask that wrote nothing is not success
  });
});

/**
 * HOOK SCOPING. `installHooks` defaults to the REAL `~/.claude/settings.json`
 * and cli.ts never passes a settingsPath, so this scoping decision is the only
 * thing standing between `install-rules grok --mode shim` and rewriting the
 * user's live Claude Code hook entries. It had no coverage at all.
 */
describe("install-rules --mode shim — whose settings.json gets hooks", () => {
  function spawnCli(args: string[], home: string): { status: number; stdout: string } {
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  const claudeSettings = (home: string): string => path.join(home, ".claude", "settings.json");

  it("naming another host leaves Claude Code's settings alone", () => {
    const home = fakeHome("hooks-grok");
    const r = spawnCli(["install-rules", "grok", "--mode", "shim"], home);
    expect(r.stdout).toMatch(/hooks SKIPPED/);
    expect(existsSync(claudeSettings(home))).toBe(false);
    // ...and the block it DID write is the search-first one, not the shim body
    // that presupposes the hook this run just skipped.
    const grok = readFileSync(path.join(home, ".grok", "AGENTS.md"), "utf8");
    expect(grok).toContain("call `fimemory_search` first");
    expect(grok).not.toContain("ALREADY-RETRIEVED");
  });

  it("does NOT create a ~/.claude tree for an app that is not installed", () => {
    // The shipped quickstart on a Codex-only machine. It used to print
    // "claude-code: skipped — not detected" and then write hooks into a
    // ~/.claude it had just invented, after which doctor claimed a retrieval
    // shim the machine cannot run.
    const home = fakeHome("hooks-nodetect");
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const r = spawnCli(["install-rules", "--mode", "shim"], home);
    expect(r.stdout).toMatch(/claude-code: skipped/);
    expect(r.stdout).toMatch(/hooks SKIPPED/);
    expect(existsSync(claudeSettings(home))).toBe(false);
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
    // Codex still got its block — in the un-downgraded, search-first form.
    expect(readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8")).toContain(
      "call `fimemory_search` first",
    );
  });

  it("installs hooks when Claude Code IS the host being written", () => {
    const home = fakeHome("hooks-claude");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const r = spawnCli(["install-rules", "--mode", "shim"], home);
    expect(r.stdout).toMatch(/hooks (installed|replaced|unchanged)/);
    expect(existsSync(claudeSettings(home))).toBe(true);
    expect(readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "ALREADY-RETRIEVED",
    );
  });

  it("--with-hooks is still the explicit override", () => {
    const home = fakeHome("hooks-force");
    const r = spawnCli(["install-rules", "grok", "--mode", "shim", "--with-hooks"], home);
    expect(r.stdout).not.toMatch(/hooks SKIPPED/);
    expect(existsSync(claudeSettings(home))).toBe(true);
  });
});
