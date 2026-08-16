import { promises as fsp } from "node:fs";
import { GestaltError } from "../errors.js";
import { assertValidId } from "../id.js";
import { fsPath, topicNotePath } from "../paths.js";
import { keyState } from "../store/codec.js";
import { decodeForExport, OPEN_IT_HINT } from "./exportDecode.js";

export interface CatResult {
  id: string;
  /** The note's full text, decoded — exactly the bytes a text editor would show. */
  text: string;
}

/**
 * `cat <id>` — print one topic's note, decoded, to stdout. The single-topic
 * companion to `export --plaintext` (ENCRYPTION-BUILD-PLAN E2b): when the store
 * is encrypted you can no longer `cat ~/.gestalt/topics/foo.md` and see your own
 * note, so the runtime hands it back. Debug/inspection surface for the human.
 *
 * **CLI-only** (SPEC §5.1/§6). Unlike `get` it charges no read budget and does
 * not clamp or truncate — the same unbudgeted read a human performs by opening
 * the file, sanctioned by invariant §0.1 and therefore emphatically *not* an
 * agent surface: no `ALLOWED_MCP_TOOLS` entry reaches it. (`readNoteFull` in
 * index.ts is the harness's separately-registered HS3 §4.4 equivalent; this one
 * serves the CLI and shares only the store-layer read.)
 *
 * Decodes through `decodeForExport` — THE decode contract it shares with its
 * sibling `export --plaintext` (ops/exportDecode.ts), so the two ownership
 * commands speak identical FACTS and can never drift (Grok review, 2026-07-16).
 * It used to call the codec's `decryptFile` directly, which made cat the last
 * surface that could deliver the store layer's cause-naming refusals: a RENAMED
 * sealed note (the AEAD's aad binds the basename; §0.1 sanctions the rename)
 * drew "wrong key or tampered data", a git-CONFLICTED sealed note was
 * misreported as "found plaintext", and a plaintext note in an encrypted store
 * was REFUSED outright while export happily exported it. Now: sealed notes that
 * open print; proven-plaintext notes print verbatim; everything else is the same
 * factual refusal export gives — no cause, no verdict on the key, and still no
 * ciphertext on stdout.
 *
 * Reads the file directly rather than through the tolerant `readText`, which
 * collapses every failure to null: that made an EACCES/EBUSY/EISDIR (a Windows
 * antivirus or indexer holding the file open is routine — `store/atomic.ts`
 * already retries for exactly this) report `E_NOT_FOUND` "No topic <id>" for a
 * note that plainly EXISTS. Telling someone their memory is gone when it is
 * merely locked is the worst answer this command could give. Absent and
 * unreadable are now distinct (`E_NOT_FOUND` vs `E_IO`).
 */
export async function catNote(home: string, id: string): Promise<CatResult> {
  assertValidId(id); // traversal guard — never join a path with an unvalidated id
  const notePath = topicNotePath(home, id);
  let raw: string;
  try {
    raw = await fsp.readFile(fsPath(notePath), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new GestaltError(
        "E_NOT_FOUND",
        `No topic "${id}".`,
        `fimemory list   # see existing topics`,
      );
    }
    throw new GestaltError(
      "E_IO",
      `Topic "${id}" exists but could not be read (${code ?? "unknown error"}).`,
      `Close whatever is holding ${notePath} (an editor, antivirus, or file indexer) and retry: gestalt cat ${id}`,
    );
  }
  try {
    return { id, text: decodeForExport("note", keyState().mode, notePath, raw) };
  } catch (err) {
    if (err instanceof GestaltError) {
      // The contract's fact, re-anchored to cat's subject: export prefixes the
      // same fragment with "could not include <rel> —" and appends "Not in this
      // export." — cat names the topic instead. The facts are identical; only
      // the frame differs. The E_NOT_FOUND/E_IO distinction above is untouched.
      // The HINT is re-anchored too: the contract's own next step ends in
      // "re-run: fimemory export --plaintext …", which is the wrong advice
      // inside cat — the reader ran cat, so the retry it names is cat, on the
      // file cat was asked about. Any other hint passes through untouched.
      const said = err.message.replace(/\s*\.\s*$/, "");
      const hint =
        err.hint === OPEN_IT_HINT
          ? `Open ${notePath} in a text editor to see what is in it, then re-run: gestalt cat ${id}`
          : err.hint;
      throw new GestaltError(err.code, `Topic "${id}" could not be printed — ${said}.`, hint);
    }
    throw err;
  }
}
