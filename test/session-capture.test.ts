import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runDoctor } from "../src/ops/doctor.js";
import { installHooks, checkShimHooks, SHIM_ID, SHIM_MARKER_ARG } from "../src/ops/installHooks.js";
import {
  bulletsFromSummary,
  buildWorklogBody,
  CAPTURE_BUDGET_MS,
  extractTranscript,
  runSessionCapture,
  WORKLOG_TOPIC_ID,
} from "../src/ops/sessionCapture.js";
import { hasCapturedSession, readShimAudit } from "../src/ops/shimAudit.js";
import { reviewList, reviewShow } from "../src/ops/review.js";
import { parseNote } from "../src/store/note.js";
import { freshHome } from "./helpers.js";

function fixtureTranscript(
  dir: string,
  opts: {
    sessionId: string;
    assistantText: string;
    files?: string[];
    toolCalls?: boolean;
  },
): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${opts.sessionId}.jsonl`);
  const lines: unknown[] = [
    { type: "user", message: { role: "user", content: "do the work" }, sessionId: opts.sessionId },
  ];
  if (opts.toolCalls !== false) {
    const content: unknown[] = [];
    for (const f of opts.files ?? ["src/ops/foo.ts"]) {
      content.push({
        type: "tool_use",
        name: "Write",
        input: { file_path: f, content: "x" },
      });
    }
    content.push({ type: "tool_use", name: "Bash", input: { command: "npm test" } });
    content.push({
      type: "tool_use",
      name: "mcp__fimemory__fimemory_log",
      input: { id: "gestalt-decisions", type: "decision", project: "x", summary: "y" },
    });
    lines.push({
      type: "assistant",
      message: { role: "assistant", content },
      sessionId: opts.sessionId,
    });
  }
  lines.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: opts.assistantText }],
    },
    sessionId: opts.sessionId,
  });
  writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  return p;
}

describe("session-capture — mechanical extract", () => {
  it("extracts final assistant text, files, tool counts, fimemory_log", () => {
    const home = freshHome("cap-extract");
    const tp = fixtureTranscript(home, {
      sessionId: "sess-1",
      assistantText:
        "We shipped the capture path. Frontmatter is preserved. Doctor shows health. Tests cover the budget.",
      files: ["runtime/src/ops/sessionCapture.ts", "runtime/test/session-capture.test.ts"],
    });
    const ex = extractTranscript(readFileSync(tp, "utf8"), "sess-1");
    expect(ex.sessionId).toBe("sess-1");
    expect(ex.finalAssistantText).toMatch(/capture path/);
    expect(ex.filesTouched).toContain("runtime/src/ops/sessionCapture.ts");
    expect(ex.toolCallCount).toBeGreaterThanOrEqual(3);
    expect(ex.gestaltLogCount).toBe(1);
    expect(ex.bashCount).toBe(1);
  });

  it("bulletsFromSummary yields 3–6 bullets from prose", () => {
    const b = bulletsFromSummary(
      "First thing happened. Second thing landed. Third outcome was clean. Fourth note about files.",
    );
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b.length).toBeLessThanOrEqual(6);
  });
});

describe("session-capture — proposal path", () => {
  it("creates worklog proposal with body-only diff; frontmatter intact on approve path", async () => {
    const home = freshHome("cap-propose");
    runInit({ home });
    const tp = fixtureTranscript(path.join(home, "tx"), {
      sessionId: "sess-propose",
      assistantText:
        "Implemented session capture end to end. Wrote extract + proposal path. Added doctor capture health. Verified fail-open budget skip.",
      files: ["a.ts", "b.ts"],
    });

    const r = await runSessionCapture({
      home,
      payload: { session_id: "sess-propose", transcript_path: tp },
      disableBudgetRace: true,
    });
    expect(r.captured).toBe(true);
    expect(r.seq).toBeTypeOf("number");
    expect(hasCapturedSession(home, "sess-propose")).toBe(true);

    const pending = (await reviewList(home)).filter((p) => p.status === "pending");
    expect(pending.some((p) => p.id === WORKLOG_TOPIC_ID)).toBe(true);
    const doc = await reviewShow(home, r.seq!);
    expect(doc.proposer).toBe("session-capture");
    expect(doc.newNote).toContain("## ");
    expect(doc.newNote).toContain("session sess-propose");
    expect(doc.newNote).toContain("a.ts");
    // Base frontmatter fields present
    const note = parseNote(doc.newNote, WORKLOG_TOPIC_ID)!;
    expect(note.title).toBeTruthy();
    expect(note.updated).not.toBeNull();

    // Dedupe: second fire is no-op
    const r2 = await runSessionCapture({
      home,
      payload: { session_id: "sess-propose", transcript_path: tp },
      disableBudgetRace: true,
    });
    expect(r2.captured).toBe(false);
    expect(r2.skippedReason).toBe("already-captured");
  });

  it("silent when no tool calls or empty final message", async () => {
    const home = freshHome("cap-empty");
    runInit({ home });
    const dir = path.join(home, "tx");
    mkdirSync(dir, { recursive: true });
    const empty = path.join(dir, "empty.jsonl");
    writeFileSync(
      empty,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        sessionId: "e1",
      }) + "\n",
      "utf8",
    );
    const r = await runSessionCapture({
      home,
      payload: { session_id: "e1", transcript_path: empty },
      disableBudgetRace: true,
    });
    expect(r.captured).toBe(false);
    expect(r.skippedReason).toBe("empty-session");
  });

  it("non-human source skips with lastSkippedReason=non-human", async () => {
    const home = freshHome("cap-nonhuman");
    runInit({ home });
    const tp = fixtureTranscript(path.join(home, "tx"), {
      sessionId: "nh1",
      assistantText: "Should not capture. " + "word ".repeat(20),
    });
    const r = await runSessionCapture({
      home,
      payload: { session_id: "nh1", transcript_path: tp, source: "machine" },
      disableBudgetRace: true,
    });
    expect(r.captured).toBe(false);
    expect(r.skippedReason).toBe("non-human");
    expect(readShimAudit(home)?.lastSkippedReason).toBe("non-human");
  });

  it("oversized transcript → budget skip, exit path records budget", async () => {
    const home = freshHome("cap-budget");
    runInit({ home });
    const dir = path.join(home, "tx");
    mkdirSync(dir, { recursive: true });
    const big = path.join(dir, "big.jsonl");
    // Write a file larger than CAPTURE_MAX_TRANSCRIPT_BYTES without filling RAM with JSONL parse cost.
    const { CAPTURE_MAX_TRANSCRIPT_BYTES } = await import("../src/ops/sessionCapture.js");
    writeFileSync(big, "x".repeat(CAPTURE_MAX_TRANSCRIPT_BYTES + 10), "utf8");
    const r = await runSessionCapture({
      home,
      payload: { session_id: "big1", transcript_path: big },
      disableBudgetRace: true,
    });
    expect(r.captured).toBe(false);
    expect(r.skippedReason).toBe("budget");
    expect(readShimAudit(home)?.lastSkippedReason).toBe("budget");
  });

  it("500ms self-cap: artificial slow path races to budget", async () => {
    expect(CAPTURE_BUDGET_MS).toBe(500);
    const home = freshHome("cap-race");
    runInit({ home });
    // Missing transcript → still returns under budget without hang.
    const r = await runSessionCapture({
      home,
      payload: { session_id: "race1", transcript_path: "/no/such/file.jsonl" },
      budgetMs: 80,
    });
    expect(r.captured).toBe(false);
    expect(r.durationMs).toBeLessThan(500);
  });
});

describe("install-hooks --capture + doctor capture health", () => {
  it("installs SessionEnd + Stop with hook-capture and --shim-id", async () => {
    const home = freshHome("cap-hooks-home");
    mkdirSync(home, { recursive: true });
    const settings = path.join(freshHome("cap-hooks-set"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// cli\n", "utf8");

    const r = await installHooks({
      home,
      settingsPath: settings,
      cliPath,
      nodePath: process.execPath,
      capture: true,
    });
    expect(r.capture).toBe(true);
    expect(r.events).toContain("SessionEnd");
    expect(r.events).toContain("Stop");

    const check = checkShimHooks({ settingsPath: settings });
    expect(check.capture).toBe(true);
    expect(check.userPromptSubmit).toBe(true);
    const doc = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { args?: string[] }[] }[]>;
    };
    const se = doc.hooks.SessionEnd![0]!.hooks![0]!;
    expect(se.args).toContain("hook-capture");
    expect(se.args).toContain(SHIM_MARKER_ARG);
    expect(se.args).toContain(SHIM_ID);
  });

  it("doctor reports capture hook + last capture after a run", async () => {
    const home = freshHome("cap-doc");
    runInit({ home });
    const settings = path.join(freshHome("cap-doc-set"), "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// cli\n", "utf8");
    await installHooks({
      home,
      settingsPath: settings,
      cliPath,
      nodePath: process.execPath,
      capture: true,
    });
    const tp = fixtureTranscript(path.join(home, "tx"), {
      sessionId: "doc-sess",
      assistantText:
        "Captured for doctor. Second sentence here. Third sentence for bullets. Fourth closes the loop.",
    });
    await runSessionCapture({
      home,
      payload: { session_id: "doc-sess", transcript_path: tp },
      disableBudgetRace: true,
    });

    const r = runDoctor({
      home,
      env: {} as NodeJS.ProcessEnv,
      hostConfigPaths: {
        "claude-code": path.join(home, "absent.json"),
        "claude-desktop": path.join(home, "absent2.json"),
        cursor: path.join(home, "absent3.json"),
        codex: path.join(home, "absent4.json"),
        gemini: path.join(home, "absent5.json"),
        grok: path.join(home, "absent7.toml"),
        windsurf: path.join(home, "absent6.json"),
      },
      rulesPaths: [{ host: "claude", file: path.join(home, "no-rules.md") }],
      shimSettingsPath: settings,
    });
    expect(r.capture.hookInstalled).toBe(true);
    expect(r.capture.lastCaptureSessionId).toBe("doc-sess");
    expect(r.capture.capturedSessionCount).toBeGreaterThanOrEqual(1);
    expect(r.capture.lastCaptureSeq).toBeTypeOf("number");
  });
});

describe("buildWorklogBody — token cap trims oldest sections", () => {
  it("keeps newest section when over cap", () => {
    const old =
      "## 2026-01-01 · session old\n\n- ancient work that fills tokens " +
      "word ".repeat(400) +
      "\n\n## Owner notes\n";
    const body = buildWorklogBody(
      old,
      {
        date: "2026-07-27",
        sessionId: "new",
        bullets: ["fresh a", "fresh b", "fresh c"],
        files: ["z.ts"],
        stats: "Tools: 1",
      },
      200,
    );
    expect(body).toContain("session new");
    expect(body).toContain("## Owner notes");
  });
});
