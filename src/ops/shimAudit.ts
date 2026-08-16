import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldPathForFs } from "../fsCase.js";

/**
 * Shim audit + per-session inject state (F-struct).
 *
 * Lives OUTSIDE the store home — same out-of-store surface as last-read
 * telemetry — so reads/injects never dirty the git-synced store. Best-effort:
 * a write failure never fails the inject that succeeded.
 *
 * Audit answers doctor's "has the shim ever injected?" question:
 *   lastShimAt, lastInjectAt, lastInjectTopics, lastSkippedReason, lastDurationMs.
 *
 * Session state tracks topic ids already injected this session so the same
 * topic is not re-injected every turn (spam + budget burn).
 */

export type ShimSkipReason =
  | "empty"
  | "short"
  | "locked"
  | "timeout"
  | "error"
  | "budget"
  | "floor"
  | "already-injected"
  | "session-budget"
  /** Machine-generated prompt (control-tag envelope or non-human source). */
  | "non-human";

export interface ShimAudit {
  v: 1;
  home: string;
  lastShimAt: string | null;
  lastInjectAt: string | null;
  lastInjectTopics: string[];
  lastSkippedReason: ShimSkipReason | null;
  lastDurationMs: number | null;
  /**
   * A session id, or one of a few fixed markers describing why a capture was
   * skipped. NEVER user content.
   *
   * This replaced a field called `lastQuery`, and the rename is the point. The
   * old name invited prompt text, and it got it: two call sites fed it a slice
   * of the user's prompt and a third fed the full expanded search query, so a
   * diagnostic file ended up holding what the user typed. Nothing read it. If
   * you are about to put anything here that a user wrote, don't.
   */
  lastSessionRef: string | null;
  lastTokens: number | null;
  /** Session ids already captured (session-end capture v1 dedupe). Cap kept small. */
  capturedSessionIds?: string[];
  lastCaptureAt?: string | null;
  lastCaptureSessionId?: string | null;
  lastCaptureSeq?: number | null;
}

const MAX_CAPTURED_SESSION_IDS = 64;

export interface ShimSessionState {
  v: 1;
  sessionId: string;
  home: string;
  injectedTopics: string[];
  injectTokensUsed: number;
  injectCount: number;
  updatedAt: string;
}

/** Absolute, case-folded WHEN THE FILESYSTEM FOLDS CASE — not when the platform
 * is Windows, which is what this said before and which splits one macOS store
 * across two audit files (APFS folds case; doctor would then report "the shim
 * has never injected" about a store it had been writing all along). See
 * src/fsCase.ts. Also used for the inside-the-store refusal below, where the
 * same question decides whether a path IS the store home. */
function normalizeHome(home: string): string {
  return foldPathForFs(path.resolve(home));
}

function digestHome(home: string): string {
  return createHash("sha256").update(normalizeHome(home), "utf8").digest("hex").slice(0, 32);
}

/** Same dir tree as last-read telemetry, sibling files. */
export function shimStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GESTALT_TELEMETRY_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "gestalt", "telemetry");
  }
  const cache = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cache, "gestalt", "telemetry");
}

export function shimAuditPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(shimStateDir(env), `${digestHome(home)}.shim.json`);
}

export function shimSessionPath(
  home: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return path.join(shimStateDir(env), `${digestHome(home)}.session-${safe}.json`);
}

function refuseIfInsideStore(home: string, target: string): boolean {
  const homeKey = normalizeHome(home);
  const targetKey = normalizeHome(target);
  const homePrefix = homeKey.endsWith(path.sep) ? homeKey : homeKey + path.sep;
  return targetKey === homeKey || targetKey.startsWith(homePrefix);
}

function writeJsonBestEffort(target: string, home: string, data: unknown): void {
  try {
    if (refuseIfInsideStore(home, target)) return;
    // Owner-only, matching telemetry.ts, which writes into this same directory.
    // Without an explicit mode the file lands 0644 and, when the shim creates
    // the directory first, the directory lands 0755. mode is a no-op on
    // Windows, which is why this went unnoticed here.
    //
    // This audit no longer records any prompt text. It used to keep a lastQuery
    // field, which cli.ts fed a prompt prefix and brief.ts fed the full expanded
    // search query — so despite the 80-character slice at two of the three call
    // sites, the field was never actually bounded. Removed rather than
    // truncated: nothing in doctor's output needed it, and a diagnostic file
    // that holds what the user typed is not worth the disclosure it forces.
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(`${target}.tmp-${process.pid}`);
    } catch {
      /* ignore */
    }
  }
}

export function readShimAudit(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): ShimAudit | null {
  try {
    const raw = readFileSync(shimAuditPath(home, env), "utf8");
    const j = JSON.parse(raw) as ShimAudit;
    if (j?.v !== 1) return null;
    return j;
  } catch {
    return null;
  }
}

export function recordShimAudit(
  home: string,
  patch: {
    durationMs: number;
    topics?: string[];
    skippedReason?: ShimSkipReason | null;
    /** Session id or fixed marker. Never user content. See ShimAudit.lastSessionRef. */
    sessionRef?: string;
    tokens?: number;
    injected?: boolean;
  },
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const prev = readShimAudit(home, env);
  const ts = new Date(now).toISOString();
  const injected = Boolean(patch.injected && (patch.topics?.length ?? 0) > 0);
  const next: ShimAudit = {
    v: 1,
    home: normalizeHome(home),
    lastShimAt: ts,
    lastInjectAt: injected ? ts : (prev?.lastInjectAt ?? null),
    lastInjectTopics: injected ? (patch.topics ?? []) : (prev?.lastInjectTopics ?? []),
    lastSkippedReason: injected ? null : (patch.skippedReason ?? "empty"),
    lastDurationMs: patch.durationMs,
    lastSessionRef: patch.sessionRef ?? prev?.lastSessionRef ?? null,
    lastTokens: injected ? (patch.tokens ?? null) : (prev?.lastTokens ?? null),
    // Preserve capture fields across retrieve/capture audit writes.
    capturedSessionIds: prev?.capturedSessionIds ?? [],
    lastCaptureAt: prev?.lastCaptureAt ?? null,
    lastCaptureSessionId: prev?.lastCaptureSessionId ?? null,
    lastCaptureSeq: prev?.lastCaptureSeq ?? null,
  };
  writeJsonBestEffort(shimAuditPath(home, env), home, next);
}

/** True when session-end capture already produced a proposal for this session. */
export function hasCapturedSession(
  home: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!sessionId) return false;
  const audit = readShimAudit(home, env);
  return Boolean(audit?.capturedSessionIds?.includes(sessionId));
}

/** Record a successful session-end capture (dedupe + doctor last-capture). */
export function markSessionCaptured(
  home: string,
  sessionId: string,
  seq: number,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!sessionId) return;
  const prev = readShimAudit(home, env);
  const ts = new Date(now).toISOString();
  const ids = [...(prev?.capturedSessionIds ?? [])];
  if (!ids.includes(sessionId)) ids.push(sessionId);
  while (ids.length > MAX_CAPTURED_SESSION_IDS) ids.shift();
  const next: ShimAudit = {
    v: 1,
    home: normalizeHome(home),
    lastShimAt: prev?.lastShimAt ?? ts,
    lastInjectAt: prev?.lastInjectAt ?? null,
    lastInjectTopics: prev?.lastInjectTopics ?? [],
    lastSkippedReason: prev?.lastSkippedReason ?? null,
    lastDurationMs: prev?.lastDurationMs ?? null,
    lastSessionRef: prev?.lastSessionRef ?? null,
    lastTokens: prev?.lastTokens ?? null,
    capturedSessionIds: ids,
    lastCaptureAt: ts,
    lastCaptureSessionId: sessionId,
    lastCaptureSeq: seq,
  };
  writeJsonBestEffort(shimAuditPath(home, env), home, next);
}

export function readShimSession(
  home: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): ShimSessionState | null {
  if (!sessionId) return null;
  try {
    const raw = readFileSync(shimSessionPath(home, sessionId, env), "utf8");
    const j = JSON.parse(raw) as ShimSessionState;
    if (j?.v !== 1 || j.sessionId !== sessionId) return null;
    return j;
  } catch {
    return null;
  }
}

export function writeShimSession(
  home: string,
  state: ShimSessionState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  writeJsonBestEffort(shimSessionPath(home, state.sessionId, env), home, state);
}

export function markTopicsInjected(
  home: string,
  sessionId: string,
  topics: string[],
  tokens: number,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!sessionId || topics.length === 0) return;
  const prev = readShimSession(home, sessionId, env);
  const set = new Set(prev?.injectedTopics ?? []);
  for (const t of topics) set.add(t);
  writeShimSession(
    home,
    {
      v: 1,
      sessionId,
      home: normalizeHome(home),
      injectedTopics: [...set],
      injectTokensUsed: (prev?.injectTokensUsed ?? 0) + tokens,
      injectCount: (prev?.injectCount ?? 0) + 1,
      updatedAt: new Date(now).toISOString(),
    },
    env,
  );
}
