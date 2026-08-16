import { msFromIso } from "../clock.js";
import { unlinkSync } from "node:fs";
import { runInit } from "../commands/init.js";
import { fsPath, proposalPath, topicLogPath, topicNotePath } from "../paths.js";
import { yamlInlineArray, yamlQuote } from "../store/frontmatter.js";
import { createTopic } from "./create.js";
import { appendLog } from "./logOp.js";
import { reindexStore } from "./reindexOp.js";
import { reviewApprove } from "./review.js";
import { updateTopic } from "./update.js";
import { DEMO_PENDING_EDIT, DEMO_TOPICS } from "./demoStoreData.js";
import type { DemoTopicData } from "./demoStoreData.js";

/**
 * Demo store builder (Lane F, F-D). Builds a browsable store out of the
 * content in demoStoreData.ts: a small design studio (Pinemoor Studio), its
 * clients and its internal practice.
 *
 * That content is INVENTED, start to finish. It used to be the owner's real
 * project notes, which shipped inside the published package and handed every
 * installer a pile of private history; that is why it is invented now, and
 * why it must stay invented. Nothing real goes in this file's data source.
 * The store still reads as one person's working notes, because that is what
 * makes it useful to browse: nothing inside it announces itself as an
 * illustration, and the banned-language sweep in the tests keeps it that way.
 *
 * Everything still goes through the REAL runtime API — `runInit`,
 * `createTopic`, `appendLog`, `updateTopic` + `reviewApprove` — so the
 * builder remains a standing end-to-end exercise of the write path. The two
 * deliberate exceptions, both structural not content-authoring: the init
 * worked-example files are removed (store-meta tutorial content, and its
 * fixed stamp pins the monotonic clock floor above the real history's dates)
 * followed by a real `reindexStore` to reset the floor.
 *
 * DETERMINISTIC by construction: every event timestamp is a baked literal in
 * demoStoreData.ts (an invented but internally consistent chronology, with
 * reversals and late-arriving gotchas in it), appends run in one global
 * chronological order, and the note/approve pass uses a fixed stepping clock
 * after the last entry — two builds produce byte-identical stores.
 */

const HOUR_MS = 3_600_000;
const STEP_MS = 60_000;

export interface DemoStoreResult {
  home: string;
  /** Demo topic ids created. */
  topics: string[];
  /** Total log entries appended across the demo topics. */
  entries: number;
  /** Curated-note proposals approved through the review path. */
  approved: number;
  /** Suggested edits deliberately left pending. */
  pending: number;
}

/**
 * A full proposed-note text. Since the propose path preserves base
 * frontmatter (body-only by design, the 7/27 mangle fix), everything above
 * the body here is ignored on approve — it exists only so the document
 * parses as a valid note.
 */
function proposedNote(spec: DemoTopicData, body: string): string {
  return [
    "---",
    `id: ${spec.id}`,
    `title: ${yamlQuote(spec.title)}`,
    `aliases: ${yamlInlineArray([])}`,
    `tags: ${yamlInlineArray([])}`,
    `projects: ${yamlInlineArray([])}`,
    "updated: null",
    "compactedThrough: null",
    "---",
    "",
    body,
    "",
    "## Owner notes",
    "",
  ].join("\n");
}

/**
 * Build the browsable store at `home` (must not already hold a store —
 * `runInit` refuses with E_EXISTS). Plaintext on purpose: this store is for
 * showing, and the plaintext path is the deterministic one.
 */
export async function buildDemoStore(home: string): Promise<DemoStoreResult> {
  runInit({ home });

  // Structural reset (see module docs): drop the worked example (note, log,
  // and its sample proposal), rebuild the catalog so the monotonic floor and
  // the proposal seq both start from the real history alone.
  for (const p of [
    topicNotePath(home, "gestalt-example"),
    topicLogPath(home, "gestalt-example"),
    proposalPath(home, 1, "gestalt-example"),
  ]) {
    try {
      unlinkSync(fsPath(p));
    } catch {
      /* absent on some init shapes — nothing to remove */
    }
  }
  await reindexStore(home);

  // One global chronological stream: creates strictly before their topic's
  // first entry, everything ascending so the server-timestamp guard holds.
  interface Ev {
    kind: "create" | "log";
    ms: number;
    t: DemoTopicData;
    idx?: number;
  }
  const events: Ev[] = [];
  for (const t of DEMO_TOPICS) {
    const first = msFromIso(t.entries[0]!.ts);
    events.push({ kind: "create", ms: first - HOUR_MS, t });
    t.entries.forEach((e, idx) => events.push({ kind: "log", ms: msFromIso(e.ts), t, idx }));
  }
  events.sort((a, b) => a.ms - b.ms || (a.kind === "create" ? -1 : 1));

  const stamped = new Map<string, string>(); // `${topicId}#${entryIdx}` → server timestamp
  let entries = 0;
  for (const ev of events) {
    const clock = { now: () => ev.ms };
    if (ev.kind === "create") {
      await createTopic(home, ev.t.id, ev.t.title, clock);
    } else {
      const e = ev.t.entries[ev.idx!]!;
      const supersedes =
        e.supersedesIndex !== undefined ? stamped.get(`${ev.t.id}#${e.supersedesIndex}`) : undefined;
      const r = await appendLog(
        home,
        ev.t.id,
        {
          type: e.type,
          project: e.project,
          agent: e.agent,
          summary: e.summary,
          ...(supersedes ? { supersedes } : {}),
        },
        clock,
      );
      stamped.set(`${ev.t.id}#${ev.idx!}`, r.timestamp);
      entries += 1;
    }
  }

  // Curated bodies through the real trust loop (propose → approve), on a
  // fixed stepping clock after the last entry.
  let t = Math.max(...events.map((e) => e.ms)) + HOUR_MS;
  const clock = (): number => {
    t += STEP_MS;
    return t;
  };
  let approved = 0;
  for (const spec of DEMO_TOPICS) {
    const { seq } = await updateTopic(home, spec.id, proposedNote(spec, spec.body), {
      proposer: "team",
      now: clock,
    });
    await reviewApprove(home, seq, { now: clock });
    approved += 1;
  }

  // Leave one suggested edit pending so `review` / the Inbox has something
  // real to show.
  const target = DEMO_TOPICS.find((s) => s.id === DEMO_PENDING_EDIT.id)!;
  await updateTopic(
    home,
    target.id,
    proposedNote(target, target.body + "\n\n" + DEMO_PENDING_EDIT.addition),
    { proposer: DEMO_PENDING_EDIT.proposer, now: clock },
  );

  return {
    home,
    topics: DEMO_TOPICS.map((s) => s.id),
    entries,
    approved,
    pending: 1,
  };
}
