import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildExample, EXAMPLE_ID } from "../src/example.js";

/**
 * The gestalt-example must demonstrate, in one topic: owner notes, all five log
 * entry types, and one pending proposal (SPEC §5.1) — so a first-run user can
 * do search → get → log → review-approve without editing a file (SPEC §9).
 */
describe("gestalt-example artifacts", () => {
  const ex = buildExample();

  it("note has frontmatter, an Owner notes section, and ends with a newline", () => {
    expect(ex.note.startsWith("---\n")).toBe(true);
    expect(ex.note).toContain("\n## Owner notes\n");
    expect(ex.note.endsWith("\n")).toBe(true);
  });

  it("log demonstrates all five entry types in canonical form (SPEC §4)", () => {
    for (const type of [
      "decision",
      "pattern",
      "gotcha",
      "convention",
      "supersede",
    ]) {
      expect(ex.log, type).toContain(`| ${type} | `);
    }
    expect(ex.log.startsWith(`# ${EXAMPLE_ID} log\n`)).toBe(true);
    expect(ex.log.endsWith("\n")).toBe(true);
    // supersede references the decision entry's server timestamp (SPEC §4).
    expect(ex.log).toContain("supersedes:2026-07-11T00:00:01.000Z");
    // Anti-forgery (SPEC §4): no body line may start with "### <date>".
    const bodyLines = ex.log
      .split("\n")
      .filter((l) => !l.startsWith("### 2026-"));
    expect(bodyLines.some((l) => /^### \d{4}-\d{2}-\d{2}T/.test(l))).toBe(false);
  });

  it("exactly one pending proposal, schema-valid, baseHash = sha256 of the note bytes", () => {
    expect(ex.proposal.seq).toBe(1);
    expect(ex.proposal.filename).toBe("1-gestalt-example.md");
    expect(ex.proposal.content).toContain("status: pending");
    expect(ex.proposal.content).toMatch(/^seq: 1$/m);

    const wantHash =
      "sha256:" +
      createHash("sha256").update(Buffer.from(ex.note, "utf8")).digest("hex");
    expect(ex.proposal.content).toContain(`baseHash: ${wantHash}`);
  });

  it("Old/New fenced blocks round-trip; baseHash/newHash verify them (the B2b approve contract)", () => {
    // Old/New notes are wrapped in a 4-backtick ````markdown fence (rev 4, #2),
    // so extraction is a clean slice regardless of ## headings inside a note.
    const fenced = (content: string, section: string): string => {
      const marker = "## " + section + "\n````markdown\n";
      const start = content.indexOf(marker) + marker.length;
      const end = content.indexOf("\n````", start);
      return content.slice(start, end + 1); // include the note's trailing newline
    };
    const sha = (s: string): string =>
      "sha256:" + createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

    const oldBlock = fenced(ex.proposal.content, "Old");
    const newBlock = fenced(ex.proposal.content, "New");

    expect(oldBlock).toBe(ex.note); // Old == on-disk note, byte-for-byte
    expect(newBlock.startsWith("---\n")).toBe(true);
    expect(ex.proposal.content).toContain(`baseHash: ${sha(oldBlock)}`);
    expect(ex.proposal.content).toContain(`newHash: ${sha(newBlock)}`);
    // New proposes a real body change and keeps the owner-notes section.
    expect(newBlock).toContain("the only way curated truth ever changes");
    expect(newBlock).toContain(
      "Put anything here you want protected from automated edits.",
    );
  });

  it("index entry has canonical fields (SPEC §2) and correct counts", () => {
    const entry = ex.index.topics[EXAMPLE_ID];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!)).toEqual([
      "id",
      "title",
      "aliases",
      "tags",
      "projects",
      "updated",
      "noteTokens",
      "logEntries",
      "compactedThrough",
    ]);
    expect(entry!.logEntries).toBe(5);
    expect(entry!.compactedThrough).toBeNull();
    expect(entry!.noteTokens).toBeGreaterThan(0);
  });
});
