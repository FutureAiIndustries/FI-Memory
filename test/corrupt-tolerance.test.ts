import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { buildExample } from "../src/example.js";
import { fsPath, topicNotePath } from "../src/paths.js";
import { get } from "../src/ops/get.js";
import { reindex } from "../src/store/index.js";
import { parseLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { freshHome } from "./helpers.js";

const BOM = "﻿";
const toCrlf = (s: string): string => s.replace(/\n/g, "\r\n");

/**
 * Review finding 1 (BLOCKER, reproduced live): a note re-saved with a BOM or
 * CRLF endings must still parse — dropping it from every read path would break
 * invariant 1 ("tolerate hand edits") on Windows, the first-class platform.
 */
describe("BOM / CRLF hand edits still parse (invariant 1)", () => {
  it("parseNote tolerates a leading BOM and CRLF endings, normalizing to LF", () => {
    expect(BOM.charCodeAt(0)).toBe(0xfeff); // self-check: this really is a BOM
    const note = parseNote(BOM + toCrlf(buildExample().note));
    expect(note).not.toBeNull();
    expect(note!.id).toBe("gestalt-example");
    expect(note!.aliases).toEqual(["example", "getting-started"]);
    expect(note!.body).toContain("## Owner notes");
    expect(note!.body).not.toContain("\r");
  });

  it("parseLog tolerates CRLF — supersedes:/agent not corrupted by a trailing CR", () => {
    const { entries, warnings } = parseLog(toCrlf(buildExample().log));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(5);
    expect(entries[4]!.supersedes).toBe("2026-07-11T00:00:01.000Z");
    expect(entries[0]!.agent).toBe("gestalt-runtime");
  });

  it("a BOM+CRLF-saved note is NOT dropped by reindex or get", async () => {
    const home = freshHome();
    runInit({ home });
    // Re-save the example note exactly as PowerShell Set-Content would.
    writeFileSync(
      fsPath(topicNotePath(home, "gestalt-example")),
      BOM + toCrlf(buildExample().note),
      "utf8",
    );

    const { index, warnings } = await reindex(home);
    expect(warnings).toEqual([]);
    expect(index.topics["gestalt-example"]).toBeDefined();

    const r = await get(home, ["gestalt-example"]);
    expect(r.topics).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });
});
