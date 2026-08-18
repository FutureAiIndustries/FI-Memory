/**
 * Frozen on-disk wire constants. This module imports NOTHING, on purpose.
 *
 * These strings are not branding. They are the format itself: every sealed file
 * in every store that has ever existed begins with ENC_MAGIC, and every reader
 * decides "is this ciphertext or is this plaintext" by testing for it. Change
 * the string and every existing sealed file reclassifies as plaintext to the
 * very code that is supposed to protect it.
 *
 * WHY THIS MODULE EXISTS. Until 2026-08-17 the literal was declared twice —
 * once in codec.ts and once, privately, in keyring.ts. The two copies served
 * different jobs: codec seals and opens with it, while keyring's pre-key GATE
 * finders use it to recognise sealed files on disk before any key is available.
 * A rename sweep that caught only one copy would leave the gate unable to see
 * ciphertext it was looking straight at — and the frozen-vector tests, which
 * pin codec's copy, would have stayed green through it. Found by the agent that
 * wrote those vectors, as a gap in its own coverage.
 *
 * De-duplicating beats adding a second vector: one constant cannot drift from
 * itself, and a test can only catch drift somebody remembered to test for.
 *
 * It is a LEAF module because codec.ts and keyring.ts already import each other.
 * Hanging the shared constant off either one would deepen that cycle, and this
 * area has already produced one temporal-dead-zone failure that only a
 * load-order test caught. A module with no imports cannot participate in a cycle.
 *
 * If you are here because a rename sweep flagged these: revert the rename. A
 * deliberate format change arrives as a NEW versioned constant beside the old
 * one, never as an edit to this line. See test/crypto-vectors.test.ts.
 */

/** Prefix on every sealed file, sealed log entry and sealed ledger line. */
export const ENC_MAGIC = "gestalt-enc:1:";
