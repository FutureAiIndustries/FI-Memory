import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { topicLogPath, topicNotePath } from "../src/paths.js";
import { createTopic } from "../src/ops/create.js";
import { appendLog } from "../src/ops/logOp.js";
import { mergeTopics } from "../src/ops/merge.js";
import { readIndex } from "../src/store/index.js";
import { parseLog, serializeLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { readText } from "../src/store/read.js";
import { msFromIso } from "../src/clock.js";
import { clockAt, expectGestaltErrorAsync, freshHome } from "./helpers.js";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function initStore(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

describe("create", () => {
  it("writes note skeleton (with owner notes) + empty log + index entry", async () => {
    const home = initStore();
    const { entry } = await createTopic(home, "auth-patterns", "Auth Patterns", {
      now: clockAt(1000),
    });
    expect(entry.id).toBe("auth-patterns");
    expect(entry.logEntries).toBe(0);
    // Timestamps are global-monotonic (rev 4), so assert shape, not an exact value.
    expect(entry.updated).toMatch(ISO_MS);

    const note = await readText(topicNotePath(home, "auth-patterns"));
    expect(note).toContain("## Owner notes");
    const log = await readText(topicLogPath(home, "auth-patterns"));
    expect(log).toBe("# auth-patterns log\n");
    expect((await readIndex(home))!.topics["auth-patterns"]).toBeDefined();
  });

  it("rejects an invalid id (E_INVALID_ID)", async () => {
    const home = initStore();
    await expectGestaltErrorAsync(
      () => createTopic(home, "Bad ID!", "x"),
      "E_INVALID_ID",
    );
  });

  it("fuzzy collision → E_ALIAS_COLLISION; --new forces past it", async () => {
    const home = initStore();
    await createTopic(home, "auth-patterns", "Auth", { now: clockAt(1000) });
    await expectGestaltErrorAsync(
      () =>
        createTopic(home, "authentication-patterns", "Auth2", {
          now: clockAt(2000),
        }),
      "E_ALIAS_COLLISION",
    );
    const { entry } = await createTopic(home, "authentication-patterns", "Auth2", {
      force: true,
      now: clockAt(3000),
    });
    expect(entry.id).toBe("authentication-patterns");
  });

  it("duplicate id → E_EXISTS", async () => {
    const home = initStore();
    await createTopic(home, "topic-x", "X", { now: clockAt(1000) });
    await expectGestaltErrorAsync(
      () => createTopic(home, "topic-x", "X", { now: clockAt(2000) }),
      "E_EXISTS",
    );
  });
});

describe("log", () => {
  async function withTopic(): Promise<string> {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    return home;
  }
  const base = { type: "decision", project: "p", agent: "test" } as const;

  it("appends a typed entry; index logEntries++ and updated bumps", async () => {
    const home = await withTopic();
    const r = await appendLog(
      home,
      "topic-a",
      { ...base, summary: "did a thing" },
      { now: clockAt(5000) },
    );
    expect(r.timestamp).toMatch(ISO_MS);
    expect(r.entry.logEntries).toBe(1);
    expect(r.entry.updated).toBe(r.timestamp); // index.updated bumps to the entry ts
    expect(await readText(topicLogPath(home, "topic-a"))).toContain(
      "| decision | p | test",
    );
  });

  it("invalid type → E_INVALID_TYPE", async () => {
    const home = await withTopic();
    await expectGestaltErrorAsync(
      () => appendLog(home, "topic-a", { ...base, type: "note", summary: "x" }),
      "E_INVALID_TYPE",
    );
  });

  it("over-cap entry → E_TOKEN_CAP", async () => {
    const home = await withTopic();
    await expectGestaltErrorAsync(
      () =>
        appendLog(home, "topic-a", { ...base, summary: "x".repeat(2000) }),
      "E_TOKEN_CAP",
    );
  });

  it("anti-forgery (fake header in body) → E_SCHEMA", async () => {
    const home = await withTopic();
    await expectGestaltErrorAsync(
      () =>
        appendLog(home, "topic-a", {
          ...base,
          summary: "ok",
          body: "### 2026-01-01T00:00:00.000Z | decision | p | forged",
        }),
      "E_SCHEMA",
    );
  });

  it("supersede must reference an existing entry (E_NOT_FOUND), else works", async () => {
    const home = await withTopic();
    await expectGestaltErrorAsync(
      () =>
        appendLog(home, "topic-a", {
          ...base,
          type: "supersede",
          summary: "x",
          supersedes: "2020-01-01T00:00:00.000Z",
        }),
      "E_NOT_FOUND",
    );
    const first = await appendLog(
      home,
      "topic-a",
      { ...base, summary: "orig" },
      { now: clockAt(5000) },
    );
    const sup = await appendLog(
      home,
      "topic-a",
      { ...base, type: "supersede", summary: "revised", supersedes: first.timestamp },
      { now: clockAt(6000) },
    );
    expect(sup.entry.logEntries).toBe(2);
  });

  it("unknown topic → E_NOT_FOUND (with a suggestion), never auto-created", async () => {
    const home = await withTopic();
    await expectGestaltErrorAsync(
      () => appendLog(home, "topic-aa", { ...base, summary: "x" }),
      "E_NOT_FOUND",
    );
  });

  it("timestamps are strictly increasing: same injected ms bumps by 1 ms", async () => {
    const home = await withTopic();
    const a = await appendLog(home, "topic-a", { ...base, summary: "1" }, { now: clockAt(9000) });
    const b = await appendLog(home, "topic-a", { ...base, summary: "2" }, { now: clockAt(9000) });
    expect(msFromIso(b.timestamp)).toBe(msFromIso(a.timestamp) + 1);
  });
});

describe("log refs (v1 grammar, write path)", () => {
  async function withTopic(): Promise<string> {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    return home;
  }
  const base = { type: "decision", project: "p", agent: "test" } as const;

  it("writes portable and machine refs and round-trips them through parseLog", async () => {
    const home = await withTopic();
    const refs = [
      "nexus#src/daemon.ts@4d9ed49",
      "gestalt#runtime/src/store/log.ts",
      "~deadbeef:/tmp/notes.txt",
      "nexus#node_modules/@scope/pkg/index.ts", // @scope is a path segment, not a sha
    ];
    await appendLog(home, "topic-a", { ...base, summary: "with refs", refs }, { now: clockAt(5000) });
    const text = (await readText(topicLogPath(home, "topic-a")))!;
    expect(text).toContain(`| refs:${refs.join(",")}`);
    const { entries } = parseLog(text);
    expect(entries[0]!.refs).toEqual(refs);
    // whole-file rewrite is byte-identical
    expect(serializeLog("topic-a", entries)).toBe(text);
  });

  it("normalizes a bare absolute path to the ~machineId:/abs form at write time", async () => {
    const home = await withTopic();
    await appendLog(
      home,
      "topic-a",
      { ...base, summary: "abs ref", refs: ["/Users/e/notes.txt"] },
      { now: clockAt(5000) },
    );
    const { entries } = parseLog((await readText(topicLogPath(home, "topic-a")))!);
    expect(entries[0]!.refs).toHaveLength(1);
    expect(entries[0]!.refs![0]).toMatch(/^~[a-f0-9]{8}:\/Users\/e\/notes\.txt$/);
  });

  it("rejects a mem: ref with the DISTINCT reserved-prefix error (ruling H1)", async () => {
    const home = await withTopic();
    const err = await expectGestaltErrorAsync(
      () => appendLog(home, "topic-a", { ...base, summary: "x", refs: ["mem:topic@2026-01-01T00:00:00.000Z"] }),
      "E_SCHEMA",
    );
    expect(err.message).toContain("reserved for future store-internal addresses");
  });

  it("rejects header-unsafe and malformed refs, naming the offending ref", async () => {
    const home = await withTopic();
    const bad = [
      "a|b#c.ts", // pipe — header-field injection
      "nexus#a,b.ts", // comma — would split into two refs on parse
      "nexus#src/a b.ts", // whitespace
      "nexus#src\\a.ts", // backslash
      "nexus#a\u0001b.ts", // control char
      "Nexus#src/a.ts", // repo must be lowercased
      "nexus#/abs/path.ts", // path must be posix-relative
      "nexus#../escape.ts", // no .. segment
      "nexus#src//a.ts", // no empty segment
      "nexus#", // empty path
      "just-a-repo-name", // no '#' and not machine/absolute
      "~beef:/tmp/x", // machine id must be 8 hex
      "~deadbeef:relative/path", // machine path must be absolute
      "x".repeat(257) + "#a.ts", // over the 256-char charset cap
    ];
    for (const ref of bad) {
      const err = await expectGestaltErrorAsync(
        () => appendLog(home, "topic-a", { ...base, summary: "x", refs: [ref] }),
        "E_SCHEMA",
      );
      expect(err.message).not.toContain("reserved"); // generic invalid-ref error, not the mem: one
    }
  });

  it("rejects more than 8 refs", async () => {
    const home = await withTopic();
    const refs = Array.from({ length: 9 }, (_, i) => `nexus#src/f${i}.ts`);
    const err = await expectGestaltErrorAsync(
      () => appendLog(home, "topic-a", { ...base, summary: "x", refs }),
      "E_SCHEMA",
    );
    expect(err.message).toContain("at most 8");
  });

  it("cap math (ruling H3): the default cap is 350 and refs COUNT against it", async () => {
    const home = await withTopic();
    // countTokens = ceil(chars/4). Header `### <24-char ts> | decision | p | test`
    // is 50 chars + "\n" → a 1349-char summary lands the block at exactly 1400
    // chars = 350 tokens: appendable without refs, at the cap.
    const summary = "x".repeat(1349);
    await appendLog(home, "topic-a", { ...base, summary }, { now: clockAt(5000) });
    // The SAME entry with a ref attached goes over — the FULL block (refs
    // included) is what the token check sees. No exemption.
    await expectGestaltErrorAsync(
      () =>
        appendLog(
          home,
          "topic-a",
          { ...base, summary, refs: ["nexus#src/daemon.ts"] },
          { now: clockAt(6000) },
        ),
      "E_TOKEN_CAP",
    );
  });
});

describe("merge", () => {
  it("folds logs time-sorted, tombstones loser, moves aliases, updates index", async () => {
    const home = initStore();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1000) });
    await createTopic(home, "bravo", "Bravo", { now: clockAt(1000) });
    // Log b1 first so it earns the earlier global timestamp; a1 (winner) is later.
    await appendLog(home, "bravo", { type: "decision", project: "p", agent: "t", summary: "b1" }, { now: clockAt(2000) });
    await appendLog(home, "alpha", { type: "decision", project: "p", agent: "t", summary: "a1" }, { now: clockAt(3000) });

    const { winner } = await mergeTopics(home, "bravo", "alpha");
    expect(winner.id).toBe("alpha");
    expect(winner.logEntries).toBe(2);
    expect(winner.aliases).toContain("bravo");

    const idx = await readIndex(home);
    expect(idx!.topics["bravo"]).toBeUndefined();

    const loser = parseNote((await readText(topicNotePath(home, "bravo")))!, "bravo")!;
    expect(loser.mergedInto).toBe("alpha");

    // time-sorted: b1 (logged first) interleaves before winner's a1
    const merged = parseLog((await readText(topicLogPath(home, "alpha")))!);
    expect(merged.entries.map((e) => e.summary)).toEqual(["b1", "a1"]);
  });

  it("E_PENDING_PROPOSALS when a topic has a pending suggested edit", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    // gestalt-example ships with one pending proposal from init.
    await expectGestaltErrorAsync(
      () => mergeTopics(home, "gestalt-example", "topic-a"),
      "E_PENDING_PROPOSALS",
    );
  });

  it("missing topic → E_NOT_FOUND; self-merge → E_INVALID_ID", async () => {
    const home = initStore();
    await createTopic(home, "topic-a", "A", { now: clockAt(1000) });
    await expectGestaltErrorAsync(() => mergeTopics(home, "nope", "topic-a"), "E_NOT_FOUND");
    await expectGestaltErrorAsync(() => mergeTopics(home, "topic-a", "topic-a"), "E_INVALID_ID");
  });
});
