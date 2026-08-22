import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { EXAMPLE_ID } from "../example.js";
import { fsPath, storePaths } from "../paths.js";
import { peekSessionDek } from "../sessionKeyCache.js";
import { activateDek, clearActiveKey, decryptFile, keyState } from "../store/codec.js";
import { assertEnvKeyMatchesStore } from "../store/keyring.js";
import { parseLog } from "../store/log.js";
import { NOTE_TEMPLATE_MARKER, parseNote } from "../store/note.js";
import { asString, parseYaml, splitFrontmatter } from "../store/frontmatter.js";
import { SEED_AGENT, SEED_TOPIC_IDS } from "./seed.js";

/**
 * Content readiness — the second score.
 *
 * Both independent assessments of the 2026-08-05 Mac beta install
 * (hank-e-d/mac-store, recommendations/) converged on one structural finding:
 * `doctor` measures CONNECT (store present, MCP registered, rules written,
 * hooks resolve) and calls that "Healthy", while CONTENT — does the store hold
 * one true fact about its owner? — is measured nowhere. A never-used store and
 * a store in daily use gave the same report, and the difference between them
 * is the product working or not: retrieval fires by machinery on every prompt,
 * so an empty store is a search tax, strictly worse than no store.
 *
 * This module answers the content question with the same discipline doctor
 * applies to everything else: read-only, never deriving a key, and every
 * threshold named. Plaintext stores are scanned directly; an encrypted store
 * is scanned only when a NON-DERIVING key source is at hand
 * (`assessContentSealed` — in-process key or warm session cache), and reports
 * "not assessed" otherwise rather than a comparison that was not made.
 *
 * WHAT COUNTS AS "REAL". Seed topics and the worked example ship with every
 * store and are stamped `agent: gestalt-runtime` (SEED_AGENT) — as are the
 * bookkeeping entries the runtime appends on proposal approval. Anything else
 * (`cli`, `mcp`, an agent's own name) had to come from outside the runtime,
 * which is exactly the question being asked. Topic ids in TUTORIAL_TOPIC_IDS
 * are shipped content; every other topic is the user's own.
 */

/** Topics that ship with a fresh store — seeds plus the worked example. Both
 * halves imported from their writers (seed.ts, example.ts), so a renamed seed
 * cannot silently start counting as the user's own content. */
export const TUTORIAL_TOPIC_IDS: ReadonlySet<string> = new Set([
  ...SEED_TOPIC_IDS,
  EXAMPLE_ID,
]);

/** Pending proposals at or past this share of the cap draw a warning — the
 * ceiling (`maxPendingProposals`) otherwise arrives as a hard refusal the
 * operator was never told was approaching. */
export const PROPOSAL_CAP_WARN_RATIO = 0.8;

export interface ContentReadiness {
  /** True when the store's content could actually be inspected. */
  assessed: boolean;
  /** Why not, when it could not. */
  reason?: string;
  topicsTotal: number;
  /** Topic ids (shipped or user's) whose note still carries the untouched
   * "Newly created —" template body. */
  templateTopics: string[];
  /** Topic ids that are neither seeds nor the worked example. */
  realTopics: string[];
  /** Log entries across all topics written by anything other than the runtime
   * itself (agent !== SEED_AGENT). */
  realLogEntries: number;
  pendingProposals: number;
  maxPendingProposals: number;
  /** ISO `created` of the oldest pending proposal; null when none pending. */
  oldestPendingCreated: string | null;
  /** True when at least one pending proposal was staged by the runtime itself
   * (the install-time worked example) — the trust loop has never been run. */
  seedProposalPending: boolean;
  /** The verdict: the store holds something true about its owner — a real log
   * entry, or a topic of their own with a curated (non-template) body. */
  hasUserContent: boolean;
}

const NOT_ASSESSED: Omit<ContentReadiness, "assessed" | "reason"> = {
  topicsTotal: 0,
  templateTopics: [],
  realTopics: [],
  realLogEntries: 0,
  pendingProposals: 0,
  maxPendingProposals: 0,
  oldestPendingCreated: null,
  seedProposalPending: false,
  hasUserContent: false,
};

/**
 * Read-only, synchronous content scan of a PLAINTEXT store. Callers gate on
 * store mode (doctor passes an encrypted store to `notAssessed` instead of
 * here). Damage tolerance is PER FILE and total: an unreadable file, an
 * unparsable note, or a log parseLog refuses (mode/key mismatch, conflict
 * markers) is skipped, never thrown — doctor's whole surface is a diagnostic,
 * and a diagnostic that dies on the store it is diagnosing reports nothing at
 * all. Parse-level damage is doctor's index checks' job to REPORT; this scan
 * only answers "is there user content".
 */
export function assessContent(
  home: string,
  opts: { decoded?: boolean } = {},
): ContentReadiness {
  const paths = storePaths(home);
  const decoded = opts.decoded === true;
  let maxPendingProposals: number;
  try {
    maxPendingProposals = loadConfig(paths.config).config.maxPendingProposals;
  } catch {
    return { assessed: false, reason: "store config could not be read", ...NOT_ASSESSED };
  }

  // ── Topics: template bodies + which are the user's own ────────────────────
  const templateTopics: string[] = [];
  const realTopics: string[] = [];
  let topicsTotal = 0;
  let curatedRealTopic = false;
  let decodeFailures = 0;
  const dir = (d: string, ext: string): Array<{ id: string; text: string }> => {
    const r = readDir(d, ext, decoded);
    decodeFailures += r.decodeFailures;
    return r.entries;
  };
  for (const { id, text } of dir(paths.topicsDir, ".md")) {
    const note = parseNote(text, id);
    if (!note) continue; // unparsable notes are doctor's `notes_unparsable` finding, not ours
    topicsTotal += 1;
    const isTemplate = note.body.includes(NOTE_TEMPLATE_MARKER);
    if (isTemplate) templateTopics.push(id);
    if (!TUTORIAL_TOPIC_IDS.has(id)) {
      realTopics.push(id);
      if (!isTemplate) curatedRealTopic = true;
    }
  }

  // ── Logs: entries the runtime did not write itself ────────────────────────
  let realLogEntries = 0;
  for (const { id, text } of dir(paths.logsDir, ".log.md")) {
    // parseLog THROWS on a mode/key mismatch — a stale GESTALT_KEY over a
    // plaintext store, or a hand-edited line its encrypted-shape heuristic
    // trips on (log.ts's own §0.1 example). doctor is gate-exempt, so nothing
    // upstream has validated that env var; an unguarded call here crashed the
    // whole doctor report with zero findings. Skip the file, same tolerance
    // readDir applies — the entries we cannot read simply do not count.
    try {
      const { entries } = parseLog(text, id);
      realLogEntries += entries.filter((e) => e.agent !== SEED_AGENT).length;
    } catch {
      continue;
    }
  }

  // ── Proposals: pending count, age, and the pre-staged trust-loop one ──────
  // A sync mirror of store/proposals.ts' listProposals (that one is async and
  // decrypts; doctor's whole surface is sync + plaintext). Same frontmatter
  // fields, same skip-on-unparsable tolerance.
  let pendingProposals = 0;
  let oldestPendingCreated: string | null = null;
  let seedProposalPending = false;
  for (const { text } of dir(paths.proposalsDir, ".md")) {
    const split = splitFrontmatter(text);
    if (!split) continue;
    const data = parseYaml(split.yaml);
    if (!data) continue;
    if (asString(data["status"]) !== "pending") continue;
    pendingProposals += 1;
    const created = asString(data["created"]);
    if (created !== null && (oldestPendingCreated === null || created < oldestPendingCreated)) {
      oldestPendingCreated = created;
    }
    // The staged worked-example proposal carries `proposer: gestalt-runtime`
    // (example.ts, the literal in its frozen proposal body) — the same string
    // as SEED_AGENT. If example.ts ever changes its proposer, this match must
    // move with it.
    if (asString(data["proposer"]) === SEED_AGENT) seedProposalPending = true;
  }

  // A sealed file the available key could not open means the numbers above are
  // not the store's numbers. "Assessed, empty" over an unreadable store is a
  // WRONG report delivered confidently — the exact defect this module's
  // not-assessed contract exists to prevent. (A stale key mid-rotation and a
  // mixed-mode store both land here; doctor's own findings name those.)
  if (decoded && decodeFailures > 0) {
    return notAssessed(
      `${String(decodeFailures)} sealed file(s) could not be decoded with the available key — content was not inspected`,
    );
  }

  return {
    assessed: true,
    topicsTotal,
    templateTopics,
    realTopics,
    realLogEntries,
    pendingProposals,
    maxPendingProposals,
    oldestPendingCreated,
    seedProposalPending,
    hasUserContent: realLogEntries > 0 || curatedRealTopic,
  };
}

/** A `ContentReadiness` for the store that could not be inspected, with the
 * reason stated — "unverified, not clean", same contract as doctor's
 * `index_unverified`. */
export function notAssessed(reason: string): ContentReadiness {
  return { assessed: false, reason, ...NOT_ASSESSED };
}

/** Yield `{id, text}` for every `*.<ext>` file in `dir`; missing or unreadable
 * dirs yield nothing (a store with no proposals/ yet is not a finding). */
function readDir(
  dir: string,
  ext: string,
  decode = false,
): { entries: Array<{ id: string; text: string }>; decodeFailures: number } {
  let files: string[];
  try {
    files = readdirSync(fsPath(dir));
  } catch {
    return { entries: [], decodeFailures: 0 };
  }
  const entries: Array<{ id: string; text: string }> = [];
  let decodeFailures = 0;
  for (const f of files) {
    if (!f.endsWith(ext)) continue;
    const full = path.join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(fsPath(full), "utf8");
    } catch {
      // Unreadable file: skip. Parse-level damage is reported by doctor's
      // index checks; this scan only answers "is there user content".
      continue;
    }
    if (!decode) {
      entries.push({ id: path.basename(f, ext), text: raw });
      continue;
    }
    // The sealed path (0.5): route the bytes through the codec — identity for
    // kinds that are not whole-file sealed (logs decode per entry inside
    // parseLog), decrypt-or-throw for notes and proposals. A file the key
    // cannot open is COUNTED, not skipped: the caller downgrades the whole
    // report to not-assessed rather than presenting a partial count as truth.
    try {
      entries.push({ id: path.basename(f, ext), text: decryptFile(full, raw) });
    } catch {
      decodeFailures += 1;
    }
  }
  return { entries, decodeFailures };
}

/**
 * Content assessment for an ENCRYPTED store doctor already judged unlocked —
 * without ever deriving a key (doctor's standing promise). Two non-deriving
 * sources, in trust order: a key that is already in-process (an activated DEK
 * — the interactive-onboard case — or the GESTALT_KEY doctor validated), else
 * the warm session cache, read by pure PEEK (doctor never writes — no sweep,
 * no wipe) and given the same verify-before-trust the CLI gate applies; the
 * process key state is restored afterwards.
 *
 * Before 0.5 every encrypted store reported "content: not assessed" forever —
 * with encryption the DEFAULT, that meant the Content half of the product's
 * own scoreboard (doctor, onboard's two scores, `content_empty`) simply never
 * ran for a new user. This is the repair.
 */
export function assessContentSealed(home: string, ttlMs: number): ContentReadiness {
  if (keyState().mode !== "plaintext") {
    return assessContent(home, { decoded: true });
  }
  const hex = ttlMs > 0 ? peekSessionDek(home, Date.now(), { ttlMs }) : null;
  if (hex === null) {
    return notAssessed("encrypted store — the warm session key expired mid-report; unlock and run doctor again");
  }
  try {
    assertEnvKeyMatchesStore(home, hex);
  } catch {
    return notAssessed("encrypted store — the cached session key does not open it");
  }
  activateDek(Uint8Array.from(Buffer.from(hex, "hex")));
  try {
    return assessContent(home, { decoded: true });
  } finally {
    clearActiveKey();
  }
}
