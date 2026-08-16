import path from "node:path";
import { GestaltError } from "../errors.js";
import { decodeLogEntry, decryptFile, SEALED_TOKEN_FLOOR } from "../store/codec.js";
import type { StoreMode } from "../store/codec.js";
import { normalizeText } from "../store/frontmatter.js";
import {
  ENCRYPTED_LINE_RE,
  ENTRY_HEADER_RE,
  parseEntry,
  serializeLogPlain,
} from "../store/log.js";
import type { LogEntry } from "../store/log.js";
import { parseNote } from "../store/note.js";
import { parseProposal } from "../store/proposals.js";

/**
 * THE decode-for-export contract — one function, every kind, no exceptions.
 *
 * Five rounds of adversarial audit have now each found the same rule missing
 * from one more surface. The rule was written for notes; proposals got it a
 * round later; LOGS never got it at all — and logs are exactly where the danger
 * lives, because per-entry encoding + `merge=union` is this product's headline
 * feature, so a log is the one file git will happily hand back half-merged. The
 * fix for that is not a fourth patch on a fourth code path. It is this module:
 * every byte that leaves the store through `export --plaintext` passes through
 * `decodeForExport`, which owns all three obligations in one place —
 *
 *  (a) **POSITIVE proof.** Sealed ⇒ open it. Not sealed ⇒ export it only if it
 *      POSITIVELY parses as what it claims to be, through the store's OWN parser
 *      for that kind. Absence of evidence is never proof.
 *  (b) **The conflict-marker FACT.** A git-synced store WILL produce markers, and
 *      "which file" is the one thing the user needs from us.
 *  (c) **The factual failure.** Name the item, repeat the underlying reason
 *      verbatim, claim no cause.
 *
 * It dispatches internally between whole-file and per-line mechanics — logs ARE
 * per-line, and that is what makes keyless union-merge work — but the CONTRACT
 * lives here, so there is no path that can silently skip it and no fourth
 * surface to forget next round.
 *
 * See `exportOp.ts` for why export reports FACTS and never CAUSES.
 */

/** The three content kinds, and the store's own parser for each. */
export type ExportKind = "note" | "log" | "proposal";

/** The whole-file sealed-blob magic (`store/codec.ts`). */
const ENC_MAGIC = "gestalt-enc:1:";

/**
 * Strip a leading BOM (U+FEFF) and any leading whitespace — for the magic
 * DETECTION test ONLY, never for the exported OUTPUT bytes. A misplaced blob
 * whose first line carries a BOM or indentation (a restore/copy/editor
 * round-trip) still starts with the magic; the naked `startsWith` missed it,
 * and the ciphertext then exported byte-verbatim. The note/proposal branch uses
 * `raw.includes(ENC_MAGIC)`, a substring search a leading BOM cannot bypass, so
 * only the log branch's `startsWith` needed this. (`\s` already covers U+FEFF;
 * the class is spelled out so the intent is unmistakable.)
 */
const stripLeadingBomWs = (s: string): string => s.replace(/^[\uFEFF\s]+/, "");

/**
 * Decode one store file for export, or throw the FACT of why it is not in the
 * export. The single entry point — `exportOp` has no other way to read a file,
 * and `ops/cat.ts` reads its one note through this same contract, so the two
 * ownership commands can never drift into speaking different facts.
 */
export function decodeForExport(
  kind: ExportKind,
  mode: StoreMode,
  src: string,
  raw: string,
): string {
  // PLAINTEXT store: byte-verbatim, with one narrow per-file exception — see
  // `decodePlainStore`. Deliberately OUTSIDE the conflict-fact rewording below:
  // for a conflict-masked sealed file with no key, "contains git conflict
  // markers" alone reads as an invitation to hand-resolve two halves that are
  // both ciphertext; the load-bearing fact is the sealed material + no key.
  if (mode !== "encrypted") return decodePlainStore(kind, raw);
  try {
    return kind === "log" ? decodeLog(logIdOf(src), raw) : decodeWholeFile(kind, src, raw);
  } catch (err) {
    // (b) The wording choice, in ONE place for all three kinds. It only ever
    // runs on an item that has ALREADY failed, so it can never CAUSE a failure —
    // that ordering is load-bearing: `=======` on its own is also a markdown
    // setext H1 underline, and `<<<<<<< HEAD` is an ordinary thing to paste into
    // a gotcha entry about a merge. A file that proves out is never asked.
    throw conflictFact(raw) ?? err;
  }
}

/**
 * The sealed-token floor is defined ONCE in `store/codec.ts`, derived from and
 * pinned to the codec's own seal frame (nonce ‖ ciphertext ‖ tag), and shared
 * with the store-mode GATE (`looksLikeEncryptedLog`, store/log.ts) so the two
 * layers can never disagree about what counts as sealed. It is re-exported here
 * because this module is where the suite pins it against the real codec, and
 * where export's OWN use of it lives (`decodePlainStore`).
 *
 * THE INVARIANT — the floor only ever asserts NOT-SEALED. A full
 * `ENCRYPTED_LINE_RE` match whose token is SHORTER than the floor is provably
 * not this codec's output, so it is the user's own text (§0.1) and exports
 * byte-verbatim. A token AT or ABOVE the floor proves NOTHING: it is the same
 * bytes as a line a person is free to type, and in a keyring-less store there
 * is no AEAD to ask — the only sound statement is the per-file factual
 * refusal (sealed content cannot be ruled out). HISTORY, so the misuse is not
 * reintroduced: an earlier floor (`MIN_SEALED_TOKEN`) was deleted from
 * `proveLog` (rounds 4–7) because it asserted the OPPOSITE direction — "long
 * enough, therefore sealed" — routing hand-typed prose to the sealed decoder
 * and delivering a key verdict on a healthy key. Length can prove a token too
 * short to be ciphertext; it can never prove one is.
 */
export { SEALED_TOKEN_FLOOR };

/**
 * A PLAINTEXT store's files export BYTE-VERBATIM — that is the §0.1 promise
 * (hand edits and all), and it is why no parse-proof runs here: a hand-kept
 * note or log that the store's parsers would refuse is still the user's own
 * readable text, and refusing it would be the inverse harm.
 *
 * One narrow per-file exception (Grok review, 2026-07-16): a file that VISIBLY
 * carries sealed material. The store-level gate (`storeHasSealedContent`,
 * store/keyring.ts) reads file HEADS, so sealed bytes it cannot see — the
 * `gestalt-enc:1:` magic pushed off offset 0 by a git conflict's
 * `<<<<<<< HEAD` (the same masking that bit `isPlaintextIn`), a sealed log
 * line behind conflict markers or union-merged into a plaintext log, or
 * sealed material past the head's byte limit — used to ride the verbatim copy
 * out AS THE USER'S CONTENT, with green success and exit 0. With no key there
 * is no AEAD to consult, so the check is exactly the visible evidence and no
 * more:
 *
 *  - notes/proposals: the sealed-format marker (`gestalt-enc:1:`) anywhere in
 *    the file. Its presence is an observation, not a verdict on the bytes —
 *    the refusal says a marker was SEEN, never that the bytes are sealed.
 *  - logs: a line the sealed grammar matches in FULL (`<ISO-ts> <base64url>`)
 *    whose token is long enough to be this codec's sealed output
 *    (`SEALED_TOKEN_FLOOR`) — in EITHER entry position. The discriminator is
 *    the codec's physics, never the line's position in the file: the previous
 *    rule waved through every shape match INSIDE a parsed entry as "body
 *    text", and a union merge's DEFAULT order lands a REAL sealed append
 *    exactly there — directly after a plaintext entry — so genuine ciphertext
 *    exported byte-verbatim from a keyring-less store: exit 0, `failed: 0`,
 *    raw base64url wearing the log's filename. Position also over-refused the
 *    other side: the canonized hand-typed one-liner
 *    (`2026-07-14T09:30:00.000Z deployed`, an 8-char token) was refused when
 *    it sat ABOVE the first entry. A sub-floor token is provably NOT sealed —
 *    the user's own line in any position, exported byte-verbatim. Prose
 *    cannot collide either way — a sealed token has no spaces. AND the
 *    marker (2026-07-16): a WHOLE-FILE sealed blob that lands AT a log path —
 *    a restore/copy mishap; the codec never writes one there — carries the
 *    magic at a line START (offset 0 or right after a newline, exactly where
 *    the codec writes it), and that is the same visible evidence the
 *    note/proposal branch refuses on, with the same wording. A mid-line
 *    mention in prose is the user's own text and never fires it.
 *
 * The refusal is the OBSERVATION the contract requires: what was seen (a
 * marker, a full shape match whose token is long enough to be sealed
 * content), and that this store has no key configured. No cause, no advice,
 * no verdict — and only that one file is withheld; everything else still
 * exports.
 */
function decodePlainStore(kind: ExportKind, raw: string): string {
  if (kind === "log") {
    const lines = raw.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // A WHOLE-FILE sealed blob landed at a log path (a restore/copy
      // mishap): the magic at a line START — offset 0 or right after a
      // newline, exactly where the codec writes it — is the same visible
      // evidence the note/proposal branch refuses on, and it gets the same
      // wording. A mid-line mention in prose never fires this. The test strips
      // a leading BOM/indent (`stripLeadingBomWs`) so a round-tripped blob whose
      // first line carries a BOM or indentation is still SEEN — the strip is
      // for DETECTION only; a genuinely plaintext line is still byte-verbatim in
      // the output (`return raw` below is untouched).
      if (stripLeadingBomWs(line).startsWith(ENC_MAGIC)) throw sealedMarkerFact();
      const t = line.trim();
      if (!ENCRYPTED_LINE_RE.test(t)) continue;
      // A full shape match. The token's length decides (SEALED_TOKEN_FLOOR):
      // below the floor it is provably not this codec's output — the user's
      // own line, exported verbatim; at or above it, sealed content cannot be
      // ruled out without a key, and this store has none.
      if (t.slice(t.indexOf(" ") + 1).length < SEALED_TOKEN_FLOOR) continue;
      throw new GestaltError(
        "E_STORE_MODE",
        `line ${i + 1} matches the sealed log-entry shape (token long enough to be sealed content) and this store has no key configured.`,
        OPEN_IT_HINT,
      );
    }
    return raw;
  }
  if (raw.includes(ENC_MAGIC)) throw sealedMarkerFact();
  return raw;
}

/** The marker observation, in the contract's ONE wording — a marker was SEEN,
 * and this store has no key configured. Never a verdict on the bytes. */
function sealedMarkerFact(): GestaltError {
  return new GestaltError(
    "E_STORE_MODE",
    `matches the sealed format (the "${ENC_MAGIC}" marker), but this store has no key configured.`,
    OPEN_IT_HINT,
  );
}

/**
 * Decode one whole-file blob (a note or a proposal) on an ENCRYPTED store —
 * the plaintext store went through `decodePlainStore` and never reaches here.
 *
 *  - **Sealed** (carries the `gestalt-enc:1:` magic) → decrypt.
 *  - **Everything else** → NOT plaintext-by-default. It is plaintext only if it
 *    PARSES as this kind. A git-conflicted sealed note, a truncated one, a
 *    half-sealed one and a note the user hand-wrote all lack the magic at offset
 *    0, and only the last is the user's readable content. The parse tells them
 *    apart; the price of getting it wrong is an export full of ciphertext
 *    wearing a note's filename, reported as a success.
 *
 * A plaintext file in an encrypted store is still **exportable, not a failure**:
 * it is readable, the user owns it, and export writes plaintext anyway.
 *
 * A magic-carrying file that does NOT open gets export's OWN fact — never the
 * codec's. The codec's refusal is "wrong key or tampered data", and at the
 * store layer that wording is right: there a failed open blocks a WRITE, and
 * the two named causes are the ones worth stopping for. Export repeating it is
 * the log fix's mirror image (`decodeSealedLog`): the AEAD's aad binds the
 * file's BASENAME, so renaming `topics/deal-notes.md` in a file manager — a
 * §0.1-sanctioned act — makes a healthy key draw that verdict. We observed two
 * things: it does not parse as this kind, and it did not open with the active
 * key. Which of rename / bit rot / wrong key happened, nothing here can know —
 * so the sentence states the observations and stops.
 */
function decodeWholeFile(
  kind: Exclude<ExportKind, "log">,
  src: string,
  raw: string,
): string {
  const id = path.basename(src).slice(0, -".md".length);
  if (raw.trimStart().startsWith(ENC_MAGIC)) {
    try {
      return decryptFile(src, raw);
    } catch {
      // Both observations are actually MADE before the sentence claims them:
      // the open just failed, and the parse is tried here. (A magic-prefixed
      // file cannot in practice parse — frontmatter starts `---` — but if one
      // ever did, positive proof through the store's own parser is the
      // module's standing definition of exportable, so it exports.)
      if (parsesAs(kind, raw, id)) return raw;
      throw new GestaltError(
        "E_SCHEMA",
        `neither parses as a ${kind} nor opens with the active key.`,
        OPEN_IT_HINT,
      );
    }
  }
  if (parsesAs(kind, raw, id)) return raw;
  throw new GestaltError(
    "E_SCHEMA",
    `does not start with "${ENC_MAGIC}" and does not parse as a ${kind}.`,
    OPEN_IT_HINT,
  );
}

/**
 * POSITIVE proof that these bytes are the user's own content: they parse through
 * the parser the runtime itself reads this kind with. `parseNote` gets the same
 * fallback id every other read path gives it (the filename), so export accepts
 * exactly what the store accepts — it can never refuse a note `get` or `cat`
 * would happily hand back.
 */
function parsesAs(kind: Exclude<ExportKind, "log">, raw: string, id: string): boolean {
  return kind === "note" ? parseNote(raw, id) !== null : parseProposal(raw) !== null;
}

/**
 * Decode one LOG on an ENCRYPTED store — the per-line half of the contract
 * (a plaintext store went through `decodePlainStore` and never reaches here).
 *
 * Logs are encoded per ENTRY (one opaque line each) so git `merge=union` can
 * concatenate cross-machine appends WITHOUT the key. That is the headline
 * feature, and it is also why the whole-file magic test is the wrong test here:
 * a log never carries the magic, so "no magic ⇒ plaintext" would dump every
 * sealed log's lines verbatim. Sealedness is per line, and it is proved by the
 * AEAD.
 *
 * Three outcomes, and the same standard as a whole file:
 *
 *  - **PLAIN** — every line is accounted for by the store's own plaintext log
 *    grammar ⇒ copy the file BYTE-IDENTICAL (§0.1: hand edits and all).
 *  - **SEALED** — decode the entries per LINE and re-emit canonical plaintext
 *    (`decodeSealedLog`). A line that does not open fails the FILE with
 *    export's own per-line fact — never with the log decoder's cause-naming
 *    refusal.
 *  - **Neither** — a factual failure. A MIXED log lands here: it is NOT
 *    unambiguous, so it is never waved through.
 */
function decodeLog(id: string, raw: string): string {
  const proof = proveLog(id, raw);
  if (proof.kind === "plain") return raw;
  if (proof.kind === "sealed") return decodeSealedLog(id, raw);
  throw new GestaltError("E_SCHEMA", `${proof.reason}.`, OPEN_IT_HINT);
}

/**
 * Decode a PROVEN-sealed log per LINE, inside export's own contract — never by
 * handing the whole file to `parseLog`, whose refusal names a cause ("wrong
 * key, tampered data, or a relocated log"). That delegation was the documented
 * KNOWN GAP (SPEC §5.1, 2026-07-16): `proveLog` concludes SEALED from ONE line
 * opening, while the whole-file decoder requires EVERY line to open — and in
 * the gap between those two facts lived the last cause-naming sentence export
 * could still emit. A sealed log with one bit-rotted line, or one line carried
 * in by `merge=union` from another topic's file, drew a verdict on a key that
 * was HEALTHY — the very key that had just opened the line proving the file
 * sealed. The refusal was correct; the reason was a lie.
 *
 * The iteration mirrors the store's own (`parseEncryptedLog`, store/log.ts) —
 * same normalization, same blank-line skip, same leading `# <id> log` skip,
 * same per-line AEAD open (tried as-is, then trimmed: `openSealedLine`, so the
 * decode opens everything classification opened), same entry parse, same
 * serialization — so the happy path (every line opens) emits canonical
 * plaintext byte-identical to before. Only the failure wording differs, and
 * only where the store's names a cause:
 *
 *  - A line that does not OPEN is reported as the two observations actually
 *    made — the same `unaccounted` sentence every other unprovable line gets —
 *    and the FILE is refused. Partial export of a sealed log is deliberately
 *    not offered: half a log wearing the log's filename invites the same
 *    misplaced trust as ciphertext wearing it.
 *  - A line that opens and then will not PARSE keeps the store's own fact
 *    verbatim ("decrypted but is unparsable"): the AEAD tag verified, so that
 *    sentence claims nothing about the key. It was already factual.
 *
 * `parseLog` is no longer reachable from this module at all, so no failure
 * path can surface its verdict through export — by accident or otherwise.
 */
function decodeSealedLog(id: string, raw: string): string {
  const lines = normalizeText(raw).split("\n");
  const entries: LogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue; // blank separator
    if (i === 0 && /^# \S+ log$/.test(line)) continue; // the `# <id> log` header
    const plain = openSealedLine(id, line);
    if (plain === null) {
      // The FACT, in export's own vocabulary. Both observations are real: no
      // line in a SEALED-classified log is a plaintext entry (`proveLog` ruled
      // MIXED out before routing here), and this line did not open — as-is OR
      // trimmed, so the sentence agrees with what `proveLog` measured.
      throw new GestaltError("E_SCHEMA", `${unaccounted(i + 1).reason}.`, OPEN_IT_HINT);
    }
    const parsed = parseEntry(plain);
    if (!parsed) {
      // The store's own fact for this case, verbatim (store/log.ts): it
      // DECRYPTED — the key demonstrably opens this store's data — and the
      // plaintext is still not an entry. No cause is named.
      throw new GestaltError(
        "E_CORRUPT_SKIPPED",
        "An encrypted log entry decrypted but is unparsable — corrupt entry.",
        OPEN_IT_HINT,
      );
    }
    entries.push(parsed);
  }
  return serializeLogPlain(id, entries);
}

type LogProof =
  | { kind: "plain" }
  | { kind: "sealed" }
  | { kind: "unprovable"; reason: string };

/**
 * Classify a log, using the store's own grammar and its own AEAD — never a
 * guess about what a line "looks like".
 *
 * **SEALED means it OPENED. Nothing else.** The shape of a sealed line
 * (`<ISO-ts> <base64url>`) proves nothing on its own, in any position, and no
 * measurement of it ever will — §0.1 says the user may hand edit, so every byte
 * of that shape is also a thing a person is free to type. Three rounds tried to
 * make shape safe with a length floor and each one shipped the same bug in a new
 * size, because the floor was answering a question that has no answer: the format
 * is genuinely ambiguous, and a discriminator over an ambiguous format is a
 * guess wearing a constant's name. The AEAD is the only thing here that KNOWS.
 *
 * So there are exactly two proofs, and both are positive:
 *
 *  - **Sealed** — a line OPENS under this log's key and topic id (`sealedAt`).
 *  - **Plain** — every line is accounted for by the store's own grammar
 *    (`provePlainLines`).
 *
 * Anything else is a file we cannot describe, and it says so — as a fact about
 * the line, never a verdict on the user's key. What was deleted here asserted
 * SEALED from a prefix match, handed a hand-kept plaintext log to `parseLog`, and
 * had the AEAD's failure to open a line that was never ciphertext reported as
 * **"wrong key, tampered data, or a relocated log"**: a verdict on a key that was
 * fine, delivered by the escape hatch, about a file that disproves it.
 */
function proveLog(id: string, raw: string): LogProof {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  // The two facts that classify the FILE, gathered independently of order —
  // union-merge decides which side lands first, and neither order is special.
  // Both are LOCATIONS of something proved, so a line number from either is a
  // line we actually have.
  const plainAt = lines.findIndex((l) => isEntryHeader(l));
  const sealedAt = lines.findIndex((l) => opensAsSealedEntry(id, l.trim()));

  // MIXED — plaintext entries AND sealed entries in one file. This is what a
  // union merge produces when one machine migrated to encrypted and the other
  // appended on an old build, and it is the one shape that must never be waved
  // through: half of it is the user's text and half is opaque, and no rule can
  // tell us which half the user was owed. Fail it as the fact it is.
  //
  // BOTH must be located. The claim "mixes plaintext and sealed entries" is then
  // always TRUE, because both were actually FOUND — and both line numbers name a
  // real line. Judged on shape, this branch could fire on a file with nothing
  // sealed in it at all, and then had to describe a sealed line it did not have.
  if (plainAt !== -1 && sealedAt !== -1) {
    return {
      kind: "unprovable",
      reason: `mixes plaintext and sealed entries (a plaintext entry on line ${
        plainAt + 1
      }, a sealed one on line ${sealedAt + 1})`,
    };
  }
  if (sealedAt !== -1) return { kind: "sealed" };

  // (a) POSITIVE proof, line by line: every line must be accounted for by the
  // store's own plaintext grammar. Anything left over is not proved to be the
  // user's text, and "not proved" is a failure, never a default.
  return provePlainLines(lines);
}

/**
 * Walk a candidate plaintext log and prove EVERY line. A line is the user's
 * readable text only if the grammar the store itself writes accounts for it:
 * the `# <id> log` H1, blank separators, a WELL-FORMED entry header, or body
 * text inside an entry.
 */
function provePlainLines(lines: string[]): LogProof {
  let inEntry = false;
  let sawContent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    const at = i + 1;

    if (t === "") continue; // blank separator
    if (!sawContent && /^# \S+ log$/.test(t)) {
      sawContent = true; // the `# <id> log` H1, which only leads the file
      continue;
    }
    sawContent = true;

    if (ENTRY_HEADER_RE.test(line)) {
      // Header POSITION: the shape alone is not enough. The store writes
      // `### <ts> | type | project | agent`, so anything else here is a file we
      // cannot prove is a log — `### <ts> | oops` is not an entry, it is a
      // question we have no answer to.
      if (!isEntryHeader(line)) {
        return { kind: "unprovable", reason: `line ${at} is not a well-formed entry header` };
      }
      inEntry = true;
      continue;
    }

    // Not inside an entry, so the plaintext grammar does not account for it, and
    // the AEAD did not open it (`sealedAt` was -1, above). Both things were
    // OBSERVED; what the line IS, we do not know. Say exactly that.
    if (!inEntry) return unaccounted(at);

    // BODY position. Ordinary text is the common case and needs no proof — it is
    // inside an entry the store's own parser accepted.
    if (!ENCRYPTED_LINE_RE.test(t)) continue;

    // …but this body line has the one shape a sealed entry also has, and the AEAD
    // has already answered for every line in this file: none opened. So it is
    // either text the user typed or a sealed entry that does not open HERE (one
    // relocated from another topic's log, a bit-rotted one, one sealed under a
    // key this store no longer holds), and nothing available to us tells those
    // apart — the two are the same bytes. Copying it out would hand the user
    // base64 as their memory, and the old length floor "resolved" the ambiguity
    // by guessing. AMBIGUOUS ⇒ fail, with the observation and nothing more.
    return unaccounted(at);
  }
  return { kind: "plain" };
}

/**
 * The FACT for a line we cannot account for: the store's own grammar does not
 * read it as an entry, and the AEAD does not open it. Two observations, both
 * made, neither explained.
 *
 * This sentence is load-bearing. It is what the ambiguous log gets INSTEAD of
 * being handed to `parseLog`, whose refusal is "wrong key, tampered data, or a
 * relocated log" — a cause, chosen from three, for a file that is just as likely
 * to be prose the user typed. We do not know which happened, so we name the line
 * and stop. No cause, no advice, no verdict on a key.
 */
function unaccounted(at: number): { kind: "unprovable"; reason: string } {
  return {
    kind: "unprovable",
    reason: `line ${at} is neither a readable log entry nor openable with the active key`,
  };
}

/** Is this line a well-formed `### <ts> | type | project | agent` entry header? */
function isEntryHeader(line: string): boolean {
  // The store's OWN parser, on the header line alone (a block with no body) — so
  // export accepts exactly the entries the runtime accepts, no more and no less.
  return ENTRY_HEADER_RE.test(line) && parseEntry(line) !== null;
}

/**
 * Open one sealed log line: as-is, then TRIMMED — the same tolerance
 * classification has (`proveLog` tests `l.trim()`). Classification and decode
 * MUST measure the same thing: a sealed line carrying editor-added leading
 * whitespace (§0.1 permits the hand edit; `decodeLogEntry` splits on the FIRST
 * space, so the indent shears the timestamp off) is exactly what proves the
 * file SEALED — and a decode that then tries only the raw line refuses the
 * file with "neither … nor openable with the active key" about a line that
 * demonstrably opens. That sentence would be FALSE, in the one module whose
 * whole contract is stating only true observations. The trimmed form that
 * opens IS the user's entry; recovering it is a strict improvement and keeps
 * the fact true. Returns the plaintext block, or null if neither form opens.
 */
function openSealedLine(id: string, line: string): string | null {
  const trimmed = line.trim();
  for (const candidate of line === trimmed ? [line] : [line, trimmed]) {
    try {
      return decodeLogEntry(id, candidate);
    } catch {
      /* try the trimmed form */
    }
  }
  return null;
}

/** Does this line AEAD-open as one of THIS log's sealed entries? */
function opensAsSealedEntry(id: string, line: string): boolean {
  if (!ENCRYPTED_LINE_RE.test(line)) return false;
  try {
    decodeLogEntry(id, line);
    return true;
  } catch {
    return false;
  }
}

/** topic id from a `logs/<id>.log.md` path — its AUTHENTICATED AEAD aad. */
function logIdOf(src: string): string {
  return path.basename(src).slice(0, -".log.md".length);
}

/** Export's own next step. `cat` re-anchors this to its subject (ops/cat.ts) —
 * "re-run: fimemory export" is the wrong advice inside a different command. */
export const OPEN_IT_HINT = `Open the file in a text editor to see what is in it, then re-run: fimemory export --plaintext "<fresh dir>"`;

/**
 * (b) Does this file carry git's conflict markers? If so, that is the fact worth
 * reporting: a git-synced store WILL produce them — notes are whole-file blobs
 * and a log without `merge=union` set conflicts too — and WHICH file is the one
 * thing the user needs from us.
 *
 * Naming it is safe because it is a statement about bytes that are PRESENT, not
 * an inference about bytes that are absent. All three shapes are required, and
 * this only ever runs on an item that already failed (see `decodeForExport`), so
 * it chooses the wording of a failure and can never cause one.
 */
function conflictFact(raw: string): GestaltError | null {
  const text = raw.replace(/\r\n?/g, "\n");
  const conflicted =
    /^<<<<<<< /m.test(text) && /^=======$/m.test(text) && /^>>>>>>> /m.test(text);
  return conflicted
    ? new GestaltError("E_SCHEMA", "contains git conflict markers.", OPEN_IT_HINT)
    : null;
}
