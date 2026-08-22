import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_KEY } from "../brand.js";
import { TOOL_NAMES, TOOLS, callTool } from "./tools.js";
import type { HomeSource } from "../paths.js";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * This build's version, read once from the package that shipped it. Reported
 * in serverInfo so a user can tell which build their AI tool is talking to;
 * previously hardcoded "0.0.0", which told them nothing.
 */
let cachedVersion: string | null = null;
function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = "unknown";
  try {
    // dist/mcp/server.js → dist/mcp → dist → package root
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version) cachedVersion = pkg.version;
  } catch {
    /* packaged oddly or unreadable — "unknown" is honest, and never fatal */
  }
  return cachedVersion;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function result(id: unknown, res: unknown): object {
  return { jsonrpc: "2.0", id, result: res };
}
function rpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message (SPEC §6, MCP over stdio). Returns the response
 * object, or null for notifications. Pure w.r.t. I/O so the mock-client tests
 * can drive it directly. Tool results carry `structuredContent` with
 * `warnings[]` / `error {code,message,hint}` alongside the human text
 * (SPEC §5.8 — warnings live in the JSON payload itself).
 */
export async function handleRpc(
  home: string,
  msg: JsonRpcMessage,
  homeSource?: HomeSource,
): Promise<object | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (typeof method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid request");
  }
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const v = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return result(id, {
        protocolVersion: typeof v === "string" ? v : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        // What the user's AI tool DISPLAYS for this connection. The name
        // matches the server key we write into host config files, so what a
        // client reports and what is in the config agree. Renamed with the
        // rest of the public surface on 2026-08-06 (see brand.ts). The version
        // was hardcoded 0.0.0, so every client showed a nonsense version and
        // no one could tell which build they were talking to — read it from
        // the package instead.
        serverInfo: { name: MCP_SERVER_KEY, version: packageVersion() },
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name || !TOOL_NAMES.has(p.name)) {
        return rpcError(id, -32602, `Unknown tool: ${p.name ?? "(none)"}`);
      }
      const r = await callTool(home, p.name, p.arguments ?? {}, homeSource);
      const res: Record<string, unknown> = {
        content: [{ type: "text", text: r.text }],
        isError: r.isError,
      };
      if (r.structured) res["structuredContent"] = r.structured;
      return result(id, res);
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Run the stdio JSON-RPC loop (newline-delimited messages). Tool calls may
 * compute concurrently, but replies go through one ordered writer — a single
 * queue guarantees FIFO, non-interleaved responses on stdout (Gate #2 #8;
 * JSON-RPC correlates by id, so ordering is a robustness guarantee, not a
 * correctness requirement).
 */
export function runStdioServer(home: string, homeSource?: HomeSource): void {
  let buffer = "";
  const pending = new Set<Promise<void>>();
  let writeChain: Promise<void> = Promise.resolve();

  const writeLine = (line: string): Promise<void> => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          process.stdout.write(line + "\n", () => resolve());
        }),
    );
    return writeChain;
  };

  const track = (line: string): void => {
    const p = processLine(home, line, writeLine, homeSource).finally(() => pending.delete(p));
    pending.add(p);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) track(line);
    }
  });
  process.stdin.on("end", () => {
    // Drain the last buffered line + any in-flight tool calls + the write queue
    // before exiting, so a request right before EOF isn't dropped.
    void (async () => {
      const last = buffer.trim();
      if (last) track(last);
      await Promise.allSettled([...pending]);
      await writeChain;
      process.exit(0);
    })();
  });
}

async function processLine(
  home: string,
  line: string,
  writeLine: (line: string) => Promise<void>,
  homeSource?: HomeSource,
): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    await writeLine(JSON.stringify(rpcError(null, -32700, "Parse error")));
    return;
  }
  const response = await handleRpc(home, msg, homeSource);
  if (response) await writeLine(JSON.stringify(response));
}
