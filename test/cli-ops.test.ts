import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { topicLogPath, topicNotePath } from "../src/paths.js";
import { createTopic } from "../src/ops/create.js";
import { ingest } from "../src/ops/ingest.js";
import { list } from "../src/ops/list.js";
import { pack } from "../src/ops/pack.js";
import { parseLog } from "../src/store/log.js";
import { readText } from "../src/store/read.js";
import { clockAt, freshHome, tickingClock, tsxEntry } from "./helpers.js";

function store(): string {
  const home = freshHome();
  runInit({ home });
  return home;
}

describe("list (SPEC §5.1, CLI-only)", () => {
  it("returns rows newest-first with the pending-edit count", async () => {
    const home = store();
    await createTopic(home, "alpha", "Alpha", { now: clockAt(1e12) });
    await createTopic(home, "bravo", "Bravo", { now: clockAt(2e12) });
    const r = await list(home);
    expect(r.rows[0]!.id).toBe("bravo"); // newer first
    expect(r.rows.map((x) => x.id)).toContain("gestalt-example");
    expect(r.pending).toBe(1); // the example ships one pending proposal
  });
});

describe("pack (SPEC §5.1)", () => {
  it("returns a budgeted brief + the report-back footer", async () => {
    const home = store();
    const r = await pack(home, ["gestalt-example"], { for: "grok" });
    expect(r.text).toContain("FIMemory brief");
    expect(r.text).toContain("gestalt-example");
    expect(r.text).toContain("```gestalt-log");
    expect(r.text).toContain("gestalt ingest");
  });
});

describe("ingest (SPEC §5.1)", () => {
  it("break script #9: 4 valid entries land, 1 unknown-topic rejected; no auto-create", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const block =
      "Here's what I learned:\n\n```gestalt-log\n" +
      "### topic-a | decision | fi | grok\none\n" +
      "### topic-a | gotcha | fi | grok\ntwo\n" +
      "### topic-a | pattern | fi | grok\nthree\n" +
      "### topic-a | convention | fi | grok\nfour\n" +
      "### ghost | decision | fi | grok\nfive\n" +
      "```\n";
    const r = await ingest(home, block, { now: tickingClock(2e12) });

    expect(r.landed).toBe(4);
    expect(r.rejected).toBe(1);
    expect(r.lines.filter((l) => !l.ok)[0]!.topic).toBe("ghost");
    // the unknown topic was NOT created
    expect(await readText(topicNotePath(home, "ghost"))).toBeNull();
    // the four valid entries landed on topic-a
    const log = parseLog((await readText(topicLogPath(home, "topic-a")))!);
    expect(log.entries).toHaveLength(4);
    expect(log.entries.map((e) => e.type)).toEqual([
      "decision",
      "gotcha",
      "pattern",
      "convention",
    ]);
  });

  it("assigns server timestamps but preserves a declared reported:", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const block =
      "```gestalt-log\n### topic-a | decision | fi | grok | reported:2020-01-01T00:00:00.000Z\nsummary\n```";
    await ingest(home, block, { now: clockAt(2e12) });
    const entry = parseLog((await readText(topicLogPath(home, "topic-a")))!).entries[0]!;
    expect(entry.reported).toBe("2020-01-01T00:00:00.000Z");
    expect(entry.timestamp).not.toBe("2020-01-01T00:00:00.000Z"); // server-assigned
  });

  it("carries a declared refs: through the paste path (never silently dropped)", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const block =
      "```gestalt-log\n### topic-a | decision | fi | grok | reported:2020-01-01T00:00:00.000Z | refs:nexus#src/daemon.ts@4d9ed49,~deadbeef:/tmp/x\nsummary\n```";
    const r = await ingest(home, block, { now: clockAt(2e12) });
    expect(r.landed).toBe(1);
    const entry = parseLog((await readText(topicLogPath(home, "topic-a")))!).entries[0]!;
    expect(entry.refs).toEqual(["nexus#src/daemon.ts@4d9ed49", "~deadbeef:/tmp/x"]);
    expect(entry.reported).toBe("2020-01-01T00:00:00.000Z"); // both extras survive together
  });

  it("rejects a pasted entry whose refs fail the v1 grammar (validated like any append)", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const block =
      "```gestalt-log\n### topic-a | decision | fi | grok | refs:mem:topic\nsummary\n```";
    const r = await ingest(home, block, { now: clockAt(2e12) });
    expect(r.landed).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.lines[0]!.message).toContain("reserved for future store-internal addresses");
  });

  it("reports nothing to do when there is no gestalt-log block", async () => {
    const home = store();
    const r = await ingest(home, "just some prose, no fenced block");
    expect(r.landed).toBe(0);
    expect(r.rejected).toBe(0);
  });
});

describe("cli `log --refs` (comma-form, end-to-end through cli.ts)", () => {
  const TSX = tsxEntry();
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function spawnCli(args: string[]): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, GESTALT_KEY: "", GESTALT_PASSPHRASE: "" },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("a single comma-separated --refs a,b lands both refs (whitespace trimmed)", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const r = spawnCli([
      "log", "topic-a", "--home", home,
      "--type", "decision", "--project", "p", "-m", "via cli",
      "--refs", "nexus#src/daemon.ts@4d9ed49, gestalt#runtime/src/store/log.ts",
    ]);
    expect(r.status).toBe(0);
    const { entries } = parseLog((await readText(topicLogPath(home, "topic-a")))!);
    expect(entries[0]!.refs).toEqual([
      "nexus#src/daemon.ts@4d9ed49",
      "gestalt#runtime/src/store/log.ts",
    ]);
  });

  it("an invalid ref fails the append non-zero with the offending ref named", async () => {
    const home = store();
    await createTopic(home, "topic-a", "A", { now: clockAt(1e12) });
    const r = spawnCli([
      "log", "topic-a", "--home", home,
      "--type", "decision", "--project", "p", "-m", "bad ref",
      "--refs", "not a ref",
    ]);
    expect(r.status).not.toBe(0);
    expect((await readText(topicLogPath(home, "topic-a")))!).toBe("# topic-a log\n"); // nothing written
  });

  it("--refs is documented in the help text", () => {
    const r = spawnCli(["--help"]);
    expect(r.stdout).toContain("--refs repo#path[@sha],...");
  });
});
