import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RULES_MARKER_BEGIN,
  RULES_MARKER_END,
  installRules,
  rulesBlock,
  rulesBlockWritten,
  uninstallRules,
} from "../src/ops/installRules.js";
import { freshHome } from "./helpers.js";

/** A rules file path inside a fresh temp dir (never a real host file). */
function rulesFile(label: string): string {
  const dir = freshHome(`rules-${label}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "CLAUDE.md");
}

describe("install-rules — the MEASURED §2.5 block, verbatim", () => {
  it("creates the file when absent, with markers around the frozen block body", async () => {
    const file = rulesFile("create");
    const r = await installRules({ file });
    expect(r.action).toBe("installed");
    expect(r.caveat).toMatch(/next session/i); // written-vs-loaded caveat travels with the result
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(RULES_MARKER_BEGIN + "\n")).toBe(true);
    expect(text.trimEnd().endsWith(RULES_MARKER_END)).toBe(true);
    // The measured wording, un-paraphrased: heading + explicit tool ids (§2.5
    // "do not de-name tools in the block").
    expect(text).toContain("## Shared memory store");
    expect(text).toContain("`fimemory_search`");
    expect(text).toContain("`fimemory_get`");
    expect(text).toContain("`fimemory_log`");
    expect(text).toContain("call `fimemory_search` first");
    expect(rulesBlockWritten(text)).toBe(true);
  });

  it("appends to an existing file without touching the user's text; reinstall is idempotent", async () => {
    const file = rulesFile("append");
    const user = "# My own memory\n\n- my private note stays\n";
    writeFileSync(file, user, "utf8");

    const first = await installRules({ file });
    expect(first.action).toBe("installed");
    const afterFirst = readFileSync(file, "utf8");
    expect(afterFirst.startsWith(user)).toBe(true); // user text byte-identical, block appended after

    // A re-run over an already-current block is `unchanged`, not `replaced`:
    // "written now" and "already up to date" are different answers, and the
    // no-op rewrite churned the file's mtime on every run.
    const second = await installRules({ file });
    expect(second.action).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(afterFirst); // reinstall = byte-identical no-op
  });

  it("replaces ONLY its own block when text surrounds it", async () => {
    const file = rulesFile("surround");
    const before = "top text\n\n";
    const after = "\n\nbottom text\n";
    // A DIFFERENT body, so this is a real replace and not the unchanged case.
    writeFileSync(file, before + rulesBlock("shim") + after, "utf8");
    const r = await installRules({ file });
    expect(r.action).toBe("replaced");
    expect(readFileSync(file, "utf8")).toBe(before + rulesBlock() + after);
  });

  it("does not touch the file at all when the block is already current", async () => {
    const file = rulesFile("unchanged");
    await installRules({ file });
    const mtimeBefore = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const again = await installRules({ file });
    expect(again.action).toBe("unchanged");
    expect(statSync(file).mtimeMs).toBe(mtimeBefore); // no write happened at all
  });

  it("switching mode is a real replace, and switching back is too", async () => {
    const file = rulesFile("mode-switch");
    expect((await installRules({ file })).action).toBe("installed");
    expect(readFileSync(file, "utf8")).toContain("call `fimemory_search` first");

    const toShim = await installRules({ file, mode: "shim" });
    expect(toShim.action).toBe("replaced");
    expect(toShim.mode).toBe("shim");
    const shimText = readFileSync(file, "utf8");
    expect(shimText).toContain("ALREADY-RETRIEVED");
    expect(shimText).not.toContain("call `fimemory_search` first");

    expect((await installRules({ file, mode: "shim" })).action).toBe("unchanged");
    expect((await installRules({ file })).action).toBe("replaced");
  });

  it("upgrades a LEGACY memory-runtime/squirl block in place (guide §2.5)", async () => {
    const file = rulesFile("legacy");
    const legacy =
      "user top\n\n<!-- memory-runtime:begin — written by `squirl install`. -->\n## Shared memory store\nold body\n<!-- memory-runtime:end -->\nuser bottom\n";
    writeFileSync(file, legacy, "utf8");
    const r = await installRules({ file });
    expect(r.action).toBe("replaced");
    const text = readFileSync(file, "utf8");
    expect(text).toContain(RULES_MARKER_BEGIN);
    expect(text).not.toContain("memory-runtime:begin"); // exactly one block, upgraded
    expect(text).not.toContain("old body");
    expect(text.startsWith("user top\n")).toBe(true);
    expect(text.endsWith("user bottom\n")).toBe(true);
  });

  it("refuses a damaged block (begin without end) instead of guessing where it ends", async () => {
    const file = rulesFile("damaged");
    writeFileSync(file, `${RULES_MARKER_BEGIN}\nno end marker here\nuser text below\n`, "utf8");
    await expect(installRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
    // And the same guard on uninstall.
    await expect(uninstallRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
  });
});

describe("uninstall-rules — clean removal, nothing else touched", () => {
  it("restores a newline-terminated user file byte-for-byte after install→uninstall", async () => {
    const file = rulesFile("roundtrip");
    const user = "# Mine\n\ncontent kept\n";
    writeFileSync(file, user, "utf8");
    await installRules({ file });
    const r = await uninstallRules({ file });
    expect(r.action).toBe("removed");
    expect(readFileSync(file, "utf8")).toBe(user);
  });

  it("removes a block sandwiched between user text, keeping both sides", async () => {
    const file = rulesFile("middle");
    writeFileSync(file, "alpha\n\n" + rulesBlock() + "\n\nomega\n", "utf8");
    const r = await uninstallRules({ file });
    expect(r.action).toBe("removed");
    expect(readFileSync(file, "utf8")).toBe("alpha\n\nomega\n");
  });

  it("removes a legacy block too, and reports absent when there is nothing", async () => {
    const file = rulesFile("legacy-un");
    writeFileSync(
      file,
      "keep\n\n<!-- squirl:begin -->\nbody\n<!-- squirl:end -->\n",
      "utf8",
    );
    expect((await uninstallRules({ file })).action).toBe("removed");
    expect(readFileSync(file, "utf8")).toBe("keep\n");
    expect((await uninstallRules({ file })).action).toBe("absent");
  });

  it("a missing file is 'absent' and is NOT created", async () => {
    const file = path.join(freshHome("rules-missing"), "CLAUDE.md");
    const r = await uninstallRules({ file });
    expect(r.action).toBe("absent");
    expect(existsSync(file)).toBe(false);
  });

  it("does not INVENT a blank line the user never had between two paragraphs", async () => {
    // A hand-placed block with single newlines on both sides. The old seam
    // rule rewrote this to "A\n\nB", changing bytes outside the markers while
    // the CLI printed "text outside the markers was not touched".
    const file = rulesFile("seam-tight");
    writeFileSync(file, "A\n" + rulesBlock() + "\nB\n", "utf8");
    expect((await uninstallRules({ file })).action).toBe("removed");
    expect(readFileSync(file, "utf8")).toBe("A\nB\n");
  });
});

describe("rules files this op must REFUSE rather than corrupt", () => {
  it("refuses a UTF-16LE file instead of rewriting it as mojibake", async () => {
    // What PowerShell 5.1's `> file` / Out-File produce on Windows: UTF-16LE
    // with a BOM. The whole decoded string is written back, so decoding this as
    // UTF-8 destroys the user's text irrecoverably, with no backup taken.
    const file = rulesFile("utf16");
    writeFileSync(file, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("# my rules\nkeep this\n", "utf16le"),
    ]));
    const before = readFileSync(file);
    await expect(installRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
    expect(readFileSync(file).equals(before)).toBe(true); // left exactly as found
  });

  it("refuses BOM-less UTF-16 too — the NUL padding is legal UTF-8 and would slip through", async () => {
    const file = rulesFile("utf16-nobom");
    const raw = Buffer.from("# my rules\nkeep this\n", "utf16le");
    writeFileSync(file, raw);
    await expect(installRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
    expect(readFileSync(file).equals(raw)).toBe(true);
  });

  it("refuses a cp1252 byte rather than silently turning it into U+FFFD", async () => {
    // 0x92 is a curly apostrophe in cp1252 — what PowerShell 5.1 Set-Content
    // writes by default. Decoding as UTF-8 and writing back is lossy and there
    // is no backup, so the file must not be touched.
    const file = rulesFile("cp1252");
    const raw = Buffer.from([0x69, 0x74, 0x92, 0x73, 0x20, 0x6d, 0x69, 0x6e, 0x65, 0x0a]);
    writeFileSync(file, raw);
    await expect(installRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
    expect(readFileSync(file).equals(raw)).toBe(true);
    // Uninstall must be just as careful.
    await expect(uninstallRules({ file })).rejects.toMatchObject({ code: "E_SCHEMA" });
    expect(readFileSync(file).equals(raw)).toBe(true);
  });

  it("a UTF-8 file with non-ASCII text round-trips normally", async () => {
    const file = rulesFile("utf8-ok");
    const user = "# Règles — “mine”\n\n- garde ça\n";
    writeFileSync(file, user, "utf8");
    expect((await installRules({ file })).action).toBe("installed");
    expect(readFileSync(file, "utf8").startsWith(user)).toBe(true);
    await uninstallRules({ file });
    expect(readFileSync(file, "utf8")).toBe(user);
  });
});

/** Can this machine create a FILE symlink? Windows needs Developer Mode or an
 * elevated shell; without it the check below must SKIP loudly, never pass
 * quietly — a silent return would report green for an unrun assertion. */
function canFileSymlink(): boolean {
  const dir = freshHome("rules-symlink-probe");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "t.md");
  writeFileSync(target, "x", "utf8");
  try {
    symlinkSync(target, path.join(dir, "l.md"), "file");
    return true;
  } catch {
    return false;
  }
}

describe("a rules file that is a SYMLINK into a dotfiles repo", () => {
  it("writes THROUGH a directory junction, so the bytes land on the real path", async () => {
    // Junctions need no special privilege on Windows, so this half of the
    // symlink contract — that the write target is REALPATH-resolved rather than
    // taken literally — is verified everywhere the suite runs.
    const dir = freshHome("rules-junction");
    const realDir = path.join(dir, "dotfiles");
    const linkDir = path.join(dir, "link");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(path.join(realDir, "CLAUDE.md"), "# tracked in git\n", "utf8");
    try {
      symlinkSync(realDir, linkDir, "junction");
    } catch {
      return; // no junction support either (non-Windows uses dir symlinks freely)
    }

    const r = await installRules({ file: path.join(linkDir, "CLAUDE.md") });
    expect(r.path).toBe(path.join(realpathSync(realDir), "CLAUDE.md")); // resolved, not literal
    expect(readFileSync(path.join(realDir, "CLAUDE.md"), "utf8")).toContain(RULES_MARKER_BEGIN);
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true); // the junction survived
  });

  it.skipIf(!canFileSymlink())(
    "writes THROUGH the link instead of replacing it with a regular file",
    async () => {
    // Symlinking ~/.claude/CLAUDE.md at a dotfiles repo is a normal setup for
    // the multi-tool users this feature targets. writeFileAtomicPlain is
    // temp+rename, and rename replaces the DIRECTORY ENTRY — so writing at the
    // link deletes it and the dotfiles copy silently stops tracking.
    const dir = freshHome("rules-symlink");
    mkdirSync(dir, { recursive: true });
    const real = path.join(dir, "dotfiles-CLAUDE.md");
    const link = path.join(dir, "CLAUDE.md");
    writeFileSync(real, "# tracked in git\n", "utf8");
    symlinkSync(real, link, "file");

    const r = await installRules({ file: link });
    expect(r.action).toBe("installed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // the link survived
    expect(readFileSync(real, "utf8")).toContain(RULES_MARKER_BEGIN); // bytes hit the target

    await uninstallRules({ file: link });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("# tracked in git\n");
    },
  );

  // Cursor project rules (cursor.com/docs/rules): a `.mdc` whose frontmatter
  // does not set `alwaysApply: true` is pulled in only when the model asks for
  // it by description, which is the exact "has the tools, never opens them"
  // failure this block exists to prevent. A plain `.md` in that same directory
  // is ignored by Cursor outright, so the frontmatter is keyed off the
  // EXTENSION — and must never leak onto other hosts' markdown.
  describe("Cursor .mdc frontmatter", () => {
    it("writes alwaysApply frontmatter when creating a .mdc, and never on .md", async () => {
      const dir = freshHome("rules-mdc");
      const mdc = path.join(dir, ".cursor", "rules", "fimemory.mdc");
      const md = path.join(dir, "AGENTS.md");

      const r = await installRules({ file: mdc });
      expect(r.action).toBe("installed");
      const mdcText = readFileSync(mdc, "utf8");
      // Frontmatter must be the FIRST bytes or Cursor does not parse it.
      expect(mdcText.startsWith("---\n")).toBe(true);
      expect(mdcText).toContain("alwaysApply: true");
      expect(mdcText).toContain(RULES_MARKER_BEGIN);

      await installRules({ file: md });
      expect(readFileSync(md, "utf8").startsWith("---")).toBe(false);
    });

    it("does not duplicate frontmatter on reinstall, and uninstall leaves it", async () => {
      const dir = freshHome("rules-mdc-again");
      const mdc = path.join(dir, ".cursor", "rules", "fimemory.mdc");
      await installRules({ file: mdc });
      await installRules({ file: mdc, mode: "shim" });
      const text = readFileSync(mdc, "utf8");
      // Frontmatter sits OUTSIDE the markers, so the replace path treats it as
      // ordinary user text: exactly one fence pair however many installs run.
      expect(text.match(/^---$/gm)?.length).toBe(2);

      await uninstallRules({ file: mdc });
      const after = readFileSync(mdc, "utf8");
      expect(after).toContain("alwaysApply: true"); // we only ever own the marker span
      expect(after).not.toContain(RULES_MARKER_BEGIN);
    });
  });
});
