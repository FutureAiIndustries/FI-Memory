import { existsSync } from "node:fs";
import path from "node:path";
import { BIN } from "../brand.js";
import { runInit } from "../commands/init.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { fsPath, storePaths } from "../paths.js";
import { runDoctor } from "./doctor.js";
import type { DoctorOptions } from "./doctor.js";
import { installHooks } from "./installHooks.js";
import { installMcp } from "./installMcp.js";
import type { InstallMcpOptions } from "./installMcp.js";
import { installRulesAll, rulesHosts } from "./installRules.js";
import type { RulesHost } from "./installRules.js";
import { seedAfterInit } from "./seed.js";

/**
 * `fimemory setup` — the verb that turns a store into a CONNECTED store.
 *
 * WHY THIS EXISTS. From a sweep of 112 manual install steps (2026-07-31):
 *
 *   "The single roughest moment is a silence, not an error: `fimemory init`
 *    succeeds, prints 'Try it: fimemory list', and the store it just made is
 *    connected to nothing. No MCP server registered, no rules file written, no
 *    hook installed … The stranger's reasonable conclusion at minute two is
 *    that they now own a folder of Markdown no AI reads, and they are correct.
 *    A working install and a dead one look identical."
 *
 * Every piece of the wiring already shipped as its own verb. Nothing named the
 * SEQUENCE, so nobody ran it. This does.
 *
 * CONTRACT
 *
 *   RE-RUNNABLE. Running this twice must be boring. `init` is skipped when a
 *   store is already here (it is the one step that can destroy something, and
 *   `runInit` itself refuses over a live store); install-mcp / install-rules /
 *   install-hooks each already report `unchanged` and write nothing — not even
 *   an mtime — when the target already says exactly this.
 *
 *   FAULT-ISOLATED. A step that throws is RECORDED and the run CONTINUES to the
 *   next step. The condition this command exists to fix is a half-wired machine
 *   that reported nothing, so an unreadable rules file must not also cost you
 *   the MCP registration, and neither may cost you the doctor verdict that
 *   would have told you which of them landed.
 *
 *   SUMMARISED, NOT DUMPED. Each step returns ONE summary line plus one SHORT
 *   line per host. Never install-mcp's generic JSON snippet, never doctor's
 *   full report. Five verbs' worth of raw output scrolls the answer off screen,
 *   which is its own kind of silence.
 *
 * STEP ORDER, and why hooks come before rules. The natural reading order is
 * mcp → rules → hooks, but the §2.5b `shim` rule body asserts "relevant store
 * context may already be present in this turn, injected by the host retrieval
 * hook". That sentence is only true once the hook is actually installed. So the
 * hook goes in FIRST and its outcome PICKS THE BODY: hooks landed → Claude Code
 * gets the shim body; hooks skipped or failed → every host gets the §2.5
 * search-first body, which is true unconditionally. Writing the shim body and
 * then failing to install the hook would tell the model to stop searching in
 * exchange for an injection that never comes — a silently worse outcome than
 * doing nothing.
 */

export type SetupStepName =
  | "init"
  | "install-mcp"
  | "install-hooks"
  | "install-rules"
  | "doctor";

/** `ok` = the step did its job (including "already done, nothing to write").
 *  `skipped` = deliberately not run, with a stated reason.
 *  `failed` = tried and could not. Never aborts the run. */
export type SetupStepStatus = "ok" | "skipped" | "failed";

/** One short line about one host/target inside a step. */
export interface SetupDetail {
  /** Host or target this line is about (`claude-code`, `grok`, …). */
  name: string;
  /** `ok` = acted (or already current); `skip` = nothing to do here;
   *  `fail` = tried and could not. Drives the CLI's colour only. */
  outcome: "ok" | "skip" | "fail";
  text: string;
  /** Host truths that decide whether a WRITTEN thing is ever READ. */
  notes?: string[];
}

export interface SetupStep {
  step: SetupStepName;
  status: SetupStepStatus;
  /** One line: what this step did, in counts. */
  summary: string;
  /** One short line per host/target. */
  details: SetupDetail[];
  /** Present when `status` is `failed` — the thrown error's message. */
  error?: string;
  /**
   * The copy-pastable remedy carried by a thrown `GestaltError`, when there was
   * one. `errors.ts` makes "every error answers with a command" the contract of
   * this CLI, and this step runner used to keep `err.message` and DROP
   * `err.hint` — so `setup --encrypted` with no passphrase printed
   * "could not complete — Creating an encrypted store needs a passphrase." and
   * nothing else, while the standalone `init --encrypted` printed the fix.
   * It is also folded into `summary`, so a renderer that only prints the
   * summary still shows it.
   */
  hint?: string;
}

export interface SetupResult {
  home: string;
  steps: SetupStep[];
  /** True when no step failed. Independent of `healthy` (doctor can find real
   * problems while every step of this run did exactly what it was asked). */
  ok: boolean;
  /** doctor's verdict. Absent when the doctor step failed to run at all. */
  healthy?: boolean;
  /** True when THIS run created the store (vs finding one already here). */
  created: boolean;
  /** Shown-once 24-word recovery phrase — present ONLY when this run created an
   * ENCRYPTED store. Never stored anywhere; the caller MUST print it. */
  mnemonic?: string;
  kid?: string;
  /** Things the user still has to do by hand, with the exact command. */
  nextSteps: string[];
  warnings: Warning[];
}

export interface SetupOptions {
  /** Store home to create and/or wire up. */
  home: string;
  /** Create an ENCRYPTED store if the init step runs. Ignored when a store is
   * already here (`encrypt` is the verb for converting one). */
  encrypted?: boolean;
  /** Passphrase for `--encrypted`, else GESTALT_PASSPHRASE. */
  passphrase?: string;
  /** Mirror of `init --no-seed`: skip the starter topics. */
  noSeed?: boolean;
  /** Opt into SessionEnd capture on the hooks step (off by default, per
   * SESSION-CAPTURE-SPEC v1 — capture is never on without an explicit ask). */
  capture?: boolean;

  /* ── injectables: tests must never touch a real host config ── */

  /** Base user home for the rules registry and doctor's default scans (NOT the
   * store home). Default `os.homedir()` via each op's own default. */
  userHome?: string;
  /** Environment consulted for host-home overrides (GROK_HOME, CODEX_HOME, …)
   * and for the seed's GESTALT_PASSPHRASE lookup. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pre-built rules registry (tests). Default `rulesHosts({homeDir, env})`. */
  registry?: RulesHost[];
  /** Extra install-mcp options — above all the per-host config paths. */
  mcp?: Omit<InstallMcpOptions, "home">;
  /** Claude settings.json the hooks step writes. Default: ~/.claude/settings.json */
  hooksSettingsPath?: string;
  /** Extra doctor options — above all `userHome` / `shimSettingsPath`. */
  doctor?: Omit<DoctorOptions, "home">;
}

/** Run one step, containing ANY throw as that step's `failed` row. The whole
 * point of this command is that a partial install reports itself, so nothing
 * below may propagate. */
async function runStep(
  step: SetupStepName,
  run: () => Promise<Omit<SetupStep, "step">>,
  /** Rewrite the underlying verb's hint for the caller that is actually on
   * screen — `init`'s hint names `fimemory init`, but the reader typed
   * `fimemory setup`, and pointing them at a different verb is a second puzzle
   * on top of the failure. */
  rewriteHint: (hint: string) => string = (h) => h,
): Promise<SetupStep> {
  try {
    return { step, ...(await run()) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      err instanceof GestaltError && err.hint ? rewriteHint(err.hint) : undefined;
    return {
      step,
      status: "failed",
      summary: hint ? `could not complete — ${message} → ${hint}` : `could not complete — ${message}`,
      details: [],
      error: message,
      ...(hint !== undefined ? { hint } : {}),
    };
  }
}

/** True when a store already lives at `home` — the same file `runInit` refuses
 * over, so this predicate and that refusal can never disagree. */
export function storeExistsAt(home: string): boolean {
  return existsSync(fsPath(storePaths(home).config));
}

/**
 * Init → install-mcp → install-hooks → install-rules → doctor, in one verb.
 * Never throws: every failure is a row in `steps`.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const home = path.resolve(opts.home);
  const env = opts.env ?? process.env;
  const steps: SetupStep[] = [];
  const nextSteps: string[] = [];
  const warnings: Warning[] = [];

  let created = false;
  let mnemonic: string | undefined;
  let kid: string | undefined;

  /* ── 1. init (only when there is no store here) ────────────────────────── */

  steps.push(
    await runStep("init", async () => {
      if (storeExistsAt(home)) {
        return {
          status: "skipped" as const,
          summary: `a store is already here — left exactly as it is`,
          details: [{ name: "store", outcome: "skip" as const, text: home }],
        };
      }
      const r = runInit({
        home,
        ...(opts.encrypted ? { encrypted: true } : {}),
        ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
        env,
      });
      created = true;
      mnemonic = r.mnemonic;
      kid = r.kid;
      warnings.push(...r.warnings);

      const details: SetupDetail[] = [
        { name: "store", outcome: "ok", text: `${home}${r.encrypted ? " (encrypted at rest)" : ""}` },
      ];
      let topics = r.topicCount;
      if (!opts.noSeed) {
        // Fault-isolated by seedAfterInit itself (never throws): a failed seed
        // must not cost the init, and above all must not cost the shown-once
        // recovery phrase of an encrypted store.
        const s = await seedAfterInit(home, {
          encrypted: r.encrypted,
          ...(opts.passphrase !== undefined ? { passphraseFlag: opts.passphrase } : {}),
          env,
        });
        if (s.seeded) {
          topics += s.seeded.topics.length;
          warnings.push(...s.seeded.warnings);
          details.push({
            name: "starter topics",
            outcome: "ok",
            text: s.seeded.topics.join(", "),
          });
        } else if (s.seedError !== undefined) {
          details.push({
            name: "starter topics",
            outcome: "fail",
            text: `not seeded: ${s.seedError} — the store itself is fine (\`${BIN} create\` adds topics).`,
          });
        }
      }
      if (r.sessionKeyWipeFailed) {
        // The init proceeded, but a PREVIOUS store's DEK is still on disk.
        details.push({
          name: "session key",
          outcome: "fail",
          text:
            `could not remove a cached session key (${r.sessionKeyWipeFailed.path}: ${r.sessionKeyWipeFailed.error}) — ` +
            `the PREVIOUS store's key stays usable until \`${BIN} lock\` succeeds.`,
        });
        nextSteps.push(`${BIN} lock    # a stale cached session key could not be removed; re-run until it succeeds`);
      }
      return {
        status: "ok" as const,
        summary: `created ${r.encrypted ? "an encrypted" : "a"} store — ${topics} ${topics === 1 ? "topic" : "topics"}, ${r.pendingProposals} suggested edit${r.pendingProposals === 1 ? "" : "s"} waiting`,
        details,
      };
    },
    // `runInit` answers a missing passphrase with `fimemory init --encrypted
    // --passphrase "…"`. The reader typed `setup`, so say `setup`.
    (hint) => hint.replace(`${BIN} init `, `${BIN} setup `)),
  );

  /* ── 2. install-mcp (how a tool LAUNCHES the server) ───────────────────── */

  steps.push(
    await runStep("install-mcp", async () => {
      const r = await installMcp({ home, ...(opts.mcp ?? {}) });
      warnings.push(...r.warnings);
      // THREE outcomes, not two. `WriterResult` distinguishes "this app is not
      // on this machine" (note: "config folder not found") from "this app IS
      // here and we could not / would not write its config" (a refusal, note:
      // "left unchanged — …"). Collapsing both into `skip` counted a REFUSED
      // Codex as "not installed here" and, because no detail carried a `fail`,
      // the CLI painted the step with a green tick and exited 0 — a half-wired
      // machine reporting success, which is the defect this verb exists to end.
      // doctor cannot rescue it either: it only fails when NO host is
      // registered, so one host landing makes the whole run green.
      const isMissingApp = (w: { note: string }): boolean => /config folder not found/.test(w.note);
      const failedWriters = r.writers.filter((w) => !w.wrote && !w.unchanged && !isMissingApp(w));
      const details: SetupDetail[] = r.writers.map((w) => ({
        name: w.target,
        // `unchanged` is success — the config already says exactly this.
        outcome: w.wrote || w.unchanged
          ? ("ok" as const)
          : isMissingApp(w)
            ? ("skip" as const)
            : ("fail" as const),
        text: w.note,
      }));
      if (r.claudeCode) {
        // install-mcp deliberately does not write ~/.claude.json itself — the
        // Claude Code CLI owns that file's schema. That makes it the ONE piece
        // of wiring `setup` cannot finish, so it becomes an explicit next step
        // rather than a line that scrolls past.
        //
        // WHICH next step depends on whether a `claude` binary exists at all.
        // The VSCode extension and Claude.app install no standalone CLI, so on
        // those machines the `claude mcp add` line dies with `command not
        // found: claude` and no pointer to the fix — the one install-blocking
        // defect of the 2026-08-05 Mac beta. The CLI command still prints
        // either way (detection is a point-in-time PATH read), but the remedy
        // that WORKS on this machine leads.
        details.push({
          name: "claude-code",
          outcome: "skip",
          text: r.claudeCode.cliDetected
            ? "needs one command of yours — Claude Code owns its own config file (see Next steps)."
            : "needs one paste of yours — no `claude` CLI on PATH (IDE/desktop installs ship none), so add the JSON block under Next steps by hand.",
        });
        if (r.claudeCode.cliDetected) {
          nextSteps.push(r.claudeCode.command);
        } else {
          // The snippet is the WHOLE top-level shape, mcpServers wrapper
          // included — so the instruction must not ALSO say "under
          // mcpServers", or the reader pastes the wrapped block inside their
          // existing key and gets mcpServers.mcpServers.gestalt, which Claude
          // Code silently ignores. Say the merge rule instead, for both file
          // states.
          nextSteps.push(
            `No \`claude\` CLI is on PATH (the VSCode extension and Claude.app install none). ` +
              `Merge this into ${r.claudeCode.configPath} — if the file already has an "mcpServers" section, add only the inner "gestalt" entry to it:\n` +
              r.claudeCode.snippet +
              `\n  (If you later install the Claude Code CLI: ${r.claudeCode.command})`,
          );
        }
      }
      const wrote = r.writers.filter((w) => w.wrote || w.unchanged).length;
      const failed = failedWriters.length;
      const missing = r.writers.length - wrote - failed;
      return {
        // Same rule the install-rules step already applies: a host-level
        // failure is the STEP's failure to report, and it never stops the run.
        status: failed > 0 ? ("failed" as const) : ("ok" as const),
        summary:
          `${wrote} host${wrote === 1 ? "" : "s"} configured` +
          `${missing > 0 ? `, ${missing} not installed here` : ""}` +
          `${failed > 0 ? `, ${failed} COULD NOT BE WRITTEN` : ""}`,
        details,
        ...(failed > 0
          ? { error: `${failed} host config(s) could not be written: ${failedWriters.map((w) => w.target).join(", ")}` }
          : {}),
      };
    }),
  );

  /* ── 3. install-hooks (must precede rules — see the module comment) ────── */

  const registry = opts.registry ?? rulesHosts({
    ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
    env,
  });
  // The hook lands in Claude Code's settings.json and nowhere else, so it is
  // installed only when Claude Code is actually on this machine. Creating
  // ~/.claude on a Codex/Grok-only box would fabricate a retrieval shim the
  // machine cannot run — and doctor would then report it as present.
  const claudeHost = registry.find((h) => h.id === "claude-code");
  const claudePresent = Boolean(
    claudeHost?.detectDir && existsSync(fsPath(claudeHost.detectDir)),
  );
  let hooksInstalled = false;

  steps.push(
    await runStep("install-hooks", async () => {
      if (!claudeHost || !claudePresent) {
        return {
          status: "skipped" as const,
          summary: `Claude Code is not installed here — the retrieval hook has nowhere to go`,
          details: [
            {
              name: "claude-code",
              outcome: "skip" as const,
              text: `${claudeHost?.detectDir ?? "~/.claude"} not found. \`${BIN} install-hooks\` can force it if you know better.`,
            },
          ],
        };
      }
      const r = await installHooks({
        home,
        ...(opts.hooksSettingsPath !== undefined ? { settingsPath: opts.hooksSettingsPath } : {}),
        ...(opts.capture ? { capture: true } : {}),
      });
      hooksInstalled = true;
      const details: SetupDetail[] = [
        {
          name: "claude-code",
          outcome: "ok",
          text: `${r.action} — ${r.events.join(", ")} → ${r.path}`,
          notes: ["Claude Code reads settings.json at session start — restart it to activate."],
        },
      ];
      // Honest advisory, verified first-hand: the file we just wrote is NOT
      // read by Claude Code alone.
      //
      // Kept SHORT on purpose: the full citation lives on the host registry's
      // `hookNote` and is printed by `install-rules --list-hosts` and by the
      // rules step below. Repeating it verbatim in two steps of one command is
      // the wall of output this verb exists to avoid.
      const grokHost = registry.find((h) => h.id === "grok");
      if (grokHost?.detectDir && existsSync(fsPath(grokHost.detectDir))) {
        details.push({
          name: "grok",
          outcome: "skip",
          text:
            "Grok CLI scans this same file and will load these two handlers, but it discards the hook's stdout and drops " +
            "its `args`, so our hook cannot inject there. Nothing is blocked, but Grok's scrollback logs a hook failure " +
            "each prompt — silence it with `[compat.claude] hooks = false` in ~/.grok/config.toml, NEVER by deleting the " +
            `handlers from this settings.json (that is Claude Code's file). \`${BIN} install-rules --list-hosts\` has the evidence.`,
        });
      }
      // Gemini ships `gemini hooks migrate`, which imports <cwd>/.claude/
      // settings.json — and its importer copies only command/type/timeout,
      // dropping `args`, exactly like Grok. Read in @google/gemini-cli 0.52.0
      // on disk, 2026-08-01. Nothing of ours runs under Gemini unless the user
      // runs that migration, so this is an advisory, not a failure.
      const geminiHost = registry.find((h) => h.id === "gemini");
      if (geminiHost?.detectDir && existsSync(fsPath(geminiHost.detectDir))) {
        details.push({
          name: "gemini",
          outcome: "skip",
          text:
            "we write no Gemini hook. Do not run `gemini hooks migrate` where a .claude/settings.json carries these " +
            "handlers: its importer drops their `args`, so the migrated hook fails on every prompt. " +
            `\`${BIN} install-rules --list-hosts\` has the evidence.`,
        });
      }
      return {
        status: "ok" as const,
        summary: `retrieval hook ${r.action}${r.capture ? " (+ session-end capture)" : ""} for Claude Code`,
        details,
      };
    }),
  );

  /* ── 4. install-rules (body chosen by whether the hook actually landed) ── */

  steps.push(
    await runStep("install-rules", async () => {
      // `shim` is offered ONLY when the hook is really in place; installRulesAll
      // then downgrades every host that does not run it back to the search-first
      // body, each with its own recorded reason.
      const mode = hooksInstalled ? ("shim" as const) : ("rules" as const);
      const r = await installRulesAll({
        mode,
        registry,
        ...(opts.userHome !== undefined ? { homeDir: opts.userHome } : {}),
        env,
      });
      const details: SetupDetail[] = r.results.map((h) => ({
        name: h.host,
        outcome:
          h.action === "failed"
            ? ("fail" as const)
            : h.action === "skipped"
              ? ("skip" as const)
              : ("ok" as const),
        text:
          h.action === "installed"
            ? `wrote the memory rule block (mode=${h.mode})`
            : h.action === "replaced"
              ? `replaced the memory rule block (mode=${h.mode})`
              : h.action === "unchanged"
                ? `already up to date (mode=${h.mode}) — nothing written`
                : h.action === "failed"
                  ? `FAILED — ${h.reason ?? "unknown error"}`
                  : `skipped — ${h.reason ?? "nothing to do"}`,
        notes: h.notes,
      }));
      const wrote = r.results.filter(
        (h) => h.action === "installed" || h.action === "replaced" || h.action === "unchanged",
      ).length;
      const failed = r.results.filter((h) => h.action === "failed").length;
      return {
        // A host-level failure is the STEP's failure to report, but it never
        // stops the run — doctor still gets to speak.
        status: failed > 0 ? ("failed" as const) : ("ok" as const),
        // The written-≠-loaded caveat is NOT repeated here: it is the same
        // sentence for every host, and it already leads the Next steps block.
        summary:
          `${wrote} host${wrote === 1 ? " carries" : "s carry"} the rule block` +
          `${failed > 0 ? `, ${failed} failed` : ""}`,
        details,
        ...(failed > 0 ? { error: `${failed} host(s) could not be written` } : {}),
      };
    }),
  );

  /* ── 5. doctor (the only step that answers "did any of that work?") ────── */

  let healthy: boolean | undefined;
  let hasUserContent: boolean | undefined;
  steps.push(
    await runStep("doctor", async () => {
      const r = runDoctor({
        home,
        ...(opts.userHome !== undefined ? { userHome: opts.userHome } : {}),
        ...(opts.hooksSettingsPath !== undefined ? { shimSettingsPath: opts.hooksSettingsPath } : {}),
        env,
        ...(opts.doctor ?? {}),
      });
      healthy = r.healthy;
      if (r.content.assessed) hasUserContent = r.content.hasUserContent;
      const details: SetupDetail[] = r.findings.map((f) => ({
        name: f.level,
        outcome: f.level === "fail" ? ("fail" as const) : f.level === "warn" ? ("skip" as const) : ("ok" as const),
        text: f.hint ? `${f.message} → ${f.hint}` : f.message,
      }));
      const fails = r.findings.filter((f) => f.level === "fail").length;
      const warns = r.findings.filter((f) => f.level === "warn").length;
      return {
        // doctor RAN, so the step is `ok` even when it found problems: "the
        // check could not run" and "the check found something" are different
        // answers, and collapsing them is how the original silence happened.
        status: "ok" as const,
        summary: r.healthy
          ? warns > 0
            ? `healthy — ${warns} warning${warns === 1 ? "" : "s"} worth reading`
            : "healthy — everything checks out"
          : `${fails} finding${fails === 1 ? " needs" : "s need"} attention` +
            (warns > 0 ? ` (and ${warns} warning${warns === 1 ? "" : "s"})` : ""),
        details,
      };
    }),
  );

  // Written ≠ loaded: every host reads its rules file and settings at session
  // start, so nothing above is live in an ALREADY-RUNNING window.
  nextSteps.push("Restart any AI tool that was already running — they read rules and hooks at session start.");
  if (created && mnemonic) {
    nextSteps.push(
      `Write down the 24-word recovery phrase above, then set GESTALT_PASSPHRASE so tools can open the store.`,
    );
  }

  // ── The options `setup` KNOWS about but was never showing ────────────────
  // Both independent Mac-beta assessments (2026-08-05, hank-e-d/mac-store)
  // landed the same finding: `--capture`, `--encrypted`, `demo`, and the review
  // loop all exist and all were invisible from the install path — the operator
  // exercised 2 of ~30 commands and the store converged on empty. These lines
  // are one sentence each, ranked by leverage, and every optional one says so:
  // an install that ends in homework is the other failure mode.
  //
  // GATED like its neighbours: the README tells people to re-run `setup` as a
  // diagnostic, so a store in daily use must not be told to "put YOUR first
  // facts in" on every re-run. Pushed unless doctor MEASURED user content
  // (unknown — encrypted, doctor failed — still pushes: the conservative
  // direction is showing the path).
  if (hasUserContent !== true) {
    nextSteps.push(
      `${BIN} onboard    # the guided first-win path: close the review loop, put YOUR first facts in the store`,
    );
  }
  if (hooksInstalled && !opts.capture) {
    // The write-path asymmetry finding: retrieval is machinery (the hook fires
    // every prompt), capture is a sentence in a rules file. --capture is the
    // one lever that fixes it — and it reads session transcripts, so the
    // tradeoff is stated here, not discoverable only via --help.
    nextSteps.push(
      `${BIN} install-hooks --capture    # optional: file a reviewable worklog proposal when a session ends. It reads that session's transcript — that is why it is opt-in.`,
    );
  }
  if (created && !mnemonic) {
    // A plaintext store should be a decision, not a default the user was never
    // shown. `encrypt` migrates in place, so choosing later is cheap — but
    // only if the user knows the fork exists before the store fills up.
    nextSteps.push(
      `${BIN} encrypt    # optional: encrypt the store at rest (prints a 24-word recovery phrase ONCE — store it off this machine). Cheapest before real content accumulates.`,
    );
  }
  if (created) {
    // Relative dir on purpose: `~` is POSIX-only and Windows is the one
    // verified platform.
    nextSteps.push(
      `${BIN} demo ${BIN}-demo    # optional: build a POPULATED example store (invented studio history) to see what good entries look like — your real store stays untouched.`,
    );
  }

  return {
    home,
    steps,
    ok: steps.every((s) => s.status !== "failed"),
    ...(healthy !== undefined ? { healthy } : {}),
    created,
    ...(mnemonic !== undefined ? { mnemonic } : {}),
    ...(kid !== undefined ? { kid } : {}),
    nextSteps,
    warnings,
  };
}
