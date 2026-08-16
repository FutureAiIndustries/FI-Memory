import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fsPath, storePaths } from "../paths.js";

/**
 * Per-clone replica id (gitignored). Used so proposal seqs are collision-free
 * across machines the same way ledger seqs are (machineId:seq).
 *
 * 8 hex chars: short enough for filenames, long enough that two clones of the
 * same store almost never collide. Derived once, then sticky on disk.
 */
const MACHINE_ID_RE = /^[a-f0-9]{8}$/;

export function machineIdPath(home: string): string {
  return path.join(storePaths(home).home, "machine-id");
}

export function loadOrCreateMachineId(home: string): string {
  const p = machineIdPath(home);
  if (existsSync(fsPath(p))) {
    try {
      const raw = readFileSync(fsPath(p), "utf8").trim().toLowerCase();
      if (MACHINE_ID_RE.test(raw)) return raw;
    } catch {
      /* fall through and rewrite */
    }
  }
  // Mix hostname entropy with random so two clones on one box still diverge.
  const host = hostname().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  const rnd = randomBytes(4).toString("hex");
  // Prefer pure random 8 hex; hostname is only a salt for the first nibble mix.
  const id = (host + rnd).replace(/[^a-f0-9]/g, "").slice(0, 8).padEnd(8, "0").slice(0, 8);
  // If host contributed non-hex, just use random.
  const finalId = MACHINE_ID_RE.test(id) ? id : randomBytes(4).toString("hex");
  try {
    mkdirSync(fsPath(storePaths(home).home), { recursive: true });
    writeFileSync(fsPath(p), finalId + "\n", "utf8");
  } catch {
    /* best-effort — still return a stable-for-this-process id */
  }
  return finalId;
}
