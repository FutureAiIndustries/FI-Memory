import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installMcp } from "../src/ops/installMcp.js";
import { freshHome } from "./helpers.js";

/**
 * `install-mcp` writes HOST APP config files (Claude Desktop, Cursor, Gemini,
 * Windsurf, Codex) — they are NOT store files and must never be routed through
 * the storage codec. They used to be written via `writeFileAtomic`, whose codec
 * classifies an unknown path as kind "other", and `isWholeFileEncrypted("other")`
 * is true (the correct fail-safe for unknown files INSIDE the store) — so with a
 * key active `fimemory install-mcp` ENCRYPTED the user's host config and broke
 * their client. These tests pin the fix: host configs stay plaintext even with a
 * key active. Isolated to this file so GESTALT_KEY only affects this process
 * (vitest forks per file). Only injected temp fixture paths are ever written —
 * never a real `~/.cursor/mcp.json` etc.
 */
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ENC_MAGIC = "gestalt-enc:1:";

beforeAll(() => {
  process.env.GESTALT_KEY = KEY;
});
afterAll(() => {
  delete process.env.GESTALT_KEY;
});

describe("install-mcp never encrypts host configs (key active)", () => {
  it("writes every JSON host config as plaintext JSON, not codec ciphertext", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const r = await installMcp({
      targets: ["claude-desktop", "cursor", "gemini", "windsurf"],
      desktopConfigPath: join(dir, "claude_desktop_config.json"),
      cursorConfigPath: join(dir, "mcp.json"),
      geminiConfigPath: join(dir, "settings.json"),
      windsurfConfigPath: join(dir, "mcp_config.json"),
      cliPath: "/fake/cli.js",
      home: dir,
    });

    expect(r.writers).toHaveLength(4);
    for (const w of r.writers) {
      expect(w.wrote).toBe(true);
      const raw = readFileSync(w.path, "utf8");
      // The bug: with a key active this was `gestalt-enc:1:<base64url>`.
      expect(raw.startsWith(ENC_MAGIC)).toBe(false);
      expect(raw).not.toContain(ENC_MAGIC);
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers["fimemory"]).toBeDefined();
    }
  });

  it("writes the codex TOML host config as plaintext TOML, preserving other sections", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, '[model]\nname = "o5"\n', "utf8");

    await installMcp({ targets: ["codex"], codexConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    const raw = readFileSync(cfg, "utf8");
    expect(raw).not.toContain(ENC_MAGIC);
    expect(raw).toContain("[mcp_servers.fimemory]");
    expect(raw).toContain("[model]"); // untouched
  });

  it("stays idempotent with a key active: re-running merges rather than failing to re-read its own write", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }), "utf8");

    await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    // Pre-fix the first write left ciphertext on disk, so this second pass could
    // not JSON.parse its own output and bailed with "not valid JSON".
    const r2 = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    // The second pass must SUCCEED, and succeeding now means `unchanged`: the
    // JSON writer compares the merged bytes against the file and writes
    // nothing when they match, the same check the TOML writer has always had.
    // (What this test really guards is that the first write left readable JSON
    // rather than ciphertext — a re-run that reported "not valid JSON" was the
    // original bug. `unchanged: true` proves the re-read worked.)
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(r2.writers[0]!.wrote).toBe(false);
    expect(r2.writers[0]!.note).toMatch(/already up to date/i);

    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["fimemory"]).toBeDefined();
    expect(parsed.mcpServers["other"]).toBeDefined(); // never clobbered
  });
});
