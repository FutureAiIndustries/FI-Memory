import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { installMcp } from "../src/ops/installMcp.js";
import { handleRpc } from "../src/mcp/server.js";
import { ALLOWED_MCP_TOOLS, TOOLS } from "../src/mcp/tools.js";
import { recordServed, resetSession, sessionMeter } from "../src/session.js";
import { topicLogPath } from "../src/paths.js";
import { readIndex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";
import { countTokens } from "../src/tokens.js";
import { clockAt, freshHome, writeNote } from "./helpers.js";

function store(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

interface CallResult {
  result?: {
    content: { text: string }[];
    isError: boolean;
    structuredContent?: {
      warnings?: { id?: string; code: string; message: string }[];
      error?: { code: string; message: string; hint: string };
      tokensUsed?: number;
      deliveredTokens?: number;
      clamped?: boolean;
      hits?: { id: string; title: string; excerpt: string }[];
      topics?: { id: string; summary: string; body: string; logTail: string }[];
      topicCount?: number;
      pendingProposals?: number;
      budget?: { maxTokensPerGet: number; maxTopicsPerGet: number };
      [k: string]: unknown;
    };
  };
  error?: unknown;
}

async function call(home: string, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await handleRpc(home, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as CallResult;
}

describe("MCP protocol (SPEC §6)", () => {
  it("initialize returns protocol version, tool capability, serverInfo", async () => {
    const r = (await handleRpc(store(), {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    })) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe("fimemory");
  });

  it("notifications get no response", async () => {
    expect(await handleRpc(store(), { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("tools/list equals the frozen ALLOWED_MCP_TOOLS — and provably NOT the dangerous ones (#19)", async () => {
    const r = (await handleRpc(store(), { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
    };
    const names = r.result.tools.map((t) => t.name).sort();
    // Single source of truth: the frozen constant used by tools.ts itself.
    expect(names).toEqual([...ALLOWED_MCP_TOOLS].sort());
    // Every CLI-only surface from SPEC §6 must be absent (#13, extended list).
    for (const forbidden of [
      "fimemory_list",
      "fimemory_review",
      "fimemory_approve",
      "fimemory_reject",
      "fimemory_merge",
      "fimemory_reindex",
      "fimemory_pack",
      "fimemory_ingest",
      "fimemory_init",
      "fimemory_install_mcp",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // No force-create and no owner-notes override on the MCP surface.
    const create = r.result.tools.find((t) => t.name === "fimemory_create")!;
    expect(Object.keys(create.inputSchema.properties)).not.toContain("force");
    expect(Object.keys(create.inputSchema.properties)).not.toContain("new");
    const update = r.result.tools.find((t) => t.name === "fimemory_update")!;
    expect(Object.keys(update.inputSchema.properties)).not.toContain("allowOwnerNotes");
    // Input limits are declared in the schema (#3).
    const getTool = r.result.tools.find((t) => t.name === "fimemory_get")!;
    const ids = getTool.inputSchema.properties["ids"] as { maxItems?: number };
    expect(ids.maxItems).toBe(3);
    const tail = getTool.inputSchema.properties["logTail"] as { type?: string; maximum?: number };
    expect(tail.type).toBe("integer");
    expect(tail.maximum).toBeGreaterThan(0);
  });

  it("tools/call with an unknown/forbidden tool → JSON-RPC error", async () => {
    const r = (await handleRpc(store(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fimemory_list", arguments: {} },
    })) as { error?: { code: number } };
    expect(r.error?.code).toBe(-32602);
  });

  it("descriptions carry the usage policy", () => {
    const search = TOOLS.find((t) => t.name === "fimemory_search")!;
    expect(search.description.toLowerCase()).toContain("search first");
    const update = TOOLS.find((t) => t.name === "fimemory_update")!;
    expect(update.description.toLowerCase()).toContain("approve");
  });
});

describe("MCP tool behavior", () => {
  it("fimemory_get budget is reported and warnings are in the payload", async () => {
    const home = store();
    const r = await call(home, "fimemory_get", { ids: ["gestalt-example", "ghost"] });
    expect(r.result!.content[0]!.text).toContain("read budget");
    expect(r.result!.content[0]!.text).toContain('dropped "ghost"'); // warning surfaced in the payload
  });

  // THE DEFAULT IS THE PRODUCT, for every host that is not Claude Code.
  //
  // Until 2026-08-01 `fimemory_get` passed `logTail: rawTail ?? 0`, so a bare
  // call — which is what Cursor, Grok, Codex and Gemini send — returned the
  // curated note and NO log entries, while the tool's own description promised
  // "curated note + recent log". A note body changes only when the owner
  // approves a proposal; `appendLog` never touches it. So the default served
  // the slowest-moving half of a topic and hid the fastest.
  //
  // Claude Code was insulated because it reads through the retrieval hook,
  // which calls `brief` and has always defaulted to 8 with the log first. That
  // asymmetry is why this survived: it was invisible on the one host the owner
  // uses daily.
  it("a BARE fimemory_get returns log entries, above the body, without being asked", async () => {
    const home = store();
    await createTopic(home, "deploys", "Deploy order", { now: clockAt(1e12) });
    await appendLog(home, "deploys", {
      type: "decision", project: "fi", summary: "Pricing page ships before the blog post", agent: "test",
    }, { now: clockAt(1e12 + 1000) });
    await appendLog(home, "deploys", {
      type: "decision", project: "fi", summary: "Reversed: blog first, pricing needs legal review", agent: "test",
    }, { now: clockAt(1e12 + 2000) });

    // No logTail argument at all. This is the call every non-Claude host makes.
    const r = await call(home, "fimemory_get", { ids: ["deploys"] });
    const text = r.result!.content[0]!.text;

    // The reversal is the whole point: under the old default it was invisible,
    // so an agent would confidently restate a decision the user had reversed.
    expect(text).toContain("Pricing page ships before the blog post");
    expect(text).toContain("Reversed: blog first");

    // Ordering is load-bearing, not cosmetic. A model reading top-down must
    // meet the fresher material first, and be told which side wins.
    expect(text).toContain("Recent log (prefer when newer than body)");
    expect(text.indexOf("Recent log")).toBeLessThan(text.indexOf("Note body"));

    // And the budget still holds, which is why 0 was never worth defending.
    expect(text).toContain("read budget");
  });

  it("logTail: 0 is still honoured, for a caller that genuinely wants the note alone", async () => {
    const home = store();
    await createTopic(home, "quiet", "Quiet", { now: clockAt(1e12) });
    await appendLog(home, "quiet", {
      type: "decision", project: "fi", summary: "an entry that must NOT appear", agent: "test",
    }, { now: clockAt(1e12 + 1000) });

    const r = await call(home, "fimemory_get", { ids: ["quiet"], logTail: 0 });
    const text = r.result!.content[0]!.text;
    expect(text).not.toContain("an entry that must NOT appear");
    expect(text).not.toContain("Recent log");
  });

  it("fimemory_update never overrides owner notes (isError, no CLI override on MCP)", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    const note: TopicNote = {
      id: "alpha", title: "Alpha", aliases: [], tags: [], projects: [],
      updated: "2026-07-11T00:00:00.000Z", compactedThrough: null, mergedInto: null,
      body: "\nnew summary.\n\n## Owner notes\nagent tried to rewrite this\n",
    };
    const r = await call(home, "fimemory_update", { id: "alpha", note: serializeNote(note) });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0]!.text).toContain("Owner notes");
  });

  // A THOUSAND round trips through the real MCP server. Vitest's default budget
  // is 5 s, which is not a tight budget for this test, it is a wrong one: the
  // work is legitimately long and the default was never chosen for it.
  //
  // Measured 2026-08-01: under a full parallel suite this timed out on the
  // owner's own Windows box while passing 26/26 when run alone, and it was the
  // third different file to do that in one day (always exactly one, always a
  // timeout, never an assertion). A CI runner is slower and noisier than that
  // box, so the same shape would land on every leg, unpredictably, and a
  // pipeline that is red for a non-reason teaches you to stop reading it.
  //
  // Per-test rather than a global testTimeout on purpose. Raising the default
  // everywhere would hide a genuine hang in some other file; naming the budget
  // here says "this one test is legitimately slow" and leaves every other test
  // held to 5 s.
  it("break script #10: 1000× fimemory_get — meter counts, store consistent, no handle leak", { timeout: 120_000 }, async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    resetSession();
    for (let i = 0; i < 1000; i++) {
      const r = await call(home, "fimemory_get", { ids: ["alpha"] });
      expect(r.result!.isError).toBe(false);
    }
    expect(sessionMeter().topicsServed).toBe(1000);
    expect(sessionMeter().tokensServed).toBeGreaterThan(0);
    // Store still consistent after the hammering.
    expect((await readIndex(home))!.topics["alpha"]).toBeDefined();
  });
});

describe("Gate #2 fixes — budget, structure, behavior", () => {
  it("#1/#3: >3 ids is rejected at the tool boundary (no warning flood, no disk reads)", async () => {
    const home = store();
    const ids = ["gestalt-example", ...Array.from({ length: 100 }, (_, i) => `ghost-${i}`)];
    const r = await call(home, "fimemory_get", { ids });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.structuredContent!.error!.code).toBe("E_SCHEMA");
    // The rejection itself is tiny — no per-ghost warnings.
    expect(countTokens(r.result!.content[0]!.text)).toBeLessThan(100);
  });

  it("#1/#4/#12: 3 huge topics + logTail 50 → DELIVERED text ≤ the read budget", async () => {
    const home = store();
    const big = "\n" + "The quick brown fox jumps over the lazy dog. ".repeat(300);
    for (const id of ["big-one", "big-two", "big-three"]) writeNote(home, id, { body: big });
    const r = await call(home, "fimemory_get", { ids: ["big-one", "big-two", "big-three"], logTail: 50 });
    expect(r.result!.isError).toBe(false);
    const delivered = countTokens(r.result!.content[0]!.text);
    expect(delivered).toBeLessThanOrEqual(2000); // wrappers + warnings included (invariant 3)
    expect(r.result!.structuredContent!.deliveredTokens).toBe(delivered);
  });

  it("#2: warnings are structured (code/id/message) in structuredContent, not just prose", async () => {
    const home = store();
    const r = await call(home, "fimemory_get", { ids: ["gestalt-example", "ghost-topic"] });
    const warnings = r.result!.structuredContent!.warnings!;
    expect(warnings.some((w) => w.code === "E_NOT_FOUND" && w.id === "ghost-topic")).toBe(true);
  });

  it("#9: op errors carry structured {code,message,hint}", async () => {
    const home = store();
    const r = await call(home, "fimemory_log", { id: "nope", type: "decision", project: "p", summary: "x" });
    expect(r.result!.isError).toBe(true);
    const e = r.result!.structuredContent!.error!;
    expect(e.code).toBe("E_NOT_FOUND");
    expect(e.hint.length).toBeGreaterThan(0);
  });

  it("fimemory_log declares refs in its schema (maxItems 8) and required is unchanged", () => {
    const log = TOOLS.find((t) => t.name === "fimemory_log")!;
    const props = log.inputSchema["properties"] as Record<string, unknown>;
    const refs = props["refs"] as { type?: string; maxItems?: number; items?: { type?: string } };
    expect(refs.type).toBe("array");
    expect(refs.items?.type).toBe("string");
    expect(refs.maxItems).toBe(8);
    // v1 refs are FILE refs only — the description must not promise topic ids,
    // entry timestamps, or ref-based retrieval (the grammar freezes at first drop).
    expect(String((refs as { description?: string }).description)).toContain("repo#path");
    expect(log.inputSchema["required"]).toEqual(["id", "type", "project", "summary"]);
  });

  it("fimemory_log forwards refs to the write path, filtering non-strings", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const r = await call(home, "fimemory_log", {
      id: "topic-a",
      type: "decision",
      project: "p",
      summary: "with refs",
      refs: ["nexus#src/daemon.ts@4d9ed49", 42, null, "~deadbeef:/tmp/x"], // junk filtered
    });
    expect(r.result!.isError).toBe(false);
    const { entries } = parseLog((await readText(topicLogPath(home, "topic-a")))!);
    expect(entries[0]!.refs).toEqual(["nexus#src/daemon.ts@4d9ed49", "~deadbeef:/tmp/x"]);
  });

  it("fimemory_log surfaces the assertAppendable ref gate (mem: reserved, E_SCHEMA)", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const r = await call(home, "fimemory_log", {
      id: "topic-a",
      type: "decision",
      project: "p",
      summary: "x",
      refs: ["mem:topic@2026-01-01T00:00:00.000Z"],
    });
    expect(r.result!.isError).toBe(true);
    const e = r.result!.structuredContent!.error!;
    expect(e.code).toBe("E_SCHEMA");
    expect(e.message).toContain("reserved for future store-internal addresses");
  });

  it("#13: a smuggled force:true is ignored — collision still rejected", async () => {
    const home = store();
    await createTopic(home, "auth-patterns", "Auth", { now: clockAt(1e12) });
    const r = await call(home, "fimemory_create", {
      id: "authentication-patterns",
      title: "Auth2",
      force: true, // not in the schema; must never be read
    });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.structuredContent!.error!.code).toBe("E_ALIAS_COLLISION");
  });

  it("#13: a smuggled allowOwnerNotes:true is ignored — owner-notes edit still refused", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    const note: TopicNote = {
      id: "alpha", title: "Alpha", aliases: [], tags: [], projects: [],
      updated: "2026-07-11T00:00:00.000Z", compactedThrough: null, mergedInto: null,
      body: "\nbody.\n\n## Owner notes\nrewritten by a sneaky agent\n",
    };
    const r = await call(home, "fimemory_update", {
      id: "alpha",
      note: serializeNote(note),
      allowOwnerNotes: true, // not in the schema; must never be read
    });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.structuredContent!.error!.code).toBe("E_OWNER_NOTES");
  });

  it("#3 (verifier catch): a traversal-shaped id is rejected before any path join", async () => {
    const home = store();
    // Would resolve to <home>/proposals/1-gestalt-example.md via path.join if unguarded.
    const r = await call(home, "fimemory_get", { ids: ["../proposals/1-gestalt-example"] });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.structuredContent!.error!.code).toBe("E_SCHEMA");
    expect(r.result!.content[0]!.text).not.toContain("seq:"); // no proposal content leaked
    // Same via compact and update: E_INVALID_ID from the op's guard.
    const c = await call(home, "fimemory_compact", { id: "../proposals/1-gestalt-example" });
    expect(c.result!.isError).toBe(true);
    expect(c.result!.structuredContent!.error!.code).toBe("E_INVALID_ID");
    const l = await call(home, "fimemory_log", { id: "../logs/gestalt-example.log", type: "decision", project: "p", summary: "x" });
    expect(l.result!.isError).toBe(true);
    expect(l.result!.structuredContent!.error!.code).toBe("E_INVALID_ID");
  });

  it("#17: a non-integer logTail is rejected with a clear error", async () => {
    const home = store();
    const r = await call(home, "fimemory_get", { ids: ["gestalt-example"], logTail: "5" });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0]!.text).toContain("whole number");
  });

  it("#5: the compact description discloses the budget exception", () => {
    const compactTool = TOOLS.find((t) => t.name === "fimemory_compact")!;
    expect(compactTool.description).toContain("larger than the fold budget");
    expect(compactTool.description).toContain("Prefer fimemory_get");
  });

  it("#6/#14: fimemory_status shows the frozen soft-warn once past 50k session tokens", async () => {
    const home = store();
    resetSession();
    recordServed(0, 60_000);
    const r = await call(home, "fimemory_status");
    expect(r.result!.content[0]!.text).toContain("read");
    expect(r.result!.structuredContent!["softWarning"]).toBeDefined();
    resetSession();
  });
});

describe("HS3 — read tools carry the payload in structuredContent, not just meters", () => {
  // Regression for the "stripped read" defect: a client that surfaces
  // structuredContent over content[].text (e.g. Claude Code) saw only
  // counts/meters — never the hits or the note body — while the read budget was
  // still charged. The payload must ride in structuredContent too (SPEC §6 is a
  // floor); the human text stays intact for CLI/Grok (which read content[].text).

  it("fimemory_search: structuredContent.hits is the actual hits (id/title/excerpt), not a bare count", async () => {
    const home = store();
    await createTopic(home, "widget-config", "Widget Configuration", { now: clockAt(1e12) });
    const r = await call(home, "fimemory_search", { query: "widget" });
    const hits = r.result!.structuredContent!.hits;
    // The pre-fix bug shipped `hits: <number>` — assert it is now the item array.
    expect(Array.isArray(hits)).toBe(true);
    const hit = hits!.find((h) => h.id === "widget-config");
    expect(hit).toBeDefined();
    expect(hit!.title).toBe("Widget Configuration");
    expect(typeof hit!.excerpt).toBe("string");
    // CLI/Grok path (content[].text) still shows the same hit.
    expect(r.result!.content[0]!.text).toContain("widget-config");
  });

  it("fimemory_get: structuredContent.topics carries the note body, not just tokensUsed/clamped", async () => {
    const home = store();
    writeNote(home, "widget-notes", {
      title: "Widget Notes",
      body: "\nAardvarks assemble at the widget factory before dawn.\n\n## Owner notes\n",
    });
    const r = await call(home, "fimemory_get", { ids: ["widget-notes"] });
    const topics = r.result!.structuredContent!.topics;
    expect(Array.isArray(topics)).toBe(true);
    expect(topics).toHaveLength(1);
    expect(topics![0]!.id).toBe("widget-notes");
    expect(topics![0]!.summary).toContain("widget-notes");
    // The body — the whole point — is present, not an empty read.
    expect(topics![0]!.body).toContain("Aardvarks assemble at the widget factory");
    // Meters are still present (SPEC §6 floor), and the CLI/Grok text still has the body.
    expect(typeof r.result!.structuredContent!.tokensUsed).toBe("number");
    expect(r.result!.content[0]!.text).toContain("Aardvarks assemble at the widget factory");
  });

  it("fimemory_status: structuredContent carries the numeric store facts it prints", async () => {
    const home = store();
    await createTopic(home, "some-topic", "Some Topic", { now: clockAt(1e12) });
    const r = await call(home, "fimemory_status");
    const sc = r.result!.structuredContent!;
    expect(typeof sc.topicCount).toBe("number");
    expect(sc.topicCount).toBeGreaterThanOrEqual(1);
    expect(typeof sc.pendingProposals).toBe("number");
    expect(sc.budget!.maxTokensPerGet).toBe(2000); // frozen default (SPEC §5.9)
    expect(sc.budget!.maxTopicsPerGet).toBe(3);
    // Human text still prints the store line for CLI/Grok.
    expect(r.result!.content[0]!.text).toContain("Topics:");
  });
});

describe("install-mcp (SPEC §5.1, rev 6)", () => {
  it("merges into an existing Claude Desktop config without clobbering other servers", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "claude_desktop_config.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }), "utf8");

    const r = await installMcp({ targets: ["claude-desktop"], desktopConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    expect(r.writers[0]!.wrote).toBe(true);
    const written = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers["fimemory"]).toBeDefined();
    expect(written.mcpServers["other"]).toBeDefined(); // preserved
  });

  it("#11: the written server entry pins the store home with an explicit --home", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "mcp.json");
    const r = await installMcp({ targets: ["cursor"], cursorConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    expect(r.serverEntry.args).toContain("--home");
    expect(r.serverEntry.args[r.serverEntry.args.indexOf("--home") + 1]).toBe(dir);
    const written = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: { fimemory: { args: string[] } } };
    expect(written.mcpServers.fimemory.args).toContain("--home");
  });

  it("cursor / gemini / windsurf writers merge like desktop", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const r = await installMcp({
      targets: ["cursor", "gemini", "windsurf"],
      cursorConfigPath: join(dir, "cursor.json"),
      geminiConfigPath: join(dir, "gemini.json"),
      windsurfConfigPath: join(dir, "windsurf.json"),
      cliPath: "/fake/cli.js",
      home: dir,
    });
    expect(r.writers).toHaveLength(3);
    for (const w of r.writers) {
      expect(w.wrote).toBe(true);
      const written = JSON.parse(readFileSync(w.path, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(written.mcpServers["fimemory"]).toBeDefined();
    }
  });

  it("codex writer emits TOML, appends without clobbering, and replaces its own section idempotently", async () => {
    const dir = freshHome();
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, '[model]\nname = "o5"\n', "utf8");

    const r1 = await installMcp({ targets: ["codex"], codexConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    expect(r1.writers[0]!.wrote).toBe(true);
    const t1 = readFileSync(cfg, "utf8");
    expect(t1).toContain('[model]'); // preserved
    expect(t1).toContain("[mcp_servers.fimemory]");
    expect(t1).toContain('"--home"');

    // Re-run: replaces the gestalt section, doesn't duplicate it.
    await installMcp({ targets: ["codex"], codexConfigPath: cfg, cliPath: "/fake/cli.js", home: dir });
    const t2 = readFileSync(cfg, "utf8");
    expect(t2.match(/\[mcp_servers\.fimemory\]/g)).toHaveLength(1);
  });

  it("#18: the claude-code command quotes every token", async () => {
    // Use a POSIX absolute path with spaces — Windows-drive paths are not
    // path.isAbsolute on Linux, and phase2's detectExecutionContext resolves
    // non-absolute inputs, which would rewrite a "C:\..." test fixture.
    const r = await installMcp({
      targets: ["claude-code"],
      cliPath: "/fake dir/cli.js",
      home: "/fake dir/.gestalt",
    });
    expect(r.claudeCode!.command).toMatch(/"([A-Za-z]:)?[\\/]fake dir[\\/]cli\.js"/);   // Windows resolves the fake POSIX path with backslashes — quoting is what #18 tests, not separators
    expect(r.claudeCode!.command).toContain('"mcp"');
    expect(r.claudeCode!.command).toMatch(/"([A-Za-z]:)?[\\/]fake dir[\\/]\.gestalt"/);
    expect(r.claudeCode!.command).toContain('"--home"');
    expect(r.warnings.some((w) => w.code === "not_built")).toBe(true);
  });
});
