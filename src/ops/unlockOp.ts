/**
 * In-process store unlock — for long-lived hosts (Harness daemon) that must
 * hold the DEK across many ledger writes (WS-3 store-as-bus × E2d encryption).
 *
 * Mirrors the CLI unlock path (cli.ts): session-key cache → GESTALT_KEY →
 * GESTALT_PASSPHRASE / explicit passphrase. Idempotent when already unlocked.
 */
import { readEnv } from "../brand.js";
import { loadConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import { storePaths } from "../paths.js";
import {
  activateDek,
  clearActiveKey,
  keyState,
} from "../store/codec.js";
import {
  assertEnvKeyMatchesStore,
  keyringExists,
  storeHasSealedContent,
  unlockWithPassphrase,
} from "../store/keyring.js";
import {
  readSessionCache,
  wipeSessionCache,
  writeSessionCache,
} from "../sessionKeyCache.js";

export interface UnlockOptions {
  /** Explicit passphrase (takes precedence over env). */
  passphrase?: string;
  /** Env to read GESTALT_PASSPHRASE / GESTALT_KEY from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The one "nothing to try" message — exported so the MCP gate can tell "no
 * key source exists" apart from "a key source exists but does not open the
 * store" (wrong passphrase, missing keyring) and report the real cause instead
 * of masking every failure as generic-locked. */
export const NO_KEY_AVAILABLE_MESSAGE =
  "This store is encrypted but no key is set.";

export interface UnlockResult {
  /** True if the store uses at-rest encryption. */
  encrypted: boolean;
  /** True if a DEK is active after this call (or was already). */
  unlocked: boolean;
  /** How the DEK was obtained (for logs — never includes the key). */
  source?: "already" | "cache" | "env-key" | "passphrase" | "plaintext";
}

/**
 * Ensure the process-local codec has a DEK for `home` if the store is encrypted.
 * No-op for plaintext stores. Throws GestaltError(E_STORE_MODE) when encrypted
 * and no passphrase/key is available.
 */
export function ensureStoreUnlocked(
  home: string,
  opts: UnlockOptions = {},
): UnlockResult {
  const env = opts.env ?? process.env;
  const encrypted = keyringExists(home) || storeHasSealedContent(home);
  if (!encrypted) {
    return { encrypted: false, unlocked: true, source: "plaintext" };
  }

  // Already warm in this process (daemon re-entry).
  if (keyState().mode === "encrypted" && keyState().dek) {
    return { encrypted: true, unlocked: true, source: "already" };
  }

  const { config } = loadConfig(storePaths(home).config);
  const ttlMs = config.sessionKeyCacheTtlHours * 3_600_000;

  if (env["GESTALT_KEY"]) {
    const hex = env["GESTALT_KEY"].trim();
    assertEnvKeyMatchesStore(home, hex);
    // Always activate: keyState() reads process.env, but the daemon may pass a
    // custom parentEnv — activateDek is the process-local source of truth.
    activateDek(Uint8Array.from(Buffer.from(hex, "hex")));
    return { encrypted: true, unlocked: true, source: "env-key" };
  }

  if (!keyringExists(home)) {
    throw new GestaltError(
      "E_STORE_MODE",
      "This store is encrypted but keyring.json is missing.",
      `Recover with your phrase: fimemory recover --mnemonic "..." --passphrase "<new>"`,
    );
  }

  // Session cache (same as CLI — skip Argon2 when warm).
  if (ttlMs > 0 && opts.passphrase === undefined) {
    const cachedHex = readSessionCache(home, Date.now(), { ttlMs });
    if (cachedHex) {
      try {
        assertEnvKeyMatchesStore(home, cachedHex);
        activateDek(Uint8Array.from(Buffer.from(cachedHex, "hex")));
        return { encrypted: true, unlocked: true, source: "cache" };
      } catch {
        clearActiveKey();
        wipeSessionCache(home);
      }
    }
  }

  const passphrase = opts.passphrase ?? readEnv("PASSPHRASE", env);
  if (passphrase === undefined || passphrase === "") {
    throw new GestaltError(
      "E_STORE_MODE",
      NO_KEY_AVAILABLE_MESSAGE,
      `Set GESTALT_PASSPHRASE in the Harness daemon env (or pass a passphrase), then restart.`,
    );
  }

  const dek = unlockWithPassphrase(home, passphrase);
  activateDek(dek);
  if (ttlMs > 0) {
    try {
      writeSessionCache(home, dek, ttlMs);
    } catch {
      /* best-effort */
    }
  }
  return { encrypted: true, unlocked: true, source: "passphrase" };
}
