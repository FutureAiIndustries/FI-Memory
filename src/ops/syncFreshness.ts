import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fsPath } from "../paths.js";

/**
 * Sync freshness — the third score.
 *
 * `doctor` answers CONNECT (is the install wired up) and CONTENT (does the
 * store hold anything true about its owner). Neither answers the question an
 * operator running more than one machine actually asks: **is this store the
 * same store my other machines are looking at?**
 *
 * Nothing surfaced that before this module. A store whose syncer died three
 * days ago and a store that synced ten seconds ago produced an identical
 * report, and the only way to tell them apart was a five-command git
 * investigation per machine. That is the same false-green shape as the Mac-beta
 * CONNECT/CONTENT finding: the signal the operator checks cannot distinguish
 * working from silently broken.
 *
 * WHERE THE SIGNAL COMES FROM. The Harness daemon writes a machine-state record
 * to `<store>/state/<machineId>.json` on each poll, and those records sync into
 * the store like everything else. So every machine's heartbeat is already
 * visible from every other machine. Two properties make this the right source:
 * the records are PLAINTEXT by design, so this check works on an encrypted
 * store that doctor cannot unlock; and it needs no network, so `doctor` stays
 * read-only and offline (it reports what last synced INTO this store, which is
 * exactly the question — a machine whose record has not arrived is precisely
 * the machine that is not syncing).
 *
 * The corollary is worth stating plainly: heartbeats are written by Harness,
 * not by this runtime. A machine with no Harness daemon never publishes one and
 * never auto-syncs at all. That is reported as "not assessed", never as
 * healthy.
 *
 * GHOSTS ARE NOT STALE MACHINES. The machine-id split leaves retired records
 * behind: same host, an id nothing runs under any more. On the store this was
 * built against, two of four records were exactly that — 18 hours and 3.2 days
 * cold — while the two live ones were beating every 30 to 60 seconds. Warning
 * on those would have shipped two permanent false alarms, and a check that
 * cries wolf on every run is worse than no check. So a record is a GHOST when
 * another FRESH record on the SAME host disowns it by naming it in
 * `shadow_ids`, and ghosts are reported as retired, never as a sync failure.
 * That is the same PROVEN-ghost rule the daemon's own cross-machine check
 * applies before it will retire a record, so the two never disagree about which
 * ids are bookkeeping. (Named as a rule, not as a command: this module ships in
 * a package whose readers have no such daemon, so a reference they cannot act
 * on would be worse than no reference at all.)
 *
 * QUIET IS NOT SILENT, and a hostname is not evidence. The tiers exist to keep
 * this score quiet on a healthy fleet, but the thing being kept quiet must be
 * BOOKKEEPING, never a machine. An earlier version demoted any overdue id to
 * INFO whenever some other record on the same host string was beating, and told
 * the reader those were "almost certainly retired ids, not stopped machines" —
 * a conclusion drawn from a string match. Two facts make that unsound here, and
 * both are live: this project deliberately runs more than one daemon per box,
 * so a live seat silences a dead one; and a host can still carry its board's
 * un-renamed DMI default hostname, a string every Linux box off that same board
 * reports, so two different machines collide by construction. A
 * probe against the real store proved a machine three days dead reading as
 * all-clear. So an overdue id goes quiet only when a beating record on that
 * host ACCOUNTS for it — disowning it, or naming it as its own config-dir id.
 * Otherwise it warns, and says plainly that it cannot tell a retired id from a
 * second daemon that stopped.
 *
 * The escalation is that warn, and its discriminator is EVIDENCE, not age: a
 * record stays loud while nothing disowns it and nobody has moved it into
 * `state/.retired/`. Age would be the wrong test — a legitimately retired id
 * only gets older, so ageing into a warning would nag forever about a file
 * nothing is wrong with, while an id retired properly the same day goes quiet
 * for good. `state/.retired/` is not read here at all, so retiring a record is
 * both the cure and the proof.
 *
 * Warn-only, like last-read and content: a machine being asleep is a fact about
 * the day, not a broken install, so it never flips the exit code.
 */

/**
 * A live machine that has not published a heartbeat in this long is not
 * syncing.
 *
 * FOUR HOURS, and the number is not ours to choose. The Harness daemon writes
 * these records and its own cross-machine check refuses to compare one older
 * than `DEFAULT_MAX_STALENESS_MS` in `scripts/lib/machine-state-core.mjs`,
 * which is 4h — so that is the SOURCE OF TRUTH for how old a heartbeat may be,
 * and this constant tracks it. It is pinned here rather than read from there on
 * purpose: this package ships to people who have no Harness, so it cannot
 * import one.
 *
 * This used to be 15 minutes, which put a 3h45m band between the two tools
 * where they said opposite things about the same machine — and that band is
 * ordinarily occupied, by a suspended laptop, a daemon restarted during a
 * deploy, or a slow poll. Two reports on one box, minutes apart, contradicting
 * each other is worse than either verdict alone, because it teaches an operator
 * that both are noise. The window in force is printed in the Machines section
 * so the two can be reconciled by eye.
 *
 * The SEVERITY still differs, deliberately. Harness's cross-machine check is
 * something an operator runs to compare machines, so a record too old to
 * compare fails it: it cannot answer the question it was asked. This score is
 * ambient, and a machine being asleep is a fact about the day rather than a
 * broken install, so it warns and never touches the exit code.
 */
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * A record must be at least this fresh to be trusted to disown another one.
 * Without it a pair of stale records could vouch each other into silence.
 */
export const DISOWN_TRUST_MS = STALE_AFTER_MS;

/**
 * How far into the future a heartbeat may sit and still be believed. Small
 * skew between machines is ordinary (NTP drift, a second either way) and
 * clamping it to "just now" is right. Anything further is a broken clock, and
 * a broken clock must not be able to buy freshness: without this, a record
 * three days ahead reports age 0, which is the FRESHEST value possible, so a
 * host that has been dark for days reads as the healthiest on the store — and
 * worse, that record then vouches for its own host and can disown its
 * siblings. Beyond this tolerance the timestamp is treated as no timestamp.
 */
export const FUTURE_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

export interface RepoDrift {
  label: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface MachineHeartbeat {
  machineId: string;
  host: string | null;
  capturedAt: string | null;
  /**
   * Age of the heartbeat in ms. Null when the record carried no usable
   * timestamp — either none at all, or one far enough in the future that its
   * clock cannot be trusted (see `skewed`).
   */
  ageMs: number | null;
  /** The timestamp sat beyond FUTURE_SKEW_TOLERANCE_MS ahead of now. */
  skewed: boolean;
  /**
   * The host itself is dark: overdue, and NO other record from this host is
   * beating. This is the only condition that warrants a warning, because the
   * unit of "is a machine syncing" is the HOST, not the id.
   */
  stale: boolean;
  /** Retired id: a fresh record on the same host names this one in shadow_ids. */
  ghost: boolean;
  /**
   * Overdue, but another record from the SAME HOST STRING is beating, and
   * nothing explicitly disowns this one — the taxonomy's SUSPECT tier. It is
   * reported rather than warned about as a dark host, because calling the whole
   * host "not syncing" would be false.
   *
   * What it does NOT mean is that this id's machine is fine. See `claimedBy`:
   * a suspect nobody claims is reported at WARN, because a shared hostname is
   * not evidence about a machine.
   */
  suspect: boolean;
  /**
   * For a SUSPECT: the machineId of the beating record on that host that
   * accounts for this id, by naming it as the id in its own config dir. Null
   * means nothing accounts for it and only the hostname connects them, which is
   * the ambiguous case this cannot resolve — a retired id nobody cleaned up, or
   * a second daemon on that box that stopped, look identical from here.
   */
  claimedBy: string | null;
  /** Repos this machine reported as diverged (ahead or behind its remote). */
  drift: RepoDrift[];
}

/**
 * A record in `state/` that could not be turned into a machine.
 *
 * These files are JSON that syncs between machines through git, so the states
 * they reach are not only the momentary torn read: a merge conflict leaves
 * marker lines in the file and a truncated write leaves half an object, and
 * both PERSIST. An unreadable record used to be dropped in silence, which did
 * not degrade the score — it ERASED the machine, and a box that had stopped
 * disappeared from the report entirely rather than being reported as stopped.
 * They are counted and named now, because "I could not read this" and "there
 * is nothing to read" are opposite answers.
 */
export interface UnreadableRecord {
  /** File name inside `state/`, e.g. "m-abc123.json". */
  file: string;
  /** What was wrong with it, in words that point at a repair. */
  reason: string;
}

export interface SyncFreshness {
  /** True when heartbeats could actually be read. */
  assessed: boolean;
  /** Why not, when they could not. */
  reason?: string;
  machines: MachineHeartbeat[];
  /**
   * Records that could not be read. Never empty-and-fine: each one is a
   * machine this report cannot see, so they are surfaced even when the check
   * could not assess anything at all.
   */
  unreadable: UnreadableRecord[];
  /** Hosts that are genuinely dark. The number that matters. */
  staleCount: number;
  /** Machines beating inside the window. */
  freshCount: number;
  /** Retired ids, reported so they read as bookkeeping rather than failure. */
  ghostCount: number;
  /** Overdue ids on a host that is otherwise beating fine. */
  suspectCount: number;
  /**
   * Suspects nobody claimed: overdue, on a host whose other records are
   * beating, and not accounted for by any of them. The number that must not be
   * hidden — every one of these is either bookkeeping nobody cleaned up or a
   * machine that stopped, and the report cannot tell which.
   */
  unclaimedCount: number;
}

export function notAssessed(reason: string, unreadable: UnreadableRecord[] = []): SyncFreshness {
  return {
    assessed: false,
    reason,
    machines: [],
    unreadable,
    staleCount: 0,
    freshCount: 0,
    ghostCount: 0,
    suspectCount: 0,
    unclaimedCount: 0,
  };
}

interface RawRecord {
  machineId: string;
  host: string | null;
  capturedAt: string | null;
  ageMs: number | null;
  skewed: boolean;
  shadowIds: string[];
  /**
   * `machineId_local`: the id in the writer's own config dir, whether or not
   * it is the one this record was published under. A LIVE record saying "the
   * id in my config dir is X" is a statement about its own identity, which is
   * why it can corroborate that a stale X on that host is the same daemon
   * wearing an old name.
   */
  machineIdLocal: string | null;
  /**
   * `machineId_source`: "daemon" when a running daemon supplied the id in this
   * record, "config-dir" when it came from the config file, "absent" when
   * there was none. A record published under a DAEMON-supplied id was written
   * by a daemon under its own effective identity, which argues against reading
   * it later as a config-dir leftover.
   */
  machineIdSource: string | null;
  drift: RepoDrift[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The key everything about identity is stored under: (host, machineId).
 *
 * A machine id is only unique WITHIN a host. Ids are seeded from a config dir,
 * so a cloned VM image, a restored backup and a re-seeded config dir all
 * produce the same id on a second box — which is the exact id churn this module
 * exists to describe. Keying a claim on the bare id lets a LIVE record on host A
 * retire a genuinely dark host B that happens to carry the same id: host B
 * disappears from the report and no `machine_not_syncing` finding is raised for
 * it. The pair key makes a claim local to the host that made it.
 *
 * Length-prefixed so the encoding is injective whatever the strings contain:
 * these values come out of a JSON file another machine wrote, so a hostname
 * holding the separator character must not be able to spell another pair.
 */
function hostKey(host: string, machineId: string): string {
  return `${host.length}:${host}:${machineId}`;
}

/**
 * Reading a record either produces a machine or produces a REASON. There is no
 * third outcome, and in particular no silent one: dropping a file this cannot
 * parse would remove a machine from the fleet without changing a single number
 * in the report.
 */
type ReadResult = { ok: true; record: RawRecord } | { ok: false; reason: string };

/**
 * One tidy line about why a file would not parse.
 *
 * The parser's own message embeds a snippet of the file, so it arrives with
 * newlines in it and no length limit. Both go into a report line and a finding
 * message, and a multi-line reason breaks the aligned Machines block and turns
 * one machine's row into several. Found by running the real CLI, not by a test.
 */
function oneLine(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function readRecord(file: string, now: number): ReadResult {
  let parsed: unknown;
  try {
    // The BOM is stripped before parsing because JSON.parse rejects it, and
    // the person most likely to put one there is someone following this
    // check's own advice: a conflicted record repaired in a Windows editor
    // comes back BOM-first and would then be reported as unreadable forever.
    // Advice that cannot be followed successfully is worse than none.
    const text = readFileSync(file, "utf8");
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    // Torn mid-rename is one cause and it clears itself on the next run. A
    // merge conflict left in the file, or a truncated write, is the other, and
    // that one stays until a human fixes it. This cannot tell them apart, so it
    // reports the file and lets the next run settle it.
    return {
      ok: false,
      reason: oneLine(`not valid JSON (${err instanceof Error ? err.message : "unreadable"})`),
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not a JSON object" };
  }
  const rec = parsed as Record<string, unknown>;
  const machineId = typeof rec["machineId"] === "string" ? rec["machineId"] : null;
  if (!machineId) {
    return { ok: false, reason: "no machineId field, so it names no machine" };
  }

  const capturedAt = typeof rec["captured_at"] === "string" ? rec["captured_at"] : null;
  const parsedAt = capturedAt ? Date.parse(capturedAt) : NaN;
  const delta = Number.isNaN(parsedAt) ? null : now - parsedAt;
  // A record from the future is not evidence of freshness. Inside the
  // tolerance it is ordinary drift and clamps to "just now"; beyond it the
  // clock is broken, and a broken clock must buy nothing — no freshness, no
  // vote in freshHosts, no standing to disown a sibling. Null age is how all
  // three fall out at once, since every downstream gate treats null as
  // overdue and untrustworthy.
  const skewed = delta !== null && delta < -FUTURE_SKEW_TOLERANCE_MS;
  const ageMs = delta === null || skewed ? null : Math.max(0, delta);

  const shadowIds = Array.isArray(rec["shadow_ids"])
    ? (rec["shadow_ids"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  // Divergence only. `dirty` is carried for the detail line but never counts as
  // drift on its own: the store repo is legitimately dirty for the moment
  // between a log write and the next sync commit, so flagging it would fire on
  // nearly every run.
  const drift: RepoDrift[] = [];
  if (Array.isArray(rec["repos"])) {
    for (const entry of rec["repos"] as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const ahead = num(r["ahead"]);
      const behind = num(r["behind"]);
      if (ahead === 0 && behind === 0) continue;
      drift.push({
        label: typeof r["label"] === "string" ? r["label"] : "?",
        ahead,
        behind,
        dirty: r["dirty"] === true,
      });
    }
  }

  return {
    ok: true,
    record: {
      machineId,
      host: typeof rec["host"] === "string" ? rec["host"] : null,
      capturedAt,
      ageMs,
      skewed,
      shadowIds,
      machineIdLocal: typeof rec["machineId_local"] === "string" ? rec["machineId_local"] : null,
      machineIdSource: typeof rec["machineId_source"] === "string" ? rec["machineId_source"] : null,
      drift,
    },
  };
}

/**
 * Read every machine heartbeat this store has received. Read-only, offline,
 * and safe on a locked store.
 */
export function assessSyncFreshness(home: string, now: number = Date.now()): SyncFreshness {
  // Not part of StorePaths on purpose: `state/` is written by the Harness
  // daemon, not by this runtime, so the runtime reads it without claiming it.
  const dir = fsPath(path.join(home, "state"));

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return notAssessed(
      "no state/ directory — no machine has ever published a heartbeat here. These records come from a separate " +
        "machine-sync daemon (the FI Harness); with one machine and no daemon there is nothing to check, and nothing wrong",
    );
  }
  if (files.length === 0) {
    return notAssessed("state/ is empty — no machine has published a heartbeat to this store");
  }

  const raw: RawRecord[] = [];
  const unreadable: UnreadableRecord[] = [];
  for (const f of files) {
    const rec = readRecord(path.join(dir, f), now);
    if (rec.ok) raw.push(rec.record);
    else unreadable.push({ file: f, reason: rec.reason });
  }
  if (raw.length === 0) {
    // Carried through, not dropped. Otherwise a store whose records ALL became
    // unreadable reports an empty, healthy fleet with nothing to explain it.
    return notAssessed("state/ holds no readable machine records", unreadable);
  }

  // A record is disowned when a FRESH record on the SAME host names it in
  // shadow_ids. Same-host is required because a different host is never a
  // ghost, however stale it looks.
  //
  // Keyed by (host, id), never by the bare id. The claim belongs to the host
  // that made it: a live record on host A saying "that id was mine" says
  // nothing whatsoever about a record carrying the same id on host B, and the
  // bare-id version silently retired that second host. Pairing also removes the
  // old first-match hazard — `raw.find(id)` picked ONE record to host-check and
  // then applied the verdict to every record sharing the id, so which of the
  // two hosts got retired depended on directory order.
  const disowned = new Set<string>();
  for (const r of raw) {
    if (r.ageMs === null || r.ageMs > DISOWN_TRUST_MS) continue;
    // A REAL host is required on the claiming side. Without it, host-less
    // records could retire each other on `null === null`.
    if (r.host === null) continue;
    for (const shadow of r.shadowIds) {
      // A record naming itself proves nothing and would retire the very
      // machine that is beating.
      if (shadow === r.machineId) continue;
      disowned.add(hostKey(r.host, shadow));
    }
  }

  // Hosts with at least one beating record. A host that is demonstrably
  // syncing cannot also be "not syncing", whatever its retired ids look like.
  //
  // Note what this can and cannot prove. It proves the HOST STRING is beating.
  // It does not prove that the machine behind an overdue id on that string is
  // alive, for two reasons that both hold on the fleet this was built against:
  // more than one daemon deliberately runs per box, so a live one silences a
  // dead one; and hostnames are not unique — a host may still carry its
  // board's un-renamed DMI default, a string every Linux box off that same
  // board reports, so two distinct machines collide by
  // construction. That is why a fresh record no longer VOUCHES for an overdue
  // sibling; it only means the report must not claim the whole host is dark.
  const freshHosts = new Set<string>();
  for (const r of raw) {
    if (r.host !== null && r.ageMs !== null && r.ageMs <= STALE_AFTER_MS) freshHosts.add(r.host);
  }

  // What a BEATING record says about an overdue id on its host, beyond sharing
  // a hostname with it. `machineId_local` is the id in that daemon's own config
  // dir: when it names the overdue id, the live daemon is saying that id is its
  // own former or alternate name, which is evidence about identity rather than
  // about location. Keyed by (host, id) for the same reason ghosting is, and
  // mapped to the claimant so the report can name who accounted for it.
  //
  // The writer derives shadow_ids FROM machineId_local today, so in practice a
  // claim here usually arrives as a disown and lands in the ghost tier above.
  // This is the backstop for a record that carries one and not the other —
  // schema drift between machines is this project's recurring failure, and the
  // cost of the extra path is a map.
  const claimedLocalIds = new Map<string, string>();
  for (const r of raw) {
    if (r.ageMs === null || r.ageMs > DISOWN_TRUST_MS) continue;
    if (r.host === null || r.machineIdLocal === null) continue;
    if (r.machineIdLocal === r.machineId) continue; // says nothing about anyone else
    claimedLocalIds.set(hostKey(r.host, r.machineIdLocal), r.machineId);
  }

  const machines: MachineHeartbeat[] = raw
    .map((r) => {
      const overdue = r.ageMs === null || r.ageMs > STALE_AFTER_MS;
      // Ghost requires overdue. Being named in someone's shadow_ids says an id
      // was retired; a record that is beating RIGHT NOW says it was not, and
      // the beating record wins. Harness writes shadow_ids whenever a
      // daemon-supplied id differs from the config-dir id, so during a cutover
      // both records are briefly fresh and the ungated version filed a live
      // machine under bookkeeping.
      const ghost = overdue && r.host !== null && disowned.has(hostKey(r.host, r.machineId));
      const suspect = !ghost && overdue && r.host !== null && freshHosts.has(r.host);
      // WHO ACCOUNTS FOR THIS ID — the difference between "this is bookkeeping"
      // and "this might be a machine that stopped". A shared hostname is not an
      // answer to that question, and treating it as one is what made this tier
      // assert, at INFO and forever, that an overdue id was "almost certainly a
      // retired id, not a stopped machine" on no evidence but a string match.
      // A claim only counts when a beating record on that host names the id as
      // its own.
      const claimedBy =
        suspect && r.host !== null
          ? // A record published under a DAEMON-supplied id was a daemon
            // running as itself, not a config-dir leftover, so a claim over it
            // is refused and it stays in the loud tier. The same veto the
            // writer's own ghost detection applies before it will retire
            // anything.
            r.machineIdSource === "daemon"
            ? null
            : (claimedLocalIds.get(hostKey(r.host, r.machineId)) ?? null)
          : null;
      return {
        machineId: r.machineId,
        host: r.host,
        capturedAt: r.capturedAt,
        ageMs: r.ageMs,
        skewed: r.skewed,
        ghost,
        suspect,
        claimedBy,
        stale: !ghost && !suspect && overdue,
        drift: r.drift,
      };
    })
    .sort((a, b) => {
      // Live first, then the genuinely dark, then bookkeeping.
      const rank = (m: MachineHeartbeat) => (m.ghost ? 3 : m.suspect ? 2 : m.stale ? 1 : 0);
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return (a.ageMs ?? Number.MAX_SAFE_INTEGER) - (b.ageMs ?? Number.MAX_SAFE_INTEGER);
    });

  return {
    assessed: true,
    machines,
    unreadable,
    staleCount: machines.filter((m) => m.stale).length,
    freshCount: machines.filter((m) => !m.ghost && !m.suspect && !m.stale).length,
    ghostCount: machines.filter((m) => m.ghost).length,
    suspectCount: machines.filter((m) => m.suspect).length,
    unclaimedCount: machines.filter((m) => m.suspect && m.claimedBy === null).length,
  };
}
