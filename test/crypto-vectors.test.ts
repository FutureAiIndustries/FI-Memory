import { describe, expect, it } from "vitest";
import {
  activateDek,
  clearActiveKey,
  decodeLedgerLine,
  decodeLogEntry,
  decryptFile,
  encodeLedgerLine,
  encodeLogEntry,
  encryptFile,
  LEDGER_ENC_MAGIC,
} from "../src/store/codec.js";
import { deriveDekFromMnemonic, deriveKid, STORE_MARKER_CONTENT } from "../src/store/keyring.js";

/**
 * ============================ FROZEN WIRE VALUES ============================
 *
 * Nothing in this file is test data. Every literal below is a byte that already
 * exists on somebody's disk, or a label that a 24-word phrase already ran
 * through to produce the key that opens it. These are the on-disk format of
 * every FIMemory store in the field, pinned so that a source change cannot move
 * them silently.
 *
 * WHY THIS FILE EXISTS. A `gestalt` -> `fimemory` rename sweep is scheduled. A
 * global search-and-replace does not distinguish a product name from a KDF
 * domain-separation label or an AEAD associated-data prefix, and the strings
 * below look exactly like branding:
 *
 *   gestalt/dek/v1            phrase -> DEK              (store/keyring.ts)
 *   gestalt/kid/v1            DEK -> key id              (store/keyring.ts)
 *   gestalt/subkeys/v1        DEK -> kNonce / kAead      (store/codec.ts)
 *   gestalt/file-nonce/v1     whole-file synthetic IV    (store/codec.ts)
 *   gestalt/log-nonce/v1      log-entry synthetic IV     (store/codec.ts)
 *   gestalt/ledger-nonce/v1   ledger-line synthetic IV   (store/codec.ts)
 *   gestalt/file/<kind>/<basename>   whole-file AEAD aad (store/codec.ts fileAad)
 *   gestalt/ledger/line/v1    ledger-line AEAD aad       (store/codec.ts)
 *   gestalt-enc:1:            sealed-blob magic          (both)
 *   gestalt-store:v1          store-mode marker plaintext (store/keyring.ts)
 *
 * Rename any of them and the damage is silent at the source and total at rest:
 * a `gestalt/dek/v1` edit makes every existing recovery phrase derive a
 * DIFFERENT key, so the 24 words the user wrote on paper stop being the master
 * secret they were promised; a `fileAad` edit makes every existing note,
 * proposal, index and marker fail its Poly1305 tag, which the codec correctly
 * reports as "wrong key or tampered data" on a store whose key is perfectly
 * fine. Both classes of break pass a normal round-trip suite with flying
 * colours, because a suite that seals and then opens under the same renamed
 * label is self-consistent. Only pinned bytes catch it.
 *
 * IF THIS FILE IS RED, THE FIX IS TO REVERT THE RENAME. Never re-bless a vector.
 * Re-recording these constants to match new source is not "updating the test":
 * it is deleting the only evidence that every store already written is about to
 * become unreadable, and it cannot be undone from the user's side — they have
 * the ciphertext and the phrase, and neither one will open the other again.
 * The one legitimate reason to change a value here is a deliberate, versioned
 * format bump (a `v2` label with a migration that reads `v1`), and that arrives
 * as a NEW vector alongside the old one, never as an edit to an old one.
 *
 * HOW EACH SEALED VECTOR IS ASSERTED — two assertions, because they catch
 * different renames and neither one subsumes the other:
 *
 *  1. Seal the fixed plaintext and compare to the pinned string. The codec's
 *     nonce is synthetic (nonce = PRF(kNonce, framed(aad, plaintext))), so the
 *     output is byte-stable, and this catches drift in the DEK, in the subkey
 *     label, and in any of the three nonce salts — all of which feed the nonce
 *     but are NOT authenticated, so a re-sealed blob under a renamed nonce salt
 *     still opens fine and would otherwise sail through.
 *
 *  2. Open the PINNED string (never a freshly sealed one) and compare to the
 *     plaintext. This is the only assertion in the codebase that can catch a
 *     `fileAad` rename: the aad is authenticated but never stored, so it exists
 *     nowhere except in the source and in the tag of bytes already at rest.
 *     Opening freshly-sealed output would round-trip happily under a renamed
 *     aad; opening a blob from BEFORE the rename is what fails.
 *
 * The DEK below is pinned as a literal and used directly, rather than piped in
 * from the mnemonic, so that a `gestalt/dek/v1` rename lights up exactly one
 * test (the derivation) instead of cascading through every sealed vector and
 * burying the actual cause.
 * ============================================================================
 */

/**
 * The published BIP39 all-zero-entropy test vector for 256 bits (24 words) —
 * 23x "abandon" + "art", the 24-word sibling of the well-known "abandon ...
 * about". Chosen precisely because it is famous: nobody can mistake it for a
 * real recovery phrase, and no real store is ever keyed by it. Its seed, and
 * therefore the DEK below, is fixed forever by the BIP39 spec.
 */
const TEST_PHRASE = [
  "abandon abandon abandon abandon abandon abandon",
  "abandon abandon abandon abandon abandon abandon",
  "abandon abandon abandon abandon abandon abandon",
  "abandon abandon abandon abandon abandon art",
].join(" ");

/** HKDF-SHA256(bip39_seed(TEST_PHRASE), info="gestalt/dek/v1", salt=empty, 32). */
const DEK_HEX = "a14bbb1a2338a441f2112b9508d05403e7f03f2b87b4a7cc47ab15588c6549c6";
/** HKDF-SHA256(DEK, info="gestalt/kid/v1", salt=empty, 8). */
const KID_HEX = "e6cdab46d52e1d36";

const DEK = Uint8Array.from(Buffer.from(DEK_HEX, "hex"));
const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");

/**
 * Fixed paths. `fileKind`/`fileAad` read only the basename and the immediate
 * parent segment, and neither `encryptFile` nor `decryptFile` touches the disk,
 * so these are pure strings — no temp store, and identical on every platform.
 */
const NOTE_PATH = "/frozen/.gestalt/topics/vector-note.md";
const NOTE_PLAIN = "---\nid: vector-note\ntitle: Vector Note\n---\n\nfrozen body\n";
const INDEX_PATH = "/frozen/.gestalt/index.json";
const INDEX_PLAIN = '{"version":1,"topics":[]}\n';
const PROPOSAL_PATH = "/frozen/.gestalt/proposals/1-vector-note.md";
const PROPOSAL_PLAIN = "---\nstatus: pending\n---\n\nfrozen patch\n";
const MARKER_PATH = "/frozen/.gestalt/store.enc";
const LOG_TOPIC = "vector-note";
const LOG_BLOCK = "### 2026-01-02T03:04:05.678Z | decision | frozen | vector\nfrozen entry body";
const LEDGER_PLAIN = '{"id":"ev-1","kind":"frozen"}';

/**
 * The sealed bytes themselves, recorded 2026-08-17 against the codec as shipped.
 * Whole-file blobs carry the trailing newline `encryptFile` writes; the log line
 * carries its plaintext ISO-ms prefix (the documented at-rest metadata leak) and
 * no magic, because logs are per-entry so `merge=union` can concatenate them.
 */
const SEALED_NOTE =
  "gestalt-enc:1:FisDZSJx0azJ6V6qAegD3NoGkEzgtw1u0fnv_0ik-scRQ4s9EOI1ZIiY1Bwezcg2glQA2EBjGeEjpEkS9u-JLncxkw9NnXF4M2zUzt2pSrnAJEoEUWZsousjsSC9pvCA\n";
const SEALED_INDEX =
  "gestalt-enc:1:q7ngEKM_CJvNUpn53hx4ezxxbPJ4hc9sp4OJCgjqO5rzTRqQ9-Q3ZKOi9yV9v4Z5sxmh7xzrllUWUAN8U2Ev9IMo\n";
const SEALED_PROPOSAL =
  "gestalt-enc:1:OTQ7aQhjyrD0yTGpCzZKos7w9CKE8xH_QK4jTe-BfdFfC4rZRs_kAVrObZexeFhMWtP02NMmuSiDw5CmBiKJAFev_uBOZXdW8XbMed7e\n";
const SEALED_MARKER =
  "gestalt-enc:1:EAvTtrn4gss2gL02-9G6Rx_SbvvgEGOXXghqpMXsAPqFdT-2V2tjOCWYokH_cYG9Zh2gHPfbbGTh\n";
const SEALED_LOG_LINE =
  "2026-01-02T03:04:05.678Z yxICiN_9YcL_EJyG-QGRD4nwukUwa7Uobq25HHWb5YrVmuEv1FgfyT3FZRUwxCyNrr_n2jQ7_bdQ4OJWRGMQCl71Z9w7tRMm2TiYKT-Q6M6NLi4UjlVITa0EZi-FMw1nLRL1KyHLy3dBZx8Ok0Aarkqg5w";
const SEALED_LEDGER_LINE =
  "gestalt-enc:1:VwOq3tlnEDEBzVuCsA-hlW966kdFMjUZP2P7fFOyZJyYDmBkKkf9KMqa5fg_j1JrPRFgQBI1X8AquMeRTLQ7rgE9eBgq";

describe("frozen crypto vectors — the tripwire the rename sweep has to trip", () => {
  it("the published 24-word BIP39 test phrase still derives the pinned DEK", () => {
    // Guards `gestalt/dek/v1`. A rename here silently invalidates every recovery
    // phrase ever handed to a user: same words, different key, unopenable store.
    expect(hex(deriveDekFromMnemonic(TEST_PHRASE))).toBe(DEK_HEX);
  });

  it("that DEK still derives the pinned key id", () => {
    // Guards `gestalt/kid/v1`. The kid is a hint, not integrity — but a drifted
    // kid makes `unlockWithPassphrase` reject the CORRECT key at `assertKid`,
    // and tells the user to restore a keyring backup that would not help.
    expect(deriveKid(DEK)).toBe(KID_HEX);
  });

  it("the sealed-blob magic and the store-marker plaintext are unchanged", () => {
    // Both are read by the pre-key store gate (`storeHasSealedContent`), which
    // runs BEFORE any key exists. Rename the magic and every sealed store reads
    // as plaintext to the gate; rename the marker content and `store.enc` stops
    // being the DEK-to-ciphertext oracle that binds a candidate key to a store.
    expect(LEDGER_ENC_MAGIC).toBe("gestalt-enc:1:");
    expect(STORE_MARKER_CONTENT).toBe("gestalt-store:v1\n");
  });

  describe("whole-file blobs sealed under the pinned DEK", () => {
    const cases: ReadonlyArray<{ kind: string; path: string; plain: string; sealed: string }> = [
      { kind: "note", path: NOTE_PATH, plain: NOTE_PLAIN, sealed: SEALED_NOTE },
      { kind: "index", path: INDEX_PATH, plain: INDEX_PLAIN, sealed: SEALED_INDEX },
      { kind: "proposal", path: PROPOSAL_PATH, plain: PROPOSAL_PLAIN, sealed: SEALED_PROPOSAL },
      { kind: "marker", path: MARKER_PATH, plain: STORE_MARKER_CONTENT, sealed: SEALED_MARKER },
    ];

    for (const c of cases) {
      it(`a ${c.kind} seals to the exact pinned bytes`, () => {
        // Assertion 1: catches DEK / subkey-label / file-nonce-salt drift. The
        // synthetic IV makes this deterministic, so any difference at all is a
        // real change to a key-derivation input, never flake.
        activateDek(DEK);
        try {
          expect(encryptFile(c.path, c.plain)).toBe(c.sealed);
        } finally {
          clearActiveKey();
        }
      });

      it(`a ${c.kind} sealed before the sweep still opens to its original plaintext`, () => {
        // Assertion 2, and THE one that matters: these bytes were sealed by a
        // build of the codec that no longer exists. Opening them exercises
        // `fileAad("<kind>", "<basename>")` as authenticated data — the aad is
        // never stored, so if the prefix, the kind token or the basename rule
        // moved, Poly1305 rejects and this throws E_STORE_MODE. That is the
        // exact failure every user in the field would hit on their own data.
        activateDek(DEK);
        try {
          expect(decryptFile(c.path, c.sealed)).toBe(c.plain);
        } finally {
          clearActiveKey();
        }
      });
    }

    it("the aad really is load-bearing — the note blob refuses to open under any other name or kind", () => {
      // Proves the open assertion above has teeth rather than passing because
      // the aad is ignored. A blob is pinned to its kind AND its filename, so
      // relocating a note or relabelling its kind must fail closed, not decrypt.
      activateDek(DEK);
      try {
        expect(() => decryptFile("/frozen/.gestalt/topics/other-note.md", SEALED_NOTE)).toThrow(
          /Could not decrypt/,
        );
        expect(() => decryptFile("/frozen/.gestalt/proposals/vector-note.md", SEALED_NOTE)).toThrow(
          /Could not decrypt/,
        );
      } finally {
        clearActiveKey();
      }
    });
  });

  it("a log entry seals to the exact pinned line and the pinned line still decodes", () => {
    // Logs are line-oriented (merge=union across machines) with their own nonce
    // salt `gestalt/log-nonce/v1` and an aad of `<topicId>\n<ts>` — no gestalt/
    // prefix, so a sweep leaves the aad alone but can still move the salt, which
    // only the byte-exact assertion sees.
    activateDek(DEK);
    try {
      expect(encodeLogEntry(LOG_TOPIC, LOG_BLOCK)).toBe(SEALED_LOG_LINE);
      expect(decodeLogEntry(LOG_TOPIC, SEALED_LOG_LINE)).toBe(LOG_BLOCK);
    } finally {
      clearActiveKey();
    }
  });

  it("a ledger line seals to the exact pinned line and the pinned line still decodes", () => {
    // Guards `gestalt/ledger-nonce/v1` (bytes) and `gestalt/ledger/line/v1`
    // (aad — decode-only, same reasoning as fileAad).
    activateDek(DEK);
    try {
      expect(encodeLedgerLine(LEDGER_PLAIN)).toBe(SEALED_LEDGER_LINE);
      expect(decodeLedgerLine(SEALED_LEDGER_LINE)).toBe(LEDGER_PLAIN);
    } finally {
      clearActiveKey();
    }
  });
});
