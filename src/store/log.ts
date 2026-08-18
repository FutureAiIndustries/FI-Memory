import { isoFromMs, msFromIso } from "../clock.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { countTokens } from "../tokens.js";
import { decodeLogEntry, encodeLogEntry, keyState, SEALED_TOKEN_FLOOR } from "./codec.js";
import { normalizeText } from "./frontmatter.js";

/** Closed set of log entry types (SPEC §4). */
export const LOG_TYPES = [
  "decision",
  "pattern",
  "gotcha",
  "convention",
  "supersede",
] as const;
export type LogType = (typeof LOG_TYPES)[number];

export function isLogType(s: string): s is LogType {
  return (LOG_TYPES as readonly string[]).includes(s);
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORGERY_RE = /^### \d{4}-\d{2}-\d{2}T/;
// An entry boundary requires the full `### <ts> | ` header shape (#11), so a
// stray `### Notes` in a summary/body can't be mistaken for a new entry.
// Exported because it is the ONLY line shape that starts a plaintext entry, so
// it is also the only line that can be compared against the sealed line shape —
// everything after it is body text the user wrote (ops/exportOp.ts).
export const ENTRY_HEADER_RE = /^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| /;
// An encrypted log line is `<ISO-ts> <base64url>` (no ` | ` header). Used to
// detect a store-mode/key mismatch (encrypted content read without a key) and,
// with SEALED_TOKEN_FLOOR, to classify a log for the store-mode gate below.
export const ENCRYPTED_LINE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [A-Za-z0-9_-]+$/;

/**
 * True if the given text (a whole log or just its head) is an ENCRYPTED log —
 * its first non-empty, non-`# <id> log` line has the sealed `<ts> <base64url>`
 * shape in FULL **and** a token at least `SEALED_TOKEN_FLOOR` long. Lets the
 * keyring detect sealed logs for the store-mode gate without a key
 * (store/keyring.ts).
 *
 * The floor is the SAME discriminator `export --plaintext` applies (defined
 * once in store/codec.ts), so the GATE and export can never disagree about what
 * counts as sealed. A sub-floor token is provably NOT this codec's output — a
 * §0.1 hand edit such as the canonized one-liner `2026-07-14T09:30:00.000Z
 * deployed` (an 8-char token) — so it must NOT gate the store, or every CLI
 * command would die "This store is encrypted but keyring.json is missing" on a
 * wholly plaintext store. A real sealed line's token vastly exceeds the floor
 * (even a truncated head read keeps ≥ the floor, never below it), so a genuine
 * encrypted log is still detected — which is why the recovery ORACLE that
 * shares this finder (`verifyDekOpensStore` via `findEncryptedLog`) still binds
 * a real sealed line as its AEAD proof and can never latch onto a sub-floor
 * line that was never AEAD-openable anyway (R3-H1 preserved).
 */
export function looksLikeEncryptedLog(text: string): boolean {
  for (const line of text.split("\n")) {
    const t = line.trimEnd();
    if (t === "" || /^# \S+ log$/.test(t)) continue;
    // The FIRST content line decides. Full sealed shape AND a token that reaches
    // the floor => sealed; anything else — including a sub-floor shape match —
    // is the user's own plaintext, never the gate's business.
    if (!ENCRYPTED_LINE_RE.test(t)) return false;
    return t.slice(t.indexOf(" ") + 1).length >= SEALED_TOKEN_FLOOR;
  }
  return false;
}

/** The first full encrypted `<ts> <base64url>` line of a log, or null. */
export function firstEncryptedLogLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (ENCRYPTED_LINE_RE.test(t)) return t;
  }
  return null;
}

function hasControl(s: string): boolean {
  for (const ch of s) if (ch.charCodeAt(0) < 0x20) return true;
  return false;
}

/** A parsed log entry. `raw` is the exact block text (re-emitted on merge). */
export interface LogEntry {
  timestamp: string;
  type: string;
  project: string;
  agent: string;
  supersedes: string | null;
  reported: string | null;
  refs: string[] | null;
  summary: string;
  raw: string;
}

/** Fields for a not-yet-timestamped entry (the runtime assigns the timestamp). */
export interface NewEntry {
  type: string;
  project: string;
  agent: string;
  summary: string;
  body?: string;
  supersedes?: string | null;
  reported?: string | null;
  refs?: string[];
}

/**
 * Parse a log file into entries, tolerating a malformed block by skipping it
 * with a warning (SPEC §1). The optional `# <id> log` H1 and blank separators
 * are ignored.
 */
export function parseLog(
  text: string,
  topicId?: string,
): { entries: LogEntry[]; warnings: Warning[] } {
  text = normalizeText(text);
  const mode = keyState().mode;
  const lines = text.split("\n");
  const hasPlainEntry = lines.some((l) => ENTRY_HEADER_RE.test(l));
  const hasEncEntry = lines.some((l) => ENCRYPTED_LINE_RE.test(l));

  // Fail closed on a mode/content mismatch, so a later re-serialize can never
  // silently drop — and then overwrite — data it merely could not decrypt.
  if (mode === "plaintext" && hasEncEntry && !hasPlainEntry) {
    throw new GestaltError(
      "E_STORE_MODE",
      "This log is encrypted but no key is set.",
      "Set GESTALT_KEY to read this store.",
    );
  }
  if (mode === "encrypted") {
    if (hasPlainEntry) {
      throw new GestaltError(
        "E_STORE_MODE",
        "This log is plaintext but a key is set.",
        "Unset GESTALT_KEY, or migrate the store to encrypted.",
      );
    }
    return parseEncryptedLog(text, topicId);
  }

  const warnings: Warning[] = [];
  const entries: LogEntry[] = [];
  let current: string[] | null = null;

  const flush = (): void => {
    if (!current) return;
    const block = current.join("\n").replace(/\n+$/, "");
    const parsed = parseEntry(block);
    if (parsed) entries.push(parsed);
    else
      warnings.push({
        code: "E_CORRUPT_SKIPPED",
        message: "unparsable log entry skipped",
      });
    current = null;
  };

  for (const line of lines) {
    if (ENTRY_HEADER_RE.test(line)) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return { entries: sortEntries(entries), warnings };
}

/**
 * Chronological order, restored on every parse.
 *
 * A union-merged log is OURS-then-THEIRS, not oldest-then-newest: git
 * concatenates the two sides, so after two machines append to the same topic the
 * file is genuinely out of timestamp order on disk. `get`'s log tail happened to
 * be safe because it sorts for itself, but every other reader takes file order
 * as chronological — `compact` folds `entries.slice(-N)` and would quietly drop
 * the newest team fact while keeping an older local one.
 *
 * Sorting HERE rather than in each caller is the point: the invariant belongs to
 * the parse, so a reader added later inherits it instead of having to know.
 *
 * The tiebreak on identical timestamps is deliberate and stable. Two machines
 * can mint the same millisecond, and the two entries are genuinely different, so
 * they must not be reordered arbitrarily between runs — a serialize that shuffles
 * equal-timestamp entries would rewrite the file on every read-modify-write and
 * manufacture git conflicts out of nothing.
 */
function sortEntries(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
  });
}

/**
 * Parse an ENCRYPTED log: a `# <id> log` header, then one `<ts> <base64url>`
 * line per entry. FAIL CLOSED — a bad line throws rather than being skipped,
 * because the only durable write path is read→parse→whole-file overwrite, so a
 * silently-dropped line is permanently destroyed on the next write (Grok F1).
 * The AEAD topic id is the caller's AUTHENTICATED id (from the file path); the
 * `# <id> log` header is unauthenticated and only a fallback for id-less read
 * paths — so a relocated log (A's ciphertext in B's file) fails to decode under
 * B's id and is detected, not silently re-homed (Grok F3).
 *
 * The throw distinguishes the two, because they are different FACTS about what
 * happened: a failed AEAD open is `E_STORE_MODE` — the plaintext never reached
 * us, so we know nothing about the bytes — while a line that decrypts and THEN
 * will not parse is `E_CORRUPT_SKIPPED`: the AEAD tag verified, so the key
 * demonstrably opens this store's data, and the plaintext is still not an entry.
 * Both were `E_STORE_MODE` before, which reported an opened-and-unparsable entry
 * as a key problem — a claim the code had already disproved.
 */
function parseEncryptedLog(
  text: string,
  topicId?: string,
): { entries: LogEntry[]; warnings: Warning[] } {
  const entries: LogEntry[] = [];
  const lines = text.split("\n");
  const id = topicId ?? lines[0]?.match(/^# (\S+) log$/)?.[1] ?? "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (i === 0 && /^# \S+ log$/.test(line)) continue; // `# <id> log` header
    let plain: string;
    try {
      plain = decodeLogEntry(id, line);
    } catch {
      // The AEAD open failed: the key is wrong/absent, the data was tampered
      // with, or this log was relocated. A KEY problem — the plaintext was
      // never in our hands, so we cannot say anything about the bytes.
      throw new GestaltError(
        "E_STORE_MODE",
        "Could not read an encrypted log entry (wrong key, tampered data, or a relocated log).",
        "Check GESTALT_KEY (it may be the wrong key), or restore the log from backup.",
      );
    }
    const parsed = parseEntry(plain);
    if (!parsed) {
      // It DECRYPTED — the AEAD tag verified, so the active key IS this store's
      // key — and the plaintext still is not a valid entry. Reporting that as a
      // store-mode/key problem sends the user after a key this very line just
      // proved correct. The distinction is kept because it makes the reported
      // FACT more accurate, which is the only thing `ops/exportOp.ts` passes on
      // to the user: "failed to decrypt" and "decrypted but will not parse" are
      // different things that happened, and export states what happened.
      throw new GestaltError(
        "E_CORRUPT_SKIPPED",
        "An encrypted log entry decrypted but is unparsable — corrupt entry.",
        "Restore this log from a backup; the key is correct, the contents are damaged.",
      );
    }
    entries.push(parsed);
  }
  // Same invariant on the encrypted path. An encrypted log union-merges exactly
  // like a plaintext one — the merge driver works on lines, not on plaintext —
  // so it arrives out of order for the same reason and must not be the one
  // shape of store where `compact` folds stale.
  return { entries: sortEntries(entries), warnings: [] };
}

/**
 * Parse one entry block: a `### <ts> | type | project | agent` header line plus
 * its body. Returns null when the block is not a well-formed entry.
 *
 * Exported because it is the store's OWN definition of "this is an entry", and
 * `export --plaintext` must prove a log's plaintext against exactly that — the
 * same parser, the same answer — rather than re-deriving a second, drifting idea
 * of the shape (ops/exportDecode.ts). Passing a bare header line (a block with
 * no body) is a valid question: it asks whether that line opens an entry.
 */
export function parseEntry(block: string): LogEntry | null {
  const nl = block.indexOf("\n");
  const headerLine = nl === -1 ? block : block.slice(0, nl);
  const rest = nl === -1 ? "" : block.slice(nl + 1);
  if (!headerLine.startsWith("### ")) return null;

  const parts = headerLine.slice(4).split(" | ");
  if (parts.length < 4) return null;
  const timestamp = parts[0]!;
  if (!TS_RE.test(timestamp)) return null;
  // Reject calendar-impossible timestamps (#25): they must survive a Date round-trip.
  const ms = msFromIso(timestamp);
  if (Number.isNaN(ms) || isoFromMs(ms) !== timestamp) return null;

  let supersedes: string | null = null;
  let reported: string | null = null;
  let refs: string[] | null = null;
  for (const extra of parts.slice(4)) {
    if (extra.startsWith("supersedes:")) supersedes = extra.slice(11);
    else if (extra.startsWith("reported:")) reported = extra.slice(9);
    else if (extra.startsWith("refs:")) refs = extra.slice(5).split(",").filter(Boolean);
  }

  return {
    timestamp,
    type: parts[1]!,
    project: parts[2]!,
    agent: parts[3]!,
    supersedes,
    reported,
    refs,
    summary: rest.split("\n")[0] ?? "",
    raw: block,
  };
}

/** Format an entry block (no trailing newline) for a resolved timestamp. */
export function formatEntryBlock(ts: string, e: NewEntry): string {
  let header = `### ${ts} | ${e.type} | ${e.project} | ${e.agent}`;
  if (e.supersedes) header += ` | supersedes:${e.supersedes}`;
  if (e.reported) header += ` | reported:${e.reported}`;
  if (e.refs && e.refs.length > 0) header += ` | refs:${e.refs.join(",")}`;
  const body = e.body && e.body.length > 0 ? `\n${e.body}` : "";
  return `${header}\n${e.summary}${body}`;
}

/**
 * Serialize a whole log file in canonical PLAINTEXT form, never encoded (SPEC
 * §4); always ends with `\n`. This is what `serializeLog` emits on a plaintext
 * store, and what `export --plaintext` emits for an ENCRYPTED store — the
 * escape hatch has to write readable text while a key is active, which is
 * exactly the case `serializeLog` would encode (ops/exportOp.ts, gate G1).
 */
export function serializeLogPlain(id: string, entries: LogEntry[]): string {
  const header = `# ${id} log\n`;
  if (entries.length === 0) return header;
  return header + "\n" + entries.map((e) => e.raw).join("\n\n") + "\n";
}

/** Serialize a whole log file in canonical form (SPEC §4); always ends with `\n`. */
export function serializeLog(id: string, entries: LogEntry[]): string {
  // Plaintext: identity + blank-line separators (byte-identical to the
  // pre-codec format). Encrypted: encode each entry through the codec to one
  // opaque line, so git merge=union concatenates cross-machine appends.
  if (keyState().mode === "plaintext") return serializeLogPlain(id, entries);
  const header = `# ${id} log\n`;
  if (entries.length === 0) return header;
  return (
    header + "\n" + entries.map((e) => encodeLogEntry(id, e.raw)).join("\n") + "\n"
  );
}

export function maxTimestampMs(entries: LogEntry[]): number | null {
  let max: number | null = null;
  for (const e of entries) {
    const ms = msFromIso(e.timestamp);
    if (!Number.isNaN(ms) && (max === null || ms > max)) max = ms;
  }
  return max;
}

export function timestampSet(entries: LogEntry[]): Set<string> {
  return new Set(entries.map((e) => e.timestamp));
}

/** Most refs one entry may carry (v1 grammar; all scoping reports converged on 8). */
export const MAX_REFS = 8;

// Ref grammar v1 (frozen at first public drop):
//   ref      := portable | machine
//   portable := repo "#" path ["@" shortsha]
//   machine  := "~" [a-f0-9]{8} ":" absolute
// The charset fast-reject keeps every character that can appear in either form
// and still bans `|`, `,`, whitespace, `\`, and control chars — the properties
// that make a ref safe to embed in the `|`-delimited, comma-joined header extra
// (header-injection safety mirrors the project/agent guard below).
const REF_CHARSET_RE = /^[A-Za-z0-9._:@#~/-]{1,256}$/;
const REF_REPO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_SHA_RE = /^[0-9a-f]{7,40}$/;
// Machine ref: 8-hex machineId (store/machineId.ts) + an absolute path.
const REF_MACHINE_RE = /^~[a-f0-9]{8}:\/.+$/;

/**
 * Structural check for the portable form `repo#path[@shortsha]`. Split repo at
 * the FIRST `#`; strip the sha at the LAST `@` and only when everything after
 * it is 7–40 hex to end-of-ref (so `nexus#node_modules/@scope/pkg/index.ts`
 * keeps its `@scope`). These split rules must be identical in producer, lens,
 * and daemon.
 */
function isPortableRef(ref: string): boolean {
  const hash = ref.indexOf("#");
  if (hash === -1) return false;
  if (!REF_REPO_RE.test(ref.slice(0, hash))) return false;
  let p = ref.slice(hash + 1);
  const at = p.lastIndexOf("@");
  if (at !== -1 && REF_SHA_RE.test(p.slice(at + 1))) p = p.slice(0, at);
  // posix-relative: no leading '/', no empty/./.. segment ('\', NUL, and
  // whitespace are already banned by the charset fast-reject).
  if (p === "" || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Normalize a caller's refs for the wire: a bare absolute path becomes the
 * machine-qualified `~<machineId>:<abs>` form, so the lens can attribute
 * machine-scoped refs without guessing. Everything else passes through
 * untouched (validation happens in assertAppendable, on the normalized form).
 * `machineId` is lazy so callers only pay the disk read when a bare path is
 * actually present.
 */
export function normalizeRefs(
  refs: string[] | undefined,
  machineId: () => string,
): string[] | undefined {
  if (!refs || !refs.some((r) => r.startsWith("/"))) return refs;
  const id = machineId();
  return refs.map((r) => (r.startsWith("/") ? `~${id}:${r}` : r));
}

/**
 * Validate a resolved entry block before appending (SPEC §4/§5): closed type
 * set, per-entry token cap, anti-forgery (no body line may start a fake
 * `### <date>` header), refs (count, charset, v1 grammar), and existence of a
 * `supersede` target.
 */
export function assertAppendable(
  block: string,
  e: NewEntry,
  entryTokenCap: number,
  existingTimestamps: Set<string>,
): void {
  if (!isLogType(e.type)) {
    throw new GestaltError(
      "E_INVALID_TYPE",
      `"${e.type}" is not a valid entry type. Use one of: ${LOG_TYPES.join(", ")}.`,
      `fimemory log <id> --type decision --project <p> -m "..."`,
    );
  }
  // Reject header-field injection (#10): project/agent are `|`-delimited header
  // fields, so a `|` or newline could forge supersedes:/reported: or shift agent.
  for (const [field, value] of [
    ["project", e.project],
    ["agent", e.agent],
  ] as const) {
    if (value.includes("|") || hasControl(value)) {
      throw new GestaltError(
        "E_SCHEMA",
        `${field} may not contain "|", newlines, or control characters.`,
        `fimemory log <id> --${field} "<clean value>" ...`,
      );
    }
  }
  if (e.summary.trim() === "") {
    throw new GestaltError(
      "E_SCHEMA",
      "A one-line summary is required (SPEC §4).",
      `fimemory log <id> --type ${e.type} -m "<summary>"`,
    );
  }
  if (hasControl(e.summary)) {
    throw new GestaltError(
      "E_SCHEMA",
      "The summary must be a single line (no newlines or control characters).",
      `fimemory log <id> -m "<single-line summary>"`,
    );
  }
  if (e.refs && e.refs.length > 0) {
    if (e.refs.length > MAX_REFS) {
      throw new GestaltError(
        "E_SCHEMA",
        `An entry may carry at most ${MAX_REFS} refs; got ${e.refs.length}.`,
        "Keep the most relevant refs and drop the rest.",
      );
    }
    for (const ref of e.refs) {
      // Reserved prefix (Eric's ruling H1): `mem:` is carved out NOW so
      // store-internal addresses can be added later without grammar ambiguity.
      // Nothing implements mem: refs in v1 — the rejection is deliberate and
      // distinct from the generic invalid-ref error.
      if (ref.startsWith("mem:")) {
        throw new GestaltError(
          "E_SCHEMA",
          `Ref "${ref}" uses the "mem:" prefix, which is reserved for future store-internal addresses.`,
          "v1 refs are file refs only: repo#path[@sha] or ~machineId:/abs/path.",
        );
      }
      // Charset fast-reject first (also the header-injection guard: bans `|`,
      // `,`, whitespace, `\`, control chars), then the structural grammar.
      if (
        !REF_CHARSET_RE.test(ref) ||
        !(isPortableRef(ref) || REF_MACHINE_RE.test(ref))
      ) {
        throw new GestaltError(
          "E_SCHEMA",
          `Ref "${ref}" is not a valid ref. Use repo#path[@sha] (portable) or ~machineId:/abs/path (machine-scoped).`,
          `Example: --refs nexus#src/daemon.ts@4d9ed49`,
        );
      }
    }
  }
  const tokens = countTokens(block);
  if (tokens > entryTokenCap) {
    // NAME THE TARGET, not just the failure.
    //
    // "Shorten the summary/body" said it was too long and nothing about by how
    // much, so a caller retries by feel. Observed on a real server 2026-08-01:
    // six consecutive calls at 269, 243, 224, 217, 211, 201 tokens against a cap
    // of 200 — six failures, the last missing by a SINGLE token. That is a blind
    // descent, and every step costs a round trip.
    //
    // The overage is arithmetic we already have, so give it — plus a rough word
    // count, because a caller edits words rather than tokens. 0.75 words/token
    // is deliberately conservative for prose so that following the advice
    // overshoots into success rather than landing one token short again.
    //
    // And name the cap as a SETTING. A caller who genuinely needs longer entries
    // should know it is theirs to raise, instead of grinding paragraphs down to
    // fit a number they cannot see.
    const over = tokens - entryTokenCap;
    const words = Math.max(1, Math.ceil(over * 0.75));
    throw new GestaltError(
      "E_TOKEN_CAP",
      `Entry is ${tokens} tokens; the cap is ${entryTokenCap}. Cut about ${over} tokens (roughly ${words} words).`,
      `Shorten the summary or body by ~${words} words and retry, or raise \`entryTokenCap\` in the store's config.json if entries this size are normal for you.`,
    );
  }
  const bodyLines = block.split("\n").slice(1);
  if (bodyLines.some((l) => FORGERY_RE.test(l))) {
    throw new GestaltError(
      "E_SCHEMA",
      "Entry body may not contain a line that looks like an entry header (### <date>…).",
      "Remove the leading '### <date>' from the body text.",
    );
  }
  if (e.supersedes && !existingTimestamps.has(e.supersedes)) {
    throw new GestaltError(
      "E_NOT_FOUND",
      `supersede target ${e.supersedes} is not an existing entry in this topic.`,
      "Copy an exact timestamp from an existing entry to supersede it.",
    );
  }
}
