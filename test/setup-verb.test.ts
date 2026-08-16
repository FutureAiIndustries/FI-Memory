import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BIN, passphraseExample } from "../src/brand.js";
import { RULES_MARKER_BEGIN, rulesHosts } from "../src/ops/installRules.js";
import type { RulesHost } from "../src/ops/installRules.js";
import { runDoctor } from "../src/ops/doctor.js";
import { runSetup, storeExistsAt } from "../src/ops/setup.js";
import type { SetupResult, SetupStepName } from "../src/ops/setup.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * `fimemory setup`, and the silence it exists to kill (2026-07-31).
 *
 * From a sweep of 112 manual install steps: "The single roughest moment is a
 * silence, not an error: `fimemory init` succeeds, prints 'Try it: fimemory
 * list', and the store it just made is connected to nothing … A working
 * install and a dead one look identical."
 *
 * Everything here runs against a FAKE user home under the test root. No test in
 * this file may read, let alone write, the real ~/.claude, ~/.codex, ~/.gemini,
 * ~/.grok or ~/.codeium — `runSetup` writes MCP configs, rules files AND
 * Claude's settings.json, so an un-injected run would rewire the developer's
 * own machine.
 */

const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A fake user home under the test root, with the named hosts "installed". */
function fakeHome(label: string, hosts: string[] = []): string {
  const home = freshHome(`setup-${label}`);
  mkdirSync(home, { recursive: true });
  for (const dir of hosts) mkdirSync(path.join(home, dir), { recursive: true });
  return home;
}

/** Every injectable pointed inside the sandbox — the shape every test uses. */
function sandboxed(
  userHome: string,
  storeHome: string,
  extra: Partial<Parameters<typeof runSetup>[0]> = {},
): Parameters<typeof runSetup>[0] {
  const reg = rulesHosts({ homeDir: userHome, env: {} });
  return {
    home: storeHome,
    userHome,
    env: {},
    registry: reg,
    hooksSettingsPath: path.join(userHome, ".claude", "settings.json"),
    mcp: {
      // Pinned TRUE so the `claude mcp add` next-step assertions hold on every
      // runner. Detection reads the real PATH by default, and whether the
      // machine running this suite has a `claude` binary is exactly the kind
      // of ambient state no test here may depend on. The FALSE arm has its own
      // describe below.
      claudeCliDetected: true,
      desktopConfigPath: path.join(userHome, "AppData", "Claude", "claude_desktop_config.json"),
      cursorConfigPath: path.join(userHome, ".cursor", "mcp.json"),
      codexConfigPath: path.join(userHome, ".codex", "config.toml"),
      geminiConfigPath: path.join(userHome, ".gemini", "settings.json"),
      grokConfigPath: path.join(userHome, ".grok", "config.toml"),
      windsurfConfigPath: path.join(userHome, ".codeium", "windsurf", "mcp_config.json"),
    },
    doctor: { userHome },
    ...extra,
  };
}

function step(r: SetupResult, name: SetupStepName): SetupResult["steps"][number] {
  const s = r.steps.find((x) => x.step === name);
  if (!s) throw new Error(`no ${name} step in the result`);
  return s;
}

function hostOf(reg: RulesHost[], id: string): RulesHost {
  const h = reg.find((x) => x.id === id);
  if (!h) throw new Error(`${id} not in registry`);
  return h;
}

describe("setup runs the whole sequence", () => {
  it("takes a machine from nothing to wired, in one verb", async () => {
    const userHome = fakeHome("full", [".claude", ".codex", ".grok"]);
    const store = freshHome("setup-full-store");

    const r = await runSetup(sandboxed(userHome, store));

    // Every step ran, in the order the wiring requires.
    expect(r.steps.map((s) => s.step)).toEqual([
      "init",
      "install-mcp",
      "install-hooks",
      "install-rules",
      "doctor",
    ]);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);

    // 1. the store exists and holds the starter topics
    expect(storeExistsAt(store)).toBe(true);
    expect(step(r, "init").status).toBe("ok");
    expect(step(r, "init").details.map((d) => d.name)).toContain("starter topics");

    // 2. MCP config was written for the TOML hosts that are "installed" here
    expect(existsSync(path.join(userHome, ".codex", "config.toml"))).toBe(true);
    expect(readFileSync(path.join(userHome, ".grok", "config.toml"), "utf8")).toContain(
      "[mcp_servers.fimemory]",
    );
    // Claude Code's own config is NOT written by us — it becomes a next step
    // with the exact command, never a line that silently scrolls past.
    expect(r.nextSteps.some((n) => n.startsWith("claude mcp add fimemory"))).toBe(true);

    // 3. the retrieval hook landed in Claude Code's settings
    const settings = JSON.parse(
      readFileSync(path.join(userHome, ".claude", "settings.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    expect(Object.keys(settings.hooks ?? {})).toEqual(
      expect.arrayContaining(["UserPromptSubmit", "SessionStart"]),
    );

    // 4. the rule block reached every detected host
    expect(readFileSync(path.join(userHome, ".claude", "CLAUDE.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
    expect(readFileSync(path.join(userHome, ".codex", "AGENTS.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
    expect(readFileSync(path.join(userHome, ".grok", "AGENTS.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
    // An UNDETECTED host is left alone — never created behind the user's back.
    expect(existsSync(path.join(userHome, ".gemini", "GEMINI.md"))).toBe(false);

    // 5. doctor actually ran and returned a verdict
    expect(step(r, "doctor").status).toBe("ok");
    expect(typeof r.healthy).toBe("boolean");
  });

  it("gives the shim rule body ONLY when the hook that justifies it really landed", async () => {
    // The §2.5b body asserts "context may already be injected by the host
    // retrieval hook". Written without the hook, it tells the model to stop
    // searching in exchange for an injection that never comes.
    const withClaude = fakeHome("mode-hook", [".claude", ".codex"]);
    const r1 = await runSetup(sandboxed(withClaude, freshHome("setup-mode-hook-store")));
    expect(step(r1, "install-hooks").status).toBe("ok");
    expect(readFileSync(path.join(withClaude, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "may already be present",
    );
    // …and the host with no hook gets the search-first body in the same run.
    expect(readFileSync(path.join(withClaude, ".codex", "AGENTS.md"), "utf8")).toContain(
      "call `fimemory_search` first",
    );

    // No Claude Code on this machine → no hook → nobody gets the shim body.
    const noClaude = fakeHome("mode-nohook", [".codex"]);
    const r2 = await runSetup(sandboxed(noClaude, freshHome("setup-mode-nohook-store")));
    expect(step(r2, "install-hooks").status).toBe("skipped");
    // The hook file was NOT fabricated for an app that is not installed.
    expect(existsSync(path.join(noClaude, ".claude", "settings.json"))).toBe(false);
    expect(readFileSync(path.join(noClaude, ".codex", "AGENTS.md"), "utf8")).toContain(
      "call `fimemory_search` first",
    );
  });

  it("is safe to re-run: the second pass writes nothing at all", async () => {
    // EVERY writable host, including all four JSON MCP hosts. With only
    // .claude/.codex/.grok here, the JSON writers all returned "config folder
    // not found" and were never exercised — so this test passed for months
    // while `setup` reported "added the gestalt server (restart gemini …)" on
    // every single run for gemini, cursor, windsurf and claude-desktop, and
    // rewrote their configs with identical bytes and a fresh mtime.
    const userHome = fakeHome("rerun", [
      ".claude",
      ".codex",
      ".grok",
      ".gemini",
      ".cursor",
      path.join(".codeium", "windsurf"),
      path.join("AppData", "Claude"),
    ]);
    const store = freshHome("setup-rerun-store");

    const first = await runSetup(sandboxed(userHome, store));
    expect(first.created).toBe(true);

    const files = [
      path.join(userHome, ".claude", "CLAUDE.md"),
      path.join(userHome, ".codex", "AGENTS.md"),
      path.join(userHome, ".grok", "AGENTS.md"),
      path.join(userHome, ".grok", "config.toml"),
      path.join(userHome, ".claude", "settings.json"),
      path.join(userHome, ".gemini", "settings.json"),
      path.join(userHome, ".cursor", "mcp.json"),
      path.join(userHome, ".codeium", "windsurf", "mcp_config.json"),
      path.join(userHome, "AppData", "Claude", "claude_desktop_config.json"),
    ];
    // Every one of them must exist after the first run, or the assertion below
    // is vacuous for that host.
    for (const f of files) expect(existsSync(f), `${f} should exist after setup`).toBe(true);
    const before = files.map((f) => readFileSync(f, "utf8"));

    const second = await runSetup(sandboxed(userHome, store));

    expect(second.ok).toBe(true);
    // init must NOT run again — it is the one step that could destroy data.
    expect(second.created).toBe(false);
    expect(step(second, "init").status).toBe("skipped");
    // Byte-for-byte identical: every op reported "already up to date".
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
    // PER DETAIL, not on a joined string. Joining first meant one matching host
    // made the whole step pass no matter what the other six said — the exact
    // way this guard green-lit the defect it names. Only `ok` details make a
    // claim about having acted; `skip` rows are "not installed here" and the
    // per-host advisories, and `fail` must not appear at all.
    for (const name of ["install-mcp", "install-rules", "install-hooks"] as const) {
      for (const d of step(second, name).details) {
        expect(d.outcome, `${name} / ${d.name} on the second run`).not.toBe("fail");
        if (d.outcome !== "ok") continue;
        expect(d.text, `${name} / ${d.name} on the second run`).toMatch(
          /already up to date|unchanged/i,
        );
      }
    }
  });

  it("keeps an EXISTING store's contents — re-running never re-inits over real memory", async () => {
    const userHome = fakeHome("existing", [".codex"]);
    const store = freshHome("setup-existing-store");
    await runSetup(sandboxed(userHome, store));

    const notePath = path.join(store, "topics", "getting-started.md");
    const marker = "\n<!-- the owner's own words -->\n";
    writeFileSync(notePath, readFileSync(notePath, "utf8") + marker, "utf8");

    const again = await runSetup(sandboxed(userHome, store));
    expect(again.created).toBe(false);
    expect(readFileSync(notePath, "utf8")).toContain("the owner's own words");
  });
});

describe("a refused encrypted install leaves nothing that looks like a store", () => {
  /**
   * THE VERDICT, reproduced on the encrypted path. A stranger follows the
   * README's encrypted line with no passphrase set and used to get: init FAILS,
   * the run continues and wires MCP + hook + rules to a store that does not
   * exist, and then `fimemory doctor` prints "Store: plaintext" and "Healthy."
   * and exits 0. Worse than the original silence, because the reader ASKED for
   * encryption and was told everything was fine over an empty, unencrypted,
   * config-less folder.
   */
  it("names the passphrase, leaves no skeleton, and doctor refuses to call it healthy", async () => {
    const userHome = fakeHome("enc-nopass", [".claude", ".codex"]);
    const store = freshHome("setup-enc-nopass-store");

    const r = await runSetup(sandboxed(userHome, store, { encrypted: true }));

    const init = step(r, "init");
    expect(init.status).toBe("failed");
    expect(init.error).toMatch(/needs a passphrase/i);
    // The REMEDY travels with the error. Every other verb in this CLI answers a
    // failure with a copy-pastable command; the flagship verb used to be the
    // one that dropped it, keeping err.message and discarding err.hint.
    expect(init.hint, "the GestaltError hint must survive containment").toBeTruthy();
    expect(init.hint).toMatch(/--passphrase/);
    // …and it names the verb the reader actually typed, not `init`.
    expect(init.hint).toContain(`${BIN} setup`);
    expect(init.summary).toContain(init.hint!);

    // NOTHING was left on disk that a later run (or doctor) could mistake for a
    // store. `runInit` creates the directory tree before it can reject the
    // missing passphrase, and it used to leave `topics/` behind.
    expect(existsSync(path.join(store, "topics")), "topics/ must not survive a refused init").toBe(false);
    expect(existsSync(path.join(store, "config.json"))).toBe(false);
    expect(storeExistsAt(store)).toBe(false);

    // And the run does not claim success.
    expect(r.ok).toBe(false);
    expect(r.created).toBe(false);
    expect(r.healthy).toBe(false);
    const doctor = step(r, "doctor");
    expect(doctor.details.some((d) => d.outcome === "fail")).toBe(true);
  });

  it("doctor calls a half-created store what it is, instead of `plaintext / healthy`", () => {
    // Belt and braces for the same defect from the other side: if a skeleton
    // ever appears (an interrupted init, a partial copy, a half-finished
    // restore), doctor must not classify it as a working plaintext store.
    const store = freshHome("doctor-halfstore");
    mkdirSync(path.join(store, "topics"), { recursive: true });

    const r = runDoctor({ home: store, userHome: fakeHome("doctor-halfstore-user"), env: {} });
    expect(r.storePresent).toBe(false);
    expect(r.mode).toBe("absent");
    expect(r.healthy).toBe(false);
    const f = r.findings.find((x) => x.code === "store_half_created");
    expect(f, "a skeleton must raise its own distinct finding").toBeTruthy();
    expect(f!.level).toBe("fail");
    expect(f!.hint).toMatch(/--passphrase/); // the encrypted case is the one that produces it
  });
});

describe("a host config that could not be written is not `not installed here`", () => {
  it("reports the refusal as a FAILURE, not as an absent app", async () => {
    // `WriterResult` distinguishes "app not on this machine" from "app is here
    // and we refused to rewrite its config". Collapsing both into `skip` meant
    // setup printed "1 host configured, 5 not installed here", carried no
    // `fail` detail, painted a green tick and exited 0 — over a Codex that is
    // installed and whose config was refused.
    const userHome = fakeHome("mcp-refused", [".claude", ".codex"]);
    writeFileSync(path.join(userHome, ".codex", "config.toml"), "[[[not toml\n", "utf8");
    const store = freshHome("setup-mcp-refused-store");

    const r = await runSetup(sandboxed(userHome, store));

    const s = step(r, "install-mcp");
    const codex = s.details.find((d) => d.name === "codex")!;
    expect(codex.outcome).toBe("fail");
    expect(s.status).toBe("failed");
    expect(s.summary).toMatch(/COULD NOT BE WRITTEN/);
    // …and the run as a whole does not report success.
    expect(r.ok).toBe(false);
  });
});

describe("no step can take down the ones after it", () => {
  it("reports a failing step and CONTINUES — the run still reaches doctor", async () => {
    const userHome = fakeHome("isolate", [".claude", ".codex"]);
    const store = freshHome("setup-isolate-store");

    // A damaged rule block (begin marker, no end marker) is the real failure
    // installRules refuses on: guessing where it ends risks eating the user's
    // own text. That must cost the rules step and NOTHING else.
    writeFileSync(
      path.join(userHome, ".codex", "AGENTS.md"),
      `# my notes\n\n${RULES_MARKER_BEGIN}\nhalf a block, no end marker\n`,
      "utf8",
    );

    const r = await runSetup(sandboxed(userHome, store));

    expect(step(r, "install-rules").status).toBe("failed");
    expect(step(r, "install-rules").details.find((d) => d.name === "codex")?.outcome).toBe("fail");
    // …and everything else still happened.
    expect(step(r, "init").status).toBe("ok");
    expect(step(r, "install-mcp").status).toBe("ok");
    expect(step(r, "install-hooks").status).toBe("ok");
    expect(step(r, "doctor").status).toBe("ok");
    expect(typeof r.healthy).toBe("boolean");
    // The run is honestly reported as not-ok, and the CLI exits non-zero.
    expect(r.ok).toBe(false);
    // The undamaged host in the SAME step still got its block.
    expect(readFileSync(path.join(userHome, ".claude", "CLAUDE.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
  });

  it("contains a throw from the FIRST step and still wires the machine", async () => {
    // The outer guard, not a per-host one: a store home that is a regular FILE
    // makes `runInit`'s mkdir throw outright. The install steps do not depend
    // on the store existing, so an unusable home must cost the init step and
    // nothing else — and doctor must still get to say the store is missing.
    const userHome = fakeHome("init-throws", [".claude", ".codex"]);
    const store = freshHome("setup-init-throws-store");
    mkdirSync(path.dirname(store), { recursive: true });
    writeFileSync(store, "not a directory", "utf8");

    const r = await runSetup(sandboxed(userHome, store));

    expect(step(r, "init").status).toBe("failed");
    expect(step(r, "init").error).toBeTruthy();
    expect(r.created).toBe(false);
    expect(r.ok).toBe(false);
    // Everything downstream still ran.
    expect(r.steps.map((s) => s.step)).toHaveLength(5);
    expect(step(r, "install-rules").status).toBe("ok");
    expect(step(r, "doctor").status).toBe("ok");
    expect(readFileSync(path.join(userHome, ".claude", "CLAUDE.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
  });

  it("a thrown step is contained as that step's row, never propagated", async () => {
    const userHome = fakeHome("throw", [".claude"]);
    const store = freshHome("setup-throw-store");
    // A registry entry whose rules file is an unreadable DIRECTORY makes the
    // rules step throw from a non-GestaltError path (EISDIR).
    const reg = rulesHosts({ homeDir: userHome, env: {} });
    const codex = hostOf(reg, "codex");
    mkdirSync(codex.file!, { recursive: true });
    mkdirSync(codex.detectDir!, { recursive: true });

    const r = await runSetup(sandboxed(userHome, store, { registry: reg }));

    // Whatever the underlying failure was, it was REPORTED, not thrown.
    expect(r.steps).toHaveLength(5);
    expect(step(r, "doctor").status).toBe("ok");
    expect(step(r, "install-rules").status).toBe("failed");
  });
});

describe("setup reports per step, not a wall of output", () => {
  it("every step carries one summary line and short per-host details", async () => {
    const userHome = fakeHome("shape", [".claude", ".codex", ".grok"]);
    const r = await runSetup(sandboxed(userHome, freshHome("setup-shape-store")));
    for (const s of r.steps) {
      expect(s.summary).not.toContain("\n");
      expect(s.summary.length).toBeGreaterThan(0);
      for (const d of s.details) expect(d.text).not.toContain("\n");
    }
    // install-mcp's generic JSON snippet is the single biggest blob the
    // underlying verbs print. It must never reach setup's report.
    const all = JSON.stringify(r);
    expect(all).not.toContain('"mcpServers"');
  });

  it("names the one thing it could not do for you, with the exact command", async () => {
    const userHome = fakeHome("nextsteps", [".claude"]);
    const r = await runSetup(sandboxed(userHome, freshHome("setup-nextsteps-store")));
    const claudeCode = r.nextSteps.find((n) => n.startsWith("claude mcp add fimemory"));
    expect(claudeCode).toBeDefined();
    expect(claudeCode).toContain("--home");
    // Written ≠ loaded is stated once, where it is actionable.
    expect(r.nextSteps.join("\n")).toMatch(/[Rr]estart/);
  });
});

describe("setup on an ENCRYPTED store", () => {
  // Real Argon2id params (~1.5s) plus a full unlock for the seed writes, so
  // this one genuinely needs longer than vitest's 5s default under load.
  it("creates it, surfaces the shown-once phrase, and still wires every host", { timeout: 60_000 }, async () => {
    const userHome = fakeHome("enc", [".claude", ".codex"]);
    const store = freshHome("setup-enc-store");
    const r = await runSetup(
      sandboxed(userHome, store, {
        encrypted: true,
        passphrase: "a memorable sentence for the tests",
      }),
    );
    expect(r.created).toBe(true);
    // The recovery phrase is never stored, so setup MUST hand it back or it is
    // gone forever — and it must not be buried inside a step's detail lines.
    expect(r.mnemonic?.split(/\s+/)).toHaveLength(24);
    expect(r.kid).toBeTruthy();
    expect(JSON.stringify(r.steps)).not.toContain(r.mnemonic!);
    // Wiring does not depend on the store being unlocked.
    expect(readFileSync(path.join(userHome, ".claude", "CLAUDE.md"), "utf8")).toContain(
      RULES_MARKER_BEGIN,
    );
    expect(existsSync(path.join(userHome, ".codex", "config.toml"))).toBe(true);
  });
});

describe("the passphrase hint runs on the platform it is printed for", () => {
  it("never prints POSIX env-prefix syntax on Windows", () => {
    // `GESTALT_PASSPHRASE=... fimemory get x` is a PARSER ERROR in both shells
    // a Windows user has, and Windows is the only verified platform:
    //   PowerShell → "The term 'GESTALT_PASSPHRASE=...' is not recognized…"
    //   cmd.exe    → "'GESTALT_PASSPHRASE' is not recognized as an internal…"
    const win = passphraseExample("get gestalt-example", "win32");
    expect(win.join("\n")).not.toMatch(/^GESTALT_PASSPHRASE=/m);
    expect(win.some((l) => l.includes("$env:GESTALT_PASSPHRASE"))).toBe(true);
    expect(win.some((l) => l.includes("set \"GESTALT_PASSPHRASE="))).toBe(true);
    // Both shells are labelled — a user cannot be assumed to know which is which.
    expect(win.join("\n")).toMatch(/PowerShell/);
    expect(win.join("\n")).toMatch(/cmd\.exe/);
    // And the command itself is there, built from the shipped bin name.
    expect(win.at(-1)).toBe(`${BIN} get gestalt-example`);
  });

  it("uses no cmd.exe redirection characters in the placeholder", () => {
    // The obvious placeholder `<your passphrase>` is a SECOND parser error in
    // cmd.exe, where < and > are redirection operators:
    //   set GESTALT_PASSPHRASE=<your passphrase>  →  ">& was unexpected at
    //                                                 this time."
    const cmdLine = passphraseExample("get x", "win32").find((l) => l.includes("cmd.exe"))!;
    expect(cmdLine).not.toMatch(/[<>|&^]/);
  });

  it("keeps the correct one-liner on POSIX", () => {
    const posix = passphraseExample("get gestalt-example", "linux");
    expect(posix).toHaveLength(1);
    expect(posix[0]).toMatch(/^GESTALT_PASSPHRASE='[^']*' fimemory get gestalt-example$/);
  });
});

describe("init hands the reader off to the wiring", () => {
  /** Run the real CLI with HOME/USERPROFILE inside the sandbox. */
  function cli(userHome: string, store: string, argv: string[]) {
    return spawnSync(
      process.execPath,
      [TSX, CLI, ...argv],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: userHome,
          USERPROFILE: userHome,
          APPDATA: path.join(userHome, "AppData"),
          // Belt and braces over test/setup.ts's global delete: the host
          // registries consult these BEFORE falling back to <home>/.codex, so
          // an inherited one would send a real write outside the sandbox.
          CODEX_HOME: path.join(userHome, ".codex"),
          GEMINI_CLI_HOME: path.join(userHome, ".gemini"),
          GROK_HOME: path.join(userHome, ".grok"),
          GESTALT_HOME: store,
          NO_COLOR: "1",
        },
      },
    );
  }

  // Each of these spawns tsx, which compiles the whole CLI before it runs —
  // comfortably past vitest's 5s default when the suite is under load.
  it("ends by naming `setup`, not by suggesting a store-local read", { timeout: 60_000 }, () => {
    // THE defect this whole build list exists for: init succeeded, said "Try
    // it: fimemory list", and left the reader believing they were done while
    // the store was connected to nothing.
    const userHome = fakeHome("init-handoff");
    const r = cli(userHome, freshHome("setup-init-handoff-store"), ["init", "--no-seed"]);
    expect(r.status).toBe(0);

    // It says, in plain words, that nothing reads the store yet…
    expect(r.stdout).toMatch(/[Nn]othing reads this store yet/);
    // …and names the command that fixes it.
    expect(r.stdout).toContain(`${BIN} setup`);
    // The old ending must not be the last word any more: `fimemory list` may
    // still appear, but only AFTER the wiring has been named.
    const setupAt = r.stdout.indexOf(`${BIN} setup`);
    const listAt = r.stdout.indexOf(`${BIN} list`);
    expect(setupAt).toBeGreaterThan(-1);
    if (listAt !== -1) expect(setupAt).toBeLessThan(listAt);
  });

  // Every OTHER install verb takes host names (`install-mcp cursor`,
  // `install-rules grok`), so `setup claude-code` is a natural thing to type.
  // Until 2026-08-01 it was swallowed in silence and setup then wired EVERY
  // tool on the machine: the user scoped the run, watched it not be scoped, and
  // was told nothing. Same family as the silence this whole verb exists to kill.
  it("refuses a host name instead of silently wiring everything", { timeout: 60_000 }, () => {
    const userHome = fakeHome("setup-hostarg", [".grok"]);
    const r = cli(userHome, freshHome("setup-hostarg-store"), ["setup", "claude-code"]);

    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/takes no host names/);
    // The refusal has to hand over the commands that DO scope, or it is just a
    // politer dead end.
    expect(r.stderr + r.stdout).toContain(`${BIN} install-mcp claude-code`);
    expect(r.stderr + r.stdout).toContain(`${BIN} install-rules claude-code`);
    // …and nothing may have been written on the way to refusing.
    expect(existsSync(path.join(userHome, ".grok", "AGENTS.md"))).toBe(false);
  });

  it("prints a passphrase example that this platform can actually run", { timeout: 60_000 }, () => {
    const userHome = fakeHome("init-enc-hint");
    const r = cli(userHome, freshHome("setup-init-enc-store"), [
      "init",
      "--encrypted",
      "--passphrase",
      "a memorable sentence for the tests",
      "--no-seed",
    ]);
    expect(r.status).toBe(0);
    // The broken POSIX-only form is gone from the Windows output.
    if (process.platform === "win32") {
      expect(r.stdout).not.toMatch(/^\s*GESTALT_PASSPHRASE=/m);
      expect(r.stdout).toContain("$env:GESTALT_PASSPHRASE");
    }
    for (const line of passphraseExample("get gestalt-example")) {
      expect(r.stdout).toContain(line);
    }
  });

  it("is reachable as a real verb and re-runnable from the CLI", { timeout: 120_000 }, () => {
    const userHome = fakeHome("cli-setup", [".codex"]);
    const store = freshHome("setup-cli-store");
    const first = cli(userHome, store, ["setup", "--json"]);
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout) as SetupResult;
    expect(parsed.created).toBe(true);
    expect(parsed.steps.map((s) => s.step)).toEqual([
      "init",
      "install-mcp",
      "install-hooks",
      "install-rules",
      "doctor",
    ]);

    const second = cli(userHome, store, ["setup", "--json"]);
    expect(second.status).toBe(0);
    const again = JSON.parse(second.stdout) as SetupResult;
    expect(again.created).toBe(false);
    expect(again.ok).toBe(true);
  });
});

describe("no host's hook status is asserted without evidence", () => {
  it("every host states WHY, and never re-makes the claim that was checked false", () => {
    // The pattern that bit three times in one day (2026-07-31): a platform
    // limit asserted in a comment, repeated into the README, never checked
    // against the vendor's docs. "Hooks are Claude Code only" was one of them,
    // and it is FALSE — Grok scans ~/.claude/settings.json by default.
    const reg = rulesHosts({ homeDir: fakeHome("hooknotes"), env: {} });
    for (const h of reg) {
      expect(h.hookNote, `${h.id} has no hookNote`).toBeTruthy();
      // The install screen gets a SHORT form. The full note carries version
      // pins, doc line numbers and the experiment that settled them, which is
      // right for `--list-hosts` and wrong for `setup`: five hosts' worth of
      // citation is the wall of output that verb exists to avoid, and output
      // nobody reads is its own kind of silence.
      expect(h.hookNoteShort, `${h.id} has no hookNoteShort`).toBeTruthy();
      expect(
        h.hookNoteShort.length,
        `${h.id}'s short note is not short (${h.hookNoteShort.length} chars)`,
      ).toBeLessThan(h.hookNote.length);
      expect(h.hookNoteShort.length).toBeLessThanOrEqual(320);
      // As of 2026-08-01 every host without our hook has been CHECKED against
      // the vendor, so the rule is no longer "say UNVERIFIED" — it is "name
      // your source". "We tested this" and "we assumed this" are
      // indistinguishable once the sentence is written confidently, and this
      // project has shipped the confident-but-wrong version more than once.
      //
      //   grok            first-hand: hooks load, Grok drops `args`, stdout
      //                   discarded for the prompt event (positive control run)
      //   cursor          cursor.com/docs/hooks — beforeSubmitPrompt returns
      //                   only { continue, user_message }, shown on BLOCK only
      //   windsurf        docs.windsurf.com — pre_user_prompt is allow/block
      //                   only, no field carries text into the prompt
      //   codex / gemini  the channel EXISTS and takes our exact wire format;
      //                   confirmed first-hand in the binaries on disk. These
      //                   are gaps in our installer, not vendor limits, and the
      //                   note must not imply otherwise.
      //   claude-desktop  settings.json route closed by the vendor (issue
      //                   63360, not planned); the PLUGIN route is genuinely
      //                   unread, so this one must STILL say UNVERIFIED.
      if (!h.supportsHook) {
        expect(
          h.hookNote,
          `${h.id} makes a hook claim without naming where it was read`,
        ).toMatch(/docs|\.com|first-hand|on disk|issue|#\d{4,}|settings\.json/i);
      }
      // The one genuinely unread path left must keep saying so.
      if (h.id === "claude-desktop") {
        expect(h.hookNote).toMatch(/UNVERIFIED/);
      }
      // …and a host whose channel exists must NOT be described as unsupported,
      // because that turns our own missing installer into the vendor's fault.
      if (h.id === "codex" || h.id === "gemini") {
        expect(h.hookNote, `${h.id}'s note should say the channel exists`).toMatch(
          /not a limit of|channel EXISTS|gap in our installer/i,
        );
      }
      // Nobody may claim hooks are exclusive to Claude Code.
      expect(h.hookNote.toLowerCase()).not.toMatch(/hooks are claude code|claude code'?s only/);
    }
  });

  it("grok's note carries the first-hand finding, and grok still does not get the shim body", () => {
    const reg = rulesHosts({ homeDir: fakeHome("groknote"), env: {} });
    const grok = hostOf(reg, "grok");
    // Settled on disk: Grok DOES load our handlers…
    expect(grok.hookNote).toMatch(/DOES load/);
    expect(grok.hookNote).toMatch(/\.claude[/\\]settings\.json|settings\.json/);
    // …but drops `args`, so our hook can never execute…
    expect(grok.hookNote).toMatch(/args/);
    // …and, the reason that CANNOT be worked around and so must be recorded
    // first: Grok runs the hook and throws its stdout away. Without this, a
    // maintainer reading only the `args` gap collapses the invocation into one
    // `command` string (which Grok's own docs allow), watches the hook execute,
    // flips supportsHook to true — and Grok legitimately receives the shim body
    // while injection still never happens.
    expect(grok.hookNote).toMatch(/DISCARDS its stdout|discards.{0,20}stdout/i);
    // The residual caveat rides along: measured headless, TUI not measured.
    expect(grok.hookNote).toMatch(/interactive TUI was not measured/i);
    // "Fails open" is not "silent" — the failure is recorded every prompt, and
    // the safe remedy is Grok's own compat switch, NOT deleting the handlers
    // from the file Claude Code uses.
    expect(grok.hookNote).toMatch(/scrollback/i);
    expect(grok.hookNote).toMatch(/\[compat\.claude\] hooks = false/);
    // …which is why the flag stays false and the search-first body is written.
    expect(grok.supportsHook).toBe(false);
    // The claim is dated and attributed to a version, not left floating.
    expect(grok.hookNote).toMatch(/0\.2\.117/);
    expect(grok.hookNote).toMatch(/2026-07-31/);
  });

  it("codex and gemini name OUR gap, not a vendor limit", () => {
    // This assertion has now moved twice, in the same direction, and the
    // direction is the point. First both notes said a blanket "UNVERIFIED".
    // Then they said "the vendor DOES have hooks, whether ours would work is
    // UNVERIFIED". As of 2026-08-01 the remaining unknown is read too: both
    // channels take the EXACT payload our handler already emits, confirmed
    // first-hand in the shipped binaries on this disk.
    //
    // So the honest sentence is no longer about the vendor at all. It is that
    // our installer does not write these files yet, and the blocker is the
    // shape of our own handler (`args`, which only Claude Code has). Letting a
    // note imply a vendor limit where we have an unfinished installer is the
    // same failure as claiming a capability we lack, pointed the other way.
    const reg = rulesHosts({ homeDir: fakeHome("hostevidence"), env: {} });

    const codex = hostOf(reg, "codex");
    expect(codex.hookNote).toMatch(/UserPromptSubmit/);
    expect(codex.hookNote).toMatch(/additionalContext/);
    expect(codex.hookNote).toMatch(/0\.145\.0/); // version-pinned
    expect(codex.hookNote).toMatch(/not a limit of Codex/i); // ours, not theirs
    expect(codex.hookNote).toMatch(/`args`/); // the actual blocker, named
    // The reason we are NOT shipping it despite the channel existing.
    expect(codex.hookNote).toMatch(/16933/);
    expect(codex.supportsHook).toBe(false);

    const gemini = hostOf(reg, "gemini");
    expect(gemini.hookNote).toMatch(/BeforeAgent/);
    expect(gemini.hookNote).toMatch(/additionalContext/);
    expect(gemini.hookNote).toMatch(/0\.52\.0/);
    expect(gemini.hookNote).toMatch(/not a limit of Gemini/i);
    // The one thing still genuinely untested, which must survive as a caveat
    // rather than be rounded off to "it works".
    expect(gemini.hookNote).toMatch(/isTrustedFolder/);
    // The hazard a Gemini user can walk into on their own: the vendor's OWN
    // migration imports our handlers and drops `args`.
    expect(gemini.hookNote).toMatch(/hooks migrate/);
    expect(gemini.hookNote).toMatch(/drops `args`/i);
    expect(gemini.supportsHook).toBe(false);
  });

  it("windsurf is a stated ceiling now, not an unknown", () => {
    // Was "whether Windsurf supports hooks at all is UNVERIFIED". It has them,
    // at three merged levels — but `pre_user_prompt` is allow/block only, so
    // the hand-off can never run there. Same ceiling as Cursor, and worth
    // recording as a ceiling so nobody re-opens it as a to-do.
    const w = hostOf(rulesHosts({ homeDir: fakeHome("windsurfceiling"), env: {} }), "windsurf");
    expect(w.hookNote).toMatch(/allow\/block/i);
    expect(w.hookNote).toMatch(/docs\.windsurf\.com/);
    expect(w.hookNote).not.toMatch(/whether Windsurf supports hooks at all is UNVERIFIED/i);
    expect(w.supportsHook).toBe(false);
  });

  it("claude-code's registry entry records that Grok reads its file too", () => {
    const reg = rulesHosts({ homeDir: fakeHome("sharedfile"), env: {} });
    // As DATA, not as a comment: the next host added must trip over this field
    // rather than have to rediscover that rules files are not private.
    expect(hostOf(reg, "claude-code").alsoReadBy).toContain("grok");
  });

  it("the downgrade note the user sees is the host's own reason", async () => {
    const userHome = fakeHome("downgrade", [".claude", ".grok"]);
    const r = await runSetup(sandboxed(userHome, freshHome("setup-downgrade-store")));
    const grokLine = step(r, "install-rules").details.find((d) => d.name === "grok");
    expect(grokLine?.notes?.join(" ")).toMatch(/search-first block/);
    expect(grokLine?.notes?.join(" ")).toMatch(/DOES load/);
    expect(grokLine?.notes?.join(" ")).not.toMatch(/hooks are Claude Code/i);
    // On this same machine ~/.claude/CLAUDE.md is shared with Grok, so it must
    // ALSO be downgraded, and its own line must say who it was downgraded for.
    const claudeLine = step(r, "install-rules").details.find((d) => d.name === "claude-code");
    expect(claudeLine?.notes?.join(" ")).toMatch(/Grok CLI also reads it/i);
    expect(readFileSync(path.join(userHome, ".claude", "CLAUDE.md"), "utf8")).toContain(
      "call `fimemory_search` first",
    );
  });

  it("tells you Grok will also load the hook file it just wrote", async () => {
    // Concrete consequence, reproduced on the owner's real machine: Grok fires
    // these handlers on every prompt with argv empty. Nothing is blocked, but
    // "fails open" is NOT "silent" — Grok's own docs say every hook failure is
    // recorded for the UI scrollback. A user who sees that recurring failure
    // takes the obvious remedy and deletes the unfamiliar handlers from
    // ~/.claude/settings.json, which silently turns off the ONE host where the
    // hook works. So the line has to name the safe remedy instead.
    const userHome = fakeHome("grokhook", [".claude", ".grok"]);
    const r = await runSetup(sandboxed(userHome, freshHome("setup-grokhook-store")));
    const line = step(r, "install-hooks").details.find((d) => d.name === "grok");
    expect(line).toBeDefined();
    expect(line!.text).toMatch(/scans this same file|also load/i);
    expect(line!.text).toMatch(/nothing is blocked|fails open|[Hh]armless/i);
    expect(line!.text).toMatch(/scrollback/i);
    expect(line!.text).toContain("[compat.claude] hooks = false");
  });

  it("warns a Gemini user off the vendor's own hook migration", async () => {
    // `gemini hooks migrate` reads <cwd>/.claude/settings.json and copies only
    // command/type/timeout, dropping `args` — the Grok defect, reproduced by a
    // first-party command, with no warning anywhere in our code or docs before
    // this. Read in @google/gemini-cli 0.52.0 on disk, 2026-08-01.
    const userHome = fakeHome("geminihook", [".claude", ".gemini"]);
    const r = await runSetup(sandboxed(userHome, freshHome("setup-geminihook-store")));
    const line = step(r, "install-hooks").details.find((d) => d.name === "gemini");
    expect(line).toBeDefined();
    expect(line!.text).toMatch(/hooks migrate/);
    expect(line!.text).toMatch(/args/);
  });
});
