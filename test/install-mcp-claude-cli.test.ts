import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectClaudeCli, installMcp } from "../src/ops/installMcp.js";
import { runSetup } from "../src/ops/setup.js";
import { rulesHosts } from "../src/ops/installRules.js";
import { freshHome } from "./helpers.js";

/**
 * The `claude mcp add` line and the machine that cannot run it.
 *
 * The 2026-08-05 Mac beta (hank-e-d/mac-store, BETA-NOTES §3) hit the one
 * defect that actually BLOCKED an install: Claude Code there is the VSCode
 * extension plus Claude.app, neither of which ships a `claude` binary — so the
 * handed-off one-liner died with `command not found: claude` and no pointer to
 * the real fix. The manual fix that worked (a `mcpServers` entry pasted into
 * ~/.claude.json) is exactly what the product must hand over FIRST on such a
 * machine. Deference to Claude Code's ownership of its config file stays; the
 * fallback just has to work for the hosts that deference targets.
 */

describe("detectClaudeCli — a PATH scan, injectable end to end", () => {
  it("finds a `claude` binary on a POSIX PATH and misses an empty one", () => {
    const bindir = freshHome("claude-cli-bin");
    mkdirSync(bindir, { recursive: true });
    writeFileSync(path.join(bindir, "claude"), "#!/bin/sh\n", "utf8");

    expect(detectClaudeCli({ PATH: bindir }, "linux")).toBe(true);
    expect(detectClaudeCli({ PATH: freshHome("claude-cli-empty") }, "linux")).toBe(false);
    expect(detectClaudeCli({ PATH: "" }, "linux")).toBe(false);
    expect(detectClaudeCli({}, "linux")).toBe(false);
  });

  it("accepts the win32 shim spellings", () => {
    // npm's global shim is `claude.cmd`; native installers ship `claude.exe`.
    // The injected `exists` keeps this assertable without a Windows runner.
    // Host-native path shapes on purpose: the `platform` parameter selects the
    // candidate NAMES only — PATH is split with the host's own delimiter, so a
    // literal `C:\bin` here would be split on its colon by a POSIX runner.
    const bindir = path.join(freshHome("claude-cli-win"), "bin");
    const hits = new Set([path.join(bindir, "claude.cmd")]);
    expect(detectClaudeCli({ PATH: bindir }, "win32", (p) => hits.has(p))).toBe(true);
    // POSIX does not look for .cmd.
    expect(detectClaudeCli({ PATH: bindir }, "linux", (p) => hits.has(p))).toBe(false);
  });
});

describe("install-mcp hands over a remedy the machine can actually run", () => {
  const sandboxMcp = (cliDetected: boolean) => {
    const userHome = freshHome(`claude-cli-mcp-${cliDetected}`);
    mkdirSync(userHome, { recursive: true });
    return installMcp({
      home: freshHome("claude-cli-store"),
      claudeCliDetected: cliDetected,
      desktopConfigPath: path.join(userHome, "AppData", "Claude", "claude_desktop_config.json"),
      cursorConfigPath: path.join(userHome, ".cursor", "mcp.json"),
      codexConfigPath: path.join(userHome, ".codex", "config.toml"),
      geminiConfigPath: path.join(userHome, ".gemini", "settings.json"),
      grokConfigPath: path.join(userHome, ".grok", "config.toml"),
      windsurfConfigPath: path.join(userHome, ".codeium", "windsurf", "mcp_config.json"),
    });
  };

  it("always carries the command, the verdict, and the manual fallback", async () => {
    const r = await sandboxMcp(false);
    expect(r.claudeCode).toBeDefined();
    const cc = r.claudeCode!;
    expect(cc.cliDetected).toBe(false);
    // The command survives either way — the user may install the CLI later.
    expect(cc.command).toMatch(/^claude mcp add fimemory/);
    // The fallback names the ONE file doctor also scans for this host…
    expect(cc.configPath.endsWith(".claude.json")).toBe(true);
    // …and the snippet is a paste-ready mcpServers block with the stdio type a
    // hand-edited ~/.claude.json needs.
    const parsed = JSON.parse(cc.snippet) as {
      mcpServers: { fimemory: { type: string; command: string; args: string[] } };
    };
    expect(parsed.mcpServers.fimemory.type).toBe("stdio");
    expect(parsed.mcpServers.fimemory.args).toContain("mcp");
  });

  it("reports detection truthfully when the CLI is present", async () => {
    const r = await sandboxMcp(true);
    expect(r.claudeCode!.cliDetected).toBe(true);
  });
});

describe("setup leads with the remedy that works on THIS machine", () => {
  async function setupWith(cliDetected: boolean) {
    const userHome = freshHome(`claude-cli-setup-${cliDetected}`);
    mkdirSync(path.join(userHome, ".claude"), { recursive: true });
    return runSetup({
      home: freshHome(`claude-cli-setup-store-${cliDetected}`),
      userHome,
      env: {},
      registry: rulesHosts({ homeDir: userHome, env: {} }),
      hooksSettingsPath: path.join(userHome, ".claude", "settings.json"),
      mcp: {
        claudeCliDetected: cliDetected,
        desktopConfigPath: path.join(userHome, "AppData", "Claude", "claude_desktop_config.json"),
        cursorConfigPath: path.join(userHome, ".cursor", "mcp.json"),
        codexConfigPath: path.join(userHome, ".codex", "config.toml"),
        geminiConfigPath: path.join(userHome, ".gemini", "settings.json"),
        grokConfigPath: path.join(userHome, ".grok", "config.toml"),
        windsurfConfigPath: path.join(userHome, ".codeium", "windsurf", "mcp_config.json"),
      },
      doctor: { userHome },
    });
  }

  it("CLI present: the one-liner is the next step, no JSON block", async () => {
    const r = await setupWith(true);
    expect(r.nextSteps.some((n) => n.startsWith("claude mcp add fimemory"))).toBe(true);
    expect(r.nextSteps.join("\n")).not.toContain('"mcpServers"');
  });

  it("CLI absent: the paste block leads, the one-liner survives as the footnote", async () => {
    const r = await setupWith(false);
    const joined = r.nextSteps.join("\n");
    // The working remedy: the exact file and a paste-ready block.
    expect(joined).toContain(".claude.json");
    expect(joined).toContain('"mcpServers"');
    expect(joined).toContain('"type": "stdio"');
    // No next step LEADS with the command that cannot run here…
    expect(r.nextSteps.some((n) => n.startsWith("claude mcp add fimemory"))).toBe(false);
    // …but it is still handed over for the day the CLI shows up.
    expect(joined).toContain("claude mcp add fimemory");
    // And the step detail says paste, not run.
    const mcpStep = r.steps.find((s) => s.step === "install-mcp")!;
    const cc = mcpStep.details.find((d) => d.name === "claude-code")!;
    expect(cc.text).toMatch(/paste|by hand/i);
    expect(cc.text).not.toMatch(/^needs one command/);
  });
});
