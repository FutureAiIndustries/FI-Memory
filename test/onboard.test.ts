import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { assessContent } from "../src/ops/contentReadiness.js";
import {
  emptyRemainingVerdict,
  hostMatrix,
  remainingSteps,
  runOnboard,
  slugForProject,
} from "../src/ops/onboard.js";
import type { OnboardIO } from "../src/ops/onboard.js";
import { runDoctor } from "../src/ops/doctor.js";
import type { DoctorReport } from "../src/ops/doctor.js";
import { reviewList } from "../src/ops/review.js";
import { seedStarterTopics } from "../src/ops/seed.js";
import { freshHome, tsxEntry } from "./helpers.js";

/**
 * `fimemory onboard` — the guided 15-minute path, assertable end to end.
 *
 * The IO is injected (scripted answers in, lines out), so the whole
 * interactive flow runs headless here — the same reason installMcp takes
 * config paths. Every store write must go through the real API: these tests
 * verify outcomes by reading the store back, never by trusting the transcript.
 */

async function store(label: string): Promise<string> {
  const home = freshHome(label);
  runInit({ home, env: {} });
  await seedStarterTopics(home);
  return home;
}

/** Scripted IO: answers are consumed in order; "" past the end (skip). */
function scripted(answers: string[]): { io: OnboardIO; lines: string[] } {
  const lines: string[] = [];
  let i = 0;
  return {
    lines,
    io: {
      out: (l?: string) => {
        lines.push(l ?? "");
      },
      ask: (q: string) => {
        lines.push(q);
        return Promise.resolve(answers[i++] ?? "");
      },
    },
  };
}

/** An empty fake user home so no doctor scan inside onboard reads the real
 * machine. */
function doctorOpts() {
  const userHome = freshHome("onboard-userhome");
  mkdirSync(userHome, { recursive: true });
  return { userHome, env: {}, shimSettingsPath: path.join(userHome, ".claude", "settings.json") };
}

describe("the guided path writes real facts through the real API", () => {
  it("machine + projects + tools land in the store, and the first win is a real search", { timeout: 30_000 }, async () => {
    const home = await store("onboard-full");
    const { io } = scripted([
      "l", // trust loop: later
      "the test box", // machine
      "Alpha Project, Beta Thing", // projects
      "Claude Code, Grok CLI", // tools
    ]);

    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.review).toBe("later");
    expect(r.topicsCreated).toEqual(["alpha-project", "beta-thing"]);
    // 1 machine + 2 project entries + 1 tools entry.
    expect(r.entriesLogged).toBe(4);
    // The first-win search ran against the machine name and found it.
    expect(r.firstWinHits).not.toBeNull();
    expect(r.firstWinHits!).toBeGreaterThan(0);

    // Verified from the STORE, not the transcript: content flipped.
    const ct = assessContent(home);
    expect(ct.hasUserContent).toBe(true);
    expect(ct.realTopics).toEqual(expect.arrayContaining(["alpha-project", "beta-thing"]));
    // The provenance line: onboard's writes are the user's, not the runtime's.
    const log = readFileSync(path.join(home, "logs", "working-rhythms.log.md"), "utf8");
    expect(log).toContain("the test box");
    expect(log).toContain("| onboard");
  });

  it("approve settles the pre-staged proposal — the trust loop actually runs", { timeout: 30_000 }, async () => {
    const home = await store("onboard-approve");
    const { io } = scripted(["a"]); // approve; skip everything else
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.review).toBe("approved");
    const pending = (await reviewList(home)).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(0);
  });

  it("reject is an equally valid run of the loop", { timeout: 30_000 }, async () => {
    const home = await store("onboard-reject");
    const { io } = scripted(["r"]);
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.review).toBe("rejected");
    expect((await reviewList(home)).some((p) => p.status === "rejected")).toBe(true);
  });

  it("all questions skipped: the store is EXACTLY as it was", { timeout: 30_000 }, async () => {
    const home = await store("onboard-skip");
    const before = assessContent(home);
    const { io, lines } = scripted([]); // every answer ""

    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.review).toBe("later");
    expect(r.topicsCreated).toEqual([]);
    expect(r.entriesLogged).toBe(0);
    expect(r.firstWinHits).toBeNull();
    expect(assessContent(home)).toEqual(before);
    // …and the flow says so instead of celebrating nothing.
    expect(lines.join("\n")).toMatch(/exactly as it was/);
  });

  it("a project name that cannot become a topic id keeps the FACT anyway", { timeout: 30_000 }, async () => {
    const home = await store("onboard-badslug");
    const { io } = scripted(["l", "", "◯◯◯", ""]);
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.topicsCreated).toEqual([]);
    expect(r.entriesLogged).toBe(1); // logged into working-rhythms instead
    const log = readFileSync(path.join(home, "logs", "working-rhythms.log.md"), "utf8");
    expect(log).toContain("◯◯◯");
  });
});

describe("slugForProject", () => {
  it("reduces names the way topic ids demand, and refuses what it cannot", () => {
    expect(slugForProject("Alpha Project")).toBe("alpha-project");
    expect(slugForProject("  FI/Memory v2!  ")).toBe("fi-memory-v2");
    expect(slugForProject("◯◯◯")).toBeNull();
    expect(slugForProject("a")).toBeNull(); // below the 2-char floor
  });
});

describe("failure containment tells the truth", () => {
  it("no store: says the cause once, names setup, and stops", { timeout: 30_000 }, async () => {
    const home = freshHome("onboard-nostore"); // never created
    const { io, lines } = scripted(["a", "machine", "proj", "tools"]);
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.noStore).toBe(true);
    expect(r.entriesLogged).toBe(0);
    expect(r.firstWinHits).toBeNull();
    const text = lines.join("\n");
    expect(text).toMatch(/no store here yet/i);
    expect(text).toContain("fimemory setup");
    // The guard means the questions were never even asked.
    expect(text).not.toContain("1/3");
  });

  it("answers given but every write failed: never says 'skipped', never claims a win", { timeout: 30_000 }, async () => {
    // init --no-seed: the worked example exists, working-rhythms does not — so
    // the machine write fails with E_NOT_FOUND. The old copy then printed
    // 'Every question skipped — the store is exactly as it was', over a user
    // who answered, and the first-win search fuzzy-hit shipped topics that do
    // not contain the fact.
    const home = freshHome("onboard-failwrites");
    runInit({ home, env: {} }); // no seedStarterTopics on purpose
    const { io, lines } = scripted(["l", "the real box", "", ""]);
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.entriesLogged).toBe(0);
    expect(r.firstWinHits).toBeNull(); // no landed fact → no search → no claim
    const text = lines.join("\n");
    expect(text).toMatch(/could not log that/);
    expect(text).toMatch(/could not be written/);
    expect(text).not.toMatch(/exactly as it was/);
    expect(text).not.toMatch(/First win/);
    // The contained error keeps its hint — every error answers with a command.
    expect(text).toMatch(/could not log that: .*→/);
  });

  it("all questions skipped after an approve: does not claim the store is untouched", { timeout: 30_000 }, async () => {
    const home = await store("onboard-approve-skip");
    const { io, lines } = scripted(["a", "", "", ""]);
    const r = await runOnboard({ home, doctor: doctorOpts() }, io);

    expect(r.review).toBe("approved");
    const text = lines.join("\n");
    expect(text).not.toMatch(/exactly as it was/); // the approve DID change it
    expect(text).toMatch(/the review above did land/);
  });
});

/** A minimal DoctorReport for the pure derivation functions (hostMatrix,
 * remainingSteps, emptyRemainingVerdict) — they read a handful of fields, and
 * the arms below (broken hook, dying grok, capture offer) are impractical to
 * conjure through a real store in a sandbox. */
function fakeReport(over: Record<string, unknown>): DoctorReport {
  return {
    storePresent: true,
    mode: "plaintext",
    mcp: [],
    rules: [],
    shim: { written: false, resolvable: false, capture: false },
    grok: { installed: false, dyingProcess: false },
    capture: { hookInstalled: false },
    content: { assessed: true, hasUserContent: true, seedProposalPending: false },
    ...over,
  } as unknown as DoctorReport;
}

describe("hostMatrix rows tell each host's truth", () => {
  const mcpRow = (target: string) => ({ target, registered: true });

  it("claude-code: broken hook is named BROKEN, not 'no hook installed'", () => {
    const rows = hostMatrix(fakeReport({
      mcp: [mcpRow("claude-code")],
      rules: [{ host: "claude-code", written: true }],
      shim: { written: true, resolvable: false, capture: false },
    }));
    const cc = rows.find((r) => r.host === "claude-code")!;
    expect(cc.text).toMatch(/BROKEN/);
    expect(cc.text).toContain("uninstall-hooks");
    expect(cc.text).not.toMatch(/no retrieval hook/);
  });

  it("claude-code: '+ rules' is only claimed when the report carries it", () => {
    const rows = hostMatrix(fakeReport({ mcp: [mcpRow("claude-code")], rules: [] }));
    expect(rows.find((r) => r.host === "claude-code")!.text).toMatch(/no rule block/);
  });

  it("cursor: the instruction pastes the OUTPUT, not the command", () => {
    const rows = hostMatrix(fakeReport({ mcp: [mcpRow("cursor")] }));
    const cur = rows.find((r) => r.host === "cursor")!;
    expect(cur.text).toMatch(/paste its OUTPUT/i);
  });

  it("grok with per-prompt noise points at grok-compat with the global cost", () => {
    const rows = hostMatrix(fakeReport({ grok: { installed: true, dyingProcess: true } }));
    const g = rows.find((r) => r.host === "grok")!;
    expect(g.text).toContain("grok-compat");
    expect(g.text).toMatch(/global to Grok/);
  });

  it("codex without rules gets the exact install-rules command", () => {
    const rows = hostMatrix(fakeReport({ mcp: [mcpRow("codex")], rules: [] }));
    expect(rows.find((r) => r.host === "codex")!.text).toContain("install-rules codex");
  });
});

describe("remaining steps and the empty-list verdict never overclaim", () => {
  it("a red Connect column puts `setup` first — and blocks 'both green'", () => {
    const red = fakeReport({
      mcp: [],
      rules: [],
      content: { assessed: false, reason: "encrypted store", hasUserContent: false, seedProposalPending: false },
      mode: "encrypted-locked",
      capture: { hookInstalled: true },
    });
    const steps = remainingSteps(red);
    expect(steps[0]).toContain("fimemory setup");
    expect(emptyRemainingVerdict(red)).not.toMatch(/both green/);
  });

  it("'both green' is only said when both columns actually are", () => {
    const green = fakeReport({
      mcp: [{ target: "claude-code", registered: true }],
      rules: [{ host: "claude-code", written: true }],
      shim: { written: true, resolvable: true, capture: true },
    });
    expect(emptyRemainingVerdict(green)).toMatch(/both green/);
  });

  it("the capture offer appears exactly when hooks run without it", () => {
    const r = fakeReport({
      mcp: [{ target: "claude-code", registered: true }],
      rules: [{ host: "claude-code", written: true }],
      shim: { written: true, resolvable: true, capture: false },
      capture: { hookInstalled: false },
      mode: "encrypted-unlocked",
    });
    expect(remainingSteps(r).some((s) => s.includes("--capture"))).toBe(true);
    const withCapture = fakeReport({
      ...{},
      mcp: [{ target: "claude-code", registered: true }],
      rules: [{ host: "claude-code", written: true }],
      shim: { written: true, resolvable: true, capture: true },
      capture: { hookInstalled: true },
      mode: "encrypted-unlocked",
    });
    expect(remainingSteps(withCapture).some((s) => s.includes("--capture"))).toBe(false);
  });
});

describe("the onboard CLI verb never hangs and keeps its contracts", () => {
  const TSX = tsxEntry();
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function cli(userHome: string, storeHome: string, argv: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [TSX, CLI, ...argv], {
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        APPDATA: path.join(userHome, "AppData"),
        CODEX_HOME: path.join(userHome, ".codex"),
        GEMINI_CLI_HOME: path.join(userHome, ".gemini"),
        GROK_HOME: path.join(userHome, ".grok"),
        GESTALT_HOME: storeHome,
        GESTALT_PASSPHRASE: "",
        NO_COLOR: "1",
        ...env,
      },
    });
  }

  it("piped stdin (non-TTY) gets the status report, exit 0, no hang", { timeout: 120_000 }, () => {
    // The anti-hang gate: a host or script spawning `fimemory onboard` with
    // pipes must get the report, never a readline waiting on stdin forever.
    const userHome = freshHome("onboard-cli-pipe");
    mkdirSync(userHome, { recursive: true });
    const store = freshHome("onboard-cli-pipe-store");
    const r = cli(userHome, store, ["onboard"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Connect (is the machine wired?)");
    expect(r.stdout).toMatch(/cannot ask questions/);
  });

  it("--json emits the status shape, even on a TTY-less runner", { timeout: 120_000 }, () => {
    const userHome = freshHome("onboard-cli-json");
    mkdirSync(userHome, { recursive: true });
    const store = freshHome("onboard-cli-json-store");
    const r = cli(userHome, store, ["onboard", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    for (const key of ["home", "content", "healthy", "hosts", "remaining"]) {
      expect(parsed, `missing ${key}`).toHaveProperty(key);
    }
  });

  it("--status on a LOCKED encrypted store reports instead of demanding the passphrase", { timeout: 120_000 }, () => {
    // The review's gate finding: --status is a read-only repackaging of
    // doctor (gate-exempt by charter), and its encrypted-store rendering was
    // unreachable in exactly the locked case it was written for.
    const userHome = freshHome("onboard-cli-locked");
    mkdirSync(userHome, { recursive: true });
    const store = freshHome("onboard-cli-locked-store");
    const init = cli(userHome, store, [
      "init", "--encrypted", "--passphrase", "a memorable sentence for the tests", "--no-seed",
    ]);
    expect(init.status).toBe(0);

    const r = cli(userHome, store, ["onboard", "--status"]); // no passphrase in env
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Content (is the store yours yet?)");
    expect(r.stdout).toMatch(/not assessed — encrypted store/);
    expect(r.stdout).not.toMatch(/Set GESTALT_PASSPHRASE/);
  });
});

describe("the status surfaces derive from doctor, not a second detection pass", () => {
  it("remainingSteps names the trust loop and onboarding while both are undone", async () => {
    const home = await store("onboard-remaining");
    const r = runDoctor({ home, ...doctorOpts() });
    const steps = remainingSteps(r);
    expect(steps.some((s) => s.includes("review show 1"))).toBe(true);
    expect(steps.some((s) => s.includes("onboard"))).toBe(true);
    // Plaintext store → encrypt is offered as optional.
    expect(steps.some((s) => s.includes("encrypt"))).toBe(true);
  });

  it("hostMatrix says nothing about hosts that are not there", async () => {
    const home = await store("onboard-matrix");
    const r = runDoctor({ home, ...doctorOpts() });
    // The sandbox user home has no host at all — an empty matrix, not invented
    // rows.
    expect(hostMatrix(r)).toEqual([]);
  });
});
