import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { isNonHumanPrompt } from "../src/ops/brief.js";
import { reindexStore } from "../src/ops/reindexOp.js";
import { readShimAudit } from "../src/ops/shimAudit.js";
import { freshHome, tsxEntry, writeNote } from "./helpers.js";

const TSX = tsxEntry();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function spawnHook(
  home: string,
  stdin: string,
  extraArgs: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, "hook-retrieve", "--home", home, ...extraArgs], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, GESTALT_KEY: "", GESTALT_PASSPHRASE: "" },
    timeout: 15_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("hook-retrieve — fail-open + stdout purity", () => {
  it("exit 0 + empty stdout on invalid stdin JSON", () => {
    const home = freshHome("hook-bad-json");
    runInit({ home });
    const r = spawnHook(home, "not-json{{{");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("exit 0 + empty stdout on short/ack prompt", () => {
    const home = freshHome("hook-short");
    runInit({ home });
    const r = spawnHook(
      home,
      JSON.stringify({ prompt: "yes", session_id: "s1", hook_event_name: "UserPromptSubmit" }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("exit 0 + empty on SessionStart with no prompt", () => {
    const home = freshHome("hook-ss");
    runInit({ home });
    const r = spawnHook(
      home,
      JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }),
      ["--session-start"],
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("on a hit: exit 0, stdout is ONLY the protocol JSON with additionalContext", async () => {
    const home = freshHome("hook-hit");
    runInit({ home });
    writeNote(home, "hook-canary", {
      title: "Hook Canary",
      body: "The silver ferret encrypts moonlight with a copper key.",
    });
    await reindexStore(home);

    const r = spawnHook(
      home,
      JSON.stringify({
        prompt: "How does the silver ferret encrypt moonlight?",
        session_id: "s-hit",
        hook_event_name: "UserPromptSubmit",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    // Stdout purity: the whole stdout must parse as one JSON object.
    const j = JSON.parse(r.stdout.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(j.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(j.hookSpecificOutput.additionalContext).toContain("ALREADY-RETRIEVED");
    expect(j.hookSpecificOutput.additionalContext).toContain("silver ferret");
    // No incidental log lines before/after the JSON.
    expect(r.stdout.trim().startsWith("{")).toBe(true);
  });

  it("locked encrypted store: exit 0 empty (fail-open), never exit 2", async () => {
    const home = freshHome("hook-locked");
    const { runInit: init } = await import("../src/commands/init.js");
    init({
      home,
      encrypted: true,
      passphrase: "a perfectly sturdy passphrase",
      argon2: { name: "argon2id", m: 256, t: 1, p: 1 },
      allowWeakParams: true,
    });
    // No cache warm, no passphrase in env — store is locked for one-shot.
    const r = spawnHook(
      home,
      JSON.stringify({
        prompt: "What is in the store about anything long enough?",
        session_id: "s-lock",
        hook_event_name: "UserPromptSubmit",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("skips control-tag prompts: exit 0 empty + lastSkippedReason=non-human", () => {
    const home = freshHome("hook-nonhuman-tag");
    runInit({ home });
    // Would be a retrieval hit if not skipped — seed content that matches the body.
    writeNote(home, "task-notes", {
      title: "Task Notes",
      body: "\nSilver ferret task notifications should never trigger retrieval.\n",
    });
    const r = spawnHook(
      home,
      JSON.stringify({
        prompt:
          "<task-notification>Silver ferret encrypts moonlight — agent completed step 3</task-notification>",
        session_id: "s-tag",
        hook_event_name: "UserPromptSubmit",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const audit = readShimAudit(home);
    expect(audit?.lastSkippedReason).toBe("non-human");
  });

  it("skips payload-marked non-human source: exit 0 empty + lastSkippedReason=non-human", () => {
    const home = freshHome("hook-nonhuman-src");
    runInit({ home });
    writeNote(home, "machine-notes", {
      title: "Machine Notes",
      body: "\nThe copper key is only for human questions about encryption.\n",
    });
    const r = spawnHook(
      home,
      JSON.stringify({
        prompt: "How does the copper key encryption work in production?",
        session_id: "s-src",
        hook_event_name: "UserPromptSubmit",
        source: "machine",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const audit = readShimAudit(home);
    expect(audit?.lastSkippedReason).toBe("non-human");
  });
});

describe("isNonHumanPrompt — pure heuristic", () => {
  it("detects control-tag openers and non-human source fields", () => {
    expect(isNonHumanPrompt("<task-notification>done</task-notification>")).toBe(true);
    expect(isNonHumanPrompt("<system>control</system>")).toBe(true);
    expect(isNonHumanPrompt("  <?xml version")).toBe(true);
    expect(isNonHumanPrompt("How does encryption work?")).toBe(false);
    expect(isNonHumanPrompt("What about <partial> tags mid-sentence?")).toBe(false);
    expect(isNonHumanPrompt("long enough human question here", { source: "machine" })).toBe(true);
    expect(isNonHumanPrompt("long enough human question here", { origin: "notification" })).toBe(
      true,
    );
    expect(isNonHumanPrompt("long enough human question here", { is_meta: true })).toBe(true);
    expect(isNonHumanPrompt("long enough human question here", { source: "user" })).toBe(false);
  });
});

// Touch writeFileSync so the import stays used if tree-shaken oddly.
void writeFileSync;
void path;
