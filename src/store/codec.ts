import { existsSync } from "node:fs";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, concatBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { GestaltError } from "../errors.js";

/**
 * Storage codec seam — the single choke point through which every store file
 * passes on its way to and from disk. When no key is configured it is the
 * IDENTITY codec: bytes are returned unchanged, on-disk files and every
 * plaintext test are byte-for-byte identical. When a key IS present it encrypts
 * at rest so a stolen `~/.gestalt` is inert, while the runtime still hands
 * decrypted plaintext to every consumer — so Nexus/the harness is unaffected.
 * See docs/ENCRYPTION-BUILD-PLAN.md and docs/ENCRYPTION-INVENTION-DISCLOSURE.md.
 *
 * Two codecs, by design (do not collapse into one):
 *  - Notes (`topics/*.md`) and the derived `index.json` are whole-file blobs →
 *    `encryptFile`/`decryptFile`, hooked at the file I/O boundary (store/atomic.ts
 *    write, store/read.ts read).
 *  - Logs (`logs/*.log.md`) are append-only and MUST stay line-oriented so git
 *    `merge=union` concatenates entries from two machines *without the key* →
 *    encoded PER-ENTRY via `encodeLogEntry`/`decodeLogEntry` inside store/log.ts.
 *    A DETERMINISTIC (synthetic-IV) nonce derived from the entry content makes
 *    identical entries produce identical byte-stable lines (so union-merge +
 *    dedupe converge). A plaintext, AEAD-authenticated ISO-timestamp prefix lets
 *    the store order/dedupe without decrypting.
 *  - Task ledgers (`ledgers/*.jsonl`) are the same dual-machine story: PER-LINE
 *    sealed via `encodeLedgerLine`/`decodeLedgerLine` (F3 / NEXUS-PHASE0-FINDINGS).
 *    Not whole-file — whole-file sealing would break `merge=union` concurrent
 *    appends. Identical event JSON → byte-stable sealed line.
 *
 * Stays plaintext on purpose: `config.json` (non-secret budgets, read before any
 * key is available) and `keyring.json` (holds the wrapped key). Proposals ARE
 * whole-file encrypted — they embed full note bodies (see proposals.ts).
 *
 * Deliberate at-rest leaks (documented; a key-less observer of the store learns):
 *  - EQUALITY of identical plaintext entries/notes (deterministic encryption),
 *    scoped per (topic, timestamp) for logs and per note-path for notes;
 *  - each log line's plaintext ISO-ms timestamp, the per-topic entry count, and
 *    the `# <id> log` topic-id header;
 *  - approximate plaintext SIZE (ciphertext is unpadded).
 * Everything else (entry/note bodies, index catalog) is confidential.
 *
 * FAIL-CLOSED: if on-disk content disagrees with the active mode (encrypted
 * content with no key, or plaintext content with a key), the codec THROWS
 * `E_STORE_MODE` rather than silently returning garbage — so a re-serialize can
 * never destroy data it merely could not decrypt.
 *
 * SPIKE-GRADE KEY HANDLING (E1): the data-encryption key (DEK) is a 32-byte hex
 * `GESTALT_KEY` env var. E2 replaces `keyState()` with real per-store key
 * management (keyring.json, Argon2id passphrase KDF, BIP39 recovery, OS
 * keychain, headless-server unlock, wipeable key buffers) — the codec below and
 * the on-disk format do not change.
 */

export type FileKind =
  | "note"
  | "log"
  | "ledger"
  | "proposal"
  | "index"
  | "marker"
  | "config"
  | "other";

export type StoreMode = "plaintext" | "encrypted";

export interface KeyState {
  mode: StoreMode;
  /** 32-byte data-encryption key; present only when mode === "encrypted". */
  dek?: Uint8Array;
  /** Sub-keys derived from the DEK (SIV key separation): nonce-PRF vs AEAD. */
  kNonce?: Uint8Array;
  kAead?: Uint8Array;
}

// Domain-separation labels for the two HKDF roles + per-codec nonce salts.
const SUBKEY_SALT = utf8ToBytes("gestalt/subkeys/v1");
const NONCE_SALT_LOG = utf8ToBytes("gestalt/log-nonce/v1");
const NONCE_SALT_FILE = utf8ToBytes("gestalt/file-nonce/v1");
const NONCE_SALT_LEDGER = utf8ToBytes("gestalt/ledger-nonce/v1");
const XNONCE_LEN = 24;
const ENC_MAGIC = "gestalt-enc:1:";
/** Exported for ledger readers that need to detect sealed lines. */
export const LEDGER_ENC_MAGIC = ENC_MAGIC;

/**
 * XChaCha20-Poly1305 authentication tag length (bytes). Every sealed frame is
 * `nonce(XNONCE_LEN) ‖ ciphertext ‖ tag(POLY1305_TAG_LEN)`; the cipher appends
 * the tag itself, so this constant exists ONLY to derive the sealed-token floor
 * below — it feeds no seal/open logic.
 */
const POLY1305_TAG_LEN = 16;

/**
 * The ONE source of truth for the minimum unpadded base64url token length a
 * sealed line/blob from THIS codec can carry — derived from and pinned to the
 * seal frame above, and consumed by BOTH the export decode contract
 * (`ops/exportDecode.ts`) and the store-mode GATE (`looksLikeEncryptedLog` in
 * store/log.ts, reached via `store/keyring.ts`). Before this constant existed
 * here the two layers each carried their own notion of the floor and DISAGREED:
 * export applied it, the gate did not, so a plaintext store whose first log
 * line was the canonized hand edit `2026-07-14T09:30:00.000Z deployed` (an
 * 8-char token) was read as encrypted and every CLI command died "This store is
 * encrypted but keyring.json is missing".
 *
 * Physics, not a guess: a seal is base64url(nonce ‖ ciphertext ‖ tag), so even
 * a ZERO-length plaintext still carries XNONCE_LEN + POLY1305_TAG_LEN = 40
 * bytes = 54 unpadded base64url chars. The suite pins this against the REAL
 * codec (it seals empty and one-byte payloads and asserts the minimum), so
 * codec drift fails loudly instead of silently hollowing out the floor.
 *
 * THE INVARIANT — the floor only ever asserts NOT-SEALED. A full sealed-shape
 * match whose token is SHORTER than the floor is provably not this codec's
 * output, so it is the user's own hand-typed text (§0.1). A token AT or ABOVE
 * the floor proves NOTHING — it is the same bytes a person may type, and in a
 * keyring-less store there is no AEAD to ask. Asserting SEALED from length is
 * the `proveLog` misuse that rounds 4–7 deleted; do not reintroduce it.
 */
export const SEALED_TOKEN_FLOOR = Math.ceil(((XNONCE_LEN + POLY1305_TAG_LEN) * 4) / 3);

// An unlocked DEK from the keyring (E2), plus a cache for the GESTALT_KEY path.
let activeState: KeyState | null = null;
let cachedKeyHex: string | undefined;
let cachedEnvState: KeyState = { mode: "plaintext" };

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Derive the AEAD/nonce sub-keys from a DEK (SIV key separation, RFC 5297 hygiene). */
function stateFromDek(dek: Uint8Array): KeyState {
  const kNonce = hkdf(sha256, dek, SUBKEY_SALT, utf8ToBytes("nonce"), 32);
  const kAead = hkdf(sha256, dek, SUBKEY_SALT, utf8ToBytes("aead"), 32);
  return { mode: "encrypted", dek, kNonce, kAead };
}

/**
 * Activate an unlocked DEK for this process — the keyring layer (store/keyring.ts)
 * calls this after a passphrase/recovery unlock. Takes precedence over
 * GESTALT_KEY. The codec just consumes the DEK; E2 owns how it's obtained.
 */
export function activateDek(dek: Uint8Array): void {
  if (dek.length !== 32) {
    throw new GestaltError("E_STORE_MODE", "DEK must be 32 bytes.", "Bug in the unlock path.");
  }
  activeState = stateFromDek(dek);
}

/** Clear any activated key (fall back to GESTALT_KEY env, else plaintext). */
export function clearActiveKey(): void {
  activeState = null;
}

/**
 * The store's encryption mode + keys. Precedence: an activated keyring DEK, then
 * a raw 32-byte hex `GESTALT_KEY` (tests/CI/power users), else plaintext.
 */
export function keyState(): KeyState {
  if (activeState) return activeState;
  const hex = process.env.GESTALT_KEY;
  if (!hex) {
    cachedKeyHex = undefined;
    cachedEnvState = { mode: "plaintext" };
    return cachedEnvState;
  }
  if (hex === cachedKeyHex) return cachedEnvState;
  const h = hex.trim();
  // Strict: reject anything but exactly 64 hex chars (Node's hex decoder would
  // otherwise silently truncate trailing junk to a valid-looking 32-byte key).
  if (!HEX64.test(h)) {
    throw new GestaltError(
      "E_STORE_MODE",
      "GESTALT_KEY must be exactly 64 hex characters (a 32-byte key).",
      "Set GESTALT_KEY to the store's 64-hex-character key, or unlock via passphrase.",
    );
  }
  cachedKeyHex = hex;
  cachedEnvState = stateFromDek(Uint8Array.from(Buffer.from(h, "hex")));
  return cachedEnvState;
}

/**
 * Classify a store path so the codec can dispatch by file kind (separator-agnostic).
 *
 * Classification looks ONLY at the file's own name and its IMMEDIATE parent
 * directory — never at the rest of the path. This used to substring-scan the
 * whole absolute path (`p.includes("/logs/")`), which meant a store whose home
 * merely CONTAINED a segment named logs/topics/proposals — `GESTALT_HOME` is
 * arbitrary and user-chosen (`~/Dropbox/logs/gestalt`, a headless-server path
 * with a `logs` segment) — misclassified every note and proposal as kind "log".
 * `isWholeFileEncrypted("log")` is false, so whole-file encryption was SILENTLY
 * DISABLED for them: `init --encrypted` reported success and wrote the keyring +
 * marker, while notes/proposals landed on disk as plaintext. The store layout is
 * exactly one level deep (`<home>/{topics,logs,proposals}/<id>.md`, ids are
 * `/^[a-z0-9-]{2,64}$/` — no separators), so the immediate parent segment IS the
 * store-relative leading segment, and no ancestor segment can ever be mistaken
 * for a store directory.
 */
export function fileKind(filePath: string): FileKind {
  const p = filePath.replace(/\\/g, "/");
  const cut = p.lastIndexOf("/");
  const base = p.slice(cut + 1);
  // The immediate parent directory's own name ("" for a bare filename).
  const dir = cut === -1 ? "" : p.slice(0, cut);
  const parent = dir.slice(dir.lastIndexOf("/") + 1);
  if (base === "index.json") return "index";
  // The store-mode marker (store.enc) is a whole-file sealed blob with fixed
  // known plaintext — the canonical DEK↔ciphertext oracle (store/keyring.ts).
  if (base === "store.enc") return "marker";
  // config.json + keyring.json + schema.json are never encrypted (budgets / the
  // wrapped key / plaintext format version) — classify as "config" so they can
  // never be routed through the codec. schema.json must stay readable without
  // a key so a cold client can refuse writes (Phase B).
  // `keyring-archived.json` is the keyring `fimemory decrypt` preserved so the
  // store can be re-locked later (ops/migrateDecrypt.ts). Same content class as
  // `keyring.json` — a WRAPPED key, never the key — so it gets the same
  // never-through-the-codec treatment. Classified here rather than left to fall
  // through to "other", which IS whole-file encrypted: a re-`encrypt` that
  // sealed it would make the archived keyring unopenable without the very key it
  // exists to recover, which is the one thing it must never become.
  if (
    base === "config.json" ||
    base === "keyring.json" ||
    base === "keyring-archived.json" ||
    base === "schema.json"
  ) {
    return "config";
  }
  if (base.endsWith(".log.md") || parent === "logs") return "log";
  // Task bus — line-oriented seal (not whole-file), so merge=union works across boxes.
  if (parent === "ledgers" && base.endsWith(".jsonl")) return "ledger";
  if (parent === "topics" && base.endsWith(".md")) return "note";
  if (parent === "proposals" && base.endsWith(".md")) return "proposal";
  return "other";
}

/**
 * Refuse a plaintext write into a store that is encrypted on disk.
 *
 * Derives the store home from the file's own path: the layout is exactly one
 * level deep (`<home>/{topics,logs,proposals,ledgers}/<id>.ext`), and
 * index.json / config.json / store.enc sit at the root, so the home is either
 * the parent or the grandparent. Cheap (one existsSync on a path we already
 * have) and only ever reached on the plaintext branch, so encrypted writes pay
 * nothing.
 */
function assertNotSealedStore(filePath: string): void {
  const p = filePath.replace(/\\/g, "/");
  const cut = p.lastIndexOf("/");
  if (cut === -1) return; // bare filename: no store to reason about
  const dir = p.slice(0, cut);
  const parent = dir.slice(dir.lastIndexOf("/") + 1);
  const home = ["topics", "logs", "proposals", "ledgers"].includes(parent)
    ? dir.slice(0, dir.lastIndexOf("/"))
    : dir;
  if (!home) return;
  // keyring.json present == this store was initialised encrypted. Its own
  // writes are classified "config" and never reach this branch.
  if (!existsSync(`${home}/keyring.json`)) return;
  throw new GestaltError(
    "E_STORE_MODE",
    `Refusing to write ${baseName(filePath)} as plaintext: this store is encrypted, but no key is active right now.`,
    "The key was cleared while this write was in flight (a lock, a failed unlock, or a concurrent recover). Unlock and retry — nothing was written.",
  );
}

/** Which kinds get whole-file encryption (fail closed on the unknown "other"). */
function isWholeFileEncrypted(kind: FileKind): boolean {
  // Proposals are sealed too — they embed the full current + proposed note body.
  // The marker is sealed under the DEK (its whole purpose is to be AEAD-openable).
  // Logs + ledgers are line-oriented (merge=union) — not whole-file.
  return kind === "note" || kind === "index" || kind === "proposal" || kind === "marker" || kind === "other";
}

/**
 * Would `encryptFile`/`decryptFile` treat this path as a WHOLE-FILE sealed blob?
 *
 * Exported for the migrations, which have to answer "is this a blob I can open
 * with `decryptFile`?" about arbitrary paths in a real store's tree. Answering it
 * by hand there means re-deriving this classification, and a copy that drifts
 * from the codec's own rule is how a sealed file gets carried into a store the
 * command just called plaintext (`decryptFile` is the IDENTITY for kinds it does
 * not seal, so a misclassified file "decrypts" to its own ciphertext).
 */
export function isWholeFileSealedPath(filePath: string): boolean {
  return isWholeFileEncrypted(fileKind(filePath));
}

function baseName(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** AAD for a whole-file blob, bound to its kind AND filename (topic/path pinning). */
function fileAad(kind: FileKind, filePath: string): Uint8Array {
  return utf8ToBytes(`gestalt/file/${kind}/${baseName(filePath)}`);
}

function toB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function fromB64Url(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64url"));
}

/** Length-framed PRF input: u32be(len(aad)) ‖ aad ‖ plaintext — injective in (aad, plaintext). */
function frameInfo(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, aad.length, false);
  return concatBytes(len, aad, plaintext);
}

/** Seal with a deterministic (synthetic-IV) nonce; returns nonce‖ct as bytes. */
function seal(
  state: KeyState,
  salt: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  // Synthetic IV: nonce = PRF(kNonce, framed(aad, plaintext)). Identical
  // (kNonce, aad, plaintext) → identical nonce → identical, byte-stable output
  // (what makes union-merge + dedupe converge). The nonce is stored (it can't
  // be recomputed on open without the plaintext). Framing makes the PRF input
  // injective, so two distinct (aad, plaintext) can never share a nonce.
  const nonce = hkdf(sha256, state.kNonce!, salt, frameInfo(aad, plaintext), XNONCE_LEN);
  const ct = xchacha20poly1305(state.kAead!, nonce, aad).encrypt(plaintext);
  return concatBytes(nonce, ct);
}

/** Inverse of seal: split stored nonce‖ct and AEAD-open (throws on tamper/wrong key). */
function open(state: KeyState, aad: Uint8Array, stored: Uint8Array): Uint8Array {
  const nonce = stored.subarray(0, XNONCE_LEN);
  const ct = stored.subarray(XNONCE_LEN);
  return xchacha20poly1305(state.kAead!, nonce, aad).decrypt(ct);
}

const modeMismatch = (msg: string, hint: string): GestaltError =>
  new GestaltError("E_STORE_MODE", msg, hint);

/**
 * Encrypt a whole-file blob on write (notes, the derived index, and any
 * unclassified store file — fail closed). Logs use the per-entry codec;
 * config stays plaintext; logs use the per-entry codec. Identity when no key.
 */
export function encryptFile(filePath: string, content: string): string {
  const state = keyState();
  if (state.mode === "plaintext") {
    // FAIL CLOSED (2026-07-28 contention audit, security). The DEK is
    // process-global mutable state, so anything that clears it mid-write —
    // `fimemory lock`, a failed unlock, a concurrent recover — used to make
    // this function silently degrade to the identity codec. A write already
    // in flight then landed CLEARTEXT in a store the user was told is
    // encrypted, reported success, and wedged the store (the next read fails
    // closed on the mode mismatch). Proven with index.json, whose topic ids,
    // titles, aliases, tags and timestamps all leaked at rest.
    //
    // If the store on disk says it is encrypted, refusing is the only safe
    // answer: better a failed write the caller can retry than plaintext at
    // rest plus an unreadable store.
    assertNotSealedStore(filePath);
    return content;
  }
  const kind = fileKind(filePath);
  if (!isWholeFileEncrypted(kind)) return content;
  const sealed = seal(state, NONCE_SALT_FILE, fileAad(kind, filePath), utf8ToBytes(content));
  return ENC_MAGIC + toB64Url(sealed) + "\n";
}

/** Inverse of `encryptFile` on read. Fail-closed on mode mismatch. Identity when no key. */
export function decryptFile(filePath: string, bytes: string): string {
  const state = keyState();
  const looksEncrypted = bytes.trimStart().startsWith(ENC_MAGIC);
  if (state.mode === "plaintext") {
    if (looksEncrypted) {
      throw modeMismatch(
        "This store is encrypted but no key is set.",
        "Set GESTALT_KEY to the store's key and retry.",
      );
    }
    return bytes;
  }
  const kind = fileKind(filePath);
  if (!isWholeFileEncrypted(kind)) return bytes; // logs (per-entry) / config
  const trimmed = bytes.trim();
  if (!trimmed.startsWith(ENC_MAGIC)) {
    throw modeMismatch(
      `Expected encrypted content in ${baseName(filePath)} but found plaintext.`,
      "This store looks plaintext; unset GESTALT_KEY or migrate it to encrypted.",
    );
  }
  // FAIL CLOSED on AEAD failure. A wrong key or tampered blob must be a hard,
  // surfaced error — NOT a generic throw that a tolerant reader turns into null
  // ("looks missing"), which would let a write path clobber unread ciphertext.
  let plain: Uint8Array;
  try {
    plain = open(state, fileAad(kind, filePath), fromB64Url(trimmed.slice(ENC_MAGIC.length)));
  } catch {
    throw modeMismatch(
      `Could not decrypt ${baseName(filePath)} — wrong key or tampered data.`,
      "Check that GESTALT_KEY is this store's key, and retry.",
    );
  }
  return bytesToUtf8(plain);
}

// A log-entry block always begins with `### <ISO-ts> | …`; pull the timestamp
// for the plaintext line prefix (metadata leak) and AEAD binding.
const TS_PREFIX_RE = /^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \| /;

/**
 * Encode ONE log entry block to a single on-disk line:
 *   `<plaintext-ISO-ts> <base64url(nonce ‖ AEAD(kAead, block, aad=topicId‖ts))>`
 * so the log file stays line-oriented (one entry per line) and git `merge=union`
 * concatenates cross-machine appends without the key. Identity when no key.
 */
export function encodeLogEntry(topicId: string, block: string): string {
  const state = keyState();
  if (state.mode === "plaintext") return block;
  const ts = block.match(TS_PREFIX_RE)?.[1];
  if (!ts) {
    // A block with no valid `### <ts> |` header is a bug (all entries are built
    // by formatEntryBlock). Fail rather than bucket everything under a sentinel ts.
    throw new Error("gestalt: cannot encode a log entry with no valid `### <ts> |` header");
  }
  // AEAD binds the entry to (topic, timestamp): the plaintext prefix can't be
  // forged and an entry can't be relocated to another topic's log undetected.
  const aad = utf8ToBytes(`${topicId}\n${ts}`);
  const sealed = seal(state, NONCE_SALT_LOG, aad, utf8ToBytes(block));
  return `${ts} ${toB64Url(sealed)}`;
}

/**
 * Inverse of `encodeLogEntry`: decode one stored line back to the plaintext
 * block. Throws on tamper / wrong key (the caller skips it with a warning).
 * Identity when no key is configured.
 */
export function decodeLogEntry(topicId: string, stored: string): string {
  const state = keyState();
  if (state.mode === "plaintext") return stored;
  const sp = stored.indexOf(" ");
  if (sp === -1) throw new Error("gestalt: malformed encrypted log line");
  const ts = stored.slice(0, sp);
  const aad = utf8ToBytes(`${topicId}\n${ts}`);
  return bytesToUtf8(open(state, aad, fromB64Url(stored.slice(sp + 1))));
}

/**
 * Seal ONE ledger event JSON line (F3). Deterministic AEAD → identical events
 * produce byte-stable on-disk lines so `merge=union` + idem-dedup converge
 * across machines without the hub holding the key. Identity when no key.
 */
export function encodeLedgerLine(jsonLine: string): string {
  const state = keyState();
  if (state.mode === "plaintext") return jsonLine;
  const plain = utf8ToBytes(jsonLine);
  const aad = utf8ToBytes("gestalt/ledger/line/v1");
  const sealed = seal(state, NONCE_SALT_LEDGER, aad, plain);
  return ENC_MAGIC + toB64Url(sealed);
}

/**
 * Inverse of `encodeLedgerLine`. Plain JSON lines (plaintext store or pre-F3
 * files) pass through. Throws on tamper / wrong key.
 */
export function decodeLedgerLine(stored: string): string {
  const state = keyState();
  const t = stored.trim();
  if (!t.startsWith(ENC_MAGIC)) return stored; // plaintext line
  if (state.mode === "plaintext") {
    throw modeMismatch(
      "This ledger line is encrypted but no key is set.",
      "Set GESTALT_KEY / unlock the store and retry.",
    );
  }
  const aad = utf8ToBytes("gestalt/ledger/line/v1");
  try {
    return bytesToUtf8(open(state, aad, fromB64Url(t.slice(ENC_MAGIC.length))));
  } catch {
    throw modeMismatch(
      "Could not decrypt a ledger line — wrong key or tampered data.",
      "Check that GESTALT_KEY is this store's key, and retry.",
    );
  }
}

/**
 * Open a LEGACY whole-file sealed ledger (pre-F3 line-seal: kind was "other").
 * Returns plaintext JSONL, or null if `bytes` is not a single whole-file blob.
 */
export function decryptLegacyWholeFileLedger(
  filePath: string,
  bytes: string,
): string | null {
  const state = keyState();
  if (state.mode === "plaintext") return null;
  const lines = bytes.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 1 || !lines[0]!.startsWith(ENC_MAGIC)) return null;
  const token = lines[0]!.slice(ENC_MAGIC.length);
  // Historical AAD used kind "other" (fileKind had no "ledger" yet).
  try {
    return bytesToUtf8(
      open(state, fileAad("other", filePath), fromB64Url(token)),
    );
  } catch {
    return null;
  }
}
