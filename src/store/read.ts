import { promises as fsp } from "node:fs";
import { GestaltError } from "../errors.js";
import { fsPath } from "../paths.js";
import { decryptFile } from "./codec.js";

/** A store-mode/key mismatch is a hard config error, not a tolerable partial read. */
function rethrowIfModeError(err: unknown): void {
  if (err instanceof GestaltError && err.code === "E_STORE_MODE") throw err;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lock-free tolerant read + parse (SPEC §1): read the file and parse it; if it
 * parses to null (a partial/half-written file), retry once after 50 ms; if it
 * still fails, return null so the caller can skip it with a warning. A missing
 * file returns null immediately (nothing to retry).
 */
export async function readParsed<T>(
  filePath: string,
  parse: (text: string) => T | null,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      // Decode through the storage codec (E0: identity). A decrypt failure on an
      // encrypted store throws here and is treated exactly like an unreadable
      // file: it routes to the retry-once-then-skip-with-warning path below.
      text = decryptFile(filePath, await fsp.readFile(fsPath(filePath), "utf8"));
    } catch (err) {
      rethrowIfModeError(err); // encrypted-without-key must fail loud, not skip
      return null; // missing/unreadable/undecryptable — not a partial-write race
    }
    const parsed = parse(text);
    if (parsed !== null) return parsed;
    if (attempt === 0) await sleep(50);
  }
  return null;
}

/** Plain tolerant read (no parse); null if unreadable. Decodes through the codec (E0: identity). */
export async function readText(filePath: string): Promise<string | null> {
  try {
    return decryptFile(filePath, await fsp.readFile(fsPath(filePath), "utf8"));
  } catch (err) {
    rethrowIfModeError(err);
    return null;
  }
}
