import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { handleRpc } from "../src/mcp/server.js";
import { wipeSessionCache, writeSessionCache } from "../src/sessionKeyCache.js";
import { clearActiveKey } from "../src/store/codec.js";
import { unlockWithPassphrase } from "../src/store/keyring.js";
import { freshHome, tsxEntry, writeNote } from "./helpers.js";

/**
 * GRACEFUL LOCKED MCP (trust surface): a LOCKED encrypted store must not kill
 * the server at spawn. The server starts, lists tools, and every tool call
 * returns a structured E_LOCKED naming the exact fixes — and because the
 * unlock chain is retried lazily PER CALL, a session cache warmed from a
 * terminal recovers the server WITHOUT a client restart.
 */

const TINY = { name: "argon2id", m: 256, t: 1, p: 1 } as const;
const PASS = "a perfectly sturdy passphrase";
const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function lockedStore(label: string): string {
  const home = freshHome(label);
  runInit({ home, encrypted: true, passphrase: PASS, argon2: TINY, allowWeakParams: true });
  clearActiveKey(); // init unlocked this process — a locked store means NO in-process key
  wipeSessionCache(home); // and no warm cache
  return home;
}

/** Run `fn` with ambient credentials stripped — an inherited GESTALT_PASSPHRASE
 * on the dev machine would silently unlock what the test needs locked. */
async function withoutAmbientKeys<T>(fn: () => Promise<T>): Promise<T> {
  const savedPass = process.env.GESTALT_PASSPHRASE;
  const savedKey = process.env.GESTALT_KEY;
  delete process.env.GESTALT_PASSPHRASE;
  delete process.env.GESTALT_KEY;
  try {
    return await fn();
  } finally {
    if (savedPass !== undefined) process.env.GESTALT_PASSPHRASE = savedPass;
    if (savedKey !== undefined) process.env.GESTALT_KEY = savedKey;
    clearActiveKey();
  }
}

interface CallResult {
  result?: {
    content: { text: string }[];
    isError: boolean;
    structuredContent?: { error?: { code: string; message: string; hint: string } };
  };
}

async function call(home: string, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await handleRpc(home, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as CallResult;
}

describe("locked MCP — in-process (mock client through handleRpc)", () => {
  it("tools/list works while locked; every tool call is E_LOCKED naming the three fixes", async () => {
    await withoutAmbientKeys(async () => {
      const home = lockedStore("mcplock-list");
      const list = (await handleRpc(home, { jsonrpc: "2.0", id: 0, method: "tools/list" })) as {
        result: { tools: unknown[] };
      };
      expect(list.result.tools.length).toBe(7); // the surface is visible while locked

      for (const name of ["fimemory_status", "fimemory_search"]) {
        const r = await call(home, name, name === "fimemory_search" ? { query: "x" } : {});
        expect(r.result!.isError).toBe(true);
        const err = r.result!.structuredContent!.error!;
        expect(err.code).toBe("E_LOCKED");
        expect(err.hint).toContain("GESTALT_PASSPHRASE");
        expect(err.hint).toContain("fimemory unlock");
        expect(err.hint).toContain("fimemory lock --status");
      }
    });
  });

  it("recovers WITHOUT restart once the session cache is warmed (lazy per-call retry)", async () => {
    await withoutAmbientKeys(async () => {
      const home = lockedStore("mcplock-recover");
      const locked = await call(home, "fimemory_status");
      expect(locked.result!.isError).toBe(true);
      expect(locked.result!.structuredContent!.error!.code).toBe("E_LOCKED");

      // A terminal-side `fimemory unlock` — modeled directly: derive + cache.
      const dek = unlockWithPassphrase(home, PASS);
      writeSessionCache(home, dek, 3_600_000);
      clearActiveKey(); // the SERVER process still holds nothing — recovery must come from the cache

      const warmed = await call(home, "fimemory_status");
      expect(warmed.result!.isError).toBe(false);
      expect(warmed.result!.content[0]!.text).toContain("Topics:");
    });
  });

  it("a WRONG GESTALT_PASSPHRASE is named as the cause, not masked as 'no key available'", async () => {
    await withoutAmbientKeys(async () => {
      const home = lockedStore("mcplock-wrongpass");
      process.env.GESTALT_PASSPHRASE = "definitely not the passphrase";
      try {
        const r = await call(home, "fimemory_status");
        expect(r.result!.isError).toBe(true);
        const err = r.result!.structuredContent!.error!;
        expect(err.code).toBe("E_LOCKED"); // still the one structured locked code…
        expect(err.message).toContain("Wrong passphrase"); // …but the REAL cause is named
        expect(err.message).not.toContain("no key is available"); // never the misleading generic
        expect(err.hint).toContain("fimemory unlock"); // the fixes stay named
      } finally {
        delete process.env.GESTALT_PASSPHRASE;
      }
    });
  });

  it("a plaintext store passes the gate untouched", async () => {
    await withoutAmbientKeys(async () => {
      const home = freshHome("mcplock-plain");
      runInit({ home });
      writeNote(home, "plain-topic", { title: "Plain" });
      const r = await call(home, "fimemory_get", { ids: ["plain-topic"] });
      expect(r.result!.isError).toBe(false);
    });
  });
});

describe("locked MCP — the real spawned server (stdio)", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it(
    "spawns against a LOCKED store, answers tools/list + E_LOCKED calls, then recovers after a cache warm — one process the whole way",
    async () => {
      const home = lockedStore("mcplock-spawn");
      child = spawn(process.execPath, [TSX, CLI, "mcp", "--home", home], {
        env: { ...process.env, GESTALT_PASSPHRASE: "", GESTALT_KEY: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const proc = child;

      const lines: string[] = [];
      let buffered = "";
      let notify: (() => void) | undefined;
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line) lines.push(line);
        }
        notify?.();
      });
      const exited = new Promise<number | null>((resolve) => {
        proc.on("exit", (code) => {
          notify?.();
          resolve(code);
        });
      });
      let dead = false;
      void exited.then(() => {
        dead = true;
      });

      const nextLine = async (): Promise<string> => {
        const deadline = Date.now() + 60_000;
        while (lines.length === 0) {
          if (dead) throw new Error("server process died — exactly what graceful-locked forbids");
          if (Date.now() > deadline) throw new Error("timed out waiting for a server response");
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, 250);
          });
        }
        return lines.shift()!;
      };
      const send = (msg: object): void => {
        proc.stdin.write(JSON.stringify(msg) + "\n");
      };

      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      const init = JSON.parse(await nextLine()) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("fimemory"); // it SPAWNED — no exit(1)

      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = JSON.parse(await nextLine()) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.length).toBe(7);

      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fimemory_status", arguments: {} } });
      const locked = JSON.parse(await nextLine()) as {
        result: { isError: boolean; structuredContent: { error: { code: string; hint: string } } };
      };
      expect(locked.result.isError).toBe(true); // a structured tool error…
      expect(locked.result.structuredContent.error.code).toBe("E_LOCKED");
      expect(locked.result.structuredContent.error.hint).toContain("fimemory unlock");
      expect(dead).toBe(false); // …not process death

      // Warm the cache from OUTSIDE the server (what `fimemory unlock` does in a
      // terminal) — the running server must pick it up on the next call.
      const dek = unlockWithPassphrase(home, PASS);
      writeSessionCache(home, dek, 3_600_000);
      clearActiveKey();

      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fimemory_status", arguments: {} } });
      const warmed = JSON.parse(await nextLine()) as { result: { isError: boolean } };
      expect(warmed.result.isError).toBe(false); // recovered WITHOUT restart

      proc.stdin.end();
      expect(await exited).toBe(0);
    },
    120_000,
  );
});
