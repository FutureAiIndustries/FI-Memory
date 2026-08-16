import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { defaultRulesFiles, runDoctor, UNLOCK_HINT } from "../src/ops/doctor.js";
import type { DoctorOptions } from "../src/ops/doctor.js";
import { rulesBlock } from "../src/ops/installRules.js";
import type { InstallTarget } from "../src/ops/installMcp.js";
import { writeSessionCache, wipeSessionCache } from "../src/sessionKeyCache.js";
import { clearActiveKey } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { recordRead } from "../src/telemetry.js";
import { freshHome } from "./helpers.js";

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
/** An env with NO ambient credentials — a real machine's GESTALT_PASSPHRASE
 * must never leak into these assertions. */
const CLEAN_ENV = {} as NodeJS.ProcessEnv;

/** Fixture host configs in a temp dir — doctor must never read the real ones
 * in tests. `registered` controls whether cursor's file carries the entry. */
function hostFixtures(label: string, registered: boolean): Partial<Record<InstallTarget, string>> {
  const dir = freshHome(`doc-hosts-${label}`);
  mkdirSync(dir, { recursive: true });
  const cursor = path.join(dir, "cursor-mcp.json");
  writeFileSync(
    cursor,
    JSON.stringify(registered ? { mcpServers: { fimemory: { command: "node", args: [] } } } : { mcpServers: {} }),
    "utf8",
  );
  const codex = path.join(dir, "codex-config.toml");
  writeFileSync(codex, registered ? '[mcp_servers.fimemory]\ncommand = "node"\n' : "# empty\n", "utf8");
  return {
    "claude-code": path.join(dir, "absent-claude.json"),
    "claude-desktop": path.join(dir, "absent-desktop.json"),
    cursor,
    codex,
    gemini: path.join(dir, "absent-gemini.json"),
    // Grok is a TOML host like codex; fixture-only, so the real ~/.grok/config.toml
    // (which the owner has, registered) can never leak into these assertions.
    grok: path.join(dir, "absent-grok.toml"),
    windsurf: path.join(dir, "absent-windsurf.json"),
  };
}

/** Fixture rules files. */
function rulesFixtures(label: string, written: boolean): { host: string; file: string }[] {
  const dir = freshHome(`doc-rules-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "CLAUDE.md");
  if (written) writeFileSync(file, "mine\n\n" + rulesBlock() + "\n", "utf8");
  else writeFileSync(file, "mine, no block\n", "utf8");
  return [{ host: "claude", file }];
}

/** Isolated Claude settings path so doctor never reads the real ~/.claude. */
function shimSettingsFixture(label: string): string {
  const dir = freshHome(`doc-shim-${label}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "settings.json");
}

function baseOpts(label: string, over: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    env: CLEAN_ENV,
    hostConfigPaths: hostFixtures(label, true),
    rulesPaths: rulesFixtures(label, true),
    shimSettingsPath: shimSettingsFixture(label),
    ...over,
  };
}

/** Recursive path|size|mtime fingerprint — the "doctor writes NOTHING" proof. */
function fingerprint(dir: string): string[] {
  const rows: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(d, name);
      const st = statSync(p);
      rows.push(`${p}|${st.isDirectory() ? "dir" : `${st.size}|${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return rows;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("fimemory doctor — store mode + key sources", () => {
  it("absent store: mode 'absent', fail finding, not healthy", () => {
    const home = freshHome("doc-absent");
    const r = runDoctor(baseOpts("absent", { home }));
    expect(r.mode).toBe("absent");
    expect(r.healthy).toBe(false);
    expect(r.findings.some((f) => f.code === "store_missing" && f.level === "fail")).toBe(true);
  });

  it("plaintext store with MCP registered + rules written: healthy (warn-only telemetry findings)", () => {
    const home = freshHome("doc-plain");
    runInit({ home });
    recordRead(home, "fimemory_search", ["x"], "mcp"); // loaded evidence
    const r = runDoctor(baseOpts("plain", { home }));
    expect(r.mode).toBe("plaintext");
    expect(r.healthy).toBe(true);
    expect(r.findings.every((f) => f.level !== "fail")).toBe(true);
    expect(r.mcp.find((m) => m.target === "cursor")!.registered).toBe(true);
    expect(r.mcp.find((m) => m.target === "codex")!.registered).toBe(true);
    expect(r.mcp.find((m) => m.target === "gemini")!.registered).toBe(false);
    expect(r.rules[0]!.written).toBe(true);
    expect(r.lastRead!.source).toBe("mcp");
  });

  it("encrypted + warm session cache: mode encrypted-unlocked with TTL remaining", () => {
    const home = freshHome("doc-warm");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    const dek = unlockWithPassphrase(home, PASS);
    writeSessionCache(home, dek, 3_600_000);
    clearActiveKey(); // unlockWithPassphrase activates in-process; later plaintext inits must not seal
    const r = runDoctor(baseOpts("warm", { home }));
    expect(r.mode).toBe("encrypted-unlocked");
    expect(r.healthy).toBe(true);
    expect(r.keySources!.cache.state).toBe("warm");
    if (r.keySources!.cache.state === "warm") {
      expect(r.keySources!.cache.msRemaining).toBeGreaterThan(0);
    }
  });

  it("encrypted + cold cache + no env: encrypted-LOCKED with the exact unlock hint, fail finding", () => {
    const home = freshHome("doc-locked");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    wipeSessionCache(home);
    const r = runDoctor(baseOpts("locked", { home }));
    expect(r.mode).toBe("encrypted-locked");
    expect(r.unlockHint).toBe(UNLOCK_HINT);
    expect(r.unlockHint).toContain("GESTALT_PASSPHRASE");
    expect(r.unlockHint).toContain("fimemory unlock");
    expect(r.unlockHint).toContain("fimemory lock --status");
    expect(r.healthy).toBe(false);
    expect(r.findings.some((f) => f.code === "store_locked" && f.level === "fail")).toBe(true);
  });

  it("locked but GESTALT_PASSPHRASE set: WARN (next command unlocks), never the secret in the report", () => {
    const home = freshHome("doc-pass");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    wipeSessionCache(home);
    const r = runDoctor(baseOpts("pass", { home, env: { GESTALT_PASSPHRASE: PASS } as NodeJS.ProcessEnv }));
    expect(r.mode).toBe("encrypted-locked");
    expect(r.keySources!.envPassphraseSet).toBe(true);
    expect(r.healthy).toBe(true); // warn, not fail — the setup works on next use
    expect(r.findings.some((f) => f.code === "locked_passphrase_available" && f.level === "warn")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PASS); // detection is presence-only
  });

  it("doctor NEVER writes: store, session dir, and telemetry dir are byte-identical after a run", () => {
    // PRIVATE session + telemetry dirs: the suite-wide sandbox is shared with
    // concurrently-running test files, whose own writes would flake the
    // fingerprint comparison.
    const sessionDir = path.join(freshHome("doc-nowrite-sess"), "session-keys");
    const telemetryDir = path.join(freshHome("doc-nowrite-tel"), "telemetry");
    withEnv(
      { GESTALT_SESSION_DIR: sessionDir, GESTALT_TELEMETRY_DIR: telemetryDir },
      () => {
        const home = freshHome("doc-nowrite");
        runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
        clearActiveKey();
        const dek = unlockWithPassphrase(home, PASS);
        // An EXPIRED cache entry on disk — readSessionCache would wipe it; doctor must not.
        writeSessionCache(home, dek, 3_600_000, Date.now() - 7_200_000);
        clearActiveKey(); // see the warm test — never leave a live DEK behind
        recordRead(home, "search", ["a"], "cli");
        const before = [
          ...fingerprint(home),
          ...fingerprint(sessionDir),
          ...fingerprint(telemetryDir),
        ];
        const r = runDoctor(baseOpts("nowrite", { home }));
        expect(r.keySources!.cache.state).toBe("expired"); // reported, not repaired
        const after = [
          ...fingerprint(home),
          ...fingerprint(sessionDir),
          ...fingerprint(telemetryDir),
        ];
        expect(after).toEqual(before);
      },
    );
  });
});

describe("fimemory doctor — written vs loaded + divergence", () => {
  it("MCP registered nowhere: fail finding naming install-mcp", () => {
    const home = freshHome("doc-nomcp");
    runInit({ home });
    const r = runDoctor(baseOpts("nomcp", { home, hostConfigPaths: hostFixtures("nomcp-off", false) }));
    expect(r.healthy).toBe(false);
    const f = r.findings.find((x) => x.code === "mcp_not_registered")!;
    expect(f.level).toBe("fail");
    expect(f.hint).toContain("install-mcp");
  });

  it("rules not written anywhere: warn only", () => {
    const home = freshHome("doc-norules");
    runInit({ home });
    recordRead(home, "fimemory_get", ["x"], "mcp");
    const r = runDoctor(baseOpts("norules", { home, rulesPaths: rulesFixtures("norules-off", false) }));
    expect(r.rules[0]!.written).toBe(false);
    expect(r.findings.find((x) => x.code === "rules_not_written")!.level).toBe("warn");
    expect(r.healthy).toBe(true);
  });

  it("SOME detected hosts missing the block still warns — one host cannot silence the rest", () => {
    // The all-missing check goes quiet the moment a single host carries the
    // block. On a four-host machine that meant one hand-written ~/.claude
    // CLAUDE.md reported Healthy while three hosts had nothing at all.
    const home = freshHome("doc-rules-partial");
    runInit({ home });
    recordRead(home, "fimemory_get", ["x"], "mcp");
    const dir = freshHome("doc-rules-mixed");
    mkdirSync(dir, { recursive: true });
    const withBlock = path.join(dir, "CLAUDE.md");
    const without = path.join(dir, "AGENTS.md");
    writeFileSync(withBlock, "mine\n\n" + rulesBlock() + "\n", "utf8");
    writeFileSync(without, "codex notes, no block\n", "utf8");

    const r = runDoctor(
      baseOpts("rules-partial", {
        home,
        rulesPaths: [
          { host: "claude-code", file: withBlock },
          { host: "codex", file: without },
        ],
      }),
    );
    expect(r.findings.find((x) => x.code === "rules_not_written")).toBeUndefined();
    const f = r.findings.find((x) => x.code === "rules_not_written_host")!;
    expect(f.level).toBe("warn");
    expect(f.message).toContain("codex");
    expect(f.message).not.toContain("claude-code");
    expect(r.healthy).toBe(true); // still warn-only, per addendum §2.4
  });

  it("the DEFAULT rules scan is the install-rules registry, on the same home", () => {
    // The point of deriving from `detectRulesHosts` is that writer and checker
    // cannot drift; that property was asserted nowhere, because the default was
    // unreachable without touching the real ~/.
    const userHome = freshHome("doc-rules-userhome");
    mkdirSync(path.join(userHome, ".codex"), { recursive: true });
    expect(defaultRulesFiles({ homeDir: userHome, env: {} })).toEqual([
      { host: "codex", file: path.join(userHome, ".codex", "AGENTS.md") },
    ]);

    // An empty home still yields the claude-code floor, so the section is never
    // silent — but it points at THIS home, not the developer's.
    const empty = freshHome("doc-rules-emptyhome");
    mkdirSync(empty, { recursive: true });
    expect(defaultRulesFiles({ homeDir: empty, env: {} })).toEqual([
      { host: "claude-code", file: path.join(empty, ".claude", "CLAUDE.md") },
    ]);
  });

  it("never-read store: never fails, and reads as expected rather than as a defect (addendum §2.4)", () => {
    // The invariant this test has always been about is in its own name:
    // last-read must not flip the exit verdict. It asserted level === "warn" as
    // a way of saying "not fail", which over-specified it.
    //
    // Both lines are now "info" on a never-read store, because that is the
    // EXPECTED state at the end of a successful install: the user cannot have
    // generated a read, since they have not restarted their AI tool yet. A
    // clean first run used to end on two yellow warnings, and a stranger's
    // reasonable conclusion was that something had not worked.
    const home = freshHome("doc-neverread");
    runInit({ home });
    const r = runDoctor(baseOpts("neverread", { home }));
    expect(r.lastRead).toBeNull();

    const neverRead = r.findings.find((x) => x.code === "never_read")!;
    const notLoaded = r.findings.find((x) => x.code === "mcp_written_not_loaded")!;

    // The real contract: neither may ever be a fail, whatever else changes.
    expect(neverRead.level).not.toBe("fail");
    expect(notLoaded.level).not.toBe("fail");
    expect(r.healthy).toBe(true);

    // And on a store nothing has touched, neither should look like a problem.
    expect(neverRead.level).toBe("info");
    expect(notLoaded.level).toBe("info");
  });

  it("MCP written but never loaded WHILE something else reads the store: that is a real warn", () => {
    // The other half of the same branch, and the reason it is not a blanket
    // softening. If the shim or the CLI is reaching the store but the MCP entry
    // we wrote has never loaded, the user believes they are connected and is
    // only half connected. That earns the yellow the fresh-install case does
    // not.
    const home = freshHome("doc-mcp-never-loaded");
    runInit({ home });
    recordRead(home, "brief", [], "cli", Date.now());
    const r = runDoctor(baseOpts("mcpneverloaded", { home }));
    const notLoaded = r.findings.find((x) => x.code === "mcp_written_not_loaded")!;
    expect(notLoaded.level).toBe("warn");
    expect(r.healthy).toBe(true);
  });

  it("stale last-read (older than the window): warn with the age in it", () => {
    const home = freshHome("doc-stale");
    runInit({ home });
    recordRead(home, "fimemory_search", [], "mcp", Date.now() - 3 * 24 * 3_600_000);
    const r = runDoctor(baseOpts("stale", { home }));
    const f = r.findings.find((x) => x.code === "not_read_recently")!;
    expect(f.level).toBe("warn");
    expect(r.healthy).toBe(true);
  });

  it("'shim locked, MCP warm' divergence: locked store + recent MCP read is called out (Session-2 #2)", () => {
    const home = freshHome("doc-diverge");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    wipeSessionCache(home);
    recordRead(home, "fimemory_get", ["hot-topic"], "mcp", Date.now() - 5 * 60_000);
    const r = runDoctor(baseOpts("diverge", { home }));
    expect(r.mode).toBe("encrypted-locked");
    expect(r.divergence).toBe("shim-locked-mcp-warm");
    expect(r.findings.some((x) => x.code === "shim_locked_mcp_warm" && x.level === "warn")).toBe(true);
  });

  it("no divergence when the MCP read is old — a dead server is not 'warm'", () => {
    const home = freshHome("doc-nodiverge");
    runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
    clearActiveKey();
    wipeSessionCache(home);
    recordRead(home, "fimemory_get", ["x"], "mcp", Date.now() - 3 * 3_600_000);
    const r = runDoctor(baseOpts("nodiverge", { home }));
    expect(r.divergence).toBeUndefined();
  });
});

describe("fimemory doctor — host config parsing", () => {
  it("reports grok beside the other hosts, from the same registry install-mcp writes", () => {
    const home = freshHome("doc-grok");
    runInit({ home });
    const hosts = hostFixtures("grok", true);
    writeFileSync(
      hosts.grok!,
      '[cli]\nauto_update = true\n\n[mcp_servers.fimemory]\ncommand = "node"\n',
      "utf8",
    );
    const r = runDoctor(baseOpts("grok", { home, hostConfigPaths: hosts }));
    const grok = r.mcp.find((m) => m.target === "grok")!;
    expect(grok.configPresent).toBe(true);
    expect(grok.registered).toBe(true);

    // …and an installed Grok with no gestalt section reads as present-not-registered.
    writeFileSync(hosts.grok!, "[cli]\nauto_update = true\n", "utf8");
    const r2 = runDoctor(baseOpts("grok2", { home, hostConfigPaths: hosts }));
    const grok2 = r2.mcp.find((m) => m.target === "grok")!;
    expect(grok2.configPresent).toBe(true);
    expect(grok2.registered).toBe(false);
  });

  it("the DEFAULT host scan honors $GROK_HOME and the injected user home", () => {
    const userHome = freshHome("doc-hosts-userhome");
    const grokHome = freshHome("doc-hosts-grokhome");
    const r = runDoctor({
      home: freshHome("doc-hosts-store"),
      env: { GROK_HOME: grokHome } as NodeJS.ProcessEnv,
      userHome,
      rulesPaths: [],
      shimSettingsPath: shimSettingsFixture("hosts-default"),
    });
    // No fixture overrides at all: the paths must still be THIS home's, never
    // the developer's real ~/.grok.
    expect(r.mcp.find((m) => m.target === "grok")!.path).toBe(path.join(grokHome, "config.toml"));
    expect(r.mcp.find((m) => m.target === "codex")!.path).toBe(
      path.join(userHome, ".codex", "config.toml"),
    );
    expect(r.mcp.every((m) => !m.configPresent)).toBe(true);
  });

  it("a commented-out TOML section is NOT 'registered' (line-anchored match)", () => {
    const home = freshHome("doc-toml-comment");
    runInit({ home });
    const hosts = hostFixtures("toml-comment", true);
    writeFileSync(
      hosts.codex!,
      '# was here once:\n#[mcp_servers.fimemory]\n#command = "node"\n',
      "utf8",
    );
    const r = runDoctor(baseOpts("toml-comment", { home, hostConfigPaths: hosts }));
    expect(r.mcp.find((m) => m.target === "codex")!.registered).toBe(false);
    // and an indented REAL header still counts
    writeFileSync(hosts.codex!, '  [mcp_servers.fimemory]\n  command = "node"\n', "utf8");
    const r2 = runDoctor(baseOpts("toml-comment2", { home, hostConfigPaths: hosts }));
    expect(r2.mcp.find((m) => m.target === "codex")!.registered).toBe(true);
  });
});

describe("fimemory doctor — isolation guard", () => {
  it("uses ONLY the injected fixture paths (a bogus override is honestly reported absent)", () => {
    // Belt-and-suspenders: overriding every target must mean no real host
    // config can influence the result — a fixture dir with nothing in it
    // reports every config as not found.
    const home = freshHome("doc-iso");
    runInit({ home });
    const dir = freshHome("doc-iso-empty");
    mkdirSync(dir, { recursive: true });
    const empty = Object.fromEntries(
      (["claude-code", "claude-desktop", "cursor", "codex", "gemini", "grok", "windsurf"] as InstallTarget[]).map(
        (t) => [t, path.join(dir, `${t}.json`)],
      ),
    ) as Partial<Record<InstallTarget, string>>;
    const r = runDoctor(baseOpts("iso", { home, hostConfigPaths: empty }));
    expect(r.mcp.every((m) => !m.configPresent && !m.registered)).toBe(true);
  });
});
