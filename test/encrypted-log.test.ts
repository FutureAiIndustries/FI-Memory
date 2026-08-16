import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { fsPath, topicLogPath, topicNotePath } from "../src/paths.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import {
  decodeLogEntry,
  decryptFile,
  encodeLogEntry,
  encryptFile,
  keyState,
} from "../src/store/codec.js";
import { formatEntryBlock, parseLog, serializeLog } from "../src/store/log.js";
import type { LogEntry } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { freshHome } from "./helpers.js";

/**
 * E1 crux — encryption at rest that still git-union-merges. Isolated to this
 * file so GESTALT_KEY only affects this process (vitest forks per file). Proves
 * the mechanism at the unit level; the two-machine REAL git merge lives in the
 * scratchpad harness (scripts/e1-merge-harness.mjs).
 */
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(() => {
  process.env.GESTALT_KEY = KEY;
});
afterAll(() => {
  delete process.env.GESTALT_KEY;
});

/** Build a LogEntry from parts without going through the (now encrypted) parser. */
function entry(
  ts: string,
  type: string,
  project: string,
  agent: string,
  summary: string,
): LogEntry {
  const raw = formatEntryBlock(ts, { type, project, agent, summary });
  return { timestamp: ts, type, project, agent, supersedes: null, reported: null, summary, raw };
}

describe("encrypted log codec (E1)", () => {
  it("keyState reports encrypted with a 32-byte DEK", () => {
    const s = keyState();
    expect(s.mode).toBe("encrypted");
    expect(s.dek?.length).toBe(32);
  });

  it("encodeLogEntry → `<ts> <base64url>`: deterministic, single-line, no plaintext leak", () => {
    const block = "### 2026-07-14T12:00:00.000Z | decision | demo | cli\nchose the seam approach\ndetail";
    const line = encodeLogEntry("widget", block);

    expect(line.startsWith("2026-07-14T12:00:00.000Z ")).toBe(true); // plaintext ts prefix
    expect(line.includes("\n")).toBe(false); // exactly one line → union-merge friendly
    expect(line).not.toContain("chose the seam approach"); // summary is encrypted
    expect(encodeLogEntry("widget", block)).toBe(line); // DETERMINISTIC → byte-stable
    expect(decodeLogEntry("widget", line)).toBe(block); // round-trips
  });

  it("AEAD binds the entry to (topic, timestamp) — tamper is detected", () => {
    const block = "### 2026-07-14T12:00:00.000Z | decision | demo | cli\nx";
    const line = encodeLogEntry("topic-a", block);
    const [ts, b64] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];

    // wrong topic id → wrong AAD → auth fails
    expect(() => decodeLogEntry("topic-b", line)).toThrow();
    // forged plaintext timestamp prefix (ts is AAD-bound) → auth fails
    expect(() => decodeLogEntry("topic-a", `2020-01-01T00:00:00.000Z ${b64}`)).toThrow();
    // flipped ciphertext byte → auth fails
    const tampered = `${ts} ${b64[0] === "A" ? "B" : "A"}${b64.slice(1)}`;
    expect(() => decodeLogEntry("topic-a", tampered)).toThrow();
  });

  it("whole-file note codec: opaque on disk, deterministic, rejects non-ciphertext", () => {
    const p = "/s/.gestalt/topics/widget.md";
    const note = "---\nid: widget\n---\n\nclassified body\n";
    const enc = encryptFile(p, note);

    expect(enc.startsWith("gestalt-enc:1:")).toBe(true);
    expect(enc).not.toContain("classified body");
    expect(decryptFile(p, enc)).toBe(note); // round-trips
    expect(encryptFile(p, note)).toBe(enc); // deterministic
    expect(() => decryptFile(p, "not ciphertext at all")).toThrow(); // fail closed
  });

  it("config + log files pass through at the boundary; the derived index is sealed", () => {
    expect(encryptFile("/s/.gestalt/config.json", "{}\n")).toBe("{}\n");
    // log FILE is pass-through here — per-entry encryption happens in serializeLog.
    expect(encryptFile("/s/.gestalt/logs/x.log.md", "# x log\n")).toBe("# x log\n");
    // index.json IS whole-file encrypted (it catalogs note titles/tags/sizes).
    const idx = encryptFile("/s/.gestalt/index.json", '{"version":1,"topics":{}}\n');
    expect(idx.startsWith("gestalt-enc:1:")).toBe(true);
    expect(idx).not.toContain("topics");
    expect(decryptFile("/s/.gestalt/index.json", idx)).toBe('{"version":1,"topics":{}}\n');
  });

  it("fail-closed: plaintext content in an encrypted store throws E_STORE_MODE, never silent", () => {
    // a plaintext note read while a key is set
    expect(() => decryptFile("/s/.gestalt/topics/x.md", "---\nid: x\n---\n\nplain\n")).toThrow(
      /E_STORE_MODE|plaintext/i,
    );
    // a plaintext log parsed while a key is set (would otherwise be re-serialized away)
    expect(() =>
      parseLog("# x log\n\n### 2026-07-14T00:00:00.000Z | decision | p | a\nhi\n"),
    ).toThrow();
  });

  it("rejects a malformed GESTALT_KEY (strict 64-hex; no silent truncation of trailing junk)", () => {
    const saved = process.env.GESTALT_KEY;
    try {
      process.env.GESTALT_KEY = KEY + "zz"; // valid 64-hex prefix + junk must NOT pass
      expect(() => keyState()).toThrow(/64 hex/i);
      process.env.GESTALT_KEY = "abc"; // too short
      expect(() => keyState()).toThrow(/64 hex/i);
    } finally {
      process.env.GESTALT_KEY = saved;
      keyState(); // restore the cached good key for later tests
    }
  });

  it("serializeLog/parseLog round-trip, and a simulated union-merge keeps BOTH machines' entries", () => {
    const eA = entry("2026-07-14T12:00:00.000Z", "decision", "demo", "machineA", "from A");
    const eB = entry("2026-07-14T12:00:01.000Z", "pattern", "demo", "machineB", "from B");

    const logA = serializeLog("widget", [eA]);
    expect(parseLog(logA).entries.map((e) => e.summary)).toEqual(["from A"]);

    // git merge=union concatenates the distinct entry lines from both machines,
    // never reading (decrypting) them. Reconstruct exactly that outcome:
    const merged = `# widget log\n\n${encodeLogEntry("widget", eA.raw)}\n${encodeLogEntry("widget", eB.raw)}\n`;
    const parsed = parseLog(merged);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries.map((e) => e.summary)).toEqual(["from A", "from B"]);
    // Re-serializing the merged entries is byte-stable (deterministic nonce).
    expect(serializeLog("widget", parsed.entries)).toBe(merged);
  });

  it("fail-closed: an undecodable line in an encrypted log throws — never silently dropped (Grok F1)", () => {
    const eGood = entry("2026-07-14T12:00:00.000Z", "decision", "demo", "a", "keep me");
    const merged = `# widget log\n\n${encodeLogEntry("widget", eGood.raw)}\n2026-07-14T12:00:02.000Z AAAA\n`;
    expect(() => parseLog(merged, "widget")).toThrow(/E_STORE_MODE|decrypt|wrong key/i);
  });

  it("fail-closed: a WRONG key never silently under-reads a note or a log (Grok F1/F2)", () => {
    const line = encodeLogEntry("widget", "### 2026-07-14T12:00:00.000Z | decision | demo | a\nsecret entry");
    const noteBlob = encryptFile("/s/.gestalt/topics/widget.md", "---\nid: widget\n---\n\nsecret note\n");
    const saved = process.env.GESTALT_KEY;
    try {
      process.env.GESTALT_KEY = "ff".repeat(32); // a DIFFERENT valid 64-hex key
      // whole-file note: hard error, NOT null/"looks missing"
      expect(() => decryptFile("/s/.gestalt/topics/widget.md", noteBlob)).toThrow(/E_STORE_MODE|decrypt|wrong key/i);
      // log: the parse THROWS — it does not return [] (which would be overwritten to nothing)
      expect(() => parseLog(`# widget log\n\n${line}\n`, "widget")).toThrow(/E_STORE_MODE|decrypt|wrong key/i);
    } finally {
      process.env.GESTALT_KEY = saved;
      keyState();
    }
  });

  it("a log RELOCATED to another topic fails to decode under its real (path) id (Grok F3)", () => {
    const line = encodeLogEntry("hr", "### 2026-07-14T12:00:00.000Z | decision | demo | a\nhr salary data");
    const relocated = `# hr log\n\n${line}\n`; // attacker copies hr's log over another topic's file
    // Read with the AUTHENTICATED id from the path → mismatched AAD → detected.
    expect(() => parseLog(relocated, "public")).toThrow(/E_STORE_MODE|decrypt|relocat|wrong key/i);
    // Sanity: under its real id it decodes fine.
    expect(parseLog(relocated, "hr").entries[0]!.summary).toBe("hr salary data");
  });

  it("on disk: note is one opaque blob, log is per-entry lines; both decrypt on read", async () => {
    const home = freshHome("enc");
    runInit({ home });

    const notePath = topicNotePath(home, "secret");
    const noteText = "---\nid: secret\ntitle: Secret\n---\n\nclassified body\n";
    await writeFileAtomic(notePath, noteText);
    const rawNote = readFileSync(fsPath(notePath), "utf8");
    expect(rawNote.startsWith("gestalt-enc:1:")).toBe(true);
    expect(rawNote).not.toContain("classified body");
    expect(await readText(notePath)).toBe(noteText);

    const logPath = topicLogPath(home, "secret");
    const logText = serializeLog("secret", [
      entry("2026-07-14T12:00:00.000Z", "gotcha", "demo", "a", "do not leak this summary"),
    ]);
    await writeFileAtomic(logPath, logText);
    const rawLog = readFileSync(fsPath(logPath), "utf8");
    expect(rawLog).toContain("# secret log"); // header stays readable
    expect(rawLog).toContain("2026-07-14T12:00:00.000Z "); // ts prefix (deliberate metadata leak)
    expect(rawLog).not.toContain("do not leak this summary"); // body encrypted
    expect(parseLog((await readText(logPath))!).entries[0]!.summary).toBe("do not leak this summary");
  });
});
