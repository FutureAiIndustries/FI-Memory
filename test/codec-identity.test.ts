import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { buildExample } from "../src/example.js";
import { fsPath, topicLogPath, topicNotePath } from "../src/paths.js";
import { writeFileAtomic } from "../src/store/atomic.js";
import {
  decodeLogEntry,
  decryptFile,
  encodeLogEntry,
  encryptFile,
  fileKind,
  keyState,
} from "../src/store/codec.js";
import { parseLog, serializeLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { freshHome } from "./helpers.js";

/**
 * E0 acceptance: the storage codec seam exists and is the IDENTITY function in
 * v1, so nothing on disk changes and every other test stays green. This locks
 * the seam's shape (so E1/E2 can swap crypto in without touching callers) and
 * proves the write/read paths transform no bytes today.
 */
describe("storage codec seam (E0 identity)", () => {
  it("the store is plaintext in v1 (no key material)", () => {
    expect(keyState().mode).toBe("plaintext");
  });

  it("classifies store paths by kind, separator-agnostic", () => {
    for (const sep of ["/", "\\"]) {
      const j = (...parts: string[]): string => parts.join(sep);
      const home = j("home", "u", ".gestalt");
      expect(fileKind(j(home, "topics", "foo.md"))).toBe("note");
      expect(fileKind(j(home, "logs", "foo.log.md"))).toBe("log");
      expect(fileKind(j(home, "proposals", "3-foo.md"))).toBe("proposal");
      expect(fileKind(j(home, "index.json"))).toBe("index");
      expect(fileKind(j(home, "config.json"))).toBe("config");
      expect(fileKind(j(home, "notes.txt"))).toBe("other");
    }
  });

  it("encryptFile/decryptFile are the identity function for every kind", () => {
    const samples: Record<string, string> = {
      "/s/.gestalt/topics/a.md": "---\nid: a\n---\n\nbody\n",
      "/s/.gestalt/logs/a.log.md": "# a log\n\n### 2026-07-14T00:00:00.000Z | decision | p | x\nhi\n",
      "/s/.gestalt/proposals/1-a.md": "---\nstatus: pending\n---\n\npatch\n",
      "/s/.gestalt/index.json": '{"version":1}\n',
      "/s/.gestalt/config.json": '{"noteTokenCap":1000}\n',
      "/s/.gestalt/misc.txt": "anything at all",
    };
    for (const [path, text] of Object.entries(samples)) {
      expect(encryptFile(path, text)).toBe(text);
      expect(decryptFile(path, text)).toBe(text);
      expect(decryptFile(path, encryptFile(path, text))).toBe(text);
    }
  });

  it("encodeLogEntry/decodeLogEntry are the identity function", () => {
    const block = "### 2026-07-14T00:00:00.000Z | decision | p | x\nsummary\nbody";
    expect(encodeLogEntry("topic-a", block)).toBe(block);
    expect(decodeLogEntry("topic-a", block)).toBe(block);
    expect(decodeLogEntry("topic-a", encodeLogEntry("topic-a", block))).toBe(block);
  });

  it("writeFileAtomic writes bytes unchanged to disk, and readText returns them", async () => {
    const home = freshHome("codec");
    runInit({ home });
    const notePath = topicNotePath(home, "codec-check");
    const content = "---\nid: codec-check\ntitle: Codec Check\n---\n\nhello world\n";

    await writeFileAtomic(notePath, content);

    // On-disk bytes match the input exactly (identity codec — no transform).
    expect(readFileSync(fsPath(notePath), "utf8")).toBe(content);
    // The read path is likewise transparent.
    expect(await readText(notePath)).toBe(content);
  });

  it("logs round-trip byte-for-byte through the per-entry codec", async () => {
    const ex = buildExample();
    const { entries } = parseLog(ex.log);
    // serialize (encode) → parse (decode) is byte-identical with the codec wired.
    expect(serializeLog("gestalt-example", entries)).toBe(ex.log);

    const home = freshHome("codec-log");
    runInit({ home });
    const logPath = topicLogPath(home, "codec-log");
    await writeFileAtomic(logPath, ex.log);
    expect(readFileSync(fsPath(logPath), "utf8")).toBe(ex.log);
    expect(await readText(logPath)).toBe(ex.log);
  });
});
