import { createHash } from "node:crypto";
import { insertionDiff } from "./diff.js";
import { countTokens } from "./tokens.js";
import type { IndexEntry, StoreIndex } from "./store/index.js";
import { splitOwnerNotes } from "./store/ownerNotes.js";

/**
 * The `gestalt-example` worked example (SPEC §5.1 init + §9). It exists so a
 * first-run user can experience search → get → log → review-approve in under
 * ten minutes without editing any file by hand. It demonstrates, in one topic:
 * owner notes, all five log entry types, and one pending proposal to approve.
 *
 * Everything here is deterministic (fixed timestamps, canned prose) on purpose:
 * the example is a stable teaching artifact, and its `baseHash` must match the
 * note bytes `init` writes so the pending edit is genuinely approvable later.
 * Server-assigned "now" timestamps apply to live `log`/append ops, not to this
 * seed content.
 */

export const EXAMPLE_ID = "gestalt-example";

// Fixed, ordered timestamps for the seed log (monotonic, distinct ms).
const T_DECISION = "2026-07-11T00:00:01.000Z";
const T_PATTERN = "2026-07-11T00:00:02.000Z";
const T_GOTCHA = "2026-07-11T00:00:03.000Z";
const T_CONVENTION = "2026-07-11T00:00:04.000Z";
const T_SUPERSEDE = "2026-07-11T00:00:05.000Z";
const T_UPDATED = T_SUPERSEDE;
const T_PROPOSAL = "2026-07-11T00:00:06.000Z";

const FRONTMATTER = `---
id: ${EXAMPLE_ID}
title: "FIMemory Example — Start Here"
aliases: [example, getting-started]
tags: [gestalt, tutorial]
projects: [gestalt]
updated: ${T_UPDATED}
compactedThrough: null
---
`;

// Body paragraphs for the *current* (Old) note.
const INTRO =
  "This is a worked example topic. It's here so you can try the whole loop — search, read, log, and approve a suggested edit — without editing any file by hand.";

const HOW_IT_WORKS =
  "A topic lives in plain Markdown files under your home folder: this note (the curated summary you're reading), an append-only log of what changed and why, and any suggested edits waiting for your approval. The files are the source of truth; the runtime just keeps them structured and every read within a budget.";

const TRY_THIS =
  "Try it: run `fimemory search budget`, then `fimemory get gestalt-example`, then `fimemory review` to see the suggested edit waiting for you.";

// The paragraph the pending proposal wants to add (main body, not owner notes).
const PROPOSED_ADDITION =
  "When you approve that edit, the runtime replaces this note with the approved version and records who suggested it. That human approval is the only way curated truth ever changes.";

const OWNER_HEADING = "## Owner notes";
const OWNER_BODY =
  "This section is yours. The runtime will never change it through a suggested edit — if a proposed edit touches these lines, approval is refused. Put anything here you want protected from automated edits.";

function assembleNote(bodyParas: string[]): { note: string; body: string } {
  const body =
    "\n" +
    bodyParas.join("\n\n") +
    "\n\n" +
    OWNER_HEADING +
    "\n" +
    OWNER_BODY +
    "\n";
  return { note: FRONTMATTER + body, body };
}

const OLD = assembleNote([INTRO, HOW_IT_WORKS, TRY_THIS]);
const NEW = assembleNote([INTRO, HOW_IT_WORKS, TRY_THIS, PROPOSED_ADDITION]);

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const LOG = `# ${EXAMPLE_ID} log

### ${T_DECISION} | decision | gestalt | gestalt-runtime
Ship a worked example topic with every new store so a first run is never empty.

### ${T_PATTERN} | pattern | gestalt | gestalt-runtime
Search first, then read one to three topics — don't browse the whole store.

### ${T_GOTCHA} | gotcha | gestalt | gestalt-runtime
Every read is capped by a budget; a large topic can come back truncated with a marker. Ask for fewer topics or a shorter log tail.

### ${T_CONVENTION} | convention | gestalt | gestalt-runtime
Log entries are one of five types: decision, pattern, gotcha, convention, supersede. Corrections are new supersede entries, never edits to old ones.

### ${T_SUPERSEDE} | supersede | gestalt | gestalt-runtime | supersedes:${T_DECISION}
The example now also ships a pending suggested edit, not just the seed note.
`;

function buildProposal(): { seq: number; filename: string; content: string } {
  const seq = 1;
  const baseHash = "sha256:" + sha256Hex(OLD.note);
  const newHash = "sha256:" + sha256Hex(NEW.note);
  const diff = insertionDiff(
    OLD.note,
    NEW.note,
    "topics/gestalt-example.md (current)",
    "topics/gestalt-example.md (proposed)",
  );
  // Old/New notes are wrapped in a 4-backtick fence so any 3-backtick code block
  // inside a note can't prematurely close the block (SPEC §5.6, rev 4, #2); the
  // fenced content re-hashes to baseHash/newHash, which approve verifies.
  const content = `---
seq: ${seq}
id: ${EXAMPLE_ID}
status: pending
proposer: gestalt-runtime
created: ${T_PROPOSAL}
compactedThrough: null
baseUpdated: ${T_UPDATED}
baseHash: ${baseHash}
newHash: ${newHash}
---

## Old
\`\`\`\`markdown
${OLD.note}\`\`\`\`

## New
\`\`\`\`markdown
${NEW.note}\`\`\`\`

## Diff
\`\`\`diff
${diff}\`\`\`
`;
  return { seq, filename: `${seq}-${EXAMPLE_ID}.md`, content };
}

export interface ExampleArtifacts {
  id: string;
  note: string;
  log: string;
  proposal: { seq: number; filename: string; content: string };
  index: StoreIndex;
}

/**
 * Build the complete, self-consistent example store artifacts. Pure and
 * deterministic — `init` writes these bytes verbatim.
 */
export function buildExample(): ExampleArtifacts {
  const proposal = buildProposal();
  const entry: IndexEntry = {
    id: EXAMPLE_ID,
    title: "FIMemory Example — Start Here",
    aliases: ["example", "getting-started"],
    tags: ["gestalt", "tutorial"],
    projects: ["gestalt"],
    updated: T_UPDATED,
    // noteTokens counts the body *before* the ## Owner notes section (SPEC §5.7, rev 4).
    noteTokens: countTokens(splitOwnerNotes(OLD.body).beforeOwner),
    logEntries: 5,
    compactedThrough: null,
  };
  return {
    id: EXAMPLE_ID,
    note: OLD.note,
    log: LOG,
    proposal,
    index: { version: 1, lastTimestamp: T_UPDATED, topics: { [EXAMPLE_ID]: entry } },
  };
}
