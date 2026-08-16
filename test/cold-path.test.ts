import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { seedAfterInit } from "../src/ops/seed.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * THE STRANGER'S PATH (2026-07-28). Everything else in this suite runs inside
 * the repo, with the repo's aliases and the repo's assumptions. The first time
 * anyone actually packed the tarball, installed it into an empty directory and
 * ran it as a new user, it was broken in three separate ways: the CLI told the
 * user to run `gestalt` (a command they do not have), the MCP server announced
 * itself as version 0.0.0, and neither had a test that could notice.
 *
 * This walks the same path a stranger walks, in one process, in seconds:
 *   init a store  ->  spawn the real MCP server over stdio  ->  handshake  ->
 *   list tools  ->  search  ->  read a topic back.
 *
 * It deliberately does NOT npm-pack (minutes, and needs a network). The
 * packaging shape is covered by stage-export.test.ts; what is covered here is
 * that a freshly created store is actually USABLE by a connecting AI tool.
 */

const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));

interface Rpc {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** A live MCP server on a real store, driven exactly as a client would. */
class McpClient {
  private buffered = "";
  private readonly lines: string[] = [];
  private notify: (() => void) | undefined;
  private dead = false;
  private nextId = 0;

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      let nl: number;
      while ((nl = this.buffered.indexOf("\n")) !== -1) {
        const line = this.buffered.slice(0, nl).trim();
        this.buffered = this.buffered.slice(nl + 1);
        if (line) this.lines.push(line);
      }
      this.notify?.();
    });
    proc.on("exit", () => {
      this.dead = true;
      this.notify?.();
    });
  }

  private async nextLine(): Promise<string> {
    const deadline = Date.now() + 60_000;
    while (this.lines.length === 0) {
      if (this.dead) throw new Error("the MCP server exited: a client would see a dead connection");
      if (Date.now() > deadline) throw new Error("timed out waiting for the MCP server");
      await new Promise<void>((resolve) => {
        this.notify = resolve;
        setTimeout(resolve, 100);
      });
    }
    return this.lines.shift()!;
  }

  async call(method: string, params: unknown): Promise<Rpc> {
    const id = ++this.nextId;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (;;) {
      const msg = JSON.parse(await this.nextLine()) as Rpc;
      if (msg.id === id) return msg;
    }
  }

  notifyInitialized(): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
}

describe("the stranger's path: a fresh store is usable by a connecting AI tool", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("init, connect, list tools, search, and read a topic back", async () => {
    // 1. What `fimemory init` gives a new user: a store with starter topics.
    const home = freshHome("cold-path");
    runInit({ home });
    const seeded = await seedAfterInit(home, { encrypted: false });
    expect(seeded.seeded?.topics.length, "a new store must not be empty").toBeGreaterThan(0);

    // 2. Their AI tool launches the server exactly as the generated config does.
    child = spawn(process.execPath, [TSX, CLI, "mcp", "--home", home], {
      env: { ...process.env, GESTALT_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new McpClient(child);

    // 3. Handshake. The version it reports is what every client DISPLAYS, and
    //    it was hardcoded 0.0.0 until this was checked.
    const init = await client.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cold-path-test", version: "0" },
    });
    const serverInfo = init.result?.["serverInfo"] as { name?: string; version?: string } | undefined;
    expect(serverInfo?.name).toBeTruthy();
    const pkgVersion = (JSON.parse(readFileSync(PKG, "utf8")) as { version: string }).version;
    // The invariant is that the reported version is the REAL one, whatever it
    // is: this private repo is legitimately 0.0.0, while the export tree is
    // 0.1.0. The bug was a hardcoded literal that stayed 0.0.0 even in the
    // published build, so every client showed a version that meant nothing.
    expect(
      serverInfo?.version,
      "the server must report the build's real version, never a hardcoded literal",
    ).toBe(pkgVersion);
    client.notifyInitialized();

    // 4. The tools an agent needs are actually offered.
    const tools = await client.call("tools/list", {});
    const names = ((tools.result?.["tools"] as { name: string }[]) ?? []).map((t) => t.name);
    for (const need of ["fimemory_search", "fimemory_get", "fimemory_log"]) {
      expect(names, `a connecting tool must be offered ${need}`).toContain(need);
    }

    // 5. THE CLAIM: search finds seeded content...
    const search = await client.call("tools/call", {
      name: "fimemory_search",
      arguments: { query: "getting started with your store" },
    });
    expect(search.error).toBeUndefined();
    const searchText = JSON.stringify(search.result);
    expect(searchText, "search must surface a seeded topic").toContain("getting-started");

    // 6. ...and the agent can read one back.
    const get = await client.call("tools/call", {
      name: "fimemory_get",
      arguments: { ids: ["getting-started"] },
    });
    expect(get.error).toBeUndefined();
    const gotText = JSON.stringify(get.result);
    expect(gotText).toContain("getting-started");
    expect(gotText.length, "a read must return a real body, not an empty shell").toBeGreaterThan(200);
  }, 120_000);

  it("the CLI never points a new user at a command the package does not install", () => {
    // The bin the package actually installs...
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { bin?: Record<string, string> };
    const bins = Object.keys(pkg.bin ?? {});
    expect(bins.length, "the package must install at least one command").toBeGreaterThan(0);

    // ...must be the one every hint names. In the private repo the bin is
    // `gestalt`; in the export tree it is `fimemory`. Either way the advice
    // has to match the package it ships in, which is what broke: the source
    // hardcoded `gestalt <verb>` while the export shipped `fimemory`.
    const seedSrc = readFileSync(
      fileURLToPath(new URL("../src/ops/seed.ts", import.meta.url)),
      "utf8",
    );
    const initSrc = readFileSync(
      fileURLToPath(new URL("../src/commands/init.ts", import.meta.url)),
      "utf8",
    );
    const cliSrc = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
    for (const [label, src] of [["seed", seedSrc], ["init", initSrc], ["cli", cliSrc]] as const) {
      const stale = /\bgestalt (?:list|get|review|search|log|init|doctor|unlock|status)\b/.exec(src);
      expect(
        stale?.[0] ?? null,
        `${label} still tells the user to run "${stale?.[0]}" — see src/brand.ts`,
      ).toBeNull();
    }
    void path;
  });
});
