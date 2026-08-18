import { promises as fsp } from "node:fs";
import path from "node:path";
import { GestaltError } from "../errors.js";
import { fsPath } from "../paths.js";
import { encryptFile } from "./codec.js";

/**
 * Write durability under Windows reader contention (found 2026-07-28).
 *
 * ## Tradeoffs (picked before implementing)
 *
 * The product premise is many AI tools sharing ONE store. On Windows a rename
 * over a file another process holds open fails with EPERM, and Node's default
 * opens do not grant FILE_SHARE_DELETE, so sustained peer readers can starve a
 * writer. Retry tuning already went 150 ms → ~2.5 s and was still not enough:
 * the write returned E_LOCKED and nothing above the store lock retried, so the
 * intended mutation was lost from the caller's point of view.
 *
 * Options considered:
 *
 * (a) Read path opens with FILE_SHARE_DELETE (native/FFI). Correct for *our*
 *     readers; renames can proceed while peers read. Needs Windows-only FFI or
 *     a native binding; does not help antivirus/editors that open without
 *     share-delete. Deferred — right fix for our own readers later.
 *
 * (b) Writers that never rename over live files (write-new + pointer swap, or
 *     true append-only hot files). Solves the root cause for the layout it
 *     covers, but a pointer-swap layout breaks the plain-file editor story for
 *     notes (SPEC invariant 1), and true append only helps logs (notes/index
 *     still rewrite). Too invasive for this lane.
 *
 * (c) Read-side retry / never hold long. Store reads are already open-read-
 *     close; hold time is microseconds. Not the bottleneck under many tools.
 *
 * (d) Write path treats rename contention as a DELAY, not a drop. Bytes live
 *     in the same-dir temp file until rename succeeds; the call blocks up to a
 *     deadline, then fails loudly if a holder never lets go. Minimum bar:
 *     a write is never silently lost. Pure TypeScript; does not touch the
 *     encryption codec path.
 *
 * ## Choice: (d)
 *
 * Deadline-based rename wait (~30 s of jittered backoff). Under sustained
 * reader pressure the write is delayed until a gap appears; under a permanent
 * holder it still fails with E_LOCKED and leaves the original file untouched.
 * The encryption path is unchanged: content is still codec-encoded before the
 * temp file is written.
 */
/** How long a rename may wait for peer readers / AV to release the target. */
export const RENAME_WAIT_MS = 30_000;
const RENAME_BACKOFF_MS = 20;
/**
 * Cap the exponential backoff LOW, because the thing being waited out is short.
 *
 * A peer holding this file open is doing a read measured in single-digit
 * milliseconds; the file is free far more of the time than not. With the cap at
 * 400 ms the ladder settled into sampling ~2.5 times a second, so a rename could
 * burn its whole 30 s budget having tried only a couple of dozen times — asleep
 * through most of the gaps it was waiting for. Measured on a borderline case:
 * `renameAttempts: [1, 24, 1, 1, 1]`, i.e. four writes landed first try and the
 * one that missed got 24 samples out of 30 seconds.
 *
 * At 25 ms the same budget buys well over a thousand samples, which converts
 * borderline hard failures into short delays. That matters most for
 * `index.json`, the hottest file in the store and the precondition for D9's
 * "saved but unfindable" window (see ops/create.ts).
 *
 * Not lowered further: below ~10 ms the retries stop being cheap relative to
 * the syscall, and under TOTAL handle occupancy no polling rate wins anyway —
 * that case is D8, and it is not solvable from this constant.
 */
const RENAME_BACKOFF_CAP_MS = 25;

let tmpCounter = 0;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write a STORE file atomically, through the storage codec: temp-file-in-same-dir,
 * fsync, → rename, fsync dir (SPEC §1). A crash mid-write can never leave a
 * partially written target, and the fsyncs make it durable across host power
 * loss too — not just process crashes (#23). On Windows, a rename blocked by a
 * peer reader or antivirus (`EPERM`/`EACCES`/`EBUSY`) is retried with jittered
 * backoff until `RENAME_WAIT_MS` elapses, then fails with `E_LOCKED`. Directory
 * fsync is best-effort (Windows may reject it).
 *
 * Store files ONLY — everything written here is classified by the codec, and an
 * unrecognized path is classified "other", which IS whole-file encrypted (fail
 * closed). For files that are not part of the store, use `writeFileAtomicPlain`.
 */
export async function writeFileAtomic(
  target: string,
  content: string,
): Promise<void> {
  // Encode through the storage codec (E0: identity) BEFORE the temp file is
  // written, so an encrypted store's temp file never holds plaintext.
  await writeFileAtomicPlain(target, encryptFile(target, content));
}

/**
 * Same atomic temp+fsync+rename mechanics as `writeFileAtomic`, but withOUT the
 * storage codec — the bytes given are the bytes written.
 *
 * For files that are NOT part of the store: host app config files written by
 * `install-mcp` (Claude Desktop / Cursor / Gemini / Windsurf / Codex), which the
 * user's client owns and must always be able to read. Routing those through the
 * codec encrypted them the moment a key was active, breaking the client.
 *
 * Do NOT use this for store files: it would silently bypass at-rest encryption,
 * which is exactly the class of bug the codec's fail-closed default guards.
 */
export async function writeFileAtomicPlain(
  target: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(target);
  // Create the parent if it is missing. This is not defensive padding: GIT DOES
  // NOT TRACK EMPTY DIRECTORIES, so a store cloned before it ever logged
  // anything arrives on the second machine with no `logs/` at all. The temp file
  // this write depends on then fails with a raw ENOENT on a path the user never
  // typed. Found by a two-machine probe whose store was minimal; every fixture
  // built by `fimemory init` has the directory already and cannot reach it.
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.tmp-${process.pid}-${tmpCounter++}`,
  );

  // Preserve the target's existing permissions, and create new files owner-only.
  //
  // This matters because the write is temp-plus-rename, so whatever mode the
  // TEMP file has becomes the target's mode. Opening the temp without a mode
  // meant a user who had deliberately chmod 600'd a config file had it silently
  // widened back to 0644 by any of our install commands. That is a bad thing to
  // do to anyone's file, and worse here specifically: this is the sole writer
  // for every AI-tool config we touch, install-mcp copies environment values
  // into those files in plaintext, and cli.ts documents
  // `--env-passthrough GESTALT_PASSPHRASE` as the recipe for an encrypted
  // store. Following our own instructions could put a store passphrase in a
  // file every local account could read.
  //
  // Preserve rather than force: a user who wants 0644 keeps it. Only the
  // default for a file we are creating is ours to choose, and that default is
  // 0600. mode is inert on Windows; this is for POSIX.
  let existingMode: number | null = null;
  try {
    existingMode = (await fsp.stat(fsPath(target))).mode & 0o777;
  } catch {
    /* target does not exist yet — we are creating it, so 0600 stands */
  }

  const handle = await fsp.open(fsPath(tmp), "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (existingMode !== null) {
    try {
      await fsp.chmod(fsPath(tmp), existingMode);
    } catch {
      /* unsupported here (Windows) — the 0600 the temp was opened with stands */
    }
  }

  await renameWithRetry(tmp, target);

  // Persist the directory entry so the rename survives power loss (best-effort).
  try {
    const dirHandle = await fsp.open(fsPath(dir), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* directory fsync unsupported here (common on Windows) — best effort */
  }
}

/**
 * Rename with deadline-based retry. The temp file holds the write intent for
 * the whole wait: success lands it, timeout leaves the original untouched and
 * removes the temp. Never returns success without the new bytes at `to`.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const deadline = Date.now() + RENAME_WAIT_MS;
  let attempt = 0;
  let permissionChecked = false;

  for (;;) {
    try {
      await fsp.rename(fsPath(from), fsPath(to));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === "EPERM" || code === "EACCES" || code === "EBUSY";

      // EPERM/EACCES has a second, PERMANENT cause: the target is marked
      // read-only (Windows `attrib +R`, or POSIX permissions). Waiting 30 s per
      // file for a holder to let go is the wrong diagnosis — and the multi-host
      // rules sweep would do it once per host, up to 2.5 minutes of silence,
      // before blaming "another program is holding the file open". Check once,
      // and fail immediately naming the real cause.
      if (retriable && !permissionChecked && code !== "EBUSY") {
        permissionChecked = true;
        // Deliberately the stat mode bit, not `access(W_OK)`: this must fire
        // ONLY for a file explicitly marked non-writable. Node reports 0o444 on
        // Windows exactly when FILE_ATTRIBUTE_READONLY is set, and stat opens
        // with FILE_READ_ATTRIBUTES + full sharing, so a peer reader holding
        // the file cannot make a contended write look like a permission
        // failure. Anything unclear falls through to the normal retry wait.
        let targetReadOnly = false;
        try {
          targetReadOnly = ((await fsp.stat(fsPath(to))).mode & 0o200) === 0;
        } catch {
          /* gone or unstattable — not our case, keep retrying */
        }
        if (targetReadOnly) {
          try {
            await fsp.unlink(fsPath(from));
          } catch {
            /* ignore */
          }
          throw new GestaltError(
            "E_IO",
            `Cannot replace ${to} (${code}): the file is not writable — on Windows that is usually the read-only attribute, on macOS/Linux the file's permissions or owner.`,
            "Clear the read-only flag (`attrib -R <file>`) or fix the permissions (`chmod u+w <file>`), then re-run.",
          );
        }
      }

      if (!retriable) {
        try {
          await fsp.unlink(fsPath(from));
        } catch {
          /* ignore */
        }
        throw err;
      }

      const failedWith = code ?? "EPERM";
      const now = Date.now();
      if (now >= deadline) {
        try {
          await fsp.unlink(fsPath(from));
        } catch {
          /* ignore */
        }
        throw new GestaltError(
          "E_LOCKED",
          `Could not replace ${to} (${failedWith}) after waiting ${RENAME_WAIT_MS} ms for the file to be free. Another program is holding the file open: on Windows that is usually a second copy of a tool reading this store, or a virus scanner.`,
          "Close extra tools connected to this store (each one holds it open), then retry. `fimemory doctor` lists what it can see.",
        );
      }

      // Exponential with jitter, capped — and never sleep past the deadline.
      const base = Math.min(RENAME_BACKOFF_MS * 2 ** Math.min(attempt, 12), RENAME_BACKOFF_CAP_MS);
      const jittered = base / 2 + Math.random() * (base / 2);
      const sleepMs = Math.min(jittered, Math.max(0, deadline - now));
      attempt += 1;
      if (sleepMs > 0) await sleep(sleepMs);
    }
  }
}
