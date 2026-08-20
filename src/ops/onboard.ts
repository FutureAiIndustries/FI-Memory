import { BIN, PRODUCT } from "../brand.js";
import { GestaltError } from "../errors.js";
import { followUp } from "../followUp.js";
import { listProposals } from "../store/proposals.js";
import { appendLog } from "./logOp.js";
import { createTopic } from "./create.js";
import { runDoctor } from "./doctor.js";
import type { DoctorOptions, DoctorReport } from "./doctor.js";
import { reviewApprove, reviewReject, reviewShow } from "./review.js";
import { search } from "./search.js";

/**
 * `fimemory onboard` — the guided first-win path.
 *
 * Both independent Mac-beta assessments (2026-08-05, hank-e-d/mac-store)
 * reached the same verdict about a fresh `setup`: "the machine is ready, the
 * user is not." Connect ends green while Content is still red — the trust loop
 * has never been run, the store holds nothing true about its owner, and every
 * hook-driven retrieval returns tutorial stubs. Each assessment then wrote out
 * the same unblock sequence by hand; this verb IS that sequence, so the next
 * operator does not need to read the README (Grok filing, acceptance
 * criterion 5).
 *
 * The steps, in leverage order:
 *   1. status — the two scores (Connect / Content), stated separately;
 *   2. trust loop — show the pending suggested edit and settle it
 *      (approve / reject / later). The product's keystone is
 *      agents-propose-humans-approve, and it is never felt until run once;
 *   3. first facts — three questions (machine, projects, tools), written
 *      through the REAL store API (`createTopic` + `appendLog`, same locks,
 *      same caps — the seed's own discipline);
 *   4. first win — a live search for something step 3 actually WROTE, so the
 *      operator sees the store answer with their own fact. Never claimed for a
 *      fact whose write failed;
 *   5. host matrix — which connected tool will actually use memory, and what
 *      each one still needs, in plain English (the "you're ~60% done" list).
 *
 * Every question is skippable (empty answer = skip); every write goes through
 * the public API; nothing here edits a file this package does not own. Every
 * failure is contained as its own line — with the error's hint kept, the same
 * every-error-answers-with-a-command contract errors.ts states — and the run
 * continues.
 */

/** Injectable I/O so the whole interactive flow is assertable from a test —
 * the same reason installMcp takes config paths. `ask` resolves with the
 * user's raw answer ("" = skip). */
export interface OnboardIO {
  out: (line?: string) => void;
  ask: (question: string) => Promise<string>;
}

export interface OnboardOptions {
  home: string;
  /** Threaded through to doctor (tests point the host scans at a fake home). */
  doctor?: Omit<DoctorOptions, "home">;
}

export interface OnboardResult {
  /** What happened to the pending suggested edit this run. */
  review: "approved" | "rejected" | "later" | "none-pending" | "error";
  topicsCreated: string[];
  entriesLogged: number;
  /** Hits the first-win search returned (null when the search never ran). */
  firstWinHits: number | null;
  /** True when the run stopped at the store-presence guard. */
  noStore?: boolean;
}

/** `message → hint`, keeping a GestaltError's copy-pastable remedy — the
 * errors.ts contract. A contained failure that drops the hint turns "here is
 * the command that fixes this" into a dead end. */
function errText(err: unknown): string {
  if (err instanceof GestaltError && err.hint) return `${err.message} → ${err.hint}`;
  return err instanceof Error ? err.message : String(err);
}

/** One plain-English line per connected host: what it will actually do with
 * the store, and what it still needs. Derived from the SAME doctor report the
 * rest of the product trusts — no second detection pass to drift, and no
 * claim (like "+ rules") the report does not actually carry. */
export function hostMatrix(r: DoctorReport): Array<{ host: string; text: string }> {
  const lines: Array<{ host: string; text: string }> = [];
  const registered = new Set(r.mcp.filter((m) => m.registered).map((m) => m.target));
  const rulesByHost = new Map(r.rules.map((rb) => [rb.host, rb]));

  if (registered.has("claude-code") || r.shim.written) {
    const claudeRules = rulesByHost.get("claude-code")?.written === true;
    const mcpAndRules = registered.has("claude-code")
      ? claudeRules ? "MCP + rules" : "MCP (no rule block)"
      : claudeRules ? "rules, no MCP entry" : "neither MCP nor rules";
    lines.push({
      host: "claude-code",
      // Three hook states, each told truthfully — "no retrieval hook
      // installed" over a written-but-broken hook contradicted the score
      // lines on the same screen.
      text: !r.shim.written
        ? `${mcpAndRules} — no retrieval hook. \`${BIN} install-hooks\` adds inject-before-every-prompt.`
        : !r.shim.resolvable
          ? `${mcpAndRules}; retrieval hook installed but BROKEN (its path does not resolve) — \`${BIN} uninstall-hooks\` then \`${BIN} install-hooks\`.`
          : registered.has("claude-code")
            ? "full auto-retrieve — the hook injects relevant memory before every prompt, no tool call needed."
            : `retrieval hook installed; the MCP entry is missing — re-run \`${BIN} setup\` (it prints the exact Claude Code step) so tools can also read on demand.`,
    });
  }
  if (r.grok.installed) {
    lines.push({
      host: "grok",
      text:
        "MCP + rules; the Claude hook CANNOT inject here (Grok drops hook args). " +
        (r.grok.dyingProcess
          ? `Grok currently spawns a dying process per prompt — \`${BIN} grok-compat\` explains, \`--off\` silences (cost is global to Grok; it stops honouring ALL Claude hooks).`
          : "Hook noise is silenced or not applicable on this machine."),
    });
  }
  if (registered.has("cursor")) {
    lines.push({
      host: "cursor",
      text:
        "MCP only by default — Cursor keeps global rules in its app UI, not a file. " +
        `Run \`${BIN} install-rules --print\` and paste its OUTPUT into Cursor → Customize → Rules, or per-repo: \`${BIN} install-rules --file .cursor/rules/fimemory.mdc\`.`,
    });
  }
  if (registered.has("claude-desktop")) {
    lines.push({
      host: "claude-desktop",
      text: "MCP only — no rules file exists for it, so ask it explicitly to search your memory when it matters.",
    });
  }
  for (const t of ["codex", "gemini", "windsurf"] as const) {
    if (!registered.has(t)) continue;
    const rb = rulesByHost.get(t);
    lines.push({
      host: t,
      text: rb?.written
        ? "MCP + rules (no hook) — it can read the store and is told to search first."
        : `MCP registered but no rule block — \`${BIN} install-rules ${t}\` tells it to actually search.`,
    });
  }
  return lines;
}

/** Is the CONNECT half of the report green — store present, at least one MCP
 * registration, at least one rule block, and no broken hook. Shared by the
 * verdict lines so "both green" can never be printed over a red column. */
export function connectGreen(r: DoctorReport): boolean {
  return (
    r.storePresent &&
    r.mcp.some((m) => m.registered) &&
    r.rules.some((rb) => rb.written) &&
    !(r.shim.written && !r.shim.resolvable)
  );
}

/** The commands that remain after this run, in leverage order — the
 * non-interactive caller's version of the guided path. Connect problems come
 * first: `setup` is the one verb that fixes that whole column. */
export function remainingSteps(r: DoctorReport): string[] {
  const steps: string[] = [];
  if (!connectGreen(r)) {
    steps.push(`${BIN} setup    # wires every AI tool it finds (MCP + rules + hook) and checks it — safe to re-run`);
  }
  const ct = r.content;
  if (ct.assessed && ct.seedProposalPending) {
    steps.push(
      `${followUp(r.home, "review show 1")}    # then: ` +
        `${followUp(r.home, "review approve 1")} (or reject 1) — run the trust loop once`,
    );
  }
  if (ct.assessed && !ct.hasUserContent) {
    steps.push(`${BIN} onboard    # interactive: puts your first real facts in the store`);
  }
  if (!r.capture.hookInstalled && r.shim.written) {
    steps.push(`${BIN} install-hooks --capture    # optional: auto-file a worklog proposal at session end (reads that session's transcript — hence opt-in)`);
  }
  if (r.grok.installed && r.grok.dyingProcess) {
    steps.push(`${BIN} grok-compat    # explains Grok's per-prompt hook noise; --off silences it (cost stated there)`);
  }
  const cursorRegistered = r.mcp.some((m) => m.target === "cursor" && m.registered);
  if (cursorRegistered) {
    steps.push(`${BIN} install-rules --print    # run it, paste the OUTPUT into Cursor → Customize → Rules (Cursor has no rules FILE to write)`);
  }
  if (r.mode === "plaintext" && r.storePresent) {
    steps.push(`${BIN} encrypt    # optional: encrypt at rest — cheapest before real content accumulates`);
  }
  return steps;
}

/** The verdict for an empty remaining list — TRUE claims only. "Both green"
 * used to print whenever the list was empty, including over a report whose
 * every Connect line was a ✗ (encrypted store, content not assessed, no
 * optional step applicable). */
export function emptyRemainingVerdict(r: DoctorReport): string {
  const content = r.content.assessed && r.content.hasUserContent;
  if (connectGreen(r) && content) return "Nothing left — Connect and Content are both green.";
  return "Nothing further to suggest here — the scores above are the state.";
}

/** Render the two-score status through `io.out` — shared by the interactive
 * flow's opening and the CLI's `onboard --status`. */
export function renderTwoScores(r: DoctorReport, io: Pick<OnboardIO, "out">): void {
  const mark = (ok: boolean): string => (ok ? "✓" : "✗");
  const mcpHosts = r.mcp.filter((m) => m.registered).map((m) => m.target);
  const rulesHosts = r.rules.filter((rb) => rb.written).map((rb) => rb.host);
  io.out("Connect (is the machine wired?):");
  io.out(`  ${mark(r.storePresent)} store: ${r.mode}`);
  io.out(`  ${mark(mcpHosts.length > 0)} MCP: ${mcpHosts.length > 0 ? mcpHosts.join(", ") : "no host registered"}`);
  io.out(`  ${mark(rulesHosts.length > 0)} rules: ${rulesHosts.length > 0 ? rulesHosts.join(", ") : "no rule block written"}`);
  io.out(`  ${mark(r.shim.written && r.shim.resolvable)} retrieval hook: ${r.shim.written ? (r.shim.resolvable ? "installed" : "installed but BROKEN (path does not resolve)") : "not installed"}`);
  io.out(`  ${r.capture.hookInstalled ? "✓" : "–"} session-end capture: ${r.capture.hookInstalled ? "installed" : "not installed (opt-in)"}`);
  io.out();
  const ct = r.content;
  io.out("Content (is the store yours yet?):");
  if (!ct.assessed) {
    io.out(`  – not assessed — ${ct.reason ?? "unknown"}`);
  } else {
    io.out(
      `  ${mark(ct.hasUserContent)} ${ct.topicsTotal} topic${ct.topicsTotal === 1 ? "" : "s"} (${ct.realTopics.length} yours) · ` +
        `${ct.realLogEntries} real log entr${ct.realLogEntries === 1 ? "y" : "ies"} · ` +
        `${ct.pendingProposals} suggested edit${ct.pendingProposals === 1 ? "" : "s"} pending`,
    );
  }
}

/** Topic ids are `^[a-z0-9-]{2,64}$` (schema). Best-effort slug; null when the
 * name cannot make a valid id (the caller logs the name instead — losing the
 * fact would be worse than losing the topic). */
export function slugForProject(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9-]{2,64}$/.test(slug) ? slug : null;
}

/** Provenance stamped on everything this verb writes. Distinct from the seed's
 * `gestalt-runtime` ON PURPOSE: content readiness counts entries by agent, and
 * these entries are the USER's facts (given interactively), not shipped copy —
 * they must count. */
export const ONBOARD_AGENT = "onboard";
export const ONBOARD_PROJECT = "onboarding";

/**
 * The guided path. Never throws for flow reasons: a failed step reports itself
 * through `io.out` (hint kept) and the run continues — the same fault
 * isolation `setup` promises, for the same reason (a half-finished onboarding
 * that says nothing is how the store converges on empty).
 */
export async function runOnboard(opts: OnboardOptions, io: OnboardIO): Promise<OnboardResult> {
  const home = opts.home;
  const doctorOpts: DoctorOptions = { home, ...(opts.doctor ?? {}) };
  const report = runDoctor(doctorOpts);
  const result: OnboardResult = {
    review: "none-pending",
    topicsCreated: [],
    entriesLogged: 0,
    firstWinHits: null,
  };

  io.out(`${PRODUCT} onboard — ${home}`);
  io.out();
  renderTwoScores(report, io);
  io.out();

  // No store: every step below would fail one at a time, each with the same
  // underlying cause. Say the cause once, name the fix, stop.
  if (!report.storePresent) {
    io.out(`There is no store here yet, so there is nothing to onboard into.`);
    io.out(`Run \`${BIN} setup\` first — it creates the store and wires your AI tools — then \`${BIN} onboard\`.`);
    result.noStore = true;
    return result;
  }

  /* ── 1. Trust loop: settle the pending suggested edit ──────────────────── */

  try {
    const pending = (await listProposals(home)).filter((p) => p.status === "pending" && p.seq !== null);
    if (pending.length > 0) {
      const first = pending[0]!;
      const doc = await reviewShow(home, first.seq!);
      io.out(`A suggested edit is waiting: #${doc.seq} on "${doc.id}" (proposed by ${doc.proposer}).`);
      io.out("This is the product's trust model in one move: agents PROPOSE, you APPROVE. The diff:");
      io.out();
      for (const line of doc.diff.split("\n")) io.out(`    ${line}`);
      io.out();
      const answer = (await io.ask("Approve it? [a]pprove / [r]eject / [l]ater: ")).trim().toLowerCase();
      if (answer === "a" || answer === "approve") {
        await reviewApprove(home, doc.seq);
        result.review = "approved";
        io.out(`Approved — "${doc.id}"'s note is updated and the change is logged. That loop is the whole trust model.`);
      } else if (answer === "r" || answer === "reject") {
        await reviewReject(home, doc.seq);
        result.review = "rejected";
        io.out("Rejected — the note stays as it was; the proposal is closed. Also a completely valid run of the loop.");
      } else {
        result.review = "later";
        io.out(
          `Left waiting — \`${followUp(home, `review show ${doc.seq}`)}\` when you are ready.`,
        );
      }
    }
  } catch (err) {
    result.review = "error";
    io.out(`Could not run the review step: ${errText(err)} — continuing.`);
  }
  io.out();

  /* ── 2. First facts: three questions, real writes ──────────────────────── */

  io.out("Three questions. Empty answer skips — nothing is written for a skipped question.");
  io.out();

  // Facts that actually LANDED, with a search query that would find each.
  // First-win only ever searches one of these — a fact whose write failed must
  // never be presented back as the store answering (probe: on a no-seed store
  // the machine write fails, and searching its name still fuzzy-hits shipped
  // topics that do not contain it).
  const landed: Array<{ query: string; summary: string }> = [];
  let anyAnswered = false;

  const machine = (await io.ask('1/3 · What do you call this machine? (e.g. "work laptop", "the mac"): ')).trim();
  if (machine !== "") {
    anyAnswered = true;
    const summary = `This machine is "${machine}". When work spans machines, log which one a path, daemon, or credential lives on.`;
    try {
      await appendLog(home, "working-rhythms", {
        type: "convention",
        project: ONBOARD_PROJECT,
        agent: ONBOARD_AGENT,
        summary,
      });
      result.entriesLogged += 1;
      landed.push({ query: machine, summary });
    } catch (err) {
      io.out(`  could not log that: ${errText(err)}`);
    }
  }

  const projectsRaw = (await io.ask("2/3 · Active projects, comma-separated (each gets its own topic): ")).trim();
  if (projectsRaw !== "") {
    anyAnswered = true;
    const names = projectsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const MAX_PROJECTS = 5;
    if (names.length > MAX_PROJECTS) {
      io.out(`  taking the first ${MAX_PROJECTS} — \`${BIN} create <id>\` adds the rest whenever.`);
    }
    for (const name of names.slice(0, MAX_PROJECTS)) {
      const slug = slugForProject(name);
      try {
        if (slug === null) {
          // The name cannot make a topic id — keep the FACT anyway.
          const summary = `Active project: ${name}. (No topic created — the name does not reduce to a topic id; \`${BIN} create\` one by hand.)`;
          await appendLog(home, "working-rhythms", {
            type: "convention",
            project: ONBOARD_PROJECT,
            agent: ONBOARD_AGENT,
            summary,
          });
          result.entriesLogged += 1;
          landed.push({ query: name, summary });
          io.out(`  "${name}": logged (no topic — name does not reduce to an id).`);
          continue;
        }
        await createTopic(home, slug, name);
        const summary = `${name} is an active project (named during onboarding). Log its decisions and gotchas here, one entry each, as they land.`;
        await appendLog(home, slug, {
          type: "convention",
          project: ONBOARD_PROJECT,
          agent: ONBOARD_AGENT,
          summary,
        });
        result.topicsCreated.push(slug);
        result.entriesLogged += 1;
        landed.push({ query: name, summary });
        io.out(`  "${name}" → topic "${slug}" created, first entry logged.`);
      } catch (err) {
        // E_FUZZY (looks like an existing topic) and E_EXISTS both land here:
        // keep the fact in working-rhythms rather than losing it to a refusal.
        const why = errText(err);
        try {
          const summary = `Active project: ${name}. (Topic not created: ${why})`;
          await appendLog(home, "working-rhythms", {
            type: "convention",
            project: ONBOARD_PROJECT,
            agent: ONBOARD_AGENT,
            summary,
          });
          result.entriesLogged += 1;
          landed.push({ query: name, summary });
          io.out(`  "${name}": logged to working-rhythms (topic not created: ${why})`);
        } catch (err2) {
          io.out(`  "${name}": could not write anything — ${errText(err2)}`);
        }
      }
    }
  }

  const tools = (await io.ask('3/3 · Which AI tools do you actually use here? (e.g. "Claude Code, Grok CLI"): ')).trim();
  if (tools !== "") {
    anyAnswered = true;
    const summary = `AI tools in real use on this machine: ${tools}. Log a gotcha the first time one of them trips on something.`;
    try {
      await appendLog(home, "working-rhythms", {
        type: "convention",
        project: ONBOARD_PROJECT,
        agent: ONBOARD_AGENT,
        summary,
      });
      result.entriesLogged += 1;
      landed.push({ query: tools, summary });
    } catch (err) {
      io.out(`  could not log that: ${errText(err)}`);
    }
  }
  io.out();

  /* ── 3. First win: watch the store answer with a fact that LANDED ──────── */

  if (landed.length > 0) {
    const fact = landed[0]!;
    try {
      const { hits } = await search(home, fact.query);
      result.firstWinHits = hits.length;
      if (hits.length > 0) {
        io.out(`First win — \`${BIN} search "${fact.query}"\` just answered from what you told it:`);
        for (const h of hits.slice(0, 3)) io.out(`    ${h.id} — ${h.title}`);
        // The hit list alone shows topic titles (often a seed topic's), which
        // proves nothing — show the entry the search actually matched.
        io.out(`    your entry there: "${fact.summary}"`);
        io.out("That is what every connected agent now sees when it searches.");
      } else {
        // No invented "index lag": search reads the files live, so a zero-hit
        // means these tokens did not match. Say that, with a runnable remedy.
        io.out(
          `Logged, but \`${BIN} search "${fact.query}"\` found no hit — those exact words did not match. ` +
            `\`${BIN} get working-rhythms\` shows what landed.`,
        );
      }
    } catch (err) {
      io.out(`Could not run the first-win search: ${errText(err)}`);
    }
  } else if (anyAnswered) {
    // Answers were given and every write failed — "skipped" would be a lie.
    io.out("Your answers could not be written — see the lines above for each failure and its fix.");
  } else if (result.review === "approved" || result.review === "rejected") {
    io.out(`Questions skipped — nothing new was logged, but the review above did land.`);
  } else {
    io.out(`Every question skipped — the store is exactly as it was. \`${BIN} onboard\` is here whenever.`);
  }
  io.out();

  /* ── 4. Host matrix + what remains ─────────────────────────────────────── */

  const fresh = runDoctor(doctorOpts); // re-read: the writes above changed Content
  const matrix = hostMatrix(fresh);
  if (matrix.length > 0) {
    io.out("What each connected tool will actually do with your memory:");
    for (const m of matrix) io.out(`  ${m.host}: ${m.text}`);
    io.out();
  }
  const remaining = remainingSteps(fresh);
  if (remaining.length > 0) {
    io.out("Still worth doing, in order of leverage:");
    for (const s of remaining) io.out(`  ${s}`);
  } else {
    io.out(emptyRemainingVerdict(fresh));
  }

  return result;
}
