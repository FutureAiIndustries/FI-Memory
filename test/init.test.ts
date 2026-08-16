import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { expectGestaltError, freshHome } from "./helpers.js";

const LAYOUT = [
  "config.json",
  "index.json",
  "topics/gestalt-example.md",
  "logs/gestalt-example.log.md",
  "proposals/1-gestalt-example.md",
];

describe("init", () => {
  it("creates the full store layout (SPEC §1)", () => {
    const home = freshHome();
    const result = runInit({ home });

    for (const rel of LAYOUT) {
      expect(existsSync(path.join(home, rel)), rel).toBe(true);
    }
    expect(result.topicCount).toBe(1);
    expect(result.pendingProposals).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.home).toBe(path.resolve(home));
  });

  it("writes config.json = frozen defaults (SPEC §5.9), pretty-printed + trailing newline", () => {
    const home = freshHome();
    runInit({ home });
    const raw = readFileSync(path.join(home, "config.json"), "utf8");

    expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "noteTokenCap": 1000'); // 2-space pretty print
    expect(raw).toContain('  "editor": null');
  });

  it("index.json registry has exactly the example topic", () => {
    const home = freshHome();
    runInit({ home });
    const index = JSON.parse(
      readFileSync(path.join(home, "index.json"), "utf8"),
    ) as { version: number; topics: Record<string, unknown> };
    expect(index.version).toBe(1);
    expect(Object.keys(index.topics)).toEqual(["gestalt-example"]);
  });

  it("refuses to clobber an existing store (E_EXISTS)", () => {
    const home = freshHome();
    runInit({ home });
    expectGestaltError(() => runInit({ home }), "E_EXISTS");
  });

  it("writes UTF-8 without BOM, LF-only newlines (clean cross-platform files)", () => {
    const home = freshHome();
    runInit({ home });
    for (const rel of LAYOUT) {
      const buf = readFileSync(path.join(home, rel));
      expect(buf[0], `${rel} starts with BOM`).not.toBe(0xef);
      expect(buf.includes(0x0d), `${rel} contains CR`).toBe(false);
    }
  });
});
