import { describe, expect, it } from "vitest";
import { buildExample } from "../src/example.js";
import { splitFrontmatter } from "../src/store/frontmatter.js";
import { formatEntryBlock, parseEntry, parseLog, serializeLog } from "../src/store/log.js";
import { parseNote, serializeNote } from "../src/store/note.js";

describe("note parse/serialize", () => {
  const ex = buildExample();

  it("round-trips the B0 example note byte-for-byte", () => {
    const note = parseNote(ex.note);
    expect(note).not.toBeNull();
    expect(serializeNote(note!)).toBe(ex.note);
  });

  it("splits frontmatter from body", () => {
    const split = splitFrontmatter(ex.note);
    expect(split).not.toBeNull();
    expect(split!.yaml).toContain("id: gestalt-example");
    expect(split!.body.startsWith("\n")).toBe(true);
    expect(split!.body).toContain("## Owner notes");
  });

  it("parses fields (ISO timestamps stay strings, not Dates)", () => {
    const note = parseNote(ex.note)!;
    expect(note.id).toBe("gestalt-example");
    expect(note.title).toBe("FIMemory Example — Start Here");
    expect(note.aliases).toEqual(["example", "getting-started"]);
    expect(note.updated).toBe("2026-07-11T00:00:05.000Z");
    expect(typeof note.updated).toBe("string");
    expect(note.compactedThrough).toBeNull();
    expect(note.mergedInto).toBeNull();
  });

  it("returns null for a note with no usable frontmatter (tolerant, invariant 1)", () => {
    expect(parseNote("just some text, no frontmatter")).toBeNull();
    expect(parseNote("---\nnot: closed\n\nbody")).toBeNull();
  });
});

describe("log parse/serialize", () => {
  const ex = buildExample();

  it("parses all five entry types from the example log", () => {
    const { entries, warnings } = parseLog(ex.log);
    expect(warnings).toEqual([]);
    expect(entries.map((e) => e.type)).toEqual([
      "decision",
      "pattern",
      "gotcha",
      "convention",
      "supersede",
    ]);
    expect(entries[4]!.supersedes).toBe("2026-07-11T00:00:01.000Z");
    expect(entries[0]!.project).toBe("gestalt");
    expect(entries[0]!.agent).toBe("gestalt-runtime");
  });

  it("round-trips the example log byte-for-byte", () => {
    const { entries } = parseLog(ex.log);
    expect(serializeLog("gestalt-example", entries)).toBe(ex.log);
  });

  it("parses a refs: header extra and round-trips the log byte-for-byte", () => {
    const log =
      "# t log\n\n" +
      "### 2026-07-11T00:00:01.000Z | decision | p | a | refs:nexus#src/daemon.ts@4d9ed49,~deadbeef:/tmp/notes.txt\n" +
      "summary line\nbody line\n";
    const { entries, warnings } = parseLog(log);
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.refs).toEqual([
      "nexus#src/daemon.ts@4d9ed49",
      "~deadbeef:/tmp/notes.txt",
    ]);
    expect(entries[0]!.summary).toBe("summary line");
    expect(serializeLog("t", entries)).toBe(log);
  });

  it("old entries without refs parse untouched: refs is null and bytes survive", () => {
    const { entries } = parseLog(ex.log);
    for (const e of entries) expect(e.refs).toBeNull();
    expect(serializeLog("gestalt-example", entries)).toBe(ex.log); // byte-identical
  });

  it("tolerates unknown header extras (forward-compat) and still finds refs", () => {
    const log =
      "# t log\n\n" +
      "### 2026-07-11T00:00:01.000Z | decision | p | a | zebra:1 | refs:nexus#a.ts | future:x\n" +
      "s\n";
    const { entries, warnings } = parseLog(log);
    expect(warnings).toEqual([]);
    expect(entries[0]!.refs).toEqual(["nexus#a.ts"]);
    expect(serializeLog("t", entries)).toBe(log); // unknown extras survive the rewrite
  });

  it("formatEntryBlock emits refs after supersedes/reported; write→parse→rewrite is byte-identical", () => {
    const ts = "2026-07-11T00:00:02.000Z";
    const block = formatEntryBlock(ts, {
      type: "supersede",
      project: "p",
      agent: "a",
      summary: "s",
      body: "b",
      supersedes: "2026-07-11T00:00:01.000Z",
      reported: "2026-07-10T00:00:00.000Z",
      refs: ["nexus#src/a.ts@1234567", "gestalt#runtime/src/store/log.ts"],
    });
    expect(block).toBe(
      `### ${ts} | supersede | p | a | supersedes:2026-07-11T00:00:01.000Z | reported:2026-07-10T00:00:00.000Z | refs:nexus#src/a.ts@1234567,gestalt#runtime/src/store/log.ts\ns\nb`,
    );
    const parsed = parseEntry(block)!;
    expect(parsed.refs).toEqual(["nexus#src/a.ts@1234567", "gestalt#runtime/src/store/log.ts"]);
    expect(parsed.supersedes).toBe("2026-07-11T00:00:01.000Z");
    expect(parsed.reported).toBe("2026-07-10T00:00:00.000Z");
    expect(parsed.raw).toBe(block); // rewrite re-emits raw → byte-identical
    expect(serializeLog("t", [parsed])).toBe(`# t log\n\n${block}\n`);
  });

  it("refs with no refs field stays absent from the header (no empty extra)", () => {
    const block = formatEntryBlock("2026-07-11T00:00:01.000Z", {
      type: "decision",
      project: "p",
      agent: "a",
      summary: "s",
      refs: [],
    });
    expect(block).not.toContain("refs:");
    expect(parseEntry(block)!.refs).toBeNull();
  });

  it("skips a header-shaped entry with a calendar-impossible timestamp, with a warning", () => {
    // A header-shaped line with an impossible date (#25) is a boundary but fails
    // to parse → skipped with a warning; a non-header `### Notes` line would just
    // be body text (#11).
    const bad = `# t log\n\n### 2026-13-45T99:99:99.999Z | decision | p | a\noops\n\n### 2026-07-11T00:00:01.000Z | decision | p | a\ngood\n`;
    const { entries, warnings } = parseLog(bad);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("good");
    expect(warnings.some((w) => w.code === "E_CORRUPT_SKIPPED")).toBe(true);
  });
});
