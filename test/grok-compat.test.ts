import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/ops/doctor.js";
import {
  GROK_COMPAT_COST,
  GROK_COMPAT_ENV_VAR,
  GROK_COMPAT_KEY,
  GROK_COMPAT_MARKER,
  GROK_HOOKS_BEHAVIOUR,
  installHooks,
  readGrokCompat,
  setGrokCompatHooks,
} from "../src/ops/installHooks.js";
import { freshHome } from "./helpers.js";

/**
 * Grok's Claude-compat hook scanning, and our opt-out from it.
 *
 * THE SITUATION UNDER TEST. `install-hooks` writes two handlers into
 * ~/.claude/settings.json with the invocation in `args`. Grok CLI scans that
 * file for hooks by default and its handler schema has no `args`, so it spawns
 * a bare interpreter that dies reading the event JSON as a script. The remedy
 * is `[compat.claude] hooks = false` in ~/.grok/config.toml — a flag that is
 * GLOBAL to Grok, which is why applying it is a verb the user runs and not
 * something `install-hooks` does on its way past.
 *
 * ISOLATION, hard rule: every path below is a temp fixture created by this
 * file. Nothing here reads or writes the real ~/.grok or the real ~/.claude —
 * every call passes `configPath` and `settingsPath` explicitly.
 */

/** A grok config shaped like a real one: sibling sections, an API key, an
 * array-of-tables, CRLF-free, ending in a single newline. */
const REAL_ISH = [
  "[cli]",
  'installer = "internal"',
  "auto_update = true",
  "",
  "[[marketplace.sources]]",
  'name = "xAI Official"',
  'git = "https://github.com/xai-org/plugin-marketplace.git"',
  "",
  "[mcp_servers.context7]",
  'command = "npx"',
  'args = ["-y", "@upstash/context7-mcp"]',
  "",
  "[mcp_servers.context7.env]",
  'CONTEXT7_API_KEY = "ctx7sk-do-not-touch-me"',
  "",
  "[ui]",
  "max_thoughts_width = 120",
  "",
].join("\n");

/** A fixture dir with a config.toml, returned as its path. */
function grokFixture(body: string | null, label = "grok"): string {
  const dir = path.join(freshHome(label), ".grok");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  if (body !== null) writeFileSync(file, body);
  return file;
}

/** A ~/.claude/settings.json carrying our real handlers, via installHooks. */
async function claudeWithHooks(): Promise<string> {
  const settingsPath = path.join(freshHome("claude"), ".claude", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  await installHooks({ home: freshHome("store"), settingsPath, cliPath: __filename });
  return settingsPath;
}

/** A ~/.claude/settings.json with somebody else's hook and none of ours. */
function claudeWithoutHooks(): string {
  const settingsPath = path.join(freshHome("claude"), ".claude", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
  );
  return settingsPath;
}

describe("grok compat — detection", () => {
  it("reports the dying process when Grok is here, scanning, and our hooks are written", async () => {
    const configPath = grokFixture(REAL_ISH);
    const settingsPath = await claudeWithHooks();

    const state = readGrokCompat({ configPath, settingsPath });
    expect(state.installed).toBe(true);
    expect(state.hooks).toBe("on");
    expect(state.shimHooksPresent).toBe(true);
    expect(state.dyingProcess).toBe(true);
    // Stated as a fact about Grok, and it names the actual consequence.
    expect(state.note).toMatch(/spawns a process that dies/);
    expect(state.reason).toMatch(/default/);
  });

  it("does not cry wolf when our hooks are not in Claude's settings", async () => {
    const configPath = grokFixture(REAL_ISH);
    const state = readGrokCompat({ configPath, settingsPath: claudeWithoutHooks() });
    expect(state.installed).toBe(true);
    expect(state.shimHooksPresent).toBe(false);
    expect(state.dyingProcess).toBe(false);
  });

  it("treats a missing ~/.grok as 'Grok is not installed here'", async () => {
    // Directory deliberately not created — the house detection rule is the dir.
    const configPath = path.join(freshHome("nogrok"), ".grok", "config.toml");
    const state = readGrokCompat({ configPath, settingsPath: await claudeWithHooks() });
    expect(state.installed).toBe(false);
    expect(state.dyingProcess).toBe(false);
  });

  it("reads an explicit hooks = false as off, and knows when it is ours", async () => {
    const settingsPath = await claudeWithHooks();
    const theirs = grokFixture(`${REAL_ISH}\n[compat.claude]\nhooks = false\n`, "theirs");
    const s1 = readGrokCompat({ configPath: theirs, settingsPath });
    expect(s1.hooks).toBe("off");
    expect(s1.ours).toBe(false);
    expect(s1.dyingProcess).toBe(false);

    const ours = grokFixture(`[compat.claude]\nhooks = false  ${GROK_COMPAT_MARKER} set by us\n`, "ours");
    const s2 = readGrokCompat({ configPath: ours, settingsPath });
    expect(s2.hooks).toBe("off");
    expect(s2.ours).toBe(true);
  });

  it("says 'unknown' rather than guessing, and unknown still counts as scanning", async () => {
    const settingsPath = await claudeWithHooks();
    // Unparseable TOML: an unterminated string.
    const bad = grokFixture('[cli]\ninstaller = "oops\n', "bad");
    const s = readGrokCompat({ configPath: bad, settingsPath });
    expect(s.hooks).toBe("unknown");
    // The safe reading of "cannot tell" is that Grok is still scanning: an
    // all-clear we cannot back up would leave the waste running silently.
    expect(s.dyingProcess).toBe(true);
  });
});

describe("grok compat — applying the opt-out", () => {
  it("adds a marked section and leaves every sibling byte-identical", async () => {
    const configPath = grokFixture(REAL_ISH);
    const before = readFileSync(configPath, "utf8");

    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    expect(r.hooks).toBe("off");
    expect(r.reverse).toMatch(/--on/);

    const after = readFileSync(configPath, "utf8");
    // Everything that was there is still there, in order, untouched.
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('CONTEXT7_API_KEY = "ctx7sk-do-not-touch-me"');
    expect(after).toContain("[compat.claude]");
    expect(after).toContain("hooks = false");
    // The line documents itself, so the back-out survives this CLI going away.
    expect(after).toContain(GROK_COMPAT_MARKER);
    expect(readGrokCompat({ configPath, shimHooksPresent: true }).hooks).toBe("off");
  });

  it("creates config.toml when ~/.grok exists but the file does not", async () => {
    const configPath = grokFixture(null, "nofile");
    expect(existsSync(configPath)).toBe(false);
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    expect(readFileSync(configPath, "utf8")).toContain("[compat.claude]");
  });

  it("refuses when Grok is not installed instead of creating its config dir", async () => {
    const configPath = path.join(freshHome("nogrok"), ".grok", "config.toml");
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("absent");
    expect(existsSync(path.dirname(configPath))).toBe(false);
  });

  it("edits only the value token of an existing hooks key, keeping the user's comment", async () => {
    const configPath = grokFixture(
      "[compat.claude]\nagents = true\nhooks = true  # I turned this on deliberately\ncommands = true\n",
      "existingkey",
    );
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    const after = readFileSync(configPath, "utf8");
    // Their comment survives verbatim, and OURS goes after it, never over it:
    // leaving `hooks = false  # I turned this on deliberately` on its own is a
    // comment that flatly contradicts the value it annotates, in a file we do
    // not own.
    expect(after).toContain("hooks = false  # I turned this on deliberately  " + GROK_COMPAT_MARKER);
    // Their other compat cells are untouched — we set ONE key, not the table.
    expect(after).toContain("agents = true");
    expect(after).toContain("commands = true");
    // Provenance is recorded, so a global flag WE set can never become
    // invisible to doctor (which keys its standing cost reminder off it).
    expect(readGrokCompat({ configPath, shimHooksPresent: true }).ours).toBe(true);
  });

  it("inserts into an existing [compat.claude] without disturbing its other keys", async () => {
    const before = "[cli]\nauto_update = true\n\n[compat.claude]\nagents = true\n\n[ui]\nx = 1\n";
    const configPath = grokFixture(before, "insert");
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("[compat.claude]\nhooks = false");
    expect(after).toContain("agents = true");
    // Substituted IN PLACE — the section did not migrate to the end.
    expect(after.indexOf("[compat.claude]")).toBeLessThan(after.indexOf("[ui]"));
    // Byte-level, not `toContain`: every sibling block comes back identical.
    expect(after.startsWith("[cli]\nauto_update = true\n\n[compat.claude]\n")).toBe(true);
    expect(after.endsWith("agents = true\n\n[ui]\nx = 1\n")).toBe(true);
  });

  it("is idempotent: a second identical run writes nothing at all", async () => {
    const configPath = grokFixture(REAL_ISH);
    await setGrokCompatHooks({ configPath, scan: false });
    const mtime = statSync(configPath).mtimeMs;
    const bytes = readFileSync(configPath, "utf8");

    const again = await setGrokCompatHooks({ configPath, scan: false });
    expect(again.action).toBe("unchanged");
    expect(readFileSync(configPath, "utf8")).toBe(bytes);
    expect(statSync(configPath).mtimeMs).toBe(mtime);
  });

  it("handles a CRLF config without mangling its line endings", async () => {
    const configPath = grokFixture(REAL_ISH.replace(/\n/g, "\r\n"), "crlf");
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("\r\n[compat.claude]\r\nhooks = false");
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it("flips the value token on a CRLF file that already assigns hooks", async () => {
    // `.` excludes \r in JS, so a naive line regex silently no-ops here.
    const configPath = grokFixture("[compat.claude]\r\nhooks = true\r\n", "crlfkey");
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    expect(readFileSync(configPath, "utf8")).toContain("hooks = false");
  });

  it("inserts into an EXISTING [compat.claude] on a CRLF file without leaving a lone LF", async () => {
    // The append path joins on view.eol and the flip path preserves \r; the
    // in-place INSERT built its line from a block split on "\n" and rejoined on
    // "\n", so it alone emitted one LF-terminated line into a CRLF file we do
    // not own — a whole-line diff in a dotfiles repo, and a whole-file diff the
    // next time an editor with "normalize on save" touches the API-key blocks.
    const before = REAL_ISH.replace("[ui]", "[compat.claude]\nagents = true\n\n[ui]").replace(/\n/g, "\r\n");
    const configPath = grokFixture(before, "crlfinsert");
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("set");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("hooks = false");
    expect(after).not.toMatch(/[^\r]\n/);
    // Sibling blocks byte-identical, including the one holding the API key.
    expect(after).toContain('CONTEXT7_API_KEY = "ctx7sk-do-not-touch-me"\r\n');
    expect(after).toContain("[compat.claude]\r\nhooks = false");
    expect(after).toContain("\r\nagents = true\r\n");
    expect(after.endsWith("[ui]\r\nmax_thoughts_width = 120\r\n")).toBe(true);
  });

  it("does not write at all when hooks is ALREADY false, and does not claim the user's line", async () => {
    // The old apply path fell through, stamped our marker onto their bare
    // line, and wrote the file — while its own note said "already false". That
    // reserialized a config holding API keys for a state change that did not
    // happen, made doctor report the user's own setting as "set by fimemory",
    // and armed `--on` to DELETE their line.
    const original = "[cli]\nx = 1\n\n[compat.claude]\nagents = true\nhooks = false\n";
    const configPath = grokFixture(original, "alreadyfalse");
    const mtime = statSync(configPath).mtimeMs;

    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("unchanged");
    expect(r.hooks).toBe("off");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(statSync(configPath).mtimeMs).toBe(mtime);

    const state = readGrokCompat({ configPath, shimHooksPresent: true });
    expect(state.hooks).toBe("off");
    expect(state.ours).toBe(false);
  });
});

describe("grok compat — refusals (a config we do not understand is left alone)", () => {
  const cases: Array<[string, string]> = [
    ["unparseable TOML", '[cli]\ninstaller = "oops\n'],
    ["compat as an inline table", 'compat = { claude = { hooks = true } }\n[cli]\nx = 1\n'],
    ["compat.claude as a dotted inline key", 'compat.claude = { agents = true }\n[cli]\nx = 1\n'],
    ["duplicate [compat.claude] tables", "[compat.claude]\nagents = true\n\n[compat.claude]\nhooks = true\n"],
    ["[[compat.claude]] array of tables", "[[compat.claude]]\nhooks = true\n"],
    ["claude as an inline key under [compat]", "[compat]\nclaude = { hooks = true }\n"],
    ["hooks assigned twice", "[compat.claude]\nhooks = true\nhooks = false\n"],
    ["hooks holding a non-boolean", '[compat.claude]\nhooks = "yes"\n'],
  ];

  for (const [label, body] of cases) {
    it(`refuses: ${label}`, async () => {
      const configPath = grokFixture(body, "refuse");
      const before = readFileSync(configPath, "utf8");
      const r = await setGrokCompatHooks({ configPath, scan: false });
      expect(r.action).toBe("refused");
      expect(r.note).toMatch(/left unchanged/);
      // Byte-identical: refusing means refusing, not "rewrote most of it".
      expect(readFileSync(configPath, "utf8")).toBe(before);
    });
  }

  it("refuses a config that is not valid UTF-8 rather than round-tripping it", async () => {
    const configPath = grokFixture("", "utf16");
    writeFileSync(configPath, Buffer.from("fffe5b0063006c0069005d00", "hex"));
    const before = readFileSync(configPath);
    const r = await setGrokCompatHooks({ configPath, scan: false });
    expect(r.action).toBe("refused");
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });
});

describe("grok compat — reversibility (no one-way door in a file we do not own)", () => {
  it("--on returns a config we edited to the exact bytes it had", async () => {
    const configPath = grokFixture(REAL_ISH);
    const before = readFileSync(configPath, "utf8");

    await setGrokCompatHooks({ configPath, scan: false });
    expect(readFileSync(configPath, "utf8")).not.toBe(before);

    const back = await setGrokCompatHooks({ configPath, scan: true });
    expect(back.action).toBe("restored");
    expect(back.hooks).toBe("on");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("--on restores a flipped user key without deleting their line or comment", async () => {
    const original = "[compat.claude]\nagents = true\nhooks = true  # mine\n";
    const configPath = grokFixture(original, "flipback");
    await setGrokCompatHooks({ configPath, scan: false });
    const back = await setGrokCompatHooks({ configPath, scan: true });
    expect(back.action).toBe("restored");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("--on keeps a [compat.claude] that holds the user's other cells", async () => {
    const configPath = grokFixture("[compat.claude]\nagents = true\n", "keepsection");
    await setGrokCompatHooks({ configPath, scan: false });
    const back = await setGrokCompatHooks({ configPath, scan: true });
    expect(back.action).toBe("restored");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("[compat.claude]");
    expect(after).toContain("agents = true");
    expect(after).not.toContain("hooks");
  });

  it("--on is a no-op, with no write, when the flag was never applied", async () => {
    const configPath = grokFixture(REAL_ISH);
    const mtime = statSync(configPath).mtimeMs;
    const r = await setGrokCompatHooks({ configPath, scan: true });
    expect(r.action).toBe("unchanged");
    expect(statSync(configPath).mtimeMs).toBe(mtime);
  });

  it("--off then --on returns a user's BARE hooks = true to its exact bytes", async () => {
    // THE REGRESSION. With one marker for both "we wrote this line" and "we
    // changed this value", `--off` stamped the marker onto a bare user line
    // and `--on` then matched it and SPLICED THE LINE OUT — deleting a line
    // the user wrote, which is the precise failure the whole design exists to
    // prevent. Three shapes, because the blast radius differed in each.
    const shapes: Array<[string, string]> = [
      ["a sibling key in the section", "[compat.claude]\nagents = true\nhooks = true\n"],
      ["a section between others", "[cli]\nx = 1\n\n[compat.claude]\nhooks = true\n\n[ui]\ny = 2\n"],
      ["the only content in the file", "[compat.claude]\nhooks = true\n"],
    ];
    for (const [label, original] of shapes) {
      const configPath = grokFixture(original, `bare-${label.replace(/\W+/g, "-")}`);
      const off = await setGrokCompatHooks({ configPath, scan: false });
      expect(off.action).toBe("set");
      expect(readGrokCompat({ configPath, shimHooksPresent: true }).hooks).toBe("off");

      const back = await setGrokCompatHooks({ configPath, scan: true });
      expect(back.action).toBe("restored");
      // Byte-identical, not merely "still has a hooks key".
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  it("removes a config.toml we created ourselves instead of leaving it zero-byte", async () => {
    // `--off` on a ~/.grok with no config.toml CREATES one holding nothing but
    // our section. Undoing that has to put the machine back where it was, and
    // a zero-byte config.toml in a directory another tool scans is not where it
    // was.
    const configPath = grokFixture(null, "createdbyus");
    expect(existsSync(configPath)).toBe(false);
    await setGrokCompatHooks({ configPath, scan: false });
    expect(existsSync(configPath)).toBe(true);

    const back = await setGrokCompatHooks({ configPath, scan: true });
    expect(back.action).toBe("restored");
    expect(existsSync(configPath)).toBe(false);
  });

  it("--on will not touch a hooks = false somebody else wrote by hand", async () => {
    // No marker → not ours to delete. It is flipped back to Grok's default,
    // which is the inverse the user asked for, but their LINE stays theirs.
    const configPath = grokFixture("[compat.claude]\nhooks = false\n", "notours");
    const r = await setGrokCompatHooks({ configPath, scan: true });
    expect(r.action).toBe("restored");
    expect(readFileSync(configPath, "utf8")).toBe("[compat.claude]\nhooks = true\n");
  });
});

describe("grok compat — an unreadable config degrades, it does not throw", () => {
  /** A config.toml that exists and cannot be read: a DIRECTORY by that name.
   * Stands in for the real-world cases (EACCES, and on Windows a sharing
   * violation while Grok holds its own config open behind
   * `.config-init.lock` / `managed_config.lock`). */
  function unreadableFixture(label: string): string {
    const dir = path.join(freshHome(label), ".grok");
    mkdirSync(path.join(dir, "config.toml"), { recursive: true });
    return path.join(dir, "config.toml");
  }

  it("readGrokCompat returns unknown rather than throwing", async () => {
    const configPath = unreadableFixture("unreadable");
    const state = readGrokCompat({ configPath, settingsPath: await claudeWithHooks() });
    expect(state.hooks).toBe("unknown");
    expect(state.configPresent).toBe(true);
    // Conservative default is unchanged — but it is stated as an assumption.
    expect(state.dyingProcess).toBe(true);
    expect(state.optOutRefused).toBe(true);
    expect(state.note).toMatch(/could not tell/i);
  });

  it("doctor still produces a whole report — the command whose job is not to die", async () => {
    // A throw here escaped runDoctor and took down every unrelated finding
    // (store, shim) with it, and escaped install-hooks AFTER settings.json had
    // already been written, turning a completed install into exit 1.
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: unreadableFixture("unreadable-doctor") },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.grok.hooks).toBe("unknown");
  });

  it("the writer refuses it instead of throwing", async () => {
    const r = await setGrokCompatHooks({ configPath: unreadableFixture("unreadable-write"), scan: false });
    expect(r.action).toBe("refused");
    expect(r.note).toMatch(/could not be read/);
  });
});

describe("grok compat — what we say we know", () => {
  it("does not assert the scanning as observed when it could not be read", async () => {
    // `unknown` folded into `dyingProcess` is a defensible DEFAULT. Narrating
    // it as "Grok is installed and still scanning (<reason>)" — where <reason>
    // is an admission that we could not read the file — is a false statement
    // about the user's machine, and it was made to exactly the user who had
    // ALREADY opted out in a shape this reader will not parse.
    const configPath = grokFixture("compat.claude.hooks = false\n[cli]\nx = 1\n", "dotted");
    const state = readGrokCompat({ configPath, settingsPath: await claudeWithHooks() });
    expect(state.hooks).toBe("unknown");
    expect(state.note).not.toMatch(/is installed and still scanning/);
    expect(state.note).toMatch(/could not tell/i);
    expect(state.note).toMatch(/assume/i);
    // And it does not send them at a command that will exit 1.
    expect(state.note).toMatch(/will REFUSE/);
  });

  it("states the visibility of the failure the way Grok's own doc states it", () => {
    // 10-hooks.md:156 — "the failure is recorded for the UI scrollback but the
    // tool call is not blocked". installRules.ts already tells the user to
    // expect a hook-failure line per prompt; a doctor message calling the same
    // condition invisible sends him hunting for a second cause.
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/scrollback/);
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/10-hooks\.md:156/);
    expect(GROK_HOOKS_BEHAVIOUR).not.toMatch(/nothing is visible/);
  });

  it("carries the stdout-discard caveat instead of dropping it downstream", () => {
    // The measurement was headless-only. Doctor is the surface that must keep
    // MEASURED and INFERRED apart, and the owner runs Grok interactively — the
    // mode nobody measured.
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/headless/);
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/TUI was\s+NOT measured/);
  });

  it("cites the section that actually enumerates the handler fields", () => {
    // "Key Fields" (:150-156) lists event/matcher/type/command/timeout — not
    // the five-field schema. :194 does.
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/10-hooks\.md:194|:194 for the handler fields/);
    expect(GROK_HOOKS_BEHAVIOUR).not.toMatch(/"Key Fields"/);
  });

  it("names a binary that exists on every platform, not just Windows", () => {
    // The handler command is process.execPath; `node.exe` is a Windows-only
    // filename, and a macOS user who can falsify the first sentence discounts
    // the finding.
    expect(GROK_HOOKS_BEHAVIOUR).toMatch(/bare interpreter/);
    expect(GROK_HOOKS_BEHAVIOUR).not.toMatch(/spawns bare node\.exe/);
  });

  it("prices the flag against EVERY source it gates, not just the one file", () => {
    // One per-vendor switch covers global settings.json AND settings.local.json
    // AND per-project .claude/settings.json (10-hooks.md:66,69,76). A user who
    // reads the old wording concludes repo-local hooks still work.
    expect(GROK_COMPAT_COST).toMatch(/settings\.local\.json/);
    expect(GROK_COMPAT_COST).toMatch(/<project>\/\.claude\/settings\.json/);
    expect(GROK_COMPAT_COST).toMatch(/10-hooks\.md:66/);
  });

  it("says config.toml is not the last word, because Grok says so", () => {
    // 05-configuration.md:360 — "Resolution: env var > config.toml > default".
    expect(GROK_COMPAT_COST).toMatch(/env var > config\.toml/);
    expect(GROK_COMPAT_COST).toMatch(/grok inspect/);
  });

  it("reports unknown, not a green all-clear, when an env layer outranks the file", async () => {
    // Writing the flag and reporting "OFF" while an env var turned it back on
    // is the one answer that leaves the waste running while telling the user it
    // stopped. The var NAME is inferred from Grok's documented siblings, so its
    // presence downgrades our answer — it never decides it.
    const configPath = grokFixture(`${REAL_ISH}\n[compat.claude]\nhooks = false\n`, "envon");
    const env = { [GROK_COMPAT_ENV_VAR]: "true" } as NodeJS.ProcessEnv;
    const state = readGrokCompat({ configPath, env, shimHooksPresent: true });
    expect(state.hooks).toBe("unknown");
    expect(state.envOverride?.value).toBe("true");
    expect(state.reason).toMatch(/env var > config\.toml/);
    // Conservative: unknown still counts as scanning.
    expect(state.dyingProcess).toBe(true);

    // And the writer does not claim an achieved state it cannot back up.
    const w = await setGrokCompatHooks({ configPath: grokFixture(REAL_ISH, "envwrite"), env, scan: false });
    expect(w.action).toBe("set");
    expect(w.hooks).toBe("unknown");
    expect(w.note).toMatch(new RegExp(GROK_COMPAT_ENV_VAR));
  });

  it("leaves the answer alone when no such variable is set", async () => {
    const configPath = grokFixture(REAL_ISH, "noenv");
    const state = readGrokCompat({ configPath, env: {}, shimHooksPresent: true });
    expect(state.envOverride).toBeNull();
    expect(state.hooks).toBe("on");
  });
});

describe("grok compat — doctor reports the loaded-but-dead setup", () => {
  it("warns when Grok is scanning and our hooks are in Claude's settings", async () => {
    const configPath = grokFixture(REAL_ISH);
    const settingsPath = await claudeWithHooks();
    const home = freshHome("store");

    const r = runDoctor({
      home,
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: configPath },
      shimSettingsPath: settingsPath,
    });
    expect(r.grok.installed).toBe(true);
    expect(r.grok.dyingProcess).toBe(true);
    const f = r.findings.find((x) => x.code === "grok_compat_hooks_dead");
    expect(f).toBeDefined();
    // Warn, not fail: Grok fails open, nothing is broken, nothing is at risk.
    expect(f!.level).toBe("warn");
    // THE PRICE RIDES WITH THE OFFER. The hint proposes `grok-compat --off`,
    // and that switch is GLOBAL to Grok, so the cost must be stated where the
    // decision is made rather than deferred to another command. A 2026-08-01
    // trim of this finding dropped it and this test caught that; the cost
    // assertion below is the one that matters most in this file.
    //
    // The 1,303-char WHY moved to `grok-compat` (reports only, writes nothing)
    // because doctor is a fast health check, so the message now states the
    // condition and points there instead of carrying the citations inline.
    expect(f!.message).not.toContain(GROK_HOOKS_BEHAVIOUR);
    expect(f!.message).toMatch(/grok-compat/);
    expect(f!.hint).toContain(GROK_COMPAT_COST);
    // The cost is named in plain words, not deferred to a doc.
    expect(f!.hint).toMatch(/ENTIRELY, not only ours/);
  });

  it("keeps restating the cost while OUR opt-out is in force", async () => {
    const configPath = grokFixture(REAL_ISH);
    const settingsPath = await claudeWithHooks();
    await setGrokCompatHooks({ configPath, scan: false });

    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: configPath },
      shimSettingsPath: settingsPath,
    });
    expect(r.grok.hooks).toBe("off");
    expect(r.grok.ours).toBe(true);
    const f = r.findings.find((x) => x.code === "grok_compat_hooks_off");
    expect(f).toBeDefined();
    expect(f!.level).toBe("info");
    expect(f!.message).toContain(GROK_COMPAT_KEY);
    expect(f!.hint).toMatch(/grok-compat --on/);
    expect(r.findings.some((x) => x.code === "grok_compat_hooks_dead")).toBe(false);
  });

  it("reports 'we could not tell' as unknown, not as observed scanning", async () => {
    // The hedged branch existed but was UNREACHABLE whenever our shim hooks
    // were present — i.e. in every case where the finding matters. A user who
    // had already opted out was warned, at `warn` level, that his machine
    // "still scans … spawns a process that dies, on every Grok prompt", and
    // then offered `--off`, which refuses and exits 1.
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: grokFixture("compat.claude.hooks = false\n[cli]\nx = 1\n", "doctordotted") },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.grok.hooks).toBe("unknown");
    expect(r.findings.some((x) => x.code === "grok_compat_hooks_dead")).toBe(false);
    const f = r.findings.find((x) => x.code === "grok_compat_unknown");
    expect(f).toBeDefined();
    expect(f!.message).not.toMatch(/is installed and still scanning/);
    expect(f!.message).toMatch(/could not tell/i);
    // The cost of the remedy is still on screen where the decision is made.
    expect(f!.hint).toContain(GROK_COMPAT_COST);
    // And it does not push a command that will refuse this file.
    expect(f!.hint).toMatch(/REFUSE/);
    expect(r.findings.filter((x) => x.level === "fail" && x.code.startsWith("grok_compat"))).toHaveLength(0);
  });

  it("keeps restating the cost for a USER line whose value we changed", async () => {
    // Provenance, not authorship: we flipped their `hooks = true`, so the
    // global flag is ours to keep explaining. Without a provenance tag this
    // finding never fired, and a flag fimemory set became permanently
    // invisible to the one tool that could explain the missing hook.
    const configPath = grokFixture("[compat.claude]\nagents = true\nhooks = true\n", "flipped-doctor");
    await setGrokCompatHooks({ configPath, scan: false });
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: configPath },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.grok.ours).toBe(true);
    const f = r.findings.find((x) => x.code === "grok_compat_hooks_off");
    expect(f).toBeDefined();
    expect(f!.message).toContain(GROK_COMPAT_COST);
  });

  it("does not lecture a user who set the flag himself", async () => {
    const configPath = grokFixture("[compat.claude]\nhooks = false\n", "theirsdoc");
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: configPath },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.grok.hooks).toBe("off");
    expect(r.grok.ours).toBe(false);
    expect(r.findings.some((x) => x.code.startsWith("grok_compat"))).toBe(false);
  });

  it("says nothing at all when Grok is not installed", async () => {
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: path.join(freshHome("nogrok"), ".grok", "config.toml") },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.grok.installed).toBe(false);
    expect(r.findings.some((x) => x.code.startsWith("grok_compat"))).toBe(false);
  });

  it("never flips the exit code — this is waste, not breakage", async () => {
    const configPath = grokFixture(REAL_ISH);
    const r = runDoctor({
      home: freshHome("store"),
      userHome: freshHome("userhome"),
      hostConfigPaths: { grok: configPath },
      shimSettingsPath: await claudeWithHooks(),
    });
    expect(r.findings.filter((f) => f.code.startsWith("grok_compat") && f.level === "fail")).toHaveLength(0);
  });
});
