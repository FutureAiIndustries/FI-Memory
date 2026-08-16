import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/ops/doctor.js";
import { defaultHostConfigFiles, installMcp } from "../src/ops/installMcp.js";
import { freshHome } from "./helpers.js";

/**
 * Grok CLI as an install-mcp target.
 *
 * Grok keeps MCP servers in `~/.grok/config.toml` under `[mcp_servers.<name>]` —
 * the same file format and the same table shape Codex uses — so it rides the
 * SAME writer, and these tests pin the part that must not go wrong: a real
 * `~/.grok/config.toml` has many sibling MCP sections (several carrying API
 * keys), an existing gestalt section, and non-MCP tables including an
 * `[[marketplace.sources]]` array-of-tables. Every sibling must come out
 * byte-identical, the file must never be reordered or reformatted, and an
 * unparseable file must be refused rather than truncated.
 *
 * ISOLATION: every path below is a temp fixture. Nothing here reads or writes
 * the real ~/.grok.
 */

/** Everything above the gestalt section in the owner-shaped fixture, verbatim. */
const HEAD = [
  "[cli]",
  'installer = "internal"',
  "auto_update = true",
  "",
  "[ui]",
  "max_thoughts_width = 120",
  'permission_mode = "always-approve"',
  "",
  "[marketplace]",
  "official_marketplace_auto_installed = true",
  "",
  "[[marketplace.sources]]",
  'name = "xAI Official"',
  'git = "https://github.com/xai-org/plugin-marketplace.git"',
  "",
  "",
].join("\n");

/** The hand-pasted gestalt section this install must replace. */
const OLD_OURS = [
  "[mcp_servers.gestalt]",
  "command = 'C:\\Program Files\\nodejs\\node.exe'",
  "args = [",
  "    'C:\\old\\checkout\\cli.js',",
  '    "mcp",',
  "]",
  "enabled = true",
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
  "startup_timeout_sec = 120",
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

const OWNER_SHAPED = HEAD + OLD_OURS + TAIL;

/** A temp ~/.grok with a config.toml in it. */
function grokDir(label: string, contents?: string): { dir: string; cfg: string } {
  const dir = freshHome(`grok-${label}`);
  mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "config.toml");
  if (contents !== undefined) writeFileSync(cfg, contents, "utf8");
  return { dir, cfg };
}

async function install(cfg: string, home: string, env?: Record<string, string>) {
  return installMcp({
    targets: ["grok"],
    grokConfigPath: cfg,
    cliPath: "/fake/cli.js",
    home,
    ...(env ? { env } : {}),
  });
}

describe("install-mcp grok — target registration", () => {
  it("is a known target, config at $GROK_HOME|~/.grok/config.toml, kind toml, key mcp_servers", () => {
    const home = freshHome("grok-registry");
    const fromHome = defaultHostConfigFiles({ homeDir: home, env: {} }).find((h) => h.target === "grok")!;
    expect(fromHome.file).toBe(path.join(home, ".grok", "config.toml"));
    expect(fromHome.kind).toBe("toml");
    expect(fromHome.key).toBe("mcp_servers");

    // Same GROK_HOME override install-rules honors, so writer and checker agree.
    const elsewhere = path.join(freshHome("grok-elsewhere"), "grokhome");
    const overridden = defaultHostConfigFiles({ homeDir: home, env: { GROK_HOME: elsewhere } }).find(
      (h) => h.target === "grok",
    )!;
    expect(overridden.file).toBe(path.join(elsewhere, "config.toml"));
  });

  it("an unknown target still warns, and grok is not in that list", async () => {
    const home = freshHome("grok-unknown");
    const r = await installMcp({ targets: ["grok-cli"], cliPath: "/fake/cli.js", home });
    const w = r.warnings.find((x) => x.code === "unknown_target")!;
    expect(w.message).toContain("grok");
    expect(r.writers).toHaveLength(0);
  });
});

describe("install-mcp grok — safety on a real-shaped config", () => {
  it("replaces ONLY the gestalt section; every sibling section is byte-identical", async () => {
    const home = freshHome("grok-siblings");
    const { cfg } = grokDir("siblings", OWNER_SHAPED);

    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(true);

    const after = readFileSync(cfg, "utf8");
    // Everything above and below our section survived to the byte, and stayed
    // in place — our section did not migrate to the end of the file.
    expect(after.startsWith(HEAD)).toBe(true);
    expect(after.endsWith(TAIL)).toBe(true);
    // Exactly one gestalt section, and it is where the old one was.
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
    expect(after.indexOf("[mcp_servers.fimemory]")).toBe(HEAD.length);
    // The middle is only our rewritten section (+ the blank-line separator the
    // old section had), so nothing else was reformatted.
    const middle = after.slice(HEAD.length, after.length - TAIL.length);
    const e = r.serverEntry;
    expect(middle).toBe(
      `[mcp_servers.fimemory]\ncommand = ${JSON.stringify(e.command)}\n` +
        `args = [${e.args.map((a) => JSON.stringify(a)).join(", ")}]\n\n`,
    );
    // The neighbours' secrets are untouched.
    expect(after).toContain('MESHY_API_KEY = "msy_supersecret_do_not_touch"');
    expect(after).toContain('Authorization = "Bearer sk-live-abcdef"');
  });

  it("preserves an [[array.of.tables]] section elsewhere in the file", async () => {
    const home = freshHome("grok-aot");
    const source = [
      "[[marketplace.sources]]",
      'name = "xAI Official"',
      'git = "https://github.com/xai-org/plugin-marketplace.git"',
      "",
      "[[marketplace.sources]]",
      'name = "Internal"',
      'git = "https://example.invalid/internal.git"',
      "",
    ].join("\n");
    const { cfg } = grokDir("aot", source);

    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(source)).toBe(true);
    expect(after.match(/^\[\[marketplace\.sources\]\]$/gm)).toHaveLength(2);
    expect(after).toContain("[mcp_servers.fimemory]");
  });

  it("replaces the existing gestalt section instead of appending a second one", async () => {
    const home = freshHome("grok-replace");
    const { cfg } = grokDir("replace", OWNER_SHAPED);
    await install(cfg, home);
    await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    const after = readFileSync(cfg, "utf8");
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
    expect(after).toContain("[mcp_servers.fimemory.env]");
    expect(after).not.toContain("C:\\old\\checkout\\cli.js");
    expect(after.endsWith(TAIL)).toBe(true);
  });

  it("drops a previous run's env sub-table when --env is dropped (no stale secret lingers)", async () => {
    const home = freshHome("grok-env");
    const { cfg } = grokDir("env", OWNER_SHAPED);
    await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    expect(readFileSync(cfg, "utf8")).toContain("[mcp_servers.fimemory.env]");

    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after).not.toContain("[mcp_servers.fimemory.env]");
    expect(after).not.toContain("s3cret");
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
    expect(after.endsWith(TAIL)).toBe(true); // siblings still byte-identical
  });

  it("is idempotent: the second run changes nothing, not even the mtime", async () => {
    const home = freshHome("grok-idem");
    const { cfg } = grokDir("idem", OWNER_SHAPED);
    await install(cfg, home);
    const first = readFileSync(cfg, "utf8");
    const stamp = statSync(cfg).mtimeMs;

    const r2 = await install(cfg, home);
    expect(readFileSync(cfg, "utf8")).toBe(first);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
    // Reported as the success it is, not as "could not write".
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(r2.writers[0]!.wrote).toBe(false);
    expect(r2.writers[0]!.note).toContain("already up to date");
  });

  it("creates the file when it is absent but ~/.grok exists", async () => {
    const home = freshHome("grok-create");
    const { cfg } = grokDir("create");
    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(true);
    expect(r.writers[0]!.note).toContain("created");
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith("[mcp_servers.fimemory]\n")).toBe(true);

    // …and creating it is itself idempotent.
    const r2 = await install(cfg, home);
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(after);
  });

  it("reports not-installed (never a failure) when ~/.grok does not exist", async () => {
    const home = freshHome("grok-absent");
    const missing = path.join(freshHome("grok-nodir"), "config.toml");
    const r = await install(missing, home);
    const w = r.writers[0]!;
    expect(w.target).toBe("grok");
    expect(w.wrote).toBe(false);
    expect(w.unchanged).toBeUndefined();
    expect(w.note).toContain("not installed");
    expect(r.warnings.some((x) => x.code === "unknown_target")).toBe(false);
  });

  it("appends to a config that has siblings but no gestalt section", async () => {
    const home = freshHome("grok-append");
    const { cfg } = grokDir("append", HEAD + TAIL);
    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(HEAD + TAIL)).toBe(true); // nothing above it moved
    expect(after).toContain("[mcp_servers.fimemory]");

    // Appending once then replacing in place stays byte-stable.
    const first = after;
    await install(cfg, home);
    expect(readFileSync(cfg, "utf8")).toBe(first);
  });

  it("a commented-out header is not mistaken for our section (and survives)", async () => {
    const home = freshHome("grok-comment");
    const commented = '# was here once:\n#[mcp_servers.gestalt]\n#command = "node"\n\n[ui]\nyolo = false\n';
    const { cfg } = grokDir("comment", commented);
    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(commented)).toBe(true); // the comment block is intact
    expect(after).toContain("[ui]");
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
  });
});

describe("install-mcp grok — refuses rather than rewriting a shape it cannot read", () => {
  const cases: Array<{ name: string; toml: string; expect: string }> = [
    {
      name: "an unterminated multi-line string (section boundaries unknowable)",
      toml: '[cli]\nnote = """\nstill going\n\n[mcp_servers.gestalt]\ncommand = "old"\n',
      expect: "could not be read as TOML",
    },
    {
      name: "a malformed table header",
      toml: "[cli\ninstaller = \"internal\"\n",
      expect: "could not be read as TOML",
    },
    {
      name: "gestalt declared as an inline key under [mcp_servers]",
      toml: '[mcp_servers]\ngestalt = { command = "node", args = [] }\nother = { command = "x" }\n',
      expect: "inline key",
    },
    {
      name: "gestalt declared as a dotted top-level key",
      toml: 'mcp_servers.gestalt = { command = "node" }\n\n[ui]\nyolo = false\n',
      expect: "inline key",
    },
    {
      name: "[[mcp_servers.gestalt]] as an array of tables",
      toml: '[[mcp_servers.gestalt]]\ncommand = "node"\n',
      expect: "array of tables",
    },
    {
      name: "two gestalt sections (ambiguous)",
      toml: '[mcp_servers.gestalt]\ncommand = "a"\n\n[mcp_servers.gestalt]\ncommand = "b"\n',
      expect: "more than once",
    },
    {
      // TOML inline tables are self-contained and may NOT be extended, so
      // adding [mcp_servers.gestalt] would define `mcp_servers` twice and take
      // every server (and key) in that inline table down with it.
      name: "the whole server map declared as one inline table",
      toml: 'mcp_servers = { playwright = { command = "npx" } }\n\n[ui]\nyolo = false\n',
      expect: "inline table",
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.name}`, async () => {
      const home = freshHome("grok-refuse");
      const { cfg } = grokDir("refuse", c.toml);
      const before = readFileSync(cfg, "utf8");
      const stamp = statSync(cfg).mtimeMs;

      const r = await install(cfg, home);
      const w = r.writers[0]!;
      expect(w.wrote).toBe(false);
      expect(w.unchanged).toBeUndefined();
      expect(w.note).toContain("left unchanged");
      expect(w.note).toContain(c.expect);
      // The whole point: not one byte moved.
      expect(readFileSync(cfg, "utf8")).toBe(before);
      expect(statSync(cfg).mtimeMs).toBe(stamp);
    });
  }

  it("refuses a config that is not valid UTF-8 (would corrupt sibling secrets)", async () => {
    const home = freshHome("grok-utf16");
    const { cfg } = grokDir("utf16");
    // What PowerShell 5.1 `Out-File` writes: UTF-16LE with a BOM.
    const raw = Buffer.from('\ufeff[cli]\ninstaller = "internal"\n', "utf16le");
    writeFileSync(cfg, raw);

    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(false);
    expect(r.writers[0]!.note).toContain("not valid UTF-8");
    expect(readFileSync(cfg)).toEqual(raw);
  });

  it("a `[` inside a string value is not read as a section header", async () => {
    const home = freshHome("grok-strbracket");
    const tricky = '[cli]\nbanner = "[mcp_servers.gestalt] is not a header here"\nnote = \'#[ui]\'\n\n';
    const { cfg } = grokDir("strbracket", tricky);
    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(tricky)).toBe(true);
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
  });
});

/**
 * A UTF-8 BOM is what PowerShell 5.1 `Out-File`/`>` and older Notepad produce —
 * i.e. how a hand-pasted ~/.grok/config.toml on this platform tends to be
 * written. It round-trips through UTF-8 cleanly, so a strict decoder accepts it,
 * and the leading U+FEFF then sits in front of the first `[` of line 1: the
 * FIRST table header of the file must still be seen as a header.
 */
describe("install-mcp grok — a UTF-8 BOM does not hide the first section", () => {
  const BOM = "\uFEFF";
  /** Counts our header whether or not the BOM precedes it on line 1. */
  const gestaltHeaders = (s: string): number => s.match(/^\uFEFF?\[mcp_servers\.fimemory\]$/gm)?.length ?? 0;

  it("replaces (never duplicates) a gestalt section that is the FIRST table of a BOM'd file", async () => {
    const home = freshHome("grok-bom-first");
    const source = BOM + OLD_OURS + TAIL; // our header is line 1, right after the BOM
    const { cfg } = grokDir("bom-first", source);

    const r = await install(cfg, home);
    const w = r.writers[0]!;
    expect(w.wrote).toBe(true);
    // Found in place and REPLACED — the append path here would write a second
    // [mcp_servers.gestalt], and a duplicate table makes the whole config
    // unparseable, so Grok would drop every sibling server and its API keys.
    expect(w.note).toContain("updated the existing");

    const after = readFileSync(cfg, "utf8");
    expect(gestaltHeaders(after)).toBe(1);
    expect(after.startsWith(BOM + "[mcp_servers.fimemory]")).toBe(true); // BOM re-emitted verbatim
    expect(after.endsWith(TAIL)).toBe(true);
    expect(after).not.toContain("C:\\old\\checkout\\cli.js");
    expect(after).toContain('MESHY_API_KEY = "msy_supersecret_do_not_touch"');
    // Still exactly one BOM, and only at the front.
    expect(after.split(BOM)).toHaveLength(2);

    // …and the second run is a true no-op.
    const stamp = statSync(cfg).mtimeMs;
    const r2 = await install(cfg, home);
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(after);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });

  it("doctor and the writer agree about registration on the same BOM'd bytes", async () => {
    const home = freshHome("grok-bom-doctor");
    const { cfg } = grokDir("bom-doctor", BOM + OLD_OURS + TAIL);

    // doctor's line-anchored check reports registered (JS \s matches U+FEFF)…
    const before = runDoctor({ home, userHome: freshHome("grok-bom-doctor-user"), hostConfigPaths: { grok: cfg } });
    const grokCheck = before.mcp.find((m) => m.target === "grok")!;
    expect(grokCheck.registered).toBe(true);
    // …and the writer must see the same section, i.e. update it rather than
    // append a second one. (This is the writer/checker drift the host registry
    // exists to prevent.)
    const r = await install(cfg, home);
    expect(r.writers[0]!.note).toContain("updated the existing");
    expect(gestaltHeaders(readFileSync(cfg, "utf8"))).toBe(1);
  });

  it("still refuses a BOM'd config that declares gestalt as an inline key", async () => {
    const home = freshHome("grok-bom-inline");
    const source = BOM + '[mcp_servers]\ngestalt = { command = "node", args = [] }\nother = { command = "x" }\n';
    const { cfg } = grokDir("bom-inline", source);

    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(false);
    expect(r.writers[0]!.note).toContain("inline key");
    expect(readFileSync(cfg, "utf8")).toBe(source); // not one byte moved
  });
});

describe("install-mcp grok — idempotent WITH an env block, and CRLF-safe", () => {
  it("the same --env install twice writes nothing the second time (our section last)", async () => {
    const home = freshHome("grok-env-idem");
    // Our section last, ending in a single newline — the shape an append or a
    // fresh create leaves behind, where the env sub-table's own trailing run is
    // what must be measured.
    const { cfg } = grokDir("env-idem", HEAD + "[mcp_servers.gestalt]\ncommand = 'old'\n");

    await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    const first = readFileSync(cfg, "utf8");
    const stamp = statSync(cfg).mtimeMs;
    expect(first).toContain("[mcp_servers.fimemory.env]");

    const r2 = await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    expect(readFileSync(cfg, "utf8")).toBe(first); // byte-identical, no trailing-newline creep
    expect(statSync(cfg).mtimeMs).toBe(stamp); // a file holding a passphrase is not churned
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(r2.writers[0]!.wrote).toBe(false);
  });

  it("creating the file WITH an env block is idempotent too", async () => {
    const home = freshHome("grok-env-create");
    const { cfg } = grokDir("env-create");
    await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    const first = readFileSync(cfg, "utf8");
    const r2 = await install(cfg, home, { GESTALT_PASSPHRASE: "s3cret" });
    expect(readFileSync(cfg, "utf8")).toBe(first);
    expect(r2.writers[0]!.unchanged).toBe(true);
  });

  it("a CRLF config stays CRLF, siblings byte-identical, second run unchanged", async () => {
    const home = freshHome("grok-crlf");
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    const { cfg } = grokDir("crlf", crlf(OWNER_SHAPED));

    await install(cfg, home);
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(crlf(HEAD))).toBe(true);
    expect(after.endsWith(crlf(TAIL))).toBe(true);
    expect(/(?<!\r)\n/.test(after)).toBe(false); // not one lone LF anywhere
    expect(after.match(/^\[mcp_servers\.fimemory\]\r$/gm)).toHaveLength(1);

    const stamp = statSync(cfg).mtimeMs;
    const r2 = await install(cfg, home);
    expect(r2.writers[0]!.unchanged).toBe(true);
    expect(readFileSync(cfg, "utf8")).toBe(after);
    expect(statSync(cfg).mtimeMs).toBe(stamp);
  });
});

describe("install-mcp grok — what it writes is valid TOML, and a failed write is reported", () => {
  it("an env key that is not a bare TOML key is refused, never written", async () => {
    const home = freshHome("grok-badkey");
    const { cfg } = grokDir("badkey", OWNER_SHAPED);

    // `--env "GESTALT PASSPHRASE=hunter2"` — a shell-quoting slip. Writing
    // `GESTALT PASSPHRASE = "hunter2"` would be a syntax error that costs the
    // host the WHOLE file, sibling API keys included.
    const r = await install(cfg, home, { "GESTALT PASSPHRASE": "hunter2", "a.b": "y" });
    expect(r.warnings.filter((w) => w.code === "env_key_invalid")).toHaveLength(2);
    expect(r.serverEntry.env).toBeUndefined();

    const after = readFileSync(cfg, "utf8");
    expect(after).not.toContain("hunter2");
    expect(after).not.toContain("GESTALT PASSPHRASE");
    expect(after).not.toContain("[mcp_servers.fimemory.env]");
    expect(after).toContain('MESHY_API_KEY = "msy_supersecret_do_not_touch"');
  });

  it("a multi-line array is not mistaken for a table header (the file is still handled)", async () => {
    const home = freshHome("grok-array");
    const nested = [
      "[cli]",
      "matrix = [",
      '  ["a", "b"],',
      '  ["c", "d"],',
      "]",
      "",
      "",
    ].join("\n");
    const { cfg } = grokDir("array", nested + OLD_OURS + TAIL);

    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(true); // NOT refused as "could not be read as TOML"
    const after = readFileSync(cfg, "utf8");
    expect(after.startsWith(nested)).toBe(true); // the array came through verbatim
    expect(after.indexOf("[mcp_servers.fimemory]")).toBe(nested.length); // replaced in place
    expect(after.match(/^\[mcp_servers\.fimemory\]$/gm)).toHaveLength(1);
    expect(after.endsWith(TAIL)).toBe(true);
  });

  it("an unterminated array is refused rather than half-understood", async () => {
    const home = freshHome("grok-openarray");
    const source = '[cli]\nmatrix = [\n  "a",\n';
    const { cfg } = grokDir("openarray", source);
    const r = await install(cfg, home);
    expect(r.writers[0]!.wrote).toBe(false);
    expect(r.writers[0]!.note).toContain("could not be read as TOML");
    expect(readFileSync(cfg, "utf8")).toBe(source);
  });

  it("a host whose write throws is reported as one row, and later hosts still run", async () => {
    const home = freshHome("grok-throw");
    // A config PATH that is a directory: the read/write throws, which must not
    // escape installMcp — otherwise the user sees one error, no per-host report,
    // and grok (ordered after codex) is never attempted at all.
    const { dir: codexDir } = grokDir("throw-codex");
    const codexCfg = path.join(codexDir, "config.toml");
    mkdirSync(codexCfg, { recursive: true });
    const { cfg: grokCfg } = grokDir("throw-grok", "[cli]\nauto_update = true\n");

    const r = await installMcp({
      targets: ["codex", "grok"],
      codexConfigPath: codexCfg,
      grokConfigPath: grokCfg,
      cliPath: "/fake/cli.js",
      home,
    });
    expect(r.writers.map((w) => w.target)).toEqual(["codex", "grok"]);
    expect(r.writers[0]!.wrote).toBe(false);
    expect(r.writers[0]!.note).toContain("the write failed");
    // The point: grok was still attempted and still reported.
    expect(r.writers[1]!.wrote).toBe(true);
    expect(readFileSync(grokCfg, "utf8")).toContain("[mcp_servers.fimemory]");
  });
});

describe("install-mcp grok — the codex writer is the same writer", () => {
  it("codex and grok produce the same section from the same server entry", async () => {
    const home = freshHome("grok-parity");
    const { cfg: grokCfg } = grokDir("parity-grok", "[cli]\nauto_update = true\n");
    const { cfg: codexCfg } = grokDir("parity-codex", "[cli]\nauto_update = true\n");

    const r = await installMcp({
      targets: ["codex", "grok"],
      codexConfigPath: codexCfg,
      grokConfigPath: grokCfg,
      cliPath: "/fake/cli.js",
      home,
    });
    expect(r.writers.map((w) => w.target)).toEqual(["codex", "grok"]);
    expect(r.writers.every((w) => w.wrote)).toBe(true);
    expect(readFileSync(grokCfg, "utf8")).toBe(readFileSync(codexCfg, "utf8"));
  });
});
