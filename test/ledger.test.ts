import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  appendLedgerLine,
  readLedgerAll,
  readLedgerSince,
} from "../src/ops/ledgerOp.js";
import { GestaltError } from "../src/errors.js";

describe("task ledger (WS-3 seam)", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  async function freshHome(): Promise<string> {
    home = mkdtempSync(path.join(tmpdir(), "gestalt-ledger-"));
    await runInit({ home });
    return home;
  }

  it("appendLedgerLine assigns monotonic seq and persists JSONL", async () => {
    const h = await freshHome();
    const a = await appendLedgerLine(
      h,
      "tasks-squirl",
      {
        task: "t1",
        cascadeRoot: "c1",
        idem: "idem-1",
        type: "assign",
        from: "human",
        to: "pip",
        parent: null,
        intent: "build hello",
        status: "assigned",
        agent: "harness",
        depth: 0,
      },
      { machineId: "m-a" },
    );
    expect(a.seq).toBe(1);
    expect(a.machineId).toBe("m-a");
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const b = await appendLedgerLine(
      h,
      "tasks-squirl",
      {
        task: "t1",
        cascadeRoot: "c1",
        idem: "idem-2",
        type: "claim",
        from: "pip",
        to: "pip",
        parent: null,
        status: "claimed",
        agent: "pip",
      },
      { machineId: "m-a" },
    );
    expect(b.seq).toBe(2);
    // Second machine keeps its own seq counter (Phase 0 HLC).
    const c = await appendLedgerLine(
      h,
      "tasks-squirl",
      {
        task: "t2",
        cascadeRoot: "c1",
        idem: "idem-b1",
        type: "assign",
        from: "pip",
        to: "devin",
        parent: "t1",
        agent: "pip",
      },
      { machineId: "m-b" },
    );
    expect(c.seq).toBe(1);
    expect(c.machineId).toBe("m-b");

    const all = await readLedgerAll(h, "tasks-squirl");
    expect(all).toHaveLength(3);
    expect(all[0]!.type).toBe("assign");
    expect(all[1]!.type).toBe("claim");
  });

  it("readLedgerSince is exclusive of afterSeq", async () => {
    const h = await freshHome();
    await appendLedgerLine(h, "tasks-squirl", {
      task: "t1",
      cascadeRoot: "c1",
      idem: "a",
      type: "assign",
      from: "human",
      to: "pip",
      parent: null,
      agent: "harness",
    });
    await appendLedgerLine(h, "tasks-squirl", {
      task: "t2",
      cascadeRoot: "c1",
      idem: "b",
      type: "assign",
      from: "pip",
      to: "devin",
      parent: "t1",
      agent: "pip",
    });
    const since1 = await readLedgerSince(h, "tasks-squirl", 1);
    expect(since1).toHaveLength(1);
    expect(since1[0]!.to).toBe("devin");
    expect(await readLedgerSince(h, "tasks-squirl", 99)).toEqual([]);
    expect(await readLedgerSince(h, "missing-ledger", 0)).toEqual([]);
  });

  it("rejects control chars and | in from/to/agent", async () => {
    const h = await freshHome();
    await expect(
      appendLedgerLine(h, "tasks-squirl", {
        task: "t1",
        cascadeRoot: "c1",
        idem: "x",
        type: "assign",
        from: "bad|agent",
        to: "pip",
        parent: null,
        agent: "harness",
      }),
    ).rejects.toBeInstanceOf(GestaltError);
  });

  it("rejects inline result content (resultRef must be work:// or mem://)", async () => {
    const h = await freshHome();
    await expect(
      appendLedgerLine(h, "tasks-squirl", {
        task: "t1",
        cascadeRoot: "c1",
        idem: "x",
        type: "result",
        from: "devin",
        to: "pip",
        parent: null,
        agent: "devin",
        resultRef: "https://evil.example/leak",
      }),
    ).rejects.toBeInstanceOf(GestaltError);
  });
});
