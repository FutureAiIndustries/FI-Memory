import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLog } from "../src/ops/logOp.js";
import { pullStore } from "../src/ops/pullOp.js";
import { runDoctor } from "../src/ops/doctor.js";
import { reviewShow } from "../src/ops/review.js";
import { search } from "../src/ops/search.js";
import { updateTopic } from "../src/ops/update.js";
import { reviewApprove } from "../src/ops/review.js";
import { fsPath, topicNotePath } from "../src/paths.js";
import { parseLog } from "../src/store/log.js";
import { parseNote } from "../src/store/note.js";
import { listProposals } from "../src/store/proposals.js";
import { readText } from "../src/store/read.js";
import { clockAt, runCli } from "./helpers.js";
import {
  T0,
  buildTrio,
  commitAll,
  filesWithMarkers,
  git,
  gitTry,
  rawPull,
  syncUntilClean,
} from "./gitHarness.js";

/**
 * THE THREE-STORE GATE (0.4). The 0.3.0 ship gate proved two machines; this
 * proves the fleet shape locally: three clones of one store, concurrent
 * writers, a three-way same-note conflict, a killed writer's residue, and the
 * push-race protocol no pair-based test ever exercised. What it deliberately
 * canNOT prove stays with the fleet gate: real network transport, cross-OS fs
 * semantics, true clock skew, version skew across installed artifacts, power
 * loss, and fi-server as a live participant.
 */

function doctorOpts(home: string, env: NodeJS.ProcessEnv) {
  return {
    home,
    env,
    hostConfigPaths: {} as Record<string, string>,
    rulesPaths: [{ host: "claude", file: path.join(home, "no-rules.md") }],
    shimSettingsPath: path.join(home, "no-settings.json"),
  };
}

describe("three-store gate — the 0.4 fleet shape, locally", () => {
  it("Leg 1+4: three concurrent writers, push-race convergence, no ACKed write lost, doctor green ×3", async () => {
    const trio = await buildTrio("gate-writers");
    const [a, b, c] = trio.clones as [string, string, string];

    // Three writers append concurrently to their own clones — the ACK is the
    // op's return. Keyed on (agent, summary): cross-machine timestamp
    // uniqueness is NOT a store guarantee pre-sync and asserting it would flake.
    const acks: Array<{ agent: string; summary: string }> = [];
    await Promise.all(
      trio.clones.map(async (home, ci) => {
        for (let i = 0; i < 5; i++) {
          const summary = `entry ${String(i)} from clone-${String(ci)} (marker s${String(ci)}x${String(i)})`;
          await appendLog(
            home,
            "alpha",
            { type: "gotcha", project: "gate", agent: `clone-${String(ci)}`, summary },
            { now: clockAt(T0 + 100_000 + ci * 10_000 + i * 1_000) },
          );
          acks.push({ agent: `clone-${String(ci)}`, summary });
        }
      }),
    );

    // Everyone commits, then syncs through the push race until clean; a final
    // pull-back round lands the last pushes everywhere.
    for (const home of trio.clones) commitAll(trio.env, home, "gate leg-1 entries");
    for (const home of trio.clones) await syncUntilClean(trio.env, home);
    for (const home of trio.clones) await pullStore({ home, env: trio.env });

    for (const home of trio.clones) {
      const logText = (await readText(path.join(home, "logs", "alpha.log.md")))!;
      const { entries } = parseLog(logText, "alpha");
      for (const ack of acks) {
        expect(
          entries.some((e) => e.agent === ack.agent && e.summary === ack.summary),
          `${ack.agent}: "${ack.summary}" missing from ${home}`,
        ).toBe(true);
      }
      expect(filesWithMarkers(home)).toEqual([]);
      const report = runDoctor(doctorOpts(home, trio.env));
      expect(report.healthy, `doctor unhealthy on ${home}`).toBe(true);
    }
    const heads = trio.clones.map((home) => git(trio.env, home, "rev-parse", "HEAD").trim());
    expect(new Set(heads).size).toBe(1);
  }, 180_000);

  it("Leg 2: three-way same-note conflict — one live body, two filed losers, every loser findable everywhere; one pull runs through the spawned CLI", async () => {
    const trio = await buildTrio("gate-threeway");
    const [a, b, c] = trio.clones as [string, string, string];

    // Each clone approves a DIFFERENT edit to alpha. Marker words all carry
    // the letter s — the /s+/ lesson: a fixture that cannot express the
    // failure proves nothing.
    const words = ["albatross-side", "osprey-side", "kestrel-side"] as const;
    for (const [i, home] of trio.clones.entries()) {
      const noteText = (await readText(topicNotePath(home, "alpha")))!;
      const note = parseNote(noteText, "alpha")!;
      const edited = noteText.replace(
        note.body,
        `\nThe ${words[i]!} paragraph from clone-${String(i)}.\n\n## Owner notes\n`,
      );
      const r = await updateTopic(home, "alpha", edited, {
        proposer: `clone-${String(i)}`,
        now: clockAt(T0 + 200_000 + i * 10_000),
      });
      await reviewApprove(home, r.seq, { now: clockAt(T0 + 201_000 + i * 10_000) });
      commitAll(trio.env, home, `clone-${String(i)} approves its edit`);
    }

    // Convergence is sequential by nature: 0 pushes clean; 1 pulls (conflict,
    // resolver files 0-vs-1 loser), pushes; 2 pulls the merged pair (second
    // resolver round), pushes; then everyone pulls back.
    await syncUntilClean(trio.env, a);
    await syncUntilClean(trio.env, b);
    // Clone 2's pull goes through the SPAWNED CLI — the user-shaped
    // `fimemory pull` over a real conflict, exercised by nothing before 0.4.
    const cli = runCli(["pull", "--home", c], { home: c, env: trio.env });
    expect(cli.code, `CLI pull failed:\n${cli.stderr}`).toBe(0);
    expect(/^\s*node:internal|^Error:|at .*\.ts:\d+/m.test(cli.stderr)).toBe(false);
    const push = gitTry(trio.env, c, "push", "-q", "origin", "main");
    expect(push.ok).toBe(true);
    for (const home of trio.clones) await pullStore({ home, env: trio.env });

    // Exactly one live body fleet-wide, and it is identical everywhere.
    const bodies = await Promise.all(
      trio.clones.map(async (home) => parseNote((await readText(topicNotePath(home, "alpha")))!, "alpha")!.body),
    );
    expect(new Set(bodies).size).toBe(1);
    const liveWord = words.find((w) => bodies[0]!.includes(w))!;
    expect(liveWord).toBeDefined();

    // Both losing bodies are pending proposals somewhere, and every loser's
    // marker word is findable from EVERY clone (log excerpt or proposal).
    const losers = words.filter((w) => w !== liveWord);
    for (const home of trio.clones) {
      const pending = (await listProposals(home)).filter((p) => p.status === "pending");
      expect(pending.length).toBeGreaterThanOrEqual(2);
      for (const w of losers) {
        const hits = await search(home, w.replace(/-/g, " "));
        expect(hits.hits.length, `"${w}" not findable from ${home}`).toBeGreaterThan(0);
      }
      expect(filesWithMarkers(home)).toEqual([]);
    }
  }, 180_000);

  it("Leg 3: a killed writer's residue — the fleet converges without the victim, the victim recovers, the remote stays clean", async () => {
    const trio = await buildTrio("gate-killed");
    const [a, b, c] = trio.clones as [string, string, string];

    // The post-kill state, manufactured deterministically (the real SIGKILL
    // race is probed in contention-processes; a gate must not flake): a torn
    // atomic temp and a dead holder's lock + owner record on clone C.
    writeFileSync(
      fsPath(path.join(c, "topics", ".alpha.md.tmp-999999-0")),
      "half a note from a writer that died\n",
      "utf8",
    );
    mkdirSync(fsPath(path.join(c, ".gestalt.lock")), { recursive: true });
    const staleMtime = new Date(Date.now() - 10_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(fsPath(path.join(c, ".gestalt.lock")), staleMtime, staleMtime);
    writeFileSync(
      fsPath(path.join(c, ".gestalt.lock.owner")),
      JSON.stringify({
        pid: 999999,
        processStartTime: Date.now() - 60_000,
        host: (await import("node:os")).default.hostname(),
        acquiredAt: Date.now() - 30_000,
      }),
      "utf8",
    );

    // A and B keep working and converge WITHOUT C — a dead clone never stalls
    // the fleet.
    await appendLog(a, "beta", { type: "decision", project: "gate", agent: "clone-0", summary: "progress despite the corpse" }, { now: clockAt(T0 + 300_000) });
    commitAll(trio.env, a, "a progresses");
    await syncUntilClean(trio.env, a);
    await pullStore({ home: b, env: trio.env });

    // C recovers: the next write steals the dead lock (D7) and reindex sweeps
    // the temp (D5); the commit ships neither (both gitignored since 0.4).
    await appendLog(c, "beta", { type: "decision", project: "gate", agent: "clone-2", summary: "the victim comes back" }, { now: clockAt(T0 + 310_000) });
    const cliReindex = runCli(["reindex", "--home", c], { home: c, env: trio.env });
    expect(cliReindex.code).toBe(0);
    commitAll(trio.env, c, "c recovers");
    await syncUntilClean(trio.env, c);
    for (const home of trio.clones) await pullStore({ home, env: trio.env });

    // The remote tree holds no residue — neither the temp nor lock machinery.
    const remoteTree = git(trio.env, trio.root, "--git-dir", trio.origin, "ls-tree", "-r", "HEAD", "--name-only");
    expect(remoteTree).not.toMatch(/\.tmp-/);
    expect(remoteTree).not.toMatch(/\.gestalt\.lock/);

    // Everyone holds everyone's entries; doctor green ×3.
    for (const home of trio.clones) {
      const logText = (await readText(path.join(home, "logs", "beta.log.md")))!;
      expect(logText).toContain("progress despite the corpse");
      expect(logText).toContain("the victim comes back");
      const report = runDoctor(doctorOpts(home, trio.env));
      expect(report.healthy, `doctor unhealthy on ${home}`).toBe(true);
    }
  }, 180_000);
});
