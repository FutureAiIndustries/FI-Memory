import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  fsPath,
  proposalPath,
  storePaths,
  topicLogPath,
  topicNotePath,
} from "../src/paths.js";
import { activateDek, clearActiveKey, fileKind } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";

/**
 * REGRESSION — silent encryption bypass under a "hostile" store home.
 *
 * `fileKind()` used to classify a store file by substring-testing its ABSOLUTE
 * path (`p.includes("/logs/")`, `"/topics/"`, `"/proposals/"`). A store whose
 * home merely CONTAINED a segment with one of those names — `GESTALT_HOME` is
 * arbitrary and user-chosen, e.g. an ordinary `~/Dropbox/logs/gestalt` or a
 * headless-server path with a `logs` segment — had every note and proposal
 * kind "log". `isWholeFileEncrypted("log")` is false, so `init --encrypted`
 * succeeded, wrote keyring.json + store.enc, printed the recovery phrase and
 * told the user the store was encrypted, while notes and proposals were written
 * to disk as PLAINTEXT. The bug survived because every existing test used a
 * benign home. These tests are parameterized over hostile homes on purpose.
 */

// Tiny Argon2 params so the suite stays fast (real default is 64 MiB / t=3).
const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASSPHRASE = "a solid hostile home passphrase";

/** A store home nested under the given hostile path segments. */
function hostileHome(...segments: string[]): string {
  const root = process.env.GESTALT_TEST_ROOT;
  if (!root) throw new Error("test setup did not run (GESTALT_TEST_ROOT unset)");
  return path.join(root, ...segments, `store-${randomUUID()}`);
}

/** Every home shape that used to defeat the absolute-path substring scan. */
const HOSTILE: Array<{ label: string; segments: string[] }> = [
  { label: "home under a `logs` segment", segments: ["logs"] },
  { label: "home under a `topics` segment", segments: ["topics"] },
  { label: "home under a `proposals` segment", segments: ["proposals"] },
  { label: "home under ALL THREE segments", segments: ["logs", "topics", "proposals"] },
  { label: "home under a `/srv/logs/gestalt`-shaped path", segments: ["srv", "logs"] },
];

afterEach(() => clearActiveKey());

describe("fileKind classifies by the store-relative path, not an absolute substring", () => {
  for (const { label, segments } of HOSTILE) {
    it(`returns the right kind for every store dir — ${label}`, () => {
      const home = hostileHome(...segments);
      const p = storePaths(home);

      expect(fileKind(topicNotePath(home, "widget"))).toBe("note");
      expect(fileKind(topicLogPath(home, "widget"))).toBe("log");
      expect(fileKind(proposalPath(home, 1, "widget"))).toBe("proposal");
      expect(fileKind(p.index)).toBe("index");
      expect(fileKind(p.storeMarker)).toBe("marker");
      expect(fileKind(p.config)).toBe("config");
      expect(fileKind(path.join(home, "keyring.json"))).toBe("config");
      expect(fileKind(path.join(home, "notes.txt"))).toBe("other");
    });
  }

  it("an ancestor segment never determines the kind (the exact bypass)", () => {
    // The pre-fix code returned "log" for both of these.
    expect(fileKind("/srv/logs/gestalt/topics/widget.md")).toBe("note");
    expect(fileKind("/srv/logs/gestalt/proposals/1-widget.md")).toBe("proposal");
    // ...and the Windows separator form of the same paths.
    expect(fileKind("C:\\Users\\u\\Dropbox\\logs\\gestalt\\topics\\widget.md")).toBe("note");
    expect(fileKind("C:\\Users\\u\\Dropbox\\logs\\gestalt\\proposals\\1-widget.md")).toBe("proposal");
  });

  it("a benign home classifies exactly as before (no behavior drift)", () => {
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
    // A file outside any store keeps its "other" classification (install-mcp
    // writes host config files through the same atomic writer).
    expect(fileKind("/home/u/.claude.json")).toBe("other");
    expect(fileKind("index.json")).toBe("index"); // bare filename, no parent
  });
});

describe("encrypted init under a hostile home actually encrypts (regression)", () => {
  for (const { label, segments } of HOSTILE) {
    it(`notes + proposals are ciphertext on disk, logs per-entry — ${label}`, async () => {
      const home = hostileHome(...segments);
      const r = runInit({
        home,
        encrypted: true,
        passphrase: PASSPHRASE,
        argon2: TINY,
        allowWeakParams: true,
      });
      expect(r.encrypted).toBe(true);

      // The note the CLI just told the user was encrypted MUST be ciphertext.
      const rawNote = readFileSync(fsPath(topicNotePath(home, "gestalt-example")), "utf8");
      expect(rawNote.startsWith("gestalt-enc:1:")).toBe(true);
      expect(rawNote).not.toContain("id: gestalt-example");

      // Proposals embed full note bodies — they are sealed too.
      const rawProp = readFileSync(fsPath(proposalPath(home, 1, "gestalt-example")), "utf8");
      expect(rawProp.startsWith("gestalt-enc:1:")).toBe(true);
      expect(rawProp).not.toContain("status: pending");

      // The derived index + the store-mode marker are sealed.
      expect(readFileSync(fsPath(storePaths(home).index), "utf8").startsWith("gestalt-enc:1:")).toBe(true);
      expect(readFileSync(fsPath(storePaths(home).storeMarker), "utf8").startsWith("gestalt-enc:1:")).toBe(true);

      // Logs stay line-oriented (per-entry encoded), NOT whole-file sealed —
      // that is what keeps git merge=union working without the key.
      const rawLog = readFileSync(fsPath(topicLogPath(home, "gestalt-example")), "utf8");
      expect(rawLog.startsWith("gestalt-enc:1:")).toBe(false);
      expect(rawLog).toContain("# gestalt-example log"); // header stays readable
      expect(rawLog).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \S+$/m); // `<ts> <b64url>` lines

      // config.json + keyring.json stay plaintext (budgets / the wrapped key).
      expect(readFileSync(fsPath(storePaths(home).config), "utf8")).toContain("noteTokenCap");
      expect(readFileSync(fsPath(path.join(home, "keyring.json")), "utf8")).toContain("argon2id");
    });

    it(`round-trips: unlock, read note + log back as plaintext — ${label}`, async () => {
      const home = hostileHome(...segments);
      runInit({
        home,
        encrypted: true,
        passphrase: PASSPHRASE,
        argon2: TINY,
        allowWeakParams: true,
      });

      activateDek(unlockWithPassphrase(home, PASSPHRASE));

      const note = await readText(topicNotePath(home, "gestalt-example"));
      expect(note).toContain("id: gestalt-example");

      const proposal = await readText(proposalPath(home, 1, "gestalt-example"));
      expect(proposal).toContain("status: pending");

      const log = await readText(topicLogPath(home, "gestalt-example"));
      expect(parseLog(log!, "gestalt-example").entries.length).toBeGreaterThan(0);
    });
  }

  it("a hostile-home store is NOT readable without the key (the bypass would have made it readable)", async () => {
    const home = hostileHome("logs");
    runInit({
      home,
      encrypted: true,
      passphrase: PASSPHRASE,
      argon2: TINY,
      allowWeakParams: true,
    });
    clearActiveKey(); // a thief with the files but no key

    // Fail CLOSED: encrypted content with no key is a hard E_STORE_MODE error,
    // never a silent plaintext read.
    await expect(readText(topicNotePath(home, "gestalt-example"))).rejects.toThrow(
      /E_STORE_MODE|encrypted but no key/i,
    );
    await expect(readText(proposalPath(home, 1, "gestalt-example"))).rejects.toThrow(
      /E_STORE_MODE|encrypted but no key/i,
    );
  });
});
