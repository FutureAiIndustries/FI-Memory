/**
 * Sync freshness — the third doctor score (2026-08-10).
 *
 * The question this answers is "is this the same store my other machines see?",
 * and the whole value of it is that it must be QUIET when nothing is wrong.
 * The first version was not: run against the real store it reported fi-server
 * as NOT SYNCING because an old machine id from the id split was three days
 * cold, while fi-server itself was beating every 25 seconds under its current
 * id. A check that cries wolf on every run is worse than no check, so the
 * tiering below is the substance of the module and most of these tests exist to
 * pin it.
 *
 * The rule the tiers encode: the unit of "is a machine syncing" is the HOST,
 * not the id. A host with any beating record is syncing, whatever its retired
 * ids look like.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runDoctor } from "../src/ops/doctor.js";
import { STALE_AFTER_MS, assessSyncFreshness } from "../src/ops/syncFreshness.js";
import { freshHome } from "./helpers.js";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function freshStore(withStateDir = true): string {
  const home = mkdtempSync(path.join(tmpdir(), "sync-freshness-"));
  if (withStateDir) mkdirSync(path.join(home, "state"));
  return home;
}

interface RecordOpts {
  machineId: string;
  /** `machineId_local` — the id in the writer's own config dir. */
  machineIdLocal?: string;
  /** `machineId_source` — "daemon" | "config-dir" | "absent". */
  machineIdSource?: string;
  host?: string | null;
  /** How long before NOW this record was captured. */
  ageMs?: number;
  shadowIds?: string[];
  repos?: { label: string; ahead?: number; behind?: number; dirty?: boolean }[];
  /** Write no captured_at at all. */
  omitTimestamp?: boolean;
  /**
   * File name inside state/, when it must differ from `<machineId>.json`.
   *
   * Needed to write the SAME machine id twice, which is the whole shape of the
   * cloned-image / restored-backup / re-seeded-config-dir case. Records are
   * keyed by file on disk, so this is a real state a store can reach — a store
   * that has received records from two boxes carrying one id.
   */
  file?: string;
}

function writeRecord(home: string, o: RecordOpts): void {
  const body: Record<string, unknown> = {
    schema: 1,
    machineId: o.machineId,
    host: o.host === undefined ? "box-a" : o.host,
    shadow_ids: o.shadowIds ?? [],
    repos: (o.repos ?? []).map((r) => ({
      label: r.label,
      ahead: r.ahead ?? 0,
      behind: r.behind ?? 0,
      dirty: r.dirty ?? false,
    })),
  };
  if (o.machineIdLocal !== undefined) body["machineId_local"] = o.machineIdLocal;
  if (o.machineIdSource !== undefined) body["machineId_source"] = o.machineIdSource;
  if (!o.omitTimestamp) {
    body["captured_at"] = new Date(NOW - (o.ageMs ?? 0)).toISOString();
  }
  writeFileSync(path.join(home, "state", o.file ?? `${o.machineId}.json`), JSON.stringify(body), "utf8");
}

const OVERDUE = STALE_AFTER_MS + 60_000;

describe("sync freshness — when it cannot assess", () => {
  it("says so plainly when there is no state/ directory, and names Harness as the writer", () => {
    const home = freshStore(false);
    const r = assessSyncFreshness(home, NOW);
    expect(r.assessed).toBe(false);
    // The operator has to learn that no heartbeat means no daemon, not a
    // healthy store with nothing to report.
    expect(r.reason).toMatch(/Harness/);
    expect(r.machines).toEqual([]);
  });

  it("reports an empty state/ as unassessed rather than as zero healthy machines", () => {
    const r = assessSyncFreshness(freshStore(), NOW);
    expect(r.assessed).toBe(false);
    expect(r.staleCount).toBe(0);
  });

  it("skips an unreadable record instead of failing the whole check, and counts it", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-good" });
    writeFileSync(path.join(home, "state", "m-torn.json"), "{ not json", "utf8");
    const r = assessSyncFreshness(home, NOW);
    // A half-written record mid-rename is normal on a store three machines
    // write to; it must not take the diagnostic down with it.
    expect(r.assessed).toBe(true);
    expect(r.machines.map((m) => m.machineId)).toEqual(["m-good"]);
    // ...but it must not vanish either. Dropping it silently does not degrade
    // the score, it removes a machine from the fleet.
    expect(r.unreadable.map((u) => u.file)).toEqual(["m-torn.json"]);
  });

  it("names a record left holding merge-conflict markers rather than dropping the machine", () => {
    // These files are JSON synced through git, so this is a state a store
    // genuinely sits in — and it is persistent, not a torn read that clears.
    const home = freshStore();
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000 });
    writeFileSync(
      path.join(home, "state", "m-stopped.json"),
      '<<<<<<< HEAD\n{"machineId":"m-stopped","host":"box-b"}\n=======\n{"machineId":"m-stopped","host":"box-b"}\n>>>>>>> origin/main\n',
      "utf8",
    );
    const r = assessSyncFreshness(home, NOW);
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]!.file).toBe("m-stopped.json");
    expect(r.unreadable[0]!.reason).toMatch(/JSON/);
  });

  it("reads a record that came back from a Windows editor with a byte-order mark", () => {
    // Found by running the real CLI. This check tells the operator to open an
    // unreadable record and repair it; saved from a Windows editor it returns
    // BOM-first, JSON.parse rejects that, and the record stays unreadable
    // forever. Advice that cannot be followed successfully is worse than none.
    const home = freshStore();
    const body = JSON.stringify({
      machineId: "m-repaired",
      host: "box-a",
      captured_at: new Date(NOW - 30_000).toISOString(),
    });
    writeFileSync(
      path.join(home, "state", "m-repaired.json"),
      `${String.fromCharCode(0xfeff)}${body}`,
      "utf8",
    );
    const r = assessSyncFreshness(home, NOW);
    expect(r.unreadable).toEqual([]);
    expect(r.machines.map((m) => m.machineId)).toEqual(["m-repaired"]);
  });

  it("keeps the reason for an unreadable record to one short line", () => {
    // The parser quotes the file back inside its message, so the reason
    // arrives with newlines and no length bound — which breaks the aligned
    // Machines block into a row per line. Also found by running the CLI.
    const home = freshStore();
    writeRecord(home, { machineId: "m-good" });
    writeFileSync(
      path.join(home, "state", "m-multiline.json"),
      `{\n  "machineId": "m-multiline",\n  broken\n  ${"x".repeat(400)}\n}`,
      "utf8",
    );
    const r = assessSyncFreshness(home, NOW);
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]!.reason).not.toMatch(/\n/);
    expect(r.unreadable[0]!.reason.length).toBeLessThanOrEqual(120);
  });

  it("does not report an empty healthy fleet when EVERY record is unreadable", () => {
    // The limit case. Nothing assessable, four machines invisible, and the old
    // report said only "no readable machine records" with no count anywhere.
    const home = freshStore();
    for (const id of ["m-1", "m-2", "m-3", "m-4"]) {
      writeFileSync(path.join(home, "state", `${id}.json`), "<<<<<<< HEAD\n", "utf8");
    }
    const r = assessSyncFreshness(home, NOW);
    expect(r.assessed).toBe(false);
    expect(r.unreadable).toHaveLength(4);
  });
});

describe("sync freshness — one staleness window across both tools", () => {
  it("uses the writer's 4h window, so this score and the cross-machine check cannot contradict each other", () => {
    // The Harness daemon WRITES these records and its own comparison refuses
    // anything older than DEFAULT_MAX_STALENESS_MS (4h) in
    // scripts/lib/machine-state-core.mjs. That makes it the authority on how
    // old a heartbeat may be; this constant tracks it. Pinned because a store
    // with two disagreeing windows on it is the actual defect.
    expect(STALE_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("does not call a machine dark inside the band the other tool still calls current", () => {
    // 2h quiet: a suspended laptop, a daemon restarted mid-deploy, a slow poll.
    // On the old 15m window this was NOT SYNCING here and current there, and
    // both reports were run on the same box minutes apart.
    const home = freshStore();
    writeRecord(home, { machineId: "m-napping", host: "box-a", ageMs: 2 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.staleCount).toBe(0);
    expect(r.freshCount).toBe(1);
  });

  it("still calls a machine dark once it is past the shared window", () => {
    // Quiet must not become silent: past 4h both tools agree it has stopped.
    const home = freshStore();
    writeRecord(home, { machineId: "m-gone", host: "box-a", ageMs: 5 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.staleCount).toBe(1);
  });
});

describe("sync freshness — the tiers", () => {
  it("counts a beating machine as fresh", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-live", ageMs: 30_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.freshCount).toBe(1);
    expect(r.staleCount).toBe(0);
    expect(r.machines[0]!.stale).toBe(false);
  });

  it("calls a host dark when it is overdue and nothing else from that host is beating", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000 });
    writeRecord(home, { machineId: "m-gone", host: "box-b", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    const gone = r.machines.find((m) => m.machineId === "m-gone")!;
    expect(gone.stale).toBe(true);
    expect(gone.suspect).toBe(false);
    expect(r.staleCount).toBe(1);
  });

  it("does NOT call an id dark when its own host is still beating (the false alarm that forced this tier)", () => {
    const home = freshStore();
    // Exactly the shape of the real store: fi-server beating under a current
    // id, with a three-day-old id from the machine-id split beside it.
    writeRecord(home, { machineId: "m-current", host: "fi-server", ageMs: 25_000 });
    writeRecord(home, { machineId: "m-retired", host: "fi-server", ageMs: 76 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    const retired = r.machines.find((m) => m.machineId === "m-retired")!;
    expect(retired.stale).toBe(false);
    expect(retired.suspect).toBe(true);
    expect(r.staleCount).toBe(0);
    expect(r.suspectCount).toBe(1);
    // ...but nothing on that host accounts for it, so it is not quietly
    // filed as bookkeeping either. See the suspect-evidence block below.
    expect(retired.claimedBy).toBeNull();
    expect(r.unclaimedCount).toBe(1);
  });

  it("treats a same-host record named in a fresh record's shadow_ids as a proven ghost", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-current",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-old"],
    });
    writeRecord(home, { machineId: "m-old", host: "box-a", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    const old = r.machines.find((m) => m.machineId === "m-old")!;
    expect(old.ghost).toBe(true);
    expect(old.stale).toBe(false);
    expect(old.suspect).toBe(false);
    expect(r.ghostCount).toBe(1);
  });

  it("refuses to let a stale record disown anything, so two dead records cannot vouch each other into silence", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-deadA",
      host: "box-a",
      ageMs: OVERDUE,
      shadowIds: ["m-deadB"],
    });
    writeRecord(home, { machineId: "m-deadB", host: "box-a", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    expect(r.ghostCount).toBe(0);
    // Neither host record is beating, so the host really is dark.
    expect(r.staleCount).toBe(2);
  });

  it("will not ghost a record that is beating, however loudly another record disowns it", () => {
    // Harness writes shadow_ids whenever the daemon id differs from the
    // config-dir id, so during a cutover BOTH records are briefly fresh. The
    // ungated version filed the live machine under bookkeeping.
    const home = freshStore();
    writeRecord(home, { machineId: "m-new", host: "box-a", ageMs: 20_000, shadowIds: ["m-old"] });
    writeRecord(home, { machineId: "m-old", host: "box-a", ageMs: 20_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.ghostCount).toBe(0);
    expect(r.freshCount).toBe(2);
  });

  it("ignores a record that names itself in shadow_ids, which would retire the machine that is beating", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-self", host: "box-a", ageMs: 20_000, shadowIds: ["m-self"] });
    const r = assessSyncFreshness(home, NOW);
    expect(r.ghostCount).toBe(0);
    expect(r.freshCount).toBe(1);
  });

  it("will not let two host-less records retire each other on null === null", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-a", host: null, ageMs: 20_000, shadowIds: ["m-b"] });
    writeRecord(home, { machineId: "m-b", host: null, ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    expect(r.ghostCount).toBe(0);
    const b = r.machines.find((m) => m.machineId === "m-b")!;
    expect(b.stale).toBe(true);
    // A null host can never be "a host that is beating", so no suspect either.
    expect(b.suspect).toBe(false);
  });

  it("will not let a live record on one host retire the SAME id on another host", () => {
    // One machine id, two hosts — a cloned VM image, a restored backup or a
    // re-seeded config dir, which is the id churn this module is about. box-a's
    // live daemon disowns "m-dup" as its own leftover; box-b is a different box
    // that has genuinely stopped. Keyed on the bare id, box-a's claim retired
    // box-b: the dark host read as bookkeeping and vanished from the report.
    const home = freshStore();
    writeRecord(home, {
      file: "1-a-live.json",
      machineId: "m-a-live",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-dup"],
    });
    writeRecord(home, { file: "2-a-dup.json", machineId: "m-dup", host: "box-a", ageMs: OVERDUE });
    writeRecord(home, { file: "3-b-dup.json", machineId: "m-dup", host: "box-b", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    const onB = r.machines.find((m) => m.machineId === "m-dup" && m.host === "box-b")!;
    expect(onB.ghost).toBe(false);
    expect(onB.stale).toBe(true);
    // box-a's own leftover is still correctly retired: the fix narrows the
    // claim to its host, it does not throw the tier away.
    const onA = r.machines.find((m) => m.machineId === "m-dup" && m.host === "box-a")!;
    expect(onA.ghost).toBe(true);
    expect(r.staleCount).toBe(1);
    expect(r.ghostCount).toBe(1);
  });

  it("resolves a duplicated id by host, not by whichever record the directory listed first", () => {
    // The other half of the same defect: the old code host-checked ONE record
    // found by id, so with the foreign copy listed first the check compared the
    // wrong hosts and the genuine same-host ghost was never recognised. Same
    // fixture as above, opposite file order — the verdicts must not move.
    const home = freshStore();
    writeRecord(home, { file: "1-b-dup.json", machineId: "m-dup", host: "box-b", ageMs: OVERDUE });
    writeRecord(home, {
      file: "2-a-live.json",
      machineId: "m-a-live",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-dup"],
    });
    writeRecord(home, { file: "3-a-dup.json", machineId: "m-dup", host: "box-a", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines.find((m) => m.machineId === "m-dup" && m.host === "box-a")!.ghost).toBe(true);
    expect(r.machines.find((m) => m.machineId === "m-dup" && m.host === "box-b")!.stale).toBe(true);
  });

  it("ignores a shadow_ids claim across hosts — a different host is never a ghost", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-a",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-b"],
    });
    writeRecord(home, { machineId: "m-b", host: "box-b", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    const b = r.machines.find((m) => m.machineId === "m-b")!;
    expect(b.ghost).toBe(false);
    expect(b.stale).toBe(true);
  });
});

/**
 * What makes an overdue id quiet. The tiers exist to keep this score quiet on a
 * healthy fleet, and the thing they may keep quiet is BOOKKEEPING — never a
 * machine. A shared hostname is not evidence about a machine, and treating it
 * as evidence is what let a box dead for three days read as all-clear.
 */
describe("sync freshness — a hostname does not vouch for a machine", () => {
  it("does not let one daemon's heartbeat account for a different daemon on the same box", () => {
    // This project deliberately runs more than one daemon per machine (an
    // office daemon beside the cockpit daemon). The live one shares the host
    // string, so under the old rule it silenced the dead one at INFO, forever,
    // with "almost certainly retired ids, not stopped machines".
    const home = freshStore();
    writeRecord(home, { machineId: "m-cockpit", host: "box-a", ageMs: 30_000 });
    writeRecord(home, { machineId: "m-office", host: "box-a", ageMs: 3 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    const office = r.machines.find((m) => m.machineId === "m-office")!;
    expect(office.suspect).toBe(true);
    expect(office.claimedBy).toBeNull();
    expect(r.unclaimedCount).toBe(1);
  });

  it("does not let two machines sharing a default hostname vouch for each other", () => {
    // A board's un-renamed DMI default hostname is reported by every
    // Ubuntu box off that board reports, so two DISTINCT machines collide on
    // the host string by construction. Freshness of one says nothing about the
    // other.
    const home = freshStore();
    const host = "linux-System-Product-Name";
    writeRecord(home, { file: "1-live.json", machineId: "m-live", host, ageMs: 40_000 });
    writeRecord(home, { file: "2-dead.json", machineId: "m-dead", host, ageMs: 3 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines.find((m) => m.machineId === "m-dead")!.claimedBy).toBeNull();
    expect(r.unclaimedCount).toBe(1);
  });

  it("goes quiet when a beating record names the overdue id as its own config-dir id", () => {
    // The real corroboration, and the shape of the live store's PC record:
    // published as m-daemon, machineId_local m-old. That is the live daemon
    // making a statement about its OWN identity, not about a hostname.
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-daemon",
      host: "box-a",
      ageMs: 30_000,
      machineIdLocal: "m-old",
      machineIdSource: "daemon",
    });
    writeRecord(home, { machineId: "m-old", host: "box-a", ageMs: 3 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    const old = r.machines.find((m) => m.machineId === "m-old")!;
    expect(old.suspect).toBe(true);
    expect(old.claimedBy).toBe("m-daemon");
    expect(r.unclaimedCount).toBe(0);
  });

  it("will not let a claim silence a record a daemon published under its own id", () => {
    // The writer's own ghost detection refuses to retire an id a daemon
    // asserted as its own; this refuses to quieten one for the same reason.
    // A daemon-sourced record was a daemon running as itself, so "that is just
    // my old config-dir name" does not fit it.
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-daemon",
      host: "box-a",
      ageMs: 30_000,
      machineIdLocal: "m-other",
    });
    writeRecord(home, {
      machineId: "m-other",
      host: "box-a",
      ageMs: 3 * 24 * 3600_000,
      machineIdSource: "daemon",
    });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines.find((m) => m.machineId === "m-other")!.claimedBy).toBeNull();
    expect(r.unclaimedCount).toBe(1);
  });

  it("keeps a claim on its own host, so a claim cannot cross to a colliding hostname", () => {
    const home = freshStore();
    writeRecord(home, {
      file: "1-a-live.json",
      machineId: "m-a-live",
      host: "box-a",
      ageMs: 30_000,
      machineIdLocal: "m-dup",
    });
    writeRecord(home, { file: "2-b-dup.json", machineId: "m-dup", host: "box-b", ageMs: OVERDUE });
    writeRecord(home, { file: "3-b-live.json", machineId: "m-b-live", host: "box-b", ageMs: 30_000 });
    const r = assessSyncFreshness(home, NOW);
    // box-a's claim over "m-dup" must not account for box-b's m-dup.
    expect(r.machines.find((m) => m.machineId === "m-dup")!.claimedBy).toBeNull();
  });

  it("never treats age alone as the discriminator: a long-dead unclaimed id stays loud, a claimed one stays quiet", () => {
    // Age is the wrong test in both directions. A legitimately retired id only
    // gets older, so ageing into a warning would nag forever; and a machine
    // that stopped does not become fine by staying stopped.
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-live",
      host: "box-a",
      ageMs: 30_000,
      machineIdLocal: "m-claimed",
    });
    writeRecord(home, { machineId: "m-claimed", host: "box-a", ageMs: 40 * 24 * 3600_000 });
    writeRecord(home, { machineId: "m-nobodys", host: "box-a", ageMs: 40 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines.find((m) => m.machineId === "m-claimed")!.claimedBy).toBe("m-live");
    expect(r.machines.find((m) => m.machineId === "m-nobodys")!.claimedBy).toBeNull();
    expect(r.unclaimedCount).toBe(1);
  });
});

describe("sync freshness — reading the record", () => {
  it("absorbs small clock drift: a slightly-future heartbeat clamps to now and stays fresh", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-jitter", ageMs: -30_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines[0]!.ageMs).toBe(0);
    expect(r.machines[0]!.skewed).toBe(false);
    expect(r.machines[0]!.stale).toBe(false);
  });

  it("refuses to let a badly-skewed future heartbeat buy freshness for a dark host", () => {
    // The dangerous direction. Clamping age to 0 made a machine dead for days
    // the FRESHEST record on the store, and doctor reported it as healthy.
    const home = freshStore();
    writeRecord(home, { machineId: "m-skew", host: "box-dead", ageMs: -3 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines[0]!.skewed).toBe(true);
    expect(r.machines[0]!.ageMs).toBeNull();
    expect(r.machines[0]!.stale).toBe(true);
    expect(r.freshCount).toBe(0);
  });

  it("does not let a skewed record vouch for its own host, demoting a dead sibling to suspect", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-skew", host: "box-dead", ageMs: -3 * 24 * 3600_000 });
    writeRecord(home, { machineId: "m-dead", host: "box-dead", ageMs: 4 * 24 * 3600_000 });
    const r = assessSyncFreshness(home, NOW);
    expect(r.suspectCount).toBe(0);
    expect(r.staleCount).toBe(2);
  });

  it("does not let a skewed record disown a sibling into silence", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-skew",
      host: "box-a",
      ageMs: -3 * 24 * 3600_000,
      shadowIds: ["m-old"],
    });
    writeRecord(home, { machineId: "m-old", host: "box-a", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    expect(r.ghostCount).toBe(0);
  });

  it("treats a record with no timestamp as overdue, never as fresh", () => {
    const home = freshStore();
    writeRecord(home, { machineId: "m-notime", omitTimestamp: true });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines[0]!.ageMs).toBeNull();
    expect(r.machines[0]!.stale).toBe(true);
  });

  it("counts ahead/behind as drift but never `dirty` alone", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-live",
      ageMs: 30_000,
      repos: [
        // The store repo is legitimately dirty between a log write and the next
        // sync commit. Flagging that would fire on nearly every run.
        { label: "store", dirty: true },
        { label: "harness", ahead: 3 },
        { label: "runtime", behind: 106 },
      ],
    });
    const r = assessSyncFreshness(home, NOW);
    const drift = r.machines[0]!.drift;
    expect(drift.map((d) => d.label).sort()).toEqual(["harness", "runtime"]);
    expect(drift.find((d) => d.label === "harness")!.ahead).toBe(3);
  });

  it("sorts live machines ahead of dark ones, and bookkeeping last", () => {
    const home = freshStore();
    writeRecord(home, {
      machineId: "m-live",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-ghost"],
    });
    writeRecord(home, { machineId: "m-ghost", host: "box-a", ageMs: OVERDUE });
    writeRecord(home, { machineId: "m-dark", host: "box-b", ageMs: OVERDUE });
    const r = assessSyncFreshness(home, NOW);
    expect(r.machines.map((m) => m.machineId)).toEqual(["m-live", "m-dark", "m-ghost"]);
  });
});

/**
 * The findings themselves. The module tests above pin the tiers; these pin
 * what doctor DOES with them, which is where the exit-code contract lives and
 * where the per-record-vs-per-host mistake showed up.
 */
function doctorStore(label: string): string {
  const home = freshHome(label);
  runInit({ home, env: {} });
  mkdirSync(path.join(home, "state"), { recursive: true });
  return home;
}

function doctorOn(home: string) {
  const userHome = freshHome("sync-userhome");
  mkdirSync(userHome, { recursive: true });
  return runDoctor({
    home,
    userHome,
    env: {},
    now: NOW,
    shimSettingsPath: path.join(userHome, ".claude", "settings.json"),
  });
}

describe("doctor carries the third score without touching the exit contract", () => {
  it("warns that a dark host is not syncing, and never as `fail`", () => {
    const home = doctorStore("sync-doctor-dark");
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000 });
    writeRecord(home, { machineId: "m-gone", host: "box-b", ageMs: OVERDUE });
    const r = doctorOn(home);
    const f = r.findings.find((x) => x.code === "machine_not_syncing");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
    expect(f!.message).toContain("box-b");
    // The window in force is stated, so this verdict and the cross-machine
    // tool's verdict on the same record can be reconciled without reading
    // either source.
    expect(f!.message).toContain("overdue past 4h");
  });

  it("emits ONE finding for a dark host carrying several retired ids, not one per record", () => {
    // The cry-wolf failure reappearing one level up: three ids on one dead box
    // must read as one dead box.
    const home = doctorStore("sync-doctor-grouped");
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000 });
    writeRecord(home, { machineId: "m-gone1", host: "box-b", ageMs: OVERDUE });
    writeRecord(home, { machineId: "m-gone2", host: "box-b", ageMs: OVERDUE * 2 });
    writeRecord(home, { machineId: "m-gone3", host: "box-b", ageMs: OVERDUE * 3 });
    const r = doctorOn(home);
    const all = r.findings.filter((x) => x.code === "machine_not_syncing");
    expect(all).toHaveLength(1);
    // and it reports the freshest age for that host, not an arbitrary one
    expect(all[0]!.message).toContain("3 ids");
  });

  it("reports a CLAIMED retired id on a beating host at INFO, never as a sync failure", () => {
    const home = doctorStore("sync-doctor-suspect");
    writeRecord(home, {
      machineId: "m-current",
      host: "fi-server",
      ageMs: 25_000,
      machineIdLocal: "m-retired",
    });
    writeRecord(home, { machineId: "m-retired", host: "fi-server", ageMs: 76 * 3600_000 });
    const r = doctorOn(home);
    expect(r.findings.find((x) => x.code === "machine_not_syncing")).toBeUndefined();
    const f = r.findings.find((x) => x.code === "machine_id_probably_retired");
    expect(f).toBeDefined();
    expect(f!.level).toBe("info");
    expect(f!.message).toContain("claimed by m-current");
  });

  it("warns, and refuses to guess, when nothing on a syncing host accounts for an overdue id", () => {
    // The reproduction: a dead daemon beside a live one on a box, or a second
    // machine sharing a default hostname. Reported at INFO as "almost
    // certainly retired ids, not stopped machines" — a conclusion from a
    // string match — a machine three days dead read as all-clear.
    const home = doctorStore("sync-doctor-unaccounted");
    writeRecord(home, { machineId: "m-live", host: "linux-System-Product-Name", ageMs: 25_000 });
    writeRecord(home, { machineId: "m-dead", host: "linux-System-Product-Name", ageMs: 76 * 3600_000 });
    const r = doctorOn(home);
    expect(r.findings.find((x) => x.code === "machine_id_probably_retired")).toBeUndefined();
    const f = r.findings.find((x) => x.code === "machine_id_unaccounted");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
    expect(f!.message).toContain("m-dead");
    // It must say what it cannot tell, rather than assert one of the two.
    expect(f!.message).toMatch(/EITHER a retired id .* OR a second daemon/);
    expect(f!.message).toMatch(/cannot tell which/);
    // ...and it must not repeat the old claim.
    expect(f!.message).not.toMatch(/almost certainly/);
    // The cure is stated and it is permanent, so the warning is not a nag.
    expect(f!.hint).toContain("state/.retired/");
  });

  it("says nothing at all about a machine whose record was properly retired", () => {
    // The other half of "not a nag": state/.retired/ is not read, so retiring
    // a record silences it for good — which is why the discriminator is
    // evidence rather than age.
    const home = doctorStore("sync-doctor-retired-dir");
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 25_000 });
    mkdirSync(path.join(home, "state", ".retired"), { recursive: true });
    writeFileSync(
      path.join(home, "state", ".retired", "m-old.json"),
      JSON.stringify({ machineId: "m-old", host: "box-a", captured_at: new Date(NOW - 76 * 3600_000).toISOString() }),
      "utf8",
    );
    const r = doctorOn(home);
    expect(r.sync.machines.map((m) => m.machineId)).toEqual(["m-live"]);
    for (const code of ["machine_not_syncing", "machine_id_unaccounted", "machine_id_probably_retired"]) {
      expect(r.findings.find((x) => x.code === code)).toBeUndefined();
    }
  });

  it("still warns about a dark host whose id is duplicated on a live host", () => {
    // The consequence at the layer the operator actually reads: box-b had
    // stopped and doctor said nothing at all, because a live record on box-a
    // carrying the same id had retired it.
    const home = doctorStore("sync-doctor-dupid");
    writeRecord(home, {
      file: "1-a-live.json",
      machineId: "m-a-live",
      host: "box-a",
      ageMs: 30_000,
      shadowIds: ["m-dup"],
    });
    writeRecord(home, { file: "2-a-dup.json", machineId: "m-dup", host: "box-a", ageMs: OVERDUE });
    writeRecord(home, { file: "3-b-dup.json", machineId: "m-dup", host: "box-b", ageMs: OVERDUE });
    const r = doctorOn(home);
    const f = r.findings.find((x) => x.code === "machine_not_syncing");
    expect(f).toBeDefined();
    expect(f!.message).toContain("box-b");
  });

  it("warns when a live machine reports unpushed commits, since a heartbeat is not proof work is shared", () => {
    const home = doctorStore("sync-doctor-unpushed");
    writeRecord(home, {
      machineId: "m-live",
      host: "box-a",
      ageMs: 30_000,
      repos: [{ label: "harness", ahead: 3 }],
    });
    const r = doctorOn(home);
    const f = r.findings.find((x) => x.code === "machine_has_unpushed");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
    expect(f!.message).toContain("harness +3");
  });

  it("warns about a record it cannot read, naming the file, so a stopped machine cannot hide in a parse error", () => {
    // Reproduction of the erasure: box-b has stopped AND its record carries
    // merge-conflict markers. Before this, doctor produced no machine_* finding
    // of any kind and the id appeared nowhere in the report.
    const home = doctorStore("sync-doctor-unreadable");
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000 });
    writeFileSync(
      path.join(home, "state", "m-stopped.json"),
      '<<<<<<< HEAD\n{"machineId":"m-stopped"}\n=======\n{"machineId":"m-stopped"}\n>>>>>>> origin/main\n',
      "utf8",
    );
    const r = doctorOn(home);
    const f = r.findings.find((x) => x.code === "machine_state_unreadable");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
    expect(f!.message).toContain("m-stopped.json");
  });

  it("still warns when NOTHING in state/ can be read, where there is no fleet left to report on", () => {
    const home = doctorStore("sync-doctor-all-unreadable");
    writeFileSync(path.join(home, "state", "m-a.json"), "<<<<<<< HEAD\n", "utf8");
    writeFileSync(path.join(home, "state", "m-b.json"), "<<<<<<< HEAD\n", "utf8");
    const r = doctorOn(home);
    expect(r.sync.assessed).toBe(false);
    const f = r.findings.find((x) => x.code === "machine_state_unreadable");
    expect(f).toBeDefined();
    expect(f!.message).toContain("2 machine heartbeat record(s)");
  });

  it("says plainly that it could not assess when no daemon has ever written a heartbeat", () => {
    const home = freshHome("sync-doctor-nostate");
    runInit({ home, env: {} });
    const r = doctorOn(home);
    expect(r.sync.assessed).toBe(false);
    expect(r.sync.reason).toMatch(/Harness/);
    expect(r.findings.find((x) => x.code === "machine_not_syncing")).toBeUndefined();
  });

  it("NO sync code is ever `fail` — the exit contract, asserted directly", () => {
    const home = doctorStore("sync-doctor-contract");
    writeRecord(home, { machineId: "m-live", host: "box-a", ageMs: 30_000, repos: [{ label: "h", ahead: 1 }] });
    writeRecord(home, { machineId: "m-gone", host: "box-b", ageMs: OVERDUE });
    writeRecord(home, { machineId: "m-retired", host: "box-a", ageMs: OVERDUE });
    const r = doctorOn(home);
    for (const code of [
      "machine_not_syncing",
      "machine_id_probably_retired",
      "machine_id_unaccounted",
      "machine_state_unreadable",
      "machine_has_unpushed",
    ]) {
      const f = r.findings.find((x) => x.code === code);
      if (f) expect(f.level).not.toBe("fail");
    }
  });
});
