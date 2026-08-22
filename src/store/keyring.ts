import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { GestaltError } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";
import { ENC_MAGIC } from "./wireFormat.js";
import { wipeSessionCache } from "../sessionKeyCache.js";
import type { WipeOutcome } from "../sessionKeyCache.js";
import { activateDek, clearActiveKey, decodeLogEntry, decryptFile } from "./codec.js";
import { firstEncryptedLogLine, looksLikeEncryptedLog } from "./log.js";

/**
 * Fixed plaintext of the store-mode marker (store.enc). Sealed under the DEK at
 * init, it is the canonical, always-present oracle that (a) proves a store is
 * encrypted for the pre-key CLI gate and (b) proves a candidate DEK actually
 * opens THIS store's ciphertext on every unlock path (Grok/Claude R3 H1).
 */
export const STORE_MARKER_CONTENT = "gestalt-store:v1\n";

/**
 * Keyring — E2 key management. The 24-word BIP39 recovery phrase is the MASTER
 * secret: DEK = HKDF(bip39_seed(mnemonic), "gestalt/dek/v1") is deterministic,
 * so the phrase alone restores the key on any machine even without keyring.json.
 * A passphrase → Argon2id → KEK wraps the DEK in plaintext keyring.json as a
 * convenience-unlock cache. No escrow: lose passphrase AND phrase → data gone.
 * See docs/ENCRYPTION-BUILD-PLAN.md; hardened per Claude + Grok reviews.
 *
 * `kid` is a UX/debug tag only (it lives in the attacker-writable keyring next
 * to the wrap) — real integrity comes from AEAD + verifying the DEK actually
 * opens the store's ciphertext (verifyDekOpensStore, Grok H1).
 */

export interface Argon2Params {
  name: "argon2id";
  salt: string; // base64
  m: number;
  t: number;
  p: number;
}
interface WrappedKey {
  n: string; // base64 nonce (24 bytes)
  ct: string; // base64 AEAD(nonce, DEK)
}
export interface Keyring {
  v: 1;
  kid: string;
  kdf: Argon2Params;
  wrap: { passphrase: WrappedKey };
}

export const DEFAULT_ARGON2: Omit<Argon2Params, "salt"> = { name: "argon2id", m: 65536, t: 3, p: 1 };
const ARGON2_FLOOR = { m: 19456, t: 2 };
const ARGON2_CEIL = { m: 1_048_576, t: 10, p: 4 };
const KID_RE = /^[0-9a-f]{16}$/;

/**
 * Strip a leading BOM (U+FEFF) and any leading whitespace — for the magic
 * DETECTION test ONLY, never applied to bytes we hand back. The codec writes
 * the magic at offset 0, but a restore/copy/editor round-trip can prepend a BOM
 * or indent the first line; the naked `startsWith(ENC_MAGIC)` then reads the
 * blob as plaintext and the sealed bytes ride the gate. (`\s` already covers
 * U+FEFF, but the class is spelled out so the intent is unmistakable.)
 */
const stripLeadingBomWs = (s: string): string => s.replace(/^[\uFEFF\s]+/, "");

const WRAP_AAD = utf8ToBytes("gestalt/keyring/wrap/v1");
const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const unb64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
const b64len = (s: unknown): number => {
  if (typeof s !== "string") return -1;
  try { return unb64(s).length; } catch { return -1; }
};

function keyringPath(home: string): string {
  return storePaths(home).home + "/keyring.json";
}
export function keyringExists(home: string): boolean {
  return existsSync(fsPath(keyringPath(home)));
}

export function deriveKid(dek: Uint8Array): string {
  return Buffer.from(hkdf(sha256, dek, utf8ToBytes("gestalt/kid/v1"), new Uint8Array(0), 8)).toString("hex");
}

function normalizeMnemonic(m: string): string {
  return m.trim().toLowerCase().replace(/\s+/g, " ");
}

export function deriveDekFromMnemonic(mnemonic: string): Uint8Array {
  const m = normalizeMnemonic(mnemonic);
  // Require a full 24-word phrase (generation uses 256-bit entropy); shorter
  // BIP39 lengths are also valid but never issued by us (Grok L1).
  if (m.split(" ").length !== 24 || !bip39.validateMnemonic(m, wordlist)) {
    throw new GestaltError("E_SCHEMA", "That is not a valid 24-word BIP39 recovery phrase.", "Check the words and their order.");
  }
  const seed = bip39.mnemonicToSeedSync(m);
  return hkdf(sha256, seed, utf8ToBytes("gestalt/dek/v1"), new Uint8Array(0), 32);
}

function kekFromPassphrase(passphrase: string, kdf: Argon2Params): Uint8Array {
  return argon2id(utf8ToBytes(passphrase.normalize("NFKC")), unb64(kdf.salt), {
    t: kdf.t, m: kdf.m, p: kdf.p, dkLen: 32, maxmem: 2 ** 32 - 1,
  });
}
function wrap(kek: Uint8Array, dek: Uint8Array): WrappedKey {
  const n = randomBytes(24);
  return { n: b64(n), ct: b64(xchacha20poly1305(kek, n, WRAP_AAD).encrypt(dek)) };
}
function unwrap(kek: Uint8Array, w: WrappedKey): Uint8Array {
  return xchacha20poly1305(kek, unb64(w.n), WRAP_AAD).decrypt(unb64(w.ct));
}

export function validatePassphrase(passphrase: string): void {
  const p = passphrase.normalize("NFKC").trim();
  // The passphrase-wrapped KEK is a PARALLEL door to the same DEK the 24-word
  // phrase protects, so this gate must not be the weak link (R3 M). Two ways to
  // clear it, and neither is satisfiable by trivial multi-token junk:
  //   - a real ≥12-code-point secret (spaces don't count), OR
  //   - a genuine ≥4-DISTINCT-word phrase (each word ≥2 chars) — diceware.
  const squished = p.replace(/\s+/g, "");
  const realWords = p.split(/\s+/).filter((w) => [...w].length >= 2);
  const distinctWords = new Set(realWords.map((w) => w.toLowerCase())).size;
  const strongEnough = [...squished].length >= 12 || distinctWords >= 4;
  if (!strongEnough) {
    throw new GestaltError("E_SCHEMA", "Passphrase is too weak — use 12+ characters or a 4-word phrase of distinct words.", `A memorable sentence is ideal.`);
  }
  const weak = new Set([
    "password", "passphrase", "passwordpassword", "12345678", "123456789", "1234567890",
    "qwertyuiop", "letmein now", "iloveyou now", "correct horse battery", "correct horse battery staple",
  ]);
  if (weak.has(p.toLowerCase())) {
    throw new GestaltError("E_SCHEMA", "That passphrase is too common.", "Choose something only you would write.");
  }
  // Reject a wholly-repeated pattern — tested on the WHITESPACE-COLLAPSED string
  // so space-joined repeats ("the the the the" → "thethethethe") are caught too
  // (R3 M: the un-collapsed test missed them).
  if (/^(.+?)\1+$/.test(squished)) {
    throw new GestaltError("E_SCHEMA", "That passphrase is just a repeated pattern.", "Use something less predictable.");
  }
}

function validateKeyringShape(k: Keyring): void {
  const bad = (why: string): never => {
    throw new GestaltError("E_STORE_MODE", `keyring.json is invalid (${why}).`, "Restore keyring.json from backup, or recover with your 24-word phrase.");
  };
  if (!k || k.v !== 1 || !k.kdf || !k.wrap?.passphrase) bad("bad structure");
  if (k.kdf.name !== "argon2id") bad("unsupported KDF");
  if (!KID_RE.test(k.kid)) bad("bad key id");
  const { m, t, p } = k.kdf;
  if (!(typeof m === "number" && typeof t === "number" && typeof p === "number")) bad("non-numeric params");
  if (m > ARGON2_CEIL.m || t > ARGON2_CEIL.t || p > ARGON2_CEIL.p || m < 8 || t < 1 || p < 1) bad("out-of-range Argon2 params");
  if (b64len(k.kdf.salt) < 16) bad("bad salt"); // Grok L2
  if (b64len(k.wrap.passphrase.n) !== 24) bad("bad wrap nonce");
  if (b64len(k.wrap.passphrase.ct) < 48) bad("bad wrapped key"); // 32-byte DEK + 16-byte tag
}

function readKeyring(home: string): Keyring {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fsPath(keyringPath(home)), "utf8"));
  } catch {
    throw new GestaltError("E_STORE_MODE", "keyring.json is missing or unparsable.", "Restore it from backup, or recover with your 24-word phrase.");
  }
  const k = raw as Keyring;
  validateKeyringShape(k);
  return k;
}

/** Crash-safe keyring write: temp file → fsync → atomic rename, cleaning up the
 * temp on failure (R3 L: match store/atomic.ts durability; no orphaned *.tmp). */
function writeKeyringFile(home: string, keyring: Keyring): void {
  const target = fsPath(keyringPath(home));
  const tmp = `${target}.tmp-${process.pid}`;
  const data = JSON.stringify(keyring, null, 2) + "\n";
  // 0600 EXPLICITLY. This is a temp+rename, so the mode the temp is opened with
  // becomes keyring.json's mode. Without it Node opens 0666 and the standard
  // umask 022 lands the file at 0644 on Linux and macOS — the Argon2id-wrapped
  // DEK, the salt and the KDF params readable by every local account, which
  // reduces encryption-at-rest to passphrase-only against an offline attack.
  // Nothing repairs it later: writeFileAtomicPlain PRESERVES an existing mode,
  // so a 0644 keyring would stay 0644 forever. sessionKeyCache.ts does exactly
  // this on the diagnostic cache; the key material must not be looser than the
  // diagnostics. mode is inert on Windows, which is why this went unnoticed.
  // Measured by .github/scripts/posix-modes.mjs on the Linux and macOS legs.
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd); // durable across host power loss, not just process crash
  } finally {
    closeSync(fd);
  }
  try {
    // Retried, not bare (2026-07-28 contention audit): a single concurrent
    // READER of keyring.json — an ordinary unlock on another tool — made this
    // rename fail on Windows and took `recover` down with a bare E_LOCKED.
    // Same reasoning as the store's atomic writer: readers are transient, so
    // a short backoff turns a hard failure into a pause nobody notices.
    let renamed = false;
    for (let attempt = 0; !renamed; attempt++) {
      try {
        renameSync(tmp, target); // atomic replace (modern Node overwrites on Windows too)
        renamed = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const retriable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!retriable || attempt >= 10) throw err;
        const until = Date.now() + Math.min(10 * 2 ** attempt, 120);
        while (Date.now() < until) {
          /* brief spin: sync path, holder is a reader that closes fast */
        }
      }
    }
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw new GestaltError("E_LOCKED", "Could not write keyring.json.", "Close anything using the store and retry.");
  }
}

function writeKeyring(
  home: string,
  dek: Uint8Array,
  passphrase: string,
  params: Omit<Argon2Params, "salt"> = DEFAULT_ARGON2,
  allowWeakParams = false,
): void {
  validatePassphrase(passphrase);
  if (!allowWeakParams && (params.m < ARGON2_FLOOR.m || params.t < ARGON2_FLOOR.t)) {
    throw new GestaltError("E_SCHEMA", `Argon2 params below the security floor (need m>=${ARGON2_FLOOR.m} KiB, t>=${ARGON2_FLOOR.t}).`, "Use the default parameters.");
  }
  const kdf: Argon2Params = { ...params, salt: b64(randomBytes(16)) };
  writeKeyringFile(home, { v: 1, kid: deriveKid(dek), kdf, wrap: { passphrase: wrap(kekFromPassphrase(passphrase, kdf), dek) } });
}

/** Read up to `n` bytes from the head of a file (cheap magic/shape sniff — never
 * loads a whole file, so a giant planted blob can't force a huge read). */
function readHead(p: string, n = 512): string {
  let fd: number | undefined;
  try {
    fd = openSync(fsPath(p), "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Real store files only — never bind mode/verify decisions to a transient temp. */
function isTempName(name: string): boolean {
  return name.startsWith(".") || name.includes(".tmp-");
}

/** First whole-file-sealed blob (marker, index, a note, or a proposal), or null.
 * Reads only each file's head (M4/R3: proposals were previously never scanned).
 *
 * Scans home, topicsDir, proposalsDir — and deliberately NOT logsDir. This
 * finder is BOTH the gate's evidence AND `verifyDekOpensStore`'s AEAD oracle,
 * and those two roles disagree about a log path. `decryptFile` identity-passes
 * any log-kind path (`isWholeFileEncrypted("log")` is false — store/codec.ts),
 * so a whole-file blob MISPLACED at a log path cannot be AEAD-opened as-is:
 * handing it to the oracle would let a WRONG key "verify" against a no-op open
 * and re-key the store (R3-H1 — the regression c913ff3 introduced by adding
 * logsDir here). The GATE's separate need to SEE such a blob is served by
 * `findWholeFileSealedAtLogPath`, which must never reach the oracle. The magic
 * test strips a leading BOM/indent (`stripLeadingBomWs`) so a round-tripped
 * blob is not read as plaintext. */
function findWholeFileSealed(home: string): string | null {
  const paths = storePaths(home);
  for (const dir of [paths.home, paths.topicsDir, paths.proposalsDir]) {
    let files: string[];
    try { files = readdirSync(fsPath(dir)); } catch { continue; }
    for (const f of files) {
      if (isTempName(f)) continue;
      const p = `${dir}/${f}`;
      if (stripLeadingBomWs(readHead(p)).startsWith(ENC_MAGIC)) return p;
    }
  }
  return null;
}

/**
 * GATE-ONLY: a whole-file sealed blob MISPLACED at a log path (a restore/copy
 * mishap; the codec never writes the magic under `logs/` — logs are per-entry).
 * The store gate must see sealed content wherever it sits, but this blob MUST
 * NOT feed `verifyDekOpensStore`: `decryptFile` identity-passes a log-kind path
 * (no AEAD), so it can prove no key — see `findWholeFileSealed`. Head-read and
 * BOM/indent-tolerant, exactly like the finder above; kept a separate function
 * precisely so the oracle can never call it by reaching for `findWholeFileSealed`.
 */
function findWholeFileSealedAtLogPath(home: string): string | null {
  const dir = storePaths(home).logsDir;
  let files: string[];
  try { files = readdirSync(fsPath(dir)); } catch { return null; }
  for (const f of files) {
    if (isTempName(f)) continue;
    const p = `${dir}/${f}`;
    if (stripLeadingBomWs(readHead(p)).startsWith(ENC_MAGIC)) return p;
  }
  return null;
}

/** Path to a `logs/*.log.md` file that is ENCRYPTED (per-entry sealed), or null.
 * Logs carry no `gestalt-enc:` magic, so `looksLikeEncryptedLog` classifies by
 * the sealed line SHAPE plus the codec's `SEALED_TOKEN_FLOOR` — the SAME floor
 * export applies, so the gate never reads a sub-floor hand edit (the canonized
 * `<ts> deployed` one-liner) as encrypted and bricks a plaintext store. The
 * floor removes only false positives here: a real sealed line clears it, so the
 * oracle (`verifyDekOpensStore`) still finds its AEAD proof. */
function findEncryptedLog(home: string): string | null {
  const dir = storePaths(home).logsDir;
  let files: string[];
  try { files = readdirSync(fsPath(dir)); } catch { return null; }
  for (const f of files) {
    if (isTempName(f) || !f.endsWith(".log.md")) continue;
    const p = `${dir}/${f}`;
    if (looksLikeEncryptedLog(readHead(p))) return p;
  }
  return null;
}

/** A git conflict-marker line (`<<<<<<<`, `=======`, `|||||||`, `>>>>>>>`). */
const CONFLICT_LINE = /^(<{7}( |$)|={7}$|\|{7}( |$)|>{7}( |$))/;
const hasConflictLine = (head: string): boolean =>
  head.split("\n").some((l) => CONFLICT_LINE.test(l.trimEnd()));

/** True if a LATER line (not the first) starts with the sealed magic once a
 * leading BOM/indent is stripped — the conflict-masked mirror of
 * `findWholeFileSealed`'s offset-0 strip. A conflict pushes the blob's magic to
 * a line START, and a restore/copy/editor round-trip can prepend a BOM (U+FEFF)
 * or indentation there just as at offset 0, so it must be stripped uniformly
 * (a naked `"\n" + ENC_MAGIC` substring test missed it). The FIRST line is
 * `findWholeFileSealed`/`findWholeFileSealedAtLogPath`'s concern (offset 0,
 * already BOM-stripped), so the masked scan starts at index 1. */
const hasMaskedMagicLine = (head: string): boolean => {
  const lines = head.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (stripLeadingBomWs(lines[i]!).startsWith(ENC_MAGIC)) return true;
  }
  return false;
};

/**
 * Sealed content HIDDEN from the two positive finders by a git conflict — the
 * same masking that bit export's `isPlaintextIn` (Grok review, 2026-07-16): a
 * conflict prepends `<<<<<<< HEAD`, so a sealed note's magic is no longer at
 * offset 0 and a sealed log's first content line is a marker, not a
 * `<ts> <base64url>` line. Detected here as visible evidence only, and ONLY in
 * the masking case this finder exists for: the magic at the START of a later
 * LINE (exactly where a conflict pushes it — never a mid-line mention in
 * prose) counts only when git conflict-marker lines are ALSO present in the
 * head. Without that evidence a line-start magic is a plaintext file that
 * merely mentions the format — e.g. a note DOCUMENTING the sealed marker with
 * an example line — and firing on it locked the whole store out of the CLI
 * ("encrypted but keyring.json is missing", every command). Such a file is the
 * per-file export contract's to refuse, not the store gate's. (The unmasked
 * case — a file that STARTS with the magic — is `findWholeFileSealed`'s.)
 * A log is judged by whether its head reads as sealed once git's marker lines
 * are stepped over, which is conflict-gated by construction: with no marker
 * lines, the filter changes nothing and `findEncryptedLog` already answered.
 * The MAGIC scan covers logsDir too (2026-07-16, same conflict gating): a
 * whole-file blob that lands at a log path (a restore/copy mishap —
 * `findWholeFileSealedAtLogPath`'s case when unmasked) is masked by a conflict
 * the same way a note's blob is. The masked-magic test is BOM/indent-hardened
 * (`hasMaskedMagicLine` runs each line through the same `stripLeadingBomWs` the
 * unmasked finders use), so a round-tripped blob whose magic carries a leading
 * BOM/indent after the conflict marker is still SEEN, not read as plaintext.
 * Head-limited like the finders above (`readHead`), GATE-ONLY, and deliberately
 * NOT used by `verifyDekOpensStore`: a masked file — like a misplaced log-path
 * blob — cannot be AEAD-opened as-is, so it can prove a store sealed but must
 * never veto or (worse) falsely bless a key. The per-file export contract
 * (ops/exportDecode.ts `decodePlainStore`) remains the layer that sees every
 * byte of every file.
 */
function findMaskedSealed(home: string): string | null {
  const paths = storePaths(home);
  for (const dir of [paths.home, paths.topicsDir, paths.proposalsDir, paths.logsDir]) {
    let files: string[];
    try { files = readdirSync(fsPath(dir)); } catch { continue; }
    for (const f of files) {
      if (isTempName(f)) continue;
      const p = `${dir}/${f}`;
      const head = readHead(p);
      // BOM/indent-hardened, uniformly with the unmasked finders: strip a
      // leading BOM/indent at offset 0 (the unmasked case, owned elsewhere) AND
      // at each later line start (the masked case this finder owns) before the
      // magic test — a round-tripped blob whose magic carries a BOM/indent must
      // still be SEEN, and conflict-marker evidence is still required.
      if (
        !stripLeadingBomWs(head).startsWith(ENC_MAGIC) &&
        hasMaskedMagicLine(head) &&
        hasConflictLine(head)
      ) {
        return p;
      }
    }
  }
  let logs: string[];
  try { logs = readdirSync(fsPath(paths.logsDir)); } catch { return null; }
  for (const f of logs) {
    if (isTempName(f) || !f.endsWith(".log.md")) continue;
    const p = `${paths.logsDir}/${f}`;
    const head = readHead(p);
    if (looksLikeEncryptedLog(head)) continue; // findEncryptedLog already owns this
    const unmasked = head
      .split("\n")
      .filter((l) => !CONFLICT_LINE.test(l.trimEnd()))
      .join("\n");
    if (looksLikeEncryptedLog(unmasked)) return p;
  }
  return null;
}

/**
 * True if the store contains ANY encrypted content — whole-file (marker/index/
 * note/proposal) OR a sealed log. Independent of keyring.json, so deleting the
 * keyring can never downgrade a sealed store to plaintext at the CLI gate, and
 * a store whose only survivors are sealed logs/proposals is still recognized
 * (R3: the old scan missed both). A whole-file blob MISPLACED at a log path is
 * seen too (`findWholeFileSealedAtLogPath`) — the gate must see sealed content
 * wherever it sits, even where the codec never writes it. Conflict-MASKED
 * sealed content counts too (`findMaskedSealed`, conflict evidence required) —
 * the gate must not read a half-merged sealed store as plaintext (Grok review,
 * 2026-07-16) — while a plaintext file that merely mentions the marker never
 * locks the store out.
 *
 * This is the GATE. It is intentionally broader than `verifyDekOpensStore`'s
 * AEAD oracle: the gate may flag sealed bytes the oracle cannot open (a
 * log-path blob, conflict-masked material), and when it does, the oracle FAILS
 * CLOSED rather than treat the store as fresh (R3-H1). Detection here never
 * blesses a key; only an AEAD open does.
 */
export function storeHasSealedContent(home: string): boolean {
  return (
    findWholeFileSealed(home) !== null ||
    findWholeFileSealedAtLogPath(home) !== null ||
    findEncryptedLog(home) !== null ||
    findMaskedSealed(home) !== null
  );
}

/** topic id from a `logs/<id>.log.md` path (its AUTHENTICATED AEAD aad). */
function topicIdFromLogPath(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.log\.md$/, "");
}

/**
 * Bind a candidate DEK to the store's ACTUAL ciphertext (Grok/Claude R3): a
 * wrong-but-valid phrase (or a swapped keyring's DEK) must not "succeed". Prefers
 * the always-present marker (so a planted file elsewhere can't veto a correct
 * key); falls back to any whole-file blob, then a sealed log, for pre-marker or
 * partially-deleted stores. Activates the DEK and AEAD-opens; throws on failure.
 *
 * The oracle uses `findWholeFileSealed` — which excludes logsDir — NOT the gate
 * (`storeHasSealedContent`): a blob misplaced at a log path, or conflict-masked
 * material, cannot be AEAD-opened as-is, so it can prove no key. If the store
 * has sealed content the oracle cannot open, we FAIL CLOSED (refuse to re-key)
 * rather than mistake it for a fresh store — R3-H1: never re-key over a store
 * the phrase cannot open. A true no-op happens ONLY when the gate agrees there
 * is nothing sealed at all (a genuinely fresh/empty store).
 */
function verifyDekOpensStore(home: string, dek: Uint8Array): void {
  const marker = storePaths(home).storeMarker;
  activateDek(dek);
  try {
    if (existsSync(fsPath(marker))) {
      decryptFile(marker, readFileSync(fsPath(marker), "utf8"));
      return;
    }
    const blob = findWholeFileSealed(home);
    if (blob) {
      decryptFile(blob, readFileSync(fsPath(blob), "utf8"));
      return;
    }
    const log = findEncryptedLog(home);
    if (log) {
      const line = firstEncryptedLogLine(readFileSync(fsPath(log), "utf8"));
      if (line) {
        decodeLogEntry(topicIdFromLogPath(log), line); // throws on wrong key
        return;
      }
    }
    // No AEAD-openable artifact was found. If the GATE nonetheless sees sealed
    // content (a whole-file blob misplaced AT a log path — which decryptFile
    // identity-passes, so it is no oracle — or conflict-masked material), this
    // is NOT a fresh store: fail closed rather than re-key blindly (R3-H1).
    if (storeHasSealedContent(home)) {
      // Routed to the catch below, which states the one canonical refusal and
      // clears the activated DEK — same fail-closed answer as a wrong key.
      throw new Error("sealed content present but not AEAD-openable here");
    }
    clearActiveKey(); // genuinely nothing sealed to bind to — a fresh/empty store
  } catch {
    clearActiveKey();
    throw new GestaltError(
      "E_STORE_MODE",
      "That key does not open this store's encrypted data.",
      "Use the exact passphrase or 24-word phrase from this store's `fimemory init`.",
    );
  }
}

export function initKeyring(
  home: string,
  passphrase: string,
  params: Omit<Argon2Params, "salt"> = DEFAULT_ARGON2,
  opts: { allowWeakParams?: boolean } = {},
): { dek: Uint8Array; mnemonic: string; kid: string; sessionWipe: WipeOutcome } {
  if (keyringExists(home)) {
    throw new GestaltError("E_EXISTS", `A keyring already exists at ${keyringPath(home)}.`, "Delete the store and re-init, or use `fimemory recover`.");
  }
  const mnemonic = bip39.generateMnemonic(wordlist, 256);
  const dek = deriveDekFromMnemonic(mnemonic);
  writeKeyring(home, dek, passphrase, params, opts.allowWeakParams);
  // A NEW keyring makes any session key cached for this home path stale by
  // definition (a deleted-and-re-inited store must never warm-unlock under the
  // old store's DEK) — invalidate it at the source, not per-caller (E2c).
  //
  // The wipe's outcome is returned ALONGSIDE the result, never discarded —
  // the same rule recover() follows, one call site over: a FAILED wipe means
  // the OLD store's DEK is still on disk and still usable for its TTL, and a
  // re-init that succeeds silently over that fact is a re-init the user must
  // hear about (the init itself proceeds; `fimemory lock` is the retry verb).
  const sessionWipe = wipeSessionCache(home);
  return { dek, mnemonic, kid: deriveKid(dek), sessionWipe };
}

export function unlockWithPassphrase(home: string, passphrase: string): Uint8Array {
  const k = readKeyring(home);
  let dek: Uint8Array;
  try {
    dek = unwrap(kekFromPassphrase(passphrase, k.kdf), k.wrap.passphrase);
  } catch {
    throw new GestaltError("E_STORE_MODE", "Wrong passphrase for this store.", "Retry, or use `fimemory recover` with your 24-word phrase.");
  }
  assertKid(dek, k.kid);
  // The kid lives in the SAME attacker-writable keyring as the wrap, so a
  // swapped keyring can be internally consistent yet hold a DEK that never opens
  // THIS store. Bind to the ciphertext on the everyday path too (R3 H): reads
  // already fail closed, but writes under a wrong DEK would poison the store.
  verifyDekOpensStore(home, dek);
  return dek;
}

/** Recover the DEK from the phrase — verified against the store's ciphertext. */
export function unlockWithMnemonic(home: string, mnemonic: string): Uint8Array {
  const dek = deriveDekFromMnemonic(mnemonic);
  verifyDekOpensStore(home, dek); // H1: prove it actually opens THIS store
  return dek;
}

/**
 * Recover: derive the DEK from the phrase, verify it opens the store, then
 * (re)write keyring.json under a NEW passphrase — works with no keyring at all.
 *
 * Returns the session-cache wipe's outcome ALONGSIDE the dek, never discarding
 * it: a FAILED wipe means the OLD session key is still on disk and still
 * usable after this reset — the reset itself may proceed (it succeeded), but
 * the caller must tell the user loudly, naming the path, so they know to run
 * `fimemory lock` until it succeeds.
 */
export function recover(
  home: string,
  mnemonic: string,
  newPassphrase: string,
  params: Omit<Argon2Params, "salt"> = DEFAULT_ARGON2,
  opts: { allowWeakParams?: boolean } = {},
): { dek: Uint8Array; sessionWipe: WipeOutcome } {
  const dek = deriveDekFromMnemonic(mnemonic);
  verifyDekOpensStore(home, dek); // H1: refuse to re-key over a store this phrase can't open
  writeKeyring(home, dek, newPassphrase, params, opts.allowWeakParams);
  // Passphrase change/recover kills the cached session key (E2c): "I reset my
  // passphrase" must mean sessions unlocked under the old credential are over.
  // (The DEK itself is unchanged — this is a policy wipe, not a crypto one, and
  // it is honest about that: a cache file copied off beforehand would still
  // hold a working DEK, exactly like a copied GESTALT_KEY. Same-machine active
  // copying is outside the at-rest threat model.)
  const sessionWipe = wipeSessionCache(home);
  return { dek, sessionWipe };
}

/** A raw GESTALT_KEY used against a keyring store must be THIS store's key (Claude S2). */
export function assertEnvKeyMatchesStore(home: string, hexKey: string): void {
  const h = hexKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new GestaltError("E_STORE_MODE", "GESTALT_KEY must be 64 hex characters.", "Unset it and unlock with your passphrase.");
  }
  const dek = Uint8Array.from(Buffer.from(h, "hex"));
  if (keyringExists(home)) {
    if (deriveKid(dek) !== readKeyring(home).kid) {
      throw new GestaltError("E_STORE_MODE", "GESTALT_KEY does not match this store's keyring.", "Unset GESTALT_KEY and unlock with your passphrase (or `fimemory recover`).");
    }
  }
  // Always bind to the ciphertext, keyring or not (R3 H): the kid is only a hint
  // from the attacker-writable keyring, so a matching kid is necessary but not
  // sufficient — the DEK must actually open a sealed file.
  verifyDekOpensStore(home, dek);
}

function assertKid(dek: Uint8Array, expected: string): void {
  if (deriveKid(dek) !== expected) {
    throw new GestaltError("E_STORE_MODE", "Unlocked key does not match this store's key id.", "Restore keyring.json from backup, or recover with your 24-word phrase.");
  }
}
