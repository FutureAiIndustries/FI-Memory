import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { assessContent, notAssessed } from "../src/ops/contentReadiness.js";
import { appendLog } from "../src/ops/logOp.js";
import { createTopic } from "../src/ops/create.js";
import { runDoctor } from "../src/ops/doctor.js";
import { seedStarterTopics } from "../src/ops/seed.js";
import { recordRead } from "../src/telemetry.js";
import { freshHome } from "./helpers.js";

/**
 * Content readiness — the second score, and the conflation it ends.
 *
 * Both independent Mac-beta assessments (2026-08-05) made the same structural
 * finding: doctor measured only CONNECT, so a store in daily use and a store
 * never touched both reported "Healthy" — and the one signal the operator
 * checks could not tell the product working from the product ignored. Every
 * test here pins one edge of the line between "shipped content" and "the
 * user's own".
 */

async function seededStore(label: string): Promise<string> {
  const home = freshHome(label);
  runInit({ home, env: {} });
  await seedStarterTopics(home);
  return home;
}

/** Doctor, pointed at an empty fake user home so no host scan reads the real
 * machine (same rule setup-verb.test.ts states). */
function doctorOn(home: string) {
  const userHome = freshHome("content-userhome");
  mkdirSync(userHome, { recursive: true });
  return runDoctor({ home, userHome, env: {}, shimSettingsPath: path.join(userHome, ".claude", "settings.json") });
}

describe("assessContent draws the line between shipped and yours", () => {
  it("a fresh seeded store has NO user content — and says exactly why", async () => {
    const home = await seededStore("content-fresh");
    const ct = assessContent(home);
    expect(ct.assessed).toBe(true);
    // Seeds + the worked example are all shipped; none of them count.
    expect(ct.realTopics).toEqual([]);
    expect(ct.realLogEntries).toBe(0);
    expect(ct.hasUserContent).toBe(false);
    // The worked example stages one pending proposal, proposed by the runtime:
    // the trust loop has never been run, and that is a named fact, not a vibe.
    expect(ct.pendingProposals).toBeGreaterThanOrEqual(1);
    expect(ct.seedProposalPending).toBe(true);
    // Every seed note body is still the untouched template.
    expect(ct.templateTopics.length).toBeGreaterThan(0);
  });

  it("one real log entry flips the verdict — agent is the provenance line", async () => {
    const home = await seededStore("content-onelog");
    await appendLog(home, "working-rhythms", {
      type: "convention",
      project: "onboarding",
      agent: "cli",
      summary: "This machine is the test box.",
    });
    const ct = assessContent(home);
    expect(ct.realLogEntries).toBe(1);
    expect(ct.hasUserContent).toBe(true);
  });

  it("a runtime-agent entry does NOT count as user content", async () => {
    // Proposal-approve bookkeeping and future seed entries all carry
    // `gestalt-runtime`; counting them would let the product mark ITSELF as
    // adopted.
    const home = await seededStore("content-runtimelog");
    await appendLog(home, "decisions", {
      type: "decision",
      project: "gestalt",
      agent: "gestalt-runtime",
      summary: "Bookkeeping the runtime wrote for itself.",
    });
    const ct = assessContent(home);
    expect(ct.realLogEntries).toBe(0);
    expect(ct.hasUserContent).toBe(false);
  });

  it("a user topic counts once its body is curated, and its id is listed either way", async () => {
    const home = await seededStore("content-usertopic");
    await createTopic(home, "my-project", "My Project");
    let ct = assessContent(home);
    // Created but untouched: it is the user's topic, still a template — real
    // content has not happened yet.
    expect(ct.realTopics).toContain("my-project");
    expect(ct.templateTopics).toContain("my-project");
    expect(ct.hasUserContent).toBe(false);

    // Curate the body (direct write — update's proposal gate is its own test).
    const notePath = path.join(home, "topics", "my-project.md");
    writeFileSync(
      notePath,
      readFileSync(notePath, "utf8").replace(
        "Newly created — write the curated, present-tense summary here.",
        "A real, present-tense summary of my project.",
      ),
      "utf8",
    );
    ct = assessContent(home);
    expect(ct.templateTopics).not.toContain("my-project");
    expect(ct.hasUserContent).toBe(true);
  });

  it("notAssessed states the reason and claims nothing", () => {
    const ct = notAssessed("encrypted store — doctor never derives keys, so content was not inspected");
    expect(ct.assessed).toBe(false);
    expect(ct.reason).toMatch(/encrypted/);
    expect(ct.hasUserContent).toBe(false);
    expect(ct.topicsTotal).toBe(0);
  });

  it("a log parseLog refuses cannot crash the scan — or doctor above it", async () => {
    // The review's HIGH finding, pinned. log.ts's own doc comment canonizes
    // `2026-07-14T09:30:00.000Z deployed` as a legitimate sub-floor hand edit
    // that "must NOT gate the store" — yet parseLog THROWS on it (its
    // encrypted-shape heuristic fires with no key set). An unguarded call here
    // took down the whole doctor report: one uncaught error, zero findings, on
    // the diagnostic verb. The damaged file is skipped; every readable log
    // still counts.
    const home = await seededStore("content-throwlog");
    await appendLog(home, "working-rhythms", {
      type: "convention",
      project: "onboarding",
      agent: "cli",
      summary: "A real fact that must survive the damaged sibling.",
    });
    writeFileSync(
      path.join(home, "logs", "decisions.log.md"),
      "# decisions log\n\n2026-07-14T09:30:00.000Z deployed\n",
      "utf8",
    );

    const ct = assessContent(home); // must not throw
    expect(ct.assessed).toBe(true);
    expect(ct.realLogEntries).toBe(1); // the readable log still counted

    const r = doctorOn(home); // and doctor still reports, end to end
    expect(r.content.assessed).toBe(true);
    expect(Array.isArray(r.findings)).toBe(true);
  });
});

describe("doctor carries the second score without touching the exit contract", () => {
  it("fresh store: content findings appear at INFO, and healthy stays true", async () => {
    const home = await seededStore("content-doctor-fresh");
    const r = doctorOn(home);
    expect(r.content.assessed).toBe(true);
    expect(r.content.hasUserContent).toBe(false);
    // Nothing has read the store yet → expected state → info, not warn. The
    // same split never_read draws, for the same reason: a clean install must
    // not end painted yellow.
    const empty = r.findings.find((f) => f.code === "content_empty");
    expect(empty).toBeDefined();
    expect(empty!.level).toBe("info");
    expect(empty!.hint).toContain("onboard");
    // The never-run trust loop is its own named finding.
    const seedPending = r.findings.find((f) => f.code === "seed_review_pending");
    expect(seedPending).toBeDefined();
    expect(seedPending!.level).toBe("info");
    // Content NEVER flips the exit code — the report may hold real Connect
    // findings (no MCP host in this sandbox), so assert the contract directly:
    // no content code is ever `fail`.
    for (const code of ["content_empty", "seed_review_pending", "proposals_near_cap"]) {
      const f = r.findings.find((x) => x.code === code);
      if (f) expect(f.level).not.toBe("fail");
    }
  });

  it("escalates to WARN once the empty store is actually being read", async () => {
    // The search-tax state both beta assessments named: retrieval machinery
    // firing on every prompt, returning tutorial stubs. Before the first read
    // it is info (expected); once a heartbeat lands it is live and worth
    // yellow. This is the arm that carries the whole two-score argument.
    const home = await seededStore("content-doctor-warn");
    recordRead(home, "search", [], "mcp");
    const r = doctorOn(home);
    const empty = r.findings.find((f) => f.code === "content_empty");
    expect(empty).toBeDefined();
    expect(empty!.level).toBe("warn");
    expect(empty!.message).toMatch(/agents ARE reading/);
  });

  it("with user content, the content findings retire", async () => {
    const home = await seededStore("content-doctor-used");
    await appendLog(home, "working-rhythms", {
      type: "convention",
      project: "onboarding",
      agent: "cli",
      summary: "A real fact about the owner.",
    });
    const r = doctorOn(home);
    expect(r.content.hasUserContent).toBe(true);
    expect(r.findings.find((f) => f.code === "content_empty")).toBeUndefined();
  });

  it("the proposal ceiling announces its approach instead of arriving as a refusal", async () => {
    const home = await seededStore("content-doctor-cap");
    // Lower the cap so the one pre-staged pending proposal is already at 80%.
    const cfgPath = path.join(home, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg["maxPendingProposals"] = 1;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

    const r = doctorOn(home);
    const f = r.findings.find((x) => x.code === "proposals_near_cap");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
    expect(f!.message).toMatch(/1 of 1/);
    expect(f!.hint).toContain("review");
  });
});
