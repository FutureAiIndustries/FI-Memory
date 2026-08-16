import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { sha256 } from "../src/hash.js";
import { proposalPath, topicLogPath, topicNotePath } from "../src/paths.js";
import { compact } from "../src/ops/compact.js";
import { mergeTopics } from "../src/ops/merge.js";
import { reviewApprove, reviewReject, reviewShow } from "../src/ops/review.js";
import { updateTopic } from "../src/ops/update.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { parseLog } from "../src/store/log.js";
import { serializeNote } from "../src/store/note.js";
import type { TopicNote } from "../src/store/note.js";
import { serializeProposal } from "../src/store/proposals.js";
import { readText } from "../src/store/read.js";
import { clockAt, expectGestaltErrorAsync, freshHome } from "./helpers.js";

const OWNER = "## Owner notes\nmy protected notes\n";

function noteText(before: string, owner = OWNER): string {
  const note: TopicNote = {
    id: "alpha",
    title: "Alpha",
    aliases: [],
    tags: [],
    projects: [],
    updated: "2026-07-11T00:00:00.000Z",
    compactedThrough: null,
    mergedInto: null,
    body: "\n" + before + "\n\n" + owner,
  };
  return serializeNote(note);
}

async function seedAlpha(before = "original summary."): Promise<string> {
  const home = freshHome();
  runInit({ home });
  writeFileSync(topicNotePath(home, "alpha"), noteText(before), "utf8");
  writeFileSync(topicLogPath(home, "alpha"), "# alpha log\n", "utf8");
  await reindexStore(home);
  return home;
}

describe("update → review → approve (trust lifecycle, SPEC §5.6)", () => {
  it("update writes a pending proposal; approve applies New + appends the auto-entry", async () => {
    const home = await seedAlpha();
    const { seq } = await updateTopic(home, "alpha", noteText("revised summary."), {
      proposer: "claude-code",
      now: clockAt(1e12),
    });
    expect(seq).toBe(2); // gestalt-example is seq 1

    // Note is unchanged until approval (invariant 4).
    expect(await readText(topicNotePath(home, "alpha"))).toContain("original summary.");

    const shown = await reviewShow(home, seq);
    expect(shown.status).toBe("pending");
    expect(shown.newNote).toContain("revised summary.");

    const { id } = await reviewApprove(home, seq, { now: clockAt(1e12) });
    expect(id).toBe("alpha");

    const applied = (await readText(topicNotePath(home, "alpha")))!;
    expect(applied).toContain("revised summary.");
    expect(applied).not.toContain("original summary.");

    // Fixed auto-entry appended.
    const log = parseLog((await readText(topicLogPath(home, "alpha")))!);
    const auto = log.entries.at(-1)!;
    expect(auto.agent).toBe("gestalt-runtime");
    expect(auto.summary).toBe(`Note updated via proposal #${seq} by claude-code.`);

    // Proposal marked approved.
    expect((await reviewShow(home, seq)).status).toBe("approved");
  });

  it("preserves base title/aliases/tags when proposed frontmatter is mangled (get→update round-trip)", async () => {
    // Real failure mode (2026-07-27): agents rebuild frontmatter from fimemory_get
    // output and set updated: null / drop title/aliases/tags — 8 of 10 rejected.
    const home = freshHome();
    runInit({ home });
    const rich: TopicNote = {
      id: "brand",
      title: "Squirl — go-to-market brand",
      aliases: ["squirl", "fimemory"],
      tags: ["brand", "launch"],
      projects: ["fimemory"],
      updated: "2026-07-12T20:52:44.902Z",
      compactedThrough: null,
      mergedInto: null,
      body: "\noriginal brand summary.\n\n## Owner notes\nkeep me\n",
    };
    writeFileSync(topicNotePath(home, "brand"), serializeNote(rich), "utf8");
    writeFileSync(topicLogPath(home, "brand"), "# brand log\n", "utf8");
    await reindexStore(home);

    // Mangled draft: wrong title, empty aliases/tags, updated: null — body is good.
    const mangled = [
      "---",
      "id: brand",
      'title: "WRONG TITLE"',
      "aliases: []",
      "tags: []",
      "projects: []",
      "updated: null",
      "compactedThrough: null",
      "---",
      "",
      "revised brand summary from log fold.",
      "",
      "## Owner notes",
      "keep me",
      "",
    ].join("\n");

    const { seq } = await updateTopic(home, "brand", mangled, {
      proposer: "mcp",
      now: clockAt(1e12),
    });
    const shown = await reviewShow(home, seq);
    expect(shown.newNote).toContain("revised brand summary from log fold.");
    expect(shown.newNote).toContain('title: "Squirl — go-to-market brand"');
    expect(shown.newNote).toContain("aliases: [squirl, fimemory]");
    expect(shown.newNote).toContain("tags: [brand, launch]");
    expect(shown.newNote).toContain("projects: [fimemory]");
    expect(shown.newNote).toContain("updated: 2026-07-12T20:52:44.902Z");
    expect(shown.newNote).not.toContain("WRONG TITLE");
    expect(shown.newNote).not.toMatch(/^updated: null$/m);

    await reviewApprove(home, seq, { now: clockAt(1e12) });
    const applied = (await readText(topicNotePath(home, "brand")))!;
    expect(applied).toContain('title: "Squirl — go-to-market brand"');
    expect(applied).toContain("aliases: [squirl, fimemory]");
    expect(applied).toContain("tags: [brand, launch]");
    expect(applied).toContain("revised brand summary from log fold.");
    expect(applied).not.toContain("original brand summary.");
  });

  it("reject leaves the note unchanged and marks the proposal rejected", async () => {
    const home = await seedAlpha();
    const { seq } = await updateTopic(home, "alpha", noteText("revised."), { now: clockAt(1e12) });
    await reviewReject(home, seq);
    expect(await readText(topicNotePath(home, "alpha"))).toContain("original summary.");
    expect((await reviewShow(home, seq)).status).toBe("rejected");
  });

  it("update rejects an over-cap note (E_TOKEN_CAP)", async () => {
    const home = await seedAlpha();
    await expectGestaltErrorAsync(
      () => updateTopic(home, "alpha", noteText("word ".repeat(1200)), { now: clockAt(1e12) }),
      "E_TOKEN_CAP",
    );
  });

  it("update on an unknown topic → E_NOT_FOUND (never auto-created)", async () => {
    const home = await seedAlpha();
    await expectGestaltErrorAsync(
      () => updateTopic(home, "ghost", noteText("x"), { now: clockAt(1e12) }),
      "E_NOT_FOUND",
    );
  });
});

describe("owner-notes contract (reject on update AND approve, SPEC §3)", () => {
  it("break #2: a whitespace-only owner-notes change is rejected at update (E_OWNER_NOTES)", async () => {
    const home = await seedAlpha();
    // Same content, but a trailing space in the owner section.
    const changed = noteText("original summary.", "## Owner notes\nmy protected notes \n");
    await expectGestaltErrorAsync(
      () => updateTopic(home, "alpha", changed, { now: clockAt(1e12) }),
      "E_OWNER_NOTES",
    );
  });

  it("override is CLI-only at approve too (#3): recorded flag is NOT sufficient", async () => {
    const home = await seedAlpha();
    const changed = noteText("original summary.", "## Owner notes\nrewritten by me\n");
    const { seq, ownerNotesChanged } = await updateTopic(home, "alpha", changed, {
      allowOwnerNotes: true,
      now: clockAt(1e12),
    });
    expect(ownerNotesChanged).toBe(true);
    // Approve WITHOUT the flag is refused even though the proposal recorded the override.
    await expectGestaltErrorAsync(
      () => reviewApprove(home, seq, { now: clockAt(1e12) }),
      "E_OWNER_NOTES",
    );
    // The human must pass --allow-owner-notes at approve time.
    await reviewApprove(home, seq, { allowOwnerNotes: true, now: clockAt(1e12) });
    expect((await readText(topicNotePath(home, "alpha")))!).toContain("rewritten by me");
  });

  it("approve independently re-enforces: an override-less owner-notes proposal is rejected", async () => {
    const home = await seedAlpha();
    // Hand-craft a proposal that changes owner notes but has NO override, with valid hashes.
    const currentText = (await readText(topicNotePath(home, "alpha")))!;
    const newText = noteText("original summary.", "## Owner notes\nsneaky rewrite\n");
    writeFileSync(
      proposalPath(home, 2, "alpha"),
      serializeProposal({
        seq: 2,
        id: "alpha",
        status: "pending",
        proposer: "attacker",
        created: "2026-07-11T00:00:00.000Z",
        compactedThrough: null,
        baseUpdated: "2026-07-11T00:00:00.000Z",
        baseHash: sha256(currentText),
        newHash: sha256(newText),
        ownerNotesOverride: false,
        oldNote: currentText,
        newNote: newText,
        diff: "",
      }),
      "utf8",
    );
    await expectGestaltErrorAsync(() => reviewApprove(home, 2, { now: clockAt(1e12) }), "E_OWNER_NOTES");
  });
});

describe("staleness (break scripts #3, #4, SPEC §5.6)", () => {
  it("break #3: approve #B first → approving the sibling #A is stale", async () => {
    const home = await seedAlpha();
    const a = await updateTopic(home, "alpha", noteText("edit A."), { now: clockAt(1e12) });
    const b = await updateTopic(home, "alpha", noteText("edit B."), { now: clockAt(1e12) });
    expect(a.seq).toBe(2);
    expect(b.seq).toBe(3);

    await reviewApprove(home, b.seq, { now: clockAt(1e12) });
    // Sibling A was marked stale by B's approval.
    expect((await reviewShow(home, a.seq)).status).toBe("stale");
    await expectGestaltErrorAsync(() => reviewApprove(home, a.seq, { now: clockAt(1e12) }), "E_STALE_PROPOSAL");
  });

  it("break #4: a hand-edit between propose and approve stales the proposal", async () => {
    const home = await seedAlpha();
    const { seq } = await updateTopic(home, "alpha", noteText("revised."), { now: clockAt(1e12) });
    // Hand-edit the note (changes its bytes → baseHash mismatch).
    const cur = readFileSync(topicNotePath(home, "alpha"), "utf8");
    writeFileSync(topicNotePath(home, "alpha"), cur.replace("original summary.", "hand edited."), "utf8");
    await expectGestaltErrorAsync(() => reviewApprove(home, seq, { now: clockAt(1e12) }), "E_STALE_PROPOSAL");
    expect((await reviewShow(home, seq)).status).toBe("stale");
  });
});

describe("break #6: merge is blocked while a proposal is pending on a topic", () => {
  it("E_PENDING_PROPOSALS on the loser", async () => {
    const home = await seedAlpha();
    writeFileSync(topicNotePath(home, "winner"), noteText("winner").replace(/alpha/g, "winner"), "utf8");
    writeFileSync(topicLogPath(home, "winner"), "# winner log\n", "utf8");
    await reindexStore(home);
    await updateTopic(home, "alpha", noteText("pending edit."), { now: clockAt(1e12) }); // pending on alpha
    await expectGestaltErrorAsync(() => mergeTopics(home, "alpha", "winner"), "E_PENDING_PROPOSALS");
  });
});

describe("compact — paginated packet (SPEC §5.1/§5.7)", () => {
  it("returns entries after compactedThrough, capped, with hasMore + cursor", async () => {
    const home = await seedAlpha();
    // Seed 40 fat log entries (~250 tokens each) so the 6000 cap paginates.
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      const ts = `2026-07-11T00:00:${String(i).padStart(2, "0")}.000Z`;
      rows.push(`### ${ts} | decision | p | a\n` + "word ".repeat(200));
    }
    writeFileSync(topicLogPath(home, "alpha"), "# alpha log\n\n" + rows.join("\n\n") + "\n", "utf8");

    const first = await compact(home, "alpha");
    expect(first.note).toContain("original summary.");
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.entries.length).toBeLessThan(40);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();
    expect(first.tokensUsed).toBeLessThanOrEqual(6000);

    // Continuation via --since=cursor advances.
    const second = await compact(home, "alpha", { since: first.cursor! });
    expect(second.entries[0]).not.toBe(first.entries[0]);
  });

  it("a note body over the compact cap returns the note with zero entries + a warning (#17)", async () => {
    const home = await seedAlpha("word ".repeat(7000)); // ~1750-token... make it bigger
    writeFileSync(topicNotePath(home, "alpha"), noteText("word ".repeat(7000)), "utf8");
    const packet = await compact(home, "alpha");
    expect(packet.entries).toEqual([]);
    expect(packet.warnings.some((w) => w.code === "budget")).toBe(true);
  });
});
