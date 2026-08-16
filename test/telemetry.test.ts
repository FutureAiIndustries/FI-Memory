import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { handleRpc } from "../src/mcp/server.js";
import {
  readTelemetry,
  recordRead,
  telemetryDir,
  telemetryPath,
} from "../src/telemetry.js";
import { freshHome, writeNote } from "./helpers.js";

/** Run `fn` with telemetry routed into a PRIVATE directory (same rationale as
 * the session-cache tests: the suite-wide sandbox is shared across parallel
 * test files, so absence/exact-content assertions need their own dir). */
function withPrivateTelemetryDir<T>(label: string, fn: (dir: string) => T): T {
  const dir = path.join(freshHome(`${label}-tel`), "telemetry");
  const saved = process.env.GESTALT_TELEMETRY_DIR;
  process.env.GESTALT_TELEMETRY_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (saved === undefined) delete process.env.GESTALT_TELEMETRY_DIR;
    else process.env.GESTALT_TELEMETRY_DIR = saved;
  }
}

/** Every path under `dir` with mtime+size — the store-untouched fingerprint. */
function fingerprint(dir: string): string[] {
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      rows.push(`${p}|${st.isDirectory() ? "dir" : `${st.size}|${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return rows;
}

describe("last-read telemetry — heartbeat outside the store, store byte-untouched", () => {
  it("recordRead writes a per-store heartbeat OUTSIDE the store home; readTelemetry returns it", () => {
    withPrivateTelemetryDir("basic", () => {
      const home = freshHome("tel-basic");
      runInit({ home });
      const before = fingerprint(home);

      recordRead(home, "search", ["topic-a", "topic-b"], "cli", Date.parse("2026-07-26T10:00:00Z"));
      recordRead(home, "fimemory_get", ["topic-a"], "mcp", Date.parse("2026-07-26T10:05:00Z"));

      // The store itself is byte-untouched — reads must never dirty the synced home.
      expect(fingerprint(home)).toEqual(before);
      const file = telemetryPath(home);
      expect(file.startsWith(path.resolve(home) + path.sep)).toBe(false);
      expect(existsSync(file)).toBe(true);

      const t = readTelemetry(home)!;
      expect(t.lastRead!.op).toBe("fimemory_get");
      expect(t.lastRead!.source).toBe("mcp");
      expect(t.lastRead!.topics).toEqual(["topic-a"]);
      expect(t.bySource["cli"]!.op).toBe("search");
      expect(t.bySource["cli"]!.topics).toEqual(["topic-a", "topic-b"]);
      expect(t.bySource["mcp"]!.ts).toBe("2026-07-26T10:05:00.000Z");
    });
  });

  it("is per-store keyed — two stores never share a slot", () => {
    withPrivateTelemetryDir("keyed", () => {
      const a = freshHome("tel-a");
      const b = freshHome("tel-b");
      expect(telemetryPath(a)).not.toBe(telemetryPath(b));
      recordRead(a, "search", [], "cli");
      expect(readTelemetry(a)).not.toBeNull();
      expect(readTelemetry(b)).toBeNull();
    });
  });

  it("REFUSES to write when the telemetry dir would land inside the store home", () => {
    const home = freshHome("tel-contain");
    mkdirSync(home, { recursive: true });
    const saved = process.env.GESTALT_TELEMETRY_DIR;
    process.env.GESTALT_TELEMETRY_DIR = path.join(home, "telemetry");
    try {
      recordRead(home, "search", ["x"], "cli");
      expect(existsSync(path.join(home, "telemetry"))).toBe(false); // nothing entered the store
      expect(readTelemetry(home)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.GESTALT_TELEMETRY_DIR;
      else process.env.GESTALT_TELEMETRY_DIR = saved;
    }
  });

  it("never throws when the telemetry dir is unwritable (best-effort by contract)", () => {
    const saved = process.env.GESTALT_TELEMETRY_DIR;
    // A FILE where the dir should be — mkdir/write will fail; the record must not throw.
    const home = freshHome("tel-unwritable");
    const bogus = path.join(freshHome("tel-bogus"), "not-a-dir");
    mkdirSync(path.dirname(bogus), { recursive: true });
    writeFileSync(bogus, "i am a file, not a directory", "utf8");
    // point the "dir" at a path UNDER that file
    process.env.GESTALT_TELEMETRY_DIR = path.join(bogus, "child");
    try {
      expect(() => recordRead(home, "search", [], "cli")).not.toThrow();
      expect(readTelemetry(home)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.GESTALT_TELEMETRY_DIR;
      else process.env.GESTALT_TELEMETRY_DIR = saved;
    }
  });

  it("MCP search/get record heartbeats with source 'mcp' (the written-vs-loaded evidence)", async () => {
    await withPrivateTelemetryDir("mcp", async () => {
      const home = freshHome("tel-mcp");
      runInit({ home });
      writeNote(home, "alpha-topic", { title: "Alpha", body: "\nAlpha body text\n\n## Owner notes\n" });

      await handleRpc(home, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "fimemory_search", arguments: { query: "alpha" } },
      });
      let t = readTelemetry(home)!;
      expect(t.lastRead!.op).toBe("fimemory_search");
      expect(t.lastRead!.source).toBe("mcp");

      await handleRpc(home, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "fimemory_get", arguments: { ids: ["alpha-topic"] } },
      });
      t = readTelemetry(home)!;
      expect(t.lastRead!.op).toBe("fimemory_get");
      expect(t.lastRead!.topics).toEqual(["alpha-topic"]);
    });
  });

  it("telemetryDir honors the env override; a corrupt file reads as absent", () => {
    withPrivateTelemetryDir("corrupt", (dir) => {
      expect(telemetryDir()).toBe(path.resolve(dir));
      const home = freshHome("tel-corrupt");
      recordRead(home, "get", ["a"], "cli");
      // Corrupt it on disk — readTelemetry must degrade to null, never throw.
      const file = telemetryPath(home);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "{not json", "utf8");
      expect(readTelemetry(home)).toBeNull();
    });
  });
});
