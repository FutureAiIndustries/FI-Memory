import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { GestaltError } from "../src/errors.js";
import { applyParked, discardParked, listParked, showParked } from "../src/ops/conflictsOp.js";
import { createTopic } from "../src/ops/create.js";
import { reviewApprove } from "../src/ops/review.js";
import { search } from "../src/ops/search.js";
import { fsPath, storePaths, topicNotePath } from "../src/paths.js";
import { parseNote, serializeNote } from "../src/store/note.js";
import { readText } from "../src/store/read.js";
import { clockAt, freshHome } from "./helpers.js";

/**
 * `fimemory conflicts` — the recovery flow for the resolver's parking lot.
 * Until 0.4 the parked queue was write-only: doctor warned, nothing could
 * read, promote, or retire a parked file. These pin the whole quarter.
 */

async function storeWithPark(label: string): Promise<{
  home: string;
  parkedNoteRel: string;
  parkedConfigRel: string;
}> {
  const home = freshHome(label);
  runInit({ home });
  await createTopic(home, "disputed-topic", "Disputed Topic", { now: clockAt(1e12) });
  // Manufacture parks exactly as the resolver names them: the other machine's
  // side at conflicts/<rel>.<shortsha>, bytes in on-disk form (plaintext here).
  const note = parseNote((await readText(topicNotePath(home, "disputed-topic")))!, "disputed-topic")!;
  const otherSide = serializeNote({
    ...note,
    updated: new Date(1e12 + 60_000).toISOString(),
    body: "\nThe cormorant paragraph only the other machine wrote.\n\n## Owner notes\n",
  });
  const conflictsDir = path.join(home, "conflicts", "topics");
  mkdirSync(fsPath(conflictsDir), { recursive: true });
  const parkedNoteRel = "conflicts/topics/disputed-topic.md.ab12cd3";
  writeFileSync(fsPath(path.join(home, parkedNoteRel)), otherSide, "utf8");
  const parkedConfigRel = "conflicts/config.json.99ffee1";
  writeFileSync(
    fsPath(path.join(home, parkedConfigRel)),
    JSON.stringify({ entryTokenCap: 200 }, null, 2) + "\n",
    "utf8",
  );
  return { home, parkedNoteRel, parkedConfigRel };
}

describe("fimemory conflicts — list / show / apply / discard", () => {
  it("list classifies parked files and strips the resolver's sha suffix", async () => {
    const { home, parkedNoteRel, parkedConfigRel } = await storeWithPark("conflicts-list");
    const entries = listParked(home);
    expect(entries.map((e) => e.parkedRel).sort()).toEqual([parkedConfigRel, parkedNoteRel].sort());
    const note = entries.find((e) => e.parkedRel === parkedNoteRel)!;
    expect(note.kind).toBe("note");
    expect(note.originalRel).toBe("topics/disputed-topic.md");
    const cfg = entries.find((e) => e.parkedRel === parkedConfigRel)!;
    expect(cfg.kind).toBe("config");
    expect(cfg.originalRel).toBe("config.json");
  });

  it("show prints the parked content decoded", async () => {
    const { home, parkedNoteRel } = await storeWithPark("conflicts-show");
    const r = await showParked(home, parkedNoteRel);
    expect(r.text).toContain("cormorant paragraph");
    expect(r.entry.kind).toBe("note");
  });

  it("apply promotes a parked note into the ordinary review queue, retires the park, and approve round-trips", async () => {
    const { home, parkedNoteRel } = await storeWithPark("conflicts-apply");
    const r = await applyParked(home, parkedNoteRel);
    expect(r.handle).toBe(`${r.machineId}-${String(r.seq)}`);
    // The park is retired; its content lives on in the proposal.
    expect(existsSync(fsPath(path.join(home, parkedNoteRel)))).toBe(false);
    // The same review flow every other disagreement uses applies it.
    await reviewApprove(home, r.seq, { machineId: r.machineId });
    expect(await readText(topicNotePath(home, "disputed-topic"))).toContain("cormorant paragraph");
    // And it is findable afterwards.
    const hits = await search(home, "cormorant");
    expect(hits.hits.some((h) => h.id === "disputed-topic")).toBe(true);
  });

  it("apply refuses a parked config — show/fold/discard is that flow", async () => {
    const { home, parkedConfigRel } = await storeWithPark("conflicts-apply-config");
    await expect(applyParked(home, parkedConfigRel)).rejects.toMatchObject({ code: "E_SCHEMA" });
    // Still parked — a refusal writes nothing.
    expect(existsSync(fsPath(path.join(home, parkedConfigRel)))).toBe(true);
  });

  it("discard retires a parked file; addressing a missing park is a clean E_NOT_FOUND", async () => {
    const { home, parkedConfigRel } = await storeWithPark("conflicts-discard");
    const e = await discardParked(home, parkedConfigRel);
    expect(e.parkedRel).toBe(parkedConfigRel);
    expect(existsSync(fsPath(path.join(home, parkedConfigRel)))).toBe(false);
    await expect(discardParked(home, parkedConfigRel)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("apply against a deleted live topic refuses with recreate guidance instead of inventing a base", async () => {
    const { home, parkedNoteRel } = await storeWithPark("conflicts-apply-deleted");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(fsPath(topicNotePath(home, "disputed-topic")));
    let err: GestaltError | null = null;
    try {
      await applyParked(home, parkedNoteRel);
    } catch (e) {
      err = e as GestaltError;
    }
    expect(err?.code).toBe("E_NOT_FOUND");
    expect(err?.hint).toContain("create");
  });
});
