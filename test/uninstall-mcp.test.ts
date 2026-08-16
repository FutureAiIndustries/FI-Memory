import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_MCP_SERVER_KEY, MCP_SERVER_KEY } from "../src/brand.js";
import { installMcp, uninstallMcp } from "../src/ops/installMcp.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * `uninstall-mcp` — the removal direction.
 *
 * `install-mcp` writes up to seven host config files and, until this, nothing
 * removed them: a tester who backed out had to hand-edit JSON and TOML across
 * seven files, and if they had used `--env-passthrough GESTALT_PASSPHRASE` one
 * of those files held their passphrase in plain text. These tests pin the
 * contract that makes backing out safe:
 *
 *   - only OUR entry goes; every sibling section (and the API keys in them)
 *     comes out byte-identical;
 *   - a config with nothing of ours is left BYTE-IDENTICAL, mtime included;
 *   - a second run does nothing;
 *   - a config that cannot be parsed is REFUSED, never rewritten;
 *   - a host that is not installed is REPORTED, never treated as a failure;
 *   - an env block that leaves disk is NAMED (names only, never values).
 *
 * ISOLATION: every path below is a temp fixture built by `freshHome`. Nothing
 * here reads or writes the owner's real ~/.grok, ~/.codex, ~/.cursor,
 * ~/.claude.json or Claude Desktop config — every host path is injected.
 */

/* ───────────────────────────── TOML fixtures ─────────────────────────────── */

/** Everything above our section, verbatim — including an array-of-tables. */
const HEAD = [
  "[cli]",
  'installer = "internal"',
  "auto_update = true",
  "",
  "[[marketplace.sources]]",
  'name = "xAI Official"',
  'git = "https://github.com/xai-org/plugin-marketplace.git"',
  "",
  "",
].join("\n");

/** Our section as install-mcp's predecessor left it. */
const OURS = [
  "[mcp_servers.gestalt]",
  "command = 'C:\\Program Files\\nodejs\\node.exe'",
  "args = [",
  "    'C:\\old\\checkout\\cli.js',",
  '    "mcp",',
  "]",
  "",
  "",
].join("\n");

/** Sibling MCP sections below ours — including secrets that must not move. */
const TAIL = [
  "[mcp_servers.playwright]",
  'command = "npx"',
  "args = [",
  '    "-y",',
  '    "@playwright/mcp@latest",',
  "]",
  "enabled = true",
  "",
  "[mcp_servers.meshy]",
  'command = "npx"',
  "",
  "[mcp_servers.meshy.env]",
  'MESHY_API_KEY = "msy_supersecret_do_not_touch"',
  "",
  "[mcp_servers.scenario.headers]",
  'Authorization = "Bearer sk-live-abcdef"',
  "",
].join("\n");

/** A temp host dir with an optional config.toml in it. */
function tomlHost(label: string, contents?: string): { dir: string; cfg: string } {
  const dir = freshHome(`unmcp-${label}`);
  mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "config.toml");
  if (contents !== undefined) writeFileSync(cfg, contents, "utf8");
  return { dir, cfg };
}

/** A temp host dir with an optional JSON config in it. */
function jsonHost(label: string, contents?: unknown): { dir: string; cfg: string } {
  const dir = freshHome(`unmcp-${label}`);
  mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "mcp.json");
  if (contents !== undefined) writeFileSync(cfg, JSON.stringify(contents, null, 2) + "\n", "utf8");
  return { dir, cfg };
}

const removeGrok = (cfg: string, dryRun = false) =>
  uninstallMcp({ targets: ["grok"], grokConfigPath: cfg, ...(dryRun ? { dryRun: true } : {}) });
const removeCursor = (cfg: string, dryRun = false) =>
  uninstallMcp({ targets: ["cursor"], cursorConfigPath: cfg, ...(dryRun ? { dryRun: true } : {}) });

/* ═════════════════════════════ TOML hosts ════════════════════════════════ */

describe("uninstall-mcp (TOML) — removes only our section", () => {
  it("takes out [mcp_servers.gestalt] and leaves every sibling byte-identical", async () => {
    const { cfg } = tomlHost("siblings", HEAD + OURS + TAIL);

    const r = await removeGrok(cfg);
    const w = r.removers[0]!;
    expect(w.target).toBe("grok");
    expect(w.removed).toBe(true);
    expect(w.note).toContain("every other section untouched");

    // The point: what is left is exactly the file minus our block, to the byte.
    expect(readFileSync(cfg, "utf8")).toBe(HEAD + TAIL);
    const after = readFileSync(cfg, "utf8");
    expect(after).not.toContain("[mcp_servers.gestalt]");
    expect(after).toContain('MESHY_API_KEY = "msy_supersecret_do_not_touch"');
    expect(after).toContain('Authorization = "Bearer sk-live-abcdef"');
    expect(after.match(/^\[\[marketplace\.sources\]\]$/gm)).toHaveLength(1);
  });

  it("takes the [mcp_servers.gestalt.env] sub-table with it (no orphan secret)", async () => {
    const withEnv =
      HEAD +
      [
        "[mcp_servers.gestalt]",
        'command = "node"',
        'args = ["mcp"]',
        "",
        "[mcp_servers.gestalt.env]",
        'GESTALT_PASSPHRASE = "correct horse battery staple"',
        "",
        "",
      ].join("\n") +
      TAIL;
    const { cfg } = tomlHost("env-subtable", withEnv);

    const r = await removeGrok(cfg);
    const after = readFileSync(cfg, "utf8");
    expect(after).toBe(HEAD + TAIL);
    expect(after).not.toContain("GESTALT_PASSPHRASE");
    expect(after).not.toContain("correct horse battery staple");

    // Named, so the user knows a secret just left disk — names only.
    expect(r.removers[0]!.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    expect(r.envKeysRemoved).toEqual(["GESTALT_PASSPHRASE"]);
    expect(JSON.stringify(r)).not.toContain("correct horse battery staple");
  });

  it("leaves a config with no gestalt section BYTE-identical, mtime included", async () => {
    const source = HEAD + TAIL;
    const { cfg } = tomlHost("nothing", source);
    const stamp = statSync(cfg).mtimeMs;

    const r = await removeGrok(cfg);
    const w = r.removers[0]!;
    expect(w.removed).toBe(false);
    expect(w.absent).toBe(true);
    expect(w.note).toContain("nothing to remove");
    expect(readFileSync(cfg, "utf8")).toBe(source);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("is idempotent: the second run writes nothing, not even the mtime", async () => {
    const { cfg } = tomlHost("idem", HEAD + OURS + TAIL);
    await removeGrok(cfg);
    const first = readFileSync(cfg, "utf8");
    const stamp = statSync(cfg).mtimeMs;

    const r2 = await removeGrok(cfg);
    expect(r2.removers[0]!.absent).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(first);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("a commented-out header is not mistaken for our section", async () => {
    const commented = '# was here once:\n#[mcp_servers.gestalt]\n#command = "node"\n\n[ui]\nyolo = false\n';
    const { cfg } = tomlHost("comment", commented);
    const r = await removeGrok(cfg);
    expect(r.removers[0]!.absent).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(commented);
  });

  it("removes DUPLICATE gestalt sections (the writer refuses them; removal has no ambiguity)", async () => {
    // Two identical headers make the file unparseable for the host, and one of
    // them may hold a passphrase. Removing both is the only answer that makes
    // "uninstalled" true.
    const dupes =
      "[cli]\nauto_update = true\n\n" +
      '[mcp_servers.gestalt]\ncommand = "a"\n\n' +
      "[mcp_servers.playwright]\ncommand = \"npx\"\n\n" +
      '[mcp_servers.gestalt]\ncommand = "b"\n\n';
    const { cfg } = tomlHost("dupes", dupes);

    const r = await removeGrok(cfg);
    expect(r.removers[0]!.removed).toBe(true);
    expect(r.removers[0]!.note).toContain("duplicate");
    const after = readFileSync(cfg, "utf8");
    expect(after).not.toContain("[mcp_servers.gestalt]");
    expect(after).toContain("[mcp_servers.playwright]");
    expect(after).toContain("[cli]");
  });

  it("a CRLF config stays CRLF and its siblings stay byte-identical", async () => {
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    const { cfg } = tomlHost("crlf", crlf(HEAD + OURS + TAIL));
    await removeGrok(cfg);
    const after = readFileSync(cfg, "utf8");
    expect(after).toBe(crlf(HEAD + TAIL));
    expect(/(?<!\r)\n/.test(after)).toBe(false); // not one lone LF anywhere
  });

  it("a UTF-8 BOM survives, and our section is still found behind it", async () => {
    const BOM = "\uFEFF";
    const { cfg } = tomlHost("bom", BOM + OURS + TAIL);
    const r = await removeGrok(cfg);
    expect(r.removers[0]!.removed).toBe(true);
    const after = readFileSync(cfg, "utf8");
    expect(after).toBe(BOM + TAIL);
    expect(after.split(BOM)).toHaveLength(2); // exactly one BOM, still at the front
  });
});

describe("uninstall-mcp (TOML) — refuses rather than rewriting a shape it cannot read", () => {
  const cases: Array<{ name: string; toml: string; expect: string }> = [
    {
      name: "an unterminated multi-line string",
      toml: '[cli]\nnote = """\nstill going\n\n[mcp_servers.gestalt]\ncommand = "old"\n',
      expect: "could not be read as TOML",
    },
    {
      name: "a malformed table header",
      toml: '[cli\ninstaller = "internal"\n\n[mcp_servers.gestalt]\ncommand = "old"\n',
      expect: "could not be read as TOML",
    },
    {
      name: "an unterminated array",
      toml: '[mcp_servers.gestalt]\nargs = [\n  "mcp",\n',
      expect: "could not be read as TOML",
    },
    {
      name: "[[mcp_servers.gestalt]] as an array of tables",
      toml: '[[mcp_servers.gestalt]]\ncommand = "node"\n',
      expect: "array of tables",
    },
    {
      // The dangerous one: there IS a live gestalt entry here. Reporting
      // "nothing to remove" would be a false all-clear over a possible secret.
      name: "gestalt as an inline key under [mcp_servers]",
      toml: '[mcp_servers]\ngestalt = { command = "node", env = { GESTALT_PASSPHRASE = "hunter2" } }\nother = { command = "x" }\n',
      expect: "inline key",
    },
    {
      name: "gestalt as a dotted top-level key",
      toml: 'mcp_servers.gestalt = { command = "node" }\n\n[ui]\nyolo = false\n',
      expect: "inline key",
    },
    {
      name: "the whole server map declared as one inline table containing gestalt",
      toml: 'mcp_servers = { gestalt = { command = "node" }, playwright = { command = "npx" } }\n\n[ui]\nyolo = false\n',
      expect: "inline key",
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.name}`, async () => {
      const { cfg } = tomlHost("refuse", c.toml);
      const before = readFileSync(cfg, "utf8");
      const stamp = statSync(cfg).mtimeMs;

      const r = await removeGrok(cfg);
      const w = r.removers[0]!;
      expect(w.removed).toBe(false);
      expect(w.absent).toBeUndefined(); // NOT reported as "nothing to remove"
      expect(w.note).toContain("left unchanged");
      expect(w.note).toContain(c.expect);
      // Not one byte moved.
      expect(readFileSync(cfg, "utf8")).toBe(before);
      expect(statSync(cfg).mtimeMs).toBe(stamp);
    });
  }

  it("refuses a config that is not valid UTF-8 (would corrupt sibling secrets)", async () => {
    const { cfg } = tomlHost("utf16");
    const raw = Buffer.from('\ufeff[mcp_servers.gestalt]\ncommand = "node"\n', "utf16le");
    writeFileSync(cfg, raw);

    const r = await removeGrok(cfg);
    expect(r.removers[0]!.removed).toBe(false);
    expect(r.removers[0]!.note).toContain("not valid UTF-8");
    expect(readFileSync(cfg)).toEqual(raw);
  });

  it("a `[` inside a string value is not read as our section header", async () => {
    const tricky = '[cli]\nbanner = "[mcp_servers.gestalt] is not a header here"\n';
    const { cfg } = tomlHost("strbracket", tricky);
    const r = await removeGrok(cfg);
    expect(r.removers[0]!.absent).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(tricky);
  });
});

/* ═════════════════════════════ JSON hosts ════════════════════════════════ */

describe("the CLI accepts one spelling of a host name, in both directions", () => {
  const TSX = tsxEntry();
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function cli(argv: string[], userHome: string, grokHome: string) {
    return spawnSync(process.execPath, [TSX, CLI, ...argv], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        APPDATA: path.join(userHome, "AppData"),
        GROK_HOME: grokHome,
        GESTALT_HOME: path.join(userHome, ".gestalt"),
        NO_COLOR: "1",
      },
    });
  }

  it("`uninstall-mcp Grok` removes the entry instead of exiting 0 having done nothing", { timeout: 60_000 }, () => {
    // The usage check normalized (`.trim().toLowerCase()`) but then passed the
    // RAW positional to the op. A target differing only by case therefore
    // passed validation, matched nothing inside, produced zero removers, and
    // exited 0 — over a config that could still be holding a passphrase in
    // plain text. This command's documented contract is that
    // `uninstall-mcp && rm -rf <store>` STOPS in that situation.
    const userHome = freshHome("unmcp-case-home");
    const grokHome = freshHome("unmcp-case-grok");
    mkdirSync(userHome, { recursive: true });
    mkdirSync(grokHome, { recursive: true });
    const cfg = path.join(grokHome, "config.toml");
    writeFileSync(
      cfg,
      '[mcp_servers.gestalt]\ncommand = "node"\nargs = ["cli.js", "mcp"]\n\n[mcp_servers.gestalt.env]\nGESTALT_PASSPHRASE = "hunter2"\n',
      "utf8",
    );

    const r = cli(["uninstall-mcp", "Grok"], userHome, grokHome);
    expect(r.status).toBe(0);
    const after = readFileSync(cfg, "utf8");
    expect(after).not.toContain("hunter2");
    expect(after).not.toContain("[mcp_servers.gestalt]");
    // …and the run says the env name left disk, so the user knows to keep a copy.
    expect(r.stdout).toContain("GESTALT_PASSPHRASE");
  });

  it("`install-mcp Grok` and `install-mcp grok` name the same host", { timeout: 60_000 }, () => {
    const userHome = freshHome("inmcp-case-home");
    const grokHome = freshHome("inmcp-case-grok");
    mkdirSync(userHome, { recursive: true });
    mkdirSync(grokHome, { recursive: true });

    const r = cli(["install-mcp", "Grok"], userHome, grokHome);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/unknown target/i);
    expect(readFileSync(path.join(grokHome, "config.toml"), "utf8")).toContain(
      `[mcp_servers.${MCP_SERVER_KEY}]`,
    );
  });
});

describe("install-mcp (JSON) — the writer and the remover agree about the same file", () => {
  it("refuses a top-level ARRAY instead of reporting a write that never happened", async () => {
    // `typeof [] === "object"`, so an array used to sail through the writer's
    // guard: it set config["mcpServers"] on the array, JSON.stringify dropped
    // it, and install-mcp returned wrote:true "added the gestalt server" over a
    // reformatted file with no gestalt entry in it. `removeJsonConfig` already
    // guarded arrays, so install and uninstall disagreed about one file.
    const home = freshHome("mcp-array-home");
    const { cfg } = jsonHost("array-config", [{ keep: "me" }] as unknown as Record<string, unknown>);
    const before = readFileSync(cfg, "utf8");

    const r = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(r.writers[0]!.wrote).toBe(false);
    expect(r.writers[0]!.unchanged).toBeFalsy();
    expect(r.writers[0]!.note).toMatch(/not a JSON object/);
    // Not even reformatted: refusing means leaving the file alone.
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });

  it("a second identical install writes NOTHING and says `unchanged`", async () => {
    // The README tells a confused reader that re-running setup is the
    // diagnostic: "everything already in place reports unchanged and nothing is
    // rewritten". The JSON writer had no unchanged check at all, so it rewrote
    // four host configs and claimed "added the gestalt server (restart …)" on
    // every run, forever — making the re-run unable to tell a working install
    // from a dead one, which is the whole point of the re-run.
    const home = freshHome("mcp-json-unchanged-home");
    const { cfg } = jsonHost("json-unchanged", { mcpServers: { other: { command: "x", args: [] } } });

    const first = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(first.writers[0]!.wrote).toBe(true);
    const bytes = readFileSync(cfg, "utf8");
    const mtime = statSync(cfg).mtimeMs;

    const second = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(second.writers[0]!.unchanged).toBe(true);
    expect(second.writers[0]!.wrote).toBe(false);
    expect(second.writers[0]!.note).toMatch(/already up to date/i);
    expect(readFileSync(cfg, "utf8")).toBe(bytes);
    expect(statSync(cfg).mtimeMs, "not even the mtime may move").toBe(mtime);
  });
});

describe("uninstall-mcp (JSON) — removes only our entry", () => {
  it("deletes mcpServers.gestalt and leaves every sibling server and top-level key", async () => {
    const { cfg } = jsonHost("json-siblings", {
      theme: "dark",
      mcpServers: {
        other: { command: "x", args: [], env: { OTHER_API_KEY: "sk-live-other" } },
        gestalt: { command: "node", args: ["cli.js", "mcp"] },
      },
      trustedFolders: ["/work"],
    });

    const r = await removeCursor(cfg);
    expect(r.removers[0]!.removed).toBe(true);

    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as {
      mcpServers: Record<string, unknown>;
      theme: string;
      trustedFolders: string[];
    };
    expect(parsed.mcpServers["gestalt"]).toBeUndefined();
    expect(parsed.mcpServers["other"]).toEqual({
      command: "x",
      args: [],
      env: { OTHER_API_KEY: "sk-live-other" },
    });
    expect(parsed.theme).toBe("dark");
    expect(parsed.trustedFolders).toEqual(["/work"]);
  });

  it("leaves a config with no gestalt entry BYTE-identical, mtime included", async () => {
    const { cfg } = jsonHost("json-nothing", { mcpServers: { other: { command: "x" } }, theme: "dark" });
    const before = readFileSync(cfg, "utf8");
    const stamp = statSync(cfg).mtimeMs;

    const r = await removeCursor(cfg);
    expect(r.removers[0]!.absent).toBe(true);
    expect(r.removers[0]!.note).toContain("nothing to remove");
    // Not reserialized: someone else's formatting is not ours to normalize.
    expect(readFileSync(cfg, "utf8")).toBe(before);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("a config with no mcpServers map at all is left alone", async () => {
    const { cfg } = jsonHost("json-nomap", { theme: "dark" });
    const before = readFileSync(cfg, "utf8");
    const r = await removeCursor(cfg);
    expect(r.removers[0]!.absent).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });

  it("is idempotent", async () => {
    const { cfg } = jsonHost("json-idem", { mcpServers: { gestalt: { command: "node" }, other: { command: "x" } } });
    await removeCursor(cfg);
    const first = readFileSync(cfg, "utf8");
    const stamp = statSync(cfg).mtimeMs;

    const r2 = await removeCursor(cfg);
    expect(r2.removers[0]!.absent).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(first);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("leaves an empty mcpServers map rather than deleting structure it did not create", async () => {
    const { cfg } = jsonHost("json-onlyours", { mcpServers: { gestalt: { command: "node" } }, theme: "dark" });
    await removeCursor(cfg);
    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
    expect(parsed["mcpServers"]).toEqual({});
    expect(parsed["theme"]).toBe("dark");
  });

  it("refuses invalid JSON, and refuses a top-level array — never rewrites either", async () => {
    for (const [label, body, why] of [
      ["json-bad", '{ "mcpServers": { "gestalt": { } }, // a comment\n}', "not valid JSON"],
      ["json-array", '[{"mcpServers":{"gestalt":{}}}]\n', "not a JSON object"],
    ] as const) {
      const dir = freshHome(`unmcp-${label}`);
      mkdirSync(dir, { recursive: true });
      const cfg = path.join(dir, "mcp.json");
      writeFileSync(cfg, body, "utf8");
      const stamp = statSync(cfg).mtimeMs;

      const r = await removeCursor(cfg);
      const w = r.removers[0]!;
      expect(w.removed).toBe(false);
      expect(w.absent).toBeUndefined();
      expect(w.note).toContain("left unchanged");
      expect(w.note).toContain(why);
      expect(readFileSync(cfg, "utf8")).toBe(body);
      expect(statSync(cfg).mtimeMs).toBe(stamp);
    }
  });

  it("names the env block it removed, and never its values", async () => {
    const { cfg } = jsonHost("json-env", {
      mcpServers: { gestalt: { command: "node", args: ["mcp"], env: { GESTALT_PASSPHRASE: "hunter2" } } },
    });
    const r = await removeCursor(cfg);
    expect(r.removers[0]!.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    expect(readFileSync(cfg, "utf8")).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

/* ══════════════════ host detection, reporting, exit surface ══════════════ */

describe("uninstall-mcp — the same detection rule and per-host reporting as install-mcp", () => {
  it("reports not-installed (never a failure) when the host's config folder is absent", async () => {
    const missingTomlDir = path.join(freshHome("unmcp-nodir-toml"), "config.toml");
    const missingJsonDir = path.join(freshHome("unmcp-nodir-json"), "mcp.json");

    const r = await uninstallMcp({
      targets: ["grok", "cursor"],
      grokConfigPath: missingTomlDir,
      cursorConfigPath: missingJsonDir,
    });
    expect(r.removers.map((w) => w.target)).toEqual(["cursor", "grok"]);
    for (const w of r.removers) {
      expect(w.removed).toBe(false);
      expect(w.absent).toBe(true);
      expect(w.note).toContain("not installed here");
    }
    expect(r.warnings.some((x) => x.code === "unknown_target")).toBe(false);
  });

  it("reports a present folder with no config file as nothing-to-remove", async () => {
    const { cfg } = tomlHost("nofile"); // dir exists, file does not
    const r = await removeGrok(cfg);
    expect(r.removers[0]!.absent).toBe(true);
    expect(r.removers[0]!.note).toContain("no grok config file");
  });

  it("warns on an unknown target and touches nothing", async () => {
    const r = await uninstallMcp({ targets: ["grok-cli"] });
    expect(r.warnings.find((x) => x.code === "unknown_target")!.message).toContain("grok");
    expect(r.removers).toHaveLength(0);
  });

  it("covers every install-mcp target when none are named", async () => {
    // All seven, all injected at paths that do not exist, so nothing real is read.
    const p = (n: string): string => path.join(freshHome(`unmcp-all-${n}`), n);
    const r = await uninstallMcp({
      desktopConfigPath: p("claude_desktop_config.json"),
      cursorConfigPath: p("mcp.json"),
      codexConfigPath: p("config.toml"),
      geminiConfigPath: p("settings.json"),
      grokConfigPath: p("config.toml"),
      windsurfConfigPath: p("mcp_config.json"),
      claudeCodeConfigPath: p(".claude.json"),
    });
    expect(r.removers.map((w) => w.target).sort()).toEqual(
      ["claude-desktop", "codex", "cursor", "gemini", "grok", "windsurf"].sort(),
    );
    expect(r.claudeCode).toBeDefined(); // the seventh, by printed command
  });

  it("a host whose removal throws is one row, and later hosts still run", async () => {
    // A config PATH that is a directory: the read throws. It must not escape,
    // or the hosts after it are never attempted and never reported.
    const { dir: codexDir } = tomlHost("throw-codex");
    const codexCfg = path.join(codexDir, "config.toml");
    mkdirSync(codexCfg, { recursive: true });
    const { cfg: grokCfg } = tomlHost("throw-grok", HEAD + OURS + TAIL);

    const r = await uninstallMcp({ targets: ["codex", "grok"], codexConfigPath: codexCfg, grokConfigPath: grokCfg });
    expect(r.removers.map((w) => w.target)).toEqual(["codex", "grok"]);
    expect(r.removers[0]!.removed).toBe(false);
    expect(r.removers[0]!.note).toContain("the removal failed");
    expect(r.removers[1]!.removed).toBe(true);
    expect(readFileSync(grokCfg, "utf8")).toBe(HEAD + TAIL);
  });
});

/* ════════════════════════════ claude-code ═══════════════════════════════ */

describe("uninstall-mcp — claude-code is add-by-command, so removal is print-by-command", () => {
  it("prints the mirror of install-mcp's add line and does not write ~/.claude.json", async () => {
    const dir = freshHome("unmcp-cc");
    mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, ".claude.json");
    const body = JSON.stringify({ mcpServers: { gestalt: { command: "node", args: ["mcp"] } } }, null, 2) + "\n";
    writeFileSync(cfg, body, "utf8");
    const stamp = statSync(cfg).mtimeMs;

    const r = await uninstallMcp({ targets: ["claude-code"], claudeCodeConfigPath: cfg });
    // Verified against the shipped Claude Code executable on this disk
    // (~/.local/share/claude/versions/2.1.214), which builds this exact form
    // for itself: `mcp remove <name> -s <scope>`, scopes local|user|project.
    expect(r.claudeCode!.command).toBe("claude mcp remove gestalt -s user");
    expect(r.claudeCode!.registered).toBe(true);
    expect(r.removers).toHaveLength(0); // never a writer row: we do not own that file
    expect(readFileSync(cfg, "utf8")).toBe(body);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("says so when there is no gestalt entry, and survives an unreadable file", async () => {
    const dir = freshHome("unmcp-cc-none");
    mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, ".claude.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { other: {} } }), "utf8");
    const none = await uninstallMcp({ targets: ["claude-code"], claudeCodeConfigPath: cfg });
    expect(none.claudeCode!.registered).toBe(false);

    writeFileSync(cfg, "not json at all", "utf8");
    const broken = await uninstallMcp({ targets: ["claude-code"], claudeCodeConfigPath: cfg });
    expect(broken.claudeCode!.registered).toBe(false);
    // Nothing readable to inspect, so it falls back to the name we write today.
    expect(broken.claudeCode!.command).toBe(`claude mcp remove ${MCP_SERVER_KEY} -s user`);
  });

  it("warns that the printed command takes a plaintext env block with it", async () => {
    const dir = freshHome("unmcp-cc-env");
    mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, ".claude.json");
    writeFileSync(
      cfg,
      JSON.stringify({ mcpServers: { gestalt: { command: "node", env: { GESTALT_PASSPHRASE: "hunter2" } } } }),
      "utf8",
    );

    const r = await uninstallMcp({ targets: ["claude-code"], claudeCodeConfigPath: cfg });
    expect(r.claudeCode!.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    const w = r.warnings.find((x) => x.code === "env_secret_pending")!;
    expect(w.message).toContain("GESTALT_PASSPHRASE");
    expect(w.message).toContain("PLAIN TEXT");
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

/* ═══════════════════ the passphrase-ordering warning ════════════════════ */

describe("uninstall-mcp — order matters when the entry holds a secret", () => {
  it("warns in both directions once an env block has actually been removed", async () => {
    const { cfg } = tomlHost(
      "order",
      HEAD +
        [
          "[mcp_servers.gestalt]",
          'command = "node"',
          "",
          "[mcp_servers.gestalt.env]",
          'GESTALT_PASSPHRASE = "hunter2"',
          "",
          "",
        ].join("\n") +
        TAIL,
    );

    const r = await removeGrok(cfg);
    const w = r.warnings.find((x) => x.code === "env_secret_removed")!;
    expect(w).toBeDefined();
    expect(w.message).toContain("GESTALT_PASSPHRASE");
    expect(w.message).toContain("grok");
    // Both directions, because the hazard runs both ways.
    expect(w.message).toContain("Keeping the store");
    expect(w.message).toContain("Discarding the store");
    expect(w.message).not.toContain("hunter2");
  });

  it("says nothing about secrets when no env block was involved", async () => {
    const { cfg } = tomlHost("order-none", HEAD + OURS + TAIL);
    const r = await removeGrok(cfg);
    expect(r.envKeysRemoved).toEqual([]);
    expect(r.warnings.some((x) => x.code.startsWith("env_secret"))).toBe(false);
  });

  it("--dry-run reports the secret and writes nothing at all", async () => {
    const source =
      HEAD +
      [
        "[mcp_servers.gestalt]",
        'command = "node"',
        "",
        "[mcp_servers.gestalt.env]",
        'GESTALT_PASSPHRASE = "hunter2"',
        "",
        "",
      ].join("\n") +
      TAIL;
    const { cfg } = tomlHost("dry", source);
    const stamp = statSync(cfg).mtimeMs;

    const r = await removeGrok(cfg, true);
    const w = r.removers[0]!;
    expect(r.dryRun).toBe(true);
    expect(w.removed).toBe(false);
    expect(w.wouldRemove).toBe(true); // found work, NOT a refusal
    expect(w.absent).toBeUndefined();
    expect(w.note).toContain("would remove");
    expect(w.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    expect(r.warnings.find((x) => x.code === "env_secret_would_remove")!.message).toContain("DELETES");

    // Nothing written.
    expect(readFileSync(cfg, "utf8")).toBe(source);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("--dry-run on a JSON host is equally read-only", async () => {
    const { cfg } = jsonHost("dry-json", { mcpServers: { gestalt: { command: "node" }, other: { command: "x" } } });
    const before = readFileSync(cfg, "utf8");
    const r = await removeCursor(cfg, true);
    expect(r.removers[0]!.wouldRemove).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });
});

/* ═══════════════════════ install → uninstall round trip ═════════════════ */

describe("uninstall-mcp — install then uninstall returns the config to its own bytes", () => {
  it("TOML: a config install APPENDED to comes back byte-identical", async () => {
    const home = freshHome("unmcp-rt-home");
    const source = HEAD + TAIL;
    const { cfg } = tomlHost("roundtrip", source);

    const i = await installMcp({ targets: ["grok"], grokConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(i.writers[0]!.wrote).toBe(true);
    expect(readFileSync(cfg, "utf8")).toContain(`[mcp_servers.${MCP_SERVER_KEY}]`);

    const u = await removeGrok(cfg);
    expect(u.removers[0]!.removed).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(source);
  });

  it("TOML: blank lines the USER wrote at the end of the file survive the round trip", async () => {
    // The append path adds a separator ONLY when the file does not already end
    // in a blank line, so the only trailing run it can create is exactly two.
    // Collapsing the whole EOF newline run to one deleted blank lines nobody of
    // ours wrote, which made this describe block's own promise false and showed
    // up as an unexplained whitespace change in a version-controlled dotfile.
    const home = freshHome("unmcp-rt-blanks-home");
    const source = '[mcp_servers.other]\ncommand = "x"\n\n\n';
    const { cfg } = tomlHost("roundtrip-blanks", source);

    await installMcp({ targets: ["grok"], grokConfigPath: cfg, cliPath: "/fake/cli.js", home });
    await removeGrok(cfg);
    expect(readFileSync(cfg, "utf8")).toBe(source);
  });

  it("TOML: a config install CREATED comes back empty, and the file is not deleted", async () => {
    const home = freshHome("unmcp-rt-create-home");
    const { cfg } = tomlHost("roundtrip-create"); // dir only
    await installMcp({ targets: ["grok"], grokConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(readFileSync(cfg, "utf8")).toContain(`[mcp_servers.${MCP_SERVER_KEY}]`);

    await removeGrok(cfg);
    expect(readFileSync(cfg, "utf8")).toBe(""); // valid (empty) TOML, still there
    // …and removing again from the empty file is a clean no-op.
    const again = await removeGrok(cfg);
    expect(again.removers[0]!.absent).toBe(true);
  });

  it("TOML: an install carrying --env leaves no trace of the passphrase after removal", async () => {
    const home = freshHome("unmcp-rt-env-home");
    const source = HEAD + TAIL;
    const { cfg } = tomlHost("roundtrip-env", source);

    await installMcp({
      targets: ["grok"],
      grokConfigPath: cfg,
      cliPath: "/fake/cli.js",
      home,
      env: { GESTALT_PASSPHRASE: "hunter2" },
    });
    expect(readFileSync(cfg, "utf8")).toContain("hunter2");

    const u = await removeGrok(cfg);
    expect(u.removers[0]!.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    expect(readFileSync(cfg, "utf8")).toBe(source);
  });

  it("JSON: install then uninstall restores the original object", async () => {
    const home = freshHome("unmcp-rt-json-home");
    const original = { theme: "dark", mcpServers: { other: { command: "x", args: [] } } };
    const { cfg } = jsonHost("roundtrip-json", original);

    await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home });
    expect(readFileSync(cfg, "utf8")).toContain(`"${MCP_SERVER_KEY}"`);

    await removeCursor(cfg);
    expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual(original);
  });

  it("JSON: installing over a LEGACY entry migrates it, never leaves two servers", async () => {
    // The upgrade path. A machine that ran any build before the 2026-08-06
    // rename has the legacy key in its config. If install merely ADDED the new
    // one, that user would end up with two servers pointed at the same store
    // and their model would see two complete tool sets, with a stale one it is
    // free to call. install-mcp is the only verb that runs on an upgrade, so it
    // is the only thing that can clean this up.
    const home = freshHome("unmcp-migrate-home");
    const { cfg } = jsonHost("migrate-json", {
      theme: "dark",
      mcpServers: {
        other: { command: "x", args: [] },
        [LEGACY_MCP_SERVER_KEY]: { command: "old", args: ["--home", "/somewhere/else"] },
      },
    });

    await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home });

    const after = JSON.parse(readFileSync(cfg, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(after.mcpServers)).toContain(MCP_SERVER_KEY);
    expect(Object.keys(after.mcpServers)).not.toContain(LEGACY_MCP_SERVER_KEY);
    // The sibling is untouched — migrating ours must never disturb theirs.
    expect(after.mcpServers["other"]).toEqual({ command: "x", args: [] });
  });

  it("JSON: uninstall finds a LEGACY entry, including the passphrase it carried", async () => {
    // The mirror of the migration, and the reason it matters: an entry written
    // by an older build must stay removable by the command that promises to
    // remove it. Miss this and a pre-rename entry is stranded in a file that
    // may hold the user's passphrase in plain text via --env-passthrough.
    const { cfg } = jsonHost("legacy-uninstall-json", {
      mcpServers: {
        keep: { command: "x", args: [] },
        [LEGACY_MCP_SERVER_KEY]: {
          command: "old",
          args: [],
          env: { GESTALT_PASSPHRASE: "a sentence you will remember" },
        },
      },
    });

    const u = await removeCursor(cfg);
    expect(u.removers[0]!.removed).toBe(true);
    // Named, never valued: the user is told WHICH secret just left disk.
    expect(u.removers[0]!.envKeys).toEqual(["GESTALT_PASSPHRASE"]);
    const after = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual(["keep"]);
  });

  it("every host install-mcp writes, uninstall-mcp removes — the registries agree", async () => {
    const home = freshHome("unmcp-parity-home");
    const mk = (name: string): string => {
      const dir = freshHome(`unmcp-parity-${name}`);
      mkdirSync(dir, { recursive: true });
      return path.join(dir, name);
    };
    const paths = {
      desktopConfigPath: mk("claude_desktop_config.json"),
      cursorConfigPath: mk("mcp.json"),
      codexConfigPath: mk("config.toml"),
      geminiConfigPath: mk("settings.json"),
      grokConfigPath: mk("config.toml"),
      windsurfConfigPath: mk("mcp_config.json"),
    };

    const i = await installMcp({ ...paths, cliPath: "/fake/cli.js", home });
    expect(i.writers.every((w) => w.wrote)).toBe(true);
    expect(i.writers).toHaveLength(6);

    const u = await uninstallMcp(paths);
    expect(u.removers.map((w) => w.target).sort()).toEqual(i.writers.map((w) => w.target).sort());
    expect(u.removers.every((w) => w.removed)).toBe(true);
    for (const w of u.removers) expect(readFileSync(w.path, "utf8")).not.toContain("gestalt");
  });
});
