import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runDoctor } from "../src/ops/doctor.js";
import { installHooks } from "../src/ops/installHooks.js";
import { rulesBlock } from "../src/ops/installRules.js";
import { recordShimAudit } from "../src/ops/shimAudit.js";
import type { InstallTarget } from "../src/ops/installMcp.js";
import { freshHome } from "./helpers.js";

const CLEAN_ENV = {} as NodeJS.ProcessEnv;

function hostFixtures(label: string): Partial<Record<InstallTarget, string>> {
  const dir = freshHome(`dshim-hosts-${label}`);
  mkdirSync(dir, { recursive: true });
  const cursor = path.join(dir, "cursor.json");
  writeFileSync(cursor, JSON.stringify({ mcpServers: { gestalt: { command: "node", args: [] } } }));
  const codex = path.join(dir, "codex.toml");
  writeFileSync(codex, "[mcp_servers.gestalt]\ncommand = \"node\"\n");
  return {
    "claude-code": path.join(dir, "absent.json"),
    "claude-desktop": path.join(dir, "absent2.json"),
    cursor,
    codex,
    gemini: path.join(dir, "absent3.json"),
    grok: path.join(dir, "absent5.toml"), // never the real ~/.grok/config.toml
    windsurf: path.join(dir, "absent4.json"),
  };
}

describe("doctor — shim surface (F-struct)", () => {
  it("reports shim not written when settings empty", () => {
    const home = freshHome("doc-shim-absent");
    runInit({ home });
    const settings = path.join(freshHome("doc-shim-set-absent"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, "{}\n");
    const rulesDir = freshHome("doc-shim-rules-absent");
    mkdirSync(rulesDir, { recursive: true });
    const rules = path.join(rulesDir, "CLAUDE.md");
    writeFileSync(rules, rulesBlock() + "\n");

    const r = runDoctor({
      home,
      env: CLEAN_ENV,
      hostConfigPaths: hostFixtures("absent"),
      rulesPaths: [{ host: "claude", file: rules }],
      shimSettingsPath: settings,
    });
    expect(r.shim.written).toBe(false);
    expect(r.shimAudit).toBeNull();
    expect(r.findings.some((f) => f.code === "shim_orphan_hooks")).toBe(false);
  });

  it("FAIL on orphaned shim hooks (path does not resolve)", async () => {
    const home = freshHome("doc-shim-orphan");
    runInit({ home });
    const settings = path.join(freshHome("doc-shim-set-orphan"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const missingCli = path.join(home, "nope-cli.js");
    await installHooks({
      home,
      settingsPath: settings,
      cliPath: missingCli,
      nodePath: process.execPath,
    });
    const rulesDir = freshHome("doc-shim-rules-orphan");
    mkdirSync(rulesDir, { recursive: true });
    const rules = path.join(rulesDir, "CLAUDE.md");
    writeFileSync(rules, rulesBlock("shim") + "\n");

    const r = runDoctor({
      home,
      env: CLEAN_ENV,
      hostConfigPaths: hostFixtures("orphan"),
      rulesPaths: [{ host: "claude", file: rules }],
      shimSettingsPath: settings,
    });
    expect(r.shim.written).toBe(true);
    expect(r.shim.resolvable).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.findings.some((f) => f.code === "shim_orphan_hooks" && f.level === "fail")).toBe(true);
  });

  it("healthy when hooks resolvable; surfaces last inject audit", async () => {
    const home = freshHome("doc-shim-ok");
    runInit({ home });
    const settings = path.join(freshHome("doc-shim-set-ok"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// ok\n");
    await installHooks({
      home,
      settingsPath: settings,
      cliPath,
      nodePath: process.execPath,
    });
    recordShimAudit(home, {
      durationMs: 42,
      topics: ["gestalt-example"],
      tokens: 120,
      injected: true,
    });
    const rulesDir = freshHome("doc-shim-rules-ok");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "CLAUDE.md"), rulesBlock("shim") + "\n");

    const r = runDoctor({
      home,
      env: CLEAN_ENV,
      hostConfigPaths: hostFixtures("ok"),
      rulesPaths: [{ host: "claude", file: path.join(rulesDir, "CLAUDE.md") }],
      shimSettingsPath: settings,
    });
    expect(r.shim.written).toBe(true);
    expect(r.shim.resolvable).toBe(true);
    expect(r.shim.userPromptSubmit).toBe(true);
    expect(r.shim.sessionStart).toBe(true);
    expect(r.shimAudit?.lastInjectTopics).toContain("gestalt-example");
    expect(r.findings.some((f) => f.code === "shim_orphan_hooks")).toBe(false);
  });

  it("warns when last skip reason is locked", async () => {
    const home = freshHome("doc-shim-locked-skip");
    runInit({ home });
    const settings = path.join(freshHome("doc-shim-set-lock"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// ok\n");
    await installHooks({ home, settingsPath: settings, cliPath, nodePath: process.execPath });
    recordShimAudit(home, {
      durationMs: 5,
      skippedReason: "locked",
      injected: false,
    });
    const rulesDir = freshHome("doc-shim-rules-lock");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "CLAUDE.md"), rulesBlock("shim") + "\n");

    const r = runDoctor({
      home,
      env: CLEAN_ENV,
      hostConfigPaths: hostFixtures("lock"),
      rulesPaths: [{ host: "claude", file: path.join(rulesDir, "CLAUDE.md") }],
      shimSettingsPath: settings,
    });
    expect(r.findings.some((f) => f.code === "shim_skipped_locked" && f.level === "warn")).toBe(true);
  });
});
