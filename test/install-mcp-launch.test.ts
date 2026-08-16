import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { detectExecutionContext, installMcp } from "../src/ops/installMcp.js";
import { freshHome } from "./helpers.js";

/**
 * Phase C (install guide): the launch command written into host configs must be
 * the RESOLVED installed form when the CLI runs from an npm-installed package,
 * and the dev-checkout pin only as an explicit, warned fallback. `npx -y` is
 * never a default. Plus the optional `--env` block: plaintext-by-explicit-choice,
 * default writes NO env and NO secret.
 */

const fakePkgJson = JSON.stringify({ name: "fimemory", bin: { fimemory: "./dist/cli.js" } });

describe("detectExecutionContext — installed vs dev checkout", () => {
  it("classifies a path outside node_modules as a dev checkout", () => {
    const ctx = detectExecutionContext("/home/e/source/Gestalt/runtime/dist/cli.js", {
      platform: "linux",
      exists: () => true,
      readFile: () => fakePkgJson,
    });
    expect(ctx.kind).toBe("dev");
    expect(ctx.binPath).toBeUndefined();
  });

  it("resolves the local-install bin (node_modules/.bin/<bin>) on POSIX", () => {
    const cli = "/proj/node_modules/fimemory/dist/cli.js";
    const bin = join("/proj/node_modules", ".bin", "fimemory");
    const ctx = detectExecutionContext(cli, {
      platform: "linux",
      exists: (p) => p === bin,
      readFile: (p) => {
        expect(p).toBe(join("/proj/node_modules", "fimemory", "package.json"));
        return fakePkgJson;
      },
    });
    expect(ctx.kind).toBe("installed");
    expect(ctx.binPath).toBe(bin);
  });

  it("resolves the global-prefix bin (<prefix>/bin/<bin>) on POSIX", () => {
    const cli = "/usr/local/lib/node_modules/fimemory/dist/cli.js";
    const bin = join("/usr/local", "bin", "fimemory");
    const ctx = detectExecutionContext(cli, {
      platform: "darwin",
      exists: (p) => p === bin,
      readFile: () => fakePkgJson,
    });
    expect(ctx.kind).toBe("installed");
    expect(ctx.binPath).toBe(bin);
  });

  it("handles scoped packages (node_modules/@scope/name)", () => {
    const cli = "/proj/node_modules/@futureindustries/memory/dist/cli.js";
    let readAt = "";
    detectExecutionContext(cli, {
      platform: "linux",
      exists: () => false,
      readFile: (p) => {
        readAt = p;
        return JSON.stringify({ name: "@futureindustries/memory", bin: { fimemory: "./dist/cli.js" } });
      },
    });
    expect(readAt).toBe(join("/proj/node_modules", "@futureindustries", "memory", "package.json"));
  });

  it("on win32 an installed package gets NO binPath — node + cli.js is the resolved form (never the .cmd shim)", () => {
    const cli = "C:\\npm\\node_modules\\fimemory\\dist\\cli.js";
    const ctx = detectExecutionContext(cli, {
      platform: "win32",
      exists: () => true, // even if a shim exists on disk, we refuse it
      readFile: () => fakePkgJson,
    });
    expect(ctx.kind).toBe("installed");
    expect(ctx.binPath).toBeUndefined();
  });

  it("survives an unreadable package.json (falls back to node + cli.js, still installed)", () => {
    const ctx = detectExecutionContext("/x/node_modules/p/dist/cli.js", {
      platform: "linux",
      exists: () => true,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(ctx.kind).toBe("installed");
    expect(ctx.binPath).toBeUndefined();
  });
});

describe("installMcp — launch command selection", () => {
  it("dev checkout: keeps the node + dist/cli.js pin and WARNS it is a development pin", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const r = await installMcp({
      targets: ["cursor"],
      cursorConfigPath: join(dir, "mcp.json"),
      cliPath: join(dir, "dist", "cli.js"), // no node_modules segment → dev
      home: dir,
    });
    expect(r.context.kind).toBe("dev");
    expect(r.serverEntry.command).toBe(process.execPath);
    expect(r.serverEntry.args[0]).toContain(`dist${sep}cli.js`);
    expect(r.warnings.some((w) => w.code === "dev_path_pin")).toBe(true);
    // npx is never the default launch shape.
    expect(r.serverEntry.command).not.toContain("npx");
    expect(r.snippet).not.toContain("npx");
  });

  it("installed with a resolved bin: writes the bin as the command", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "fimemory");
    const cli = join(dir, "node_modules", "fimemory", "dist", "cli.js");
    const r = await installMcp({
      targets: ["cursor"],
      cursorConfigPath: join(dir, "mcp.json"),
      cliPath: cli,
      home: dir,
      detect: { platform: "linux", exists: (p) => p === bin, readFile: () => fakePkgJson },
    });
    expect(r.context.kind).toBe("installed");
    expect(r.serverEntry.command).toBe(bin);
    expect(r.serverEntry.args).toEqual(["mcp", "--home", dir]);
    expect(r.warnings.some((w) => w.code === "dev_path_pin")).toBe(false);
  });

  it("installed without a resolvable bin: node + installed cli.js, no dev warning", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "node_modules", "fimemory", "dist", "cli.js");
    const r = await installMcp({
      targets: ["cursor"],
      cursorConfigPath: join(dir, "mcp.json"),
      cliPath: cli,
      home: dir,
      detect: { platform: "win32", exists: () => true, readFile: () => fakePkgJson },
    });
    expect(r.context.kind).toBe("installed");
    expect(r.serverEntry.command).toBe(process.execPath);
    expect(r.serverEntry.args[0]).toBe(cli);
    expect(r.warnings.some((w) => w.code === "dev_path_pin")).toBe(false);
  });
});

describe("installMcp — optional env block (plaintext by explicit choice)", () => {
  it("default: NO env block is written anywhere", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    const r = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    expect(r.serverEntry.env).toBeUndefined();
    expect(readFileSync(cfg, "utf8")).not.toContain('"env"');
  });

  it("--env KEY=VALUE lands in JSON host configs, with the plaintext warning", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    const r = await installMcp({
      targets: ["cursor"],
      cursorConfigPath: cfg,
      cliPath: "/fake/cli.js",
      home: dir,
      env: { GESTALT_PASSPHRASE: "hunter2" },
    });
    expect(r.serverEntry.env).toEqual({ GESTALT_PASSPHRASE: "hunter2" });
    expect(r.warnings.some((w) => w.code === "env_in_config" && w.message.includes("PLAIN TEXT"))).toBe(true);
    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as {
      mcpServers: { fimemory: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.fimemory.env).toEqual({ GESTALT_PASSPHRASE: "hunter2" });
  });

  it("--env-passthrough copies from the environment; a missing key is skipped with a warning, never written empty", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    const r = await installMcp({
      targets: ["cursor"],
      cursorConfigPath: cfg,
      cliPath: "/fake/cli.js",
      home: dir,
      envPassthrough: ["GESTALT_PASSPHRASE", "NOT_SET_ANYWHERE"],
      processEnv: { GESTALT_PASSPHRASE: "from-env" },
    });
    expect(r.serverEntry.env).toEqual({ GESTALT_PASSPHRASE: "from-env" });
    expect(r.warnings.some((w) => w.code === "env_missing" && w.message.includes("NOT_SET_ANYWHERE"))).toBe(true);
  });

  it("the claude-code one-liner carries the env block as -e flags (and none by default)", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const withEnv = await installMcp({
      targets: ["claude-code"],
      cliPath: "/fake/cli.js",
      home: dir,
      env: { GESTALT_PASSPHRASE: "hunter2" },
    });
    // Claude Code is configured via this pasted command, not a file we write —
    // the user's explicit --env choice must not be silently dropped there.
    expect(withEnv.claudeCode?.command).toContain('-e "GESTALT_PASSPHRASE=hunter2"');
    expect(withEnv.claudeCode?.command).toMatch(/-e "GESTALT_PASSPHRASE=hunter2" --/);

    const noEnv = await installMcp({ targets: ["claude-code"], cliPath: "/fake/cli.js", home: dir });
    expect(noEnv.claudeCode?.command).not.toContain("-e ");
    expect(noEnv.claudeCode?.command).toContain("claude mcp add fimemory -s user -- ");
  });

  it("codex TOML gets an env sub-table, and re-running WITHOUT --env removes it", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, '[model]\nname = "o5"\n', "utf8");
    await installMcp({
      targets: ["codex"],
      codexConfigPath: cfg,
      cliPath: "/fake/cli.js",
      home: dir,
      env: { GESTALT_PASSPHRASE: "hunter2" },
    });
    const withEnv = readFileSync(cfg, "utf8");
    expect(withEnv).toContain("[mcp_servers.fimemory.env]");
    expect(withEnv).toContain('GESTALT_PASSPHRASE = "hunter2"');
    expect(withEnv).toContain("[model]");

    await installMcp({ targets: ["codex"], codexConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    const withoutEnv = readFileSync(cfg, "utf8");
    expect(withoutEnv).not.toContain("[mcp_servers.fimemory.env]");
    expect(withoutEnv).not.toContain("hunter2"); // the dropped secret must not linger
    expect(withoutEnv).toContain("[mcp_servers.fimemory]");
    expect(withoutEnv).toContain("[model]");
  });
});
