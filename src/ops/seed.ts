import { readEnv } from "../brand.js";
import type { Clock } from "../clock.js";
import type { Warning } from "../errors.js";
import { activateDek, clearActiveKey } from "../store/codec.js";
import { unlockWithPassphrase } from "../store/keyring.js";
import { createTopic } from "./create.js";
import { appendLog } from "./logOp.js";

/**
 * Seed-on-install starter topics (Lane F, F-A). A fresh store is empty on day
 * one, so the first search has nothing to find and the first log has nowhere
 * obvious to go. These three topics make minute-one retrieval real: what the
 * store is and how to work it (`getting-started`), a template for the user's
 * own projects/tools/machines (`working-rhythms`), and a decisions topic with
 * one worked example of the decision/supersede pair (`decisions`).
 *
 * Everything here goes through the REAL write path — `createTopic` +
 * `appendLog`, same locks, same validation, same token caps — never a direct
 * file write. That is deliberate: the seed doubles as a first-run exercise of
 * the store's own API, and a cap regression would fail the seed loudly instead
 * of shipping an over-budget starter store. The copy is mechanical and honest:
 * it describes what the commands do, and claims nothing that isn't measured.
 *
 * Seeding is separate from `runInit` (which stays sync — the Harness daemon
 * imports it) and composed by the CLI: `fimemory init` seeds by default,
 * `--no-seed` opts out.
 */

/** Provenance stamped on every seed entry (the `project` header field). */
export const SEED_PROJECT = "starter";
/** The agent label seed entries carry — same convention as the worked example. */
export const SEED_AGENT = "gestalt-runtime";

export const SEED_TOPIC_IDS = [
  "getting-started",
  "working-rhythms",
  "decisions",
] as const;

interface SeedEntrySpec {
  type: "decision" | "pattern" | "gotcha" | "convention" | "supersede";
  summary: string;
  /** Index (within this topic's entries) of the entry this one supersedes. */
  supersedesIndex?: number;
}

interface SeedTopicSpec {
  id: (typeof SEED_TOPIC_IDS)[number];
  title: string;
  /** `getting-started` collides (by design) with the worked example's alias. */
  force: boolean;
  entries: SeedEntrySpec[];
}

const SEED_TOPICS: SeedTopicSpec[] = [
  {
    id: "getting-started",
    title: "Getting started with your store",
    // The worked example topic carries a `getting-started` alias, so the fuzzy
    // collision check would (correctly) flag this id. The starter topic IS the
    // real getting-started topic; forcing past the alias is intentional.
    force: true,
    entries: [
      {
        type: "pattern",
        summary:
          "Search first: run `fimemory search <words>`, then `fimemory get <id>` on the top hit or two. Two well-chosen topics beat ten skimmed ones; every read has a token budget.",
      },
      {
        type: "convention",
        summary:
          "Capture as you go: when a session settles something (a decision, a gotcha, a convention), log one entry right then. Context that never gets logged is gone by the next session.",
      },
      {
        type: "pattern",
        summary:
          "Notes hold the curated summary; logs hold the append-only history. A suggested note edit only lands after you approve it: `fimemory review`.",
      },
    ],
  },
  {
    id: "working-rhythms",
    title: "Working rhythms: your projects, tools, and machines",
    force: false,
    entries: [
      {
        type: "convention",
        summary:
          "Template: give each active project its own topic. Log project decisions and gotchas there; keep this topic for how you work across all of them.",
      },
      {
        type: "convention",
        summary:
          "Template: list the AI tools you use (editor agent, chat, CLI) and how each one connects to this store. Log a gotcha the first time a tool trips on something.",
      },
      {
        type: "convention",
        summary:
          "Template: name your machines. When work spans more than one, log which machine a path, daemon, or credential lives on.",
      },
    ],
  },
  {
    id: "decisions",
    title: "Decisions: what was chosen and why",
    force: false,
    entries: [
      {
        type: "decision",
        summary:
          "EXAMPLE: keep memory in plain files a person can read in any editor. Replace this with your first real decision; one entry per decision, the choice plus the why.",
      },
      {
        type: "supersede",
        supersedesIndex: 0,
        summary:
          "EXAMPLE: a correction is a new supersede entry pointing at the old one by timestamp. The old entry stays in the log; nothing is rewritten.",
      },
    ],
  },
];

export interface SeedOptions {
  now?: Clock;
}

export interface SeedResult {
  /** Topic ids created, in creation order. */
  topics: string[];
  /** Total log entries appended across the seed topics. */
  entries: number;
  warnings: Warning[];
}

/**
 * Create the starter topics through the public store API. The store must
 * already exist (run `runInit` first) and, for an encrypted store, the DEK must
 * be active (the CLI unlocks around this call). Throws E_EXISTS if a seed topic
 * is already present — seeding is an init-time act, not an upsert.
 */
export async function seedStarterTopics(
  home: string,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const warnings: Warning[] = [];
  const topics: string[] = [];
  let entries = 0;

  for (const topic of SEED_TOPICS) {
    const created = await createTopic(home, topic.id, topic.title, {
      force: topic.force,
      ...(opts.now ? { now: opts.now } : {}),
    });
    warnings.push(...created.warnings);
    topics.push(topic.id);

    // Timestamps come back from appendLog so a supersede entry can point at
    // the real server-assigned timestamp of its target — the same contract a
    // live `fimemory log --supersedes` call has to honor.
    const stamped: string[] = [];
    for (const e of topic.entries) {
      const r = await appendLog(
        home,
        topic.id,
        {
          type: e.type,
          project: SEED_PROJECT,
          agent: SEED_AGENT,
          summary: e.summary,
          ...(e.supersedesIndex !== undefined
            ? { supersedes: stamped[e.supersedesIndex]! }
            : {}),
        },
        opts.now ? { now: opts.now } : {},
      );
      stamped.push(r.timestamp);
      warnings.push(...r.warnings);
      entries += 1;
    }
  }

  return { topics, entries, warnings };
}

export interface SeedAfterInitOptions {
  /** True when `runInit` just created the store encrypted. */
  encrypted: boolean;
  /**
   * The raw `--passphrase` flag value if the flag was present (may be `""`).
   * Selection MIRRORS runInit exactly — a TRUTHY flag wins, else
   * GESTALT_PASSPHRASE — so the seed always unlocks with the same passphrase
   * the store was just created with. (`??`-style presence semantics here once
   * made `--passphrase ""` + env diverge: init used the env, the seed derived
   * with "", and the failed unlock aborted init AFTER the store existed but
   * BEFORE the shown-once mnemonic printed — losing it forever.)
   */
  passphraseFlag?: string;
  /** Env to read GESTALT_PASSPHRASE from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  now?: Clock;
}

export interface SeedAfterInitResult {
  /** Present when seeding succeeded. */
  seeded?: SeedResult;
  /**
   * Present when seeding failed. The INIT ITSELF ALREADY SUCCEEDED — the
   * caller must still report the init result (above all, the shown-once
   * mnemonic of an encrypted store) and surface this as a warning, never as a
   * failure of the init.
   */
  seedError?: string;
}

/**
 * The CLI's init→seed composition, fault-isolated: unlock an encrypted store
 * around the seed writes (clearing the DEK after, same "unlock explicitly"
 * contract runInit keeps), and CONTAIN every seed failure as `seedError`
 * instead of throwing — a failed seed must never eat the init output. Never
 * throws.
 */
export async function seedAfterInit(
  home: string,
  opts: SeedAfterInitOptions,
): Promise<SeedAfterInitResult> {
  try {
    if (opts.encrypted) {
      const env = opts.env ?? process.env;
      const passphrase = opts.passphraseFlag
        ? opts.passphraseFlag
        : readEnv("PASSPHRASE", env);
      if (passphrase === undefined) {
        return { seedError: "no passphrase available to unlock the new store" };
      }
      activateDek(unlockWithPassphrase(home, passphrase));
    }
    const seeded = await seedStarterTopics(home, opts.now ? { now: opts.now } : {});
    return { seeded };
  } catch (err) {
    return { seedError: err instanceof Error ? err.message : String(err) };
  } finally {
    if (opts.encrypted) clearActiveKey();
  }
}
