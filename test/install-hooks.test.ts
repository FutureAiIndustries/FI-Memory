import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHIM_ID,
  SHIM_MARKER_ARG,
  checkShimHooks,
  installHooks,
  isShimHandler,
  uninstallHooks,
} from "../src/ops/installHooks.js";
import { freshHome } from "./helpers.js";

function settingsFile(label: string): string {
  const dir = freshHome(`hooks-${label}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "settings.json");
}

describe("install-hooks — Claude Code shim handlers", () => {
  it("writes UserPromptSubmit + SessionStart with --shim-id marker", async () => {
    const file = settingsFile("write");
    const home = freshHome("hooks-home-write");
    mkdirSync(home, { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// fake cli\n", "utf8");

    const r = await installHooks({
      home,
      settingsPath: file,
      cliPath,
      nodePath: process.execPath,
    });
    expect(r.action).toBe("installed");
    expect(r.events).toEqual(["UserPromptSubmit", "SessionStart"]);
    expect(r.args).toContain(SHIM_MARKER_ARG);
    expect(r.args).toContain(SHIM_ID);

    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      hooks: Record<string, { hooks: { args?: string[]; command?: string }[] }[]>;
    };
    expect(doc.hooks.UserPromptSubmit?.length).toBeGreaterThan(0);
    expect(doc.hooks.SessionStart?.length).toBeGreaterThan(0);
    const ups = doc.hooks.UserPromptSubmit![0]!.hooks![0]!;
    expect(isShimHandler(ups)).toBe(true);
    expect(ups.args).toContain("hook-retrieve");
    expect(ups.args).not.toContain("--session-start");
    const ss = doc.hooks.SessionStart![0]!.hooks![0]!;
    expect(ss.args).toContain("--session-start");
  });

  it("merges without clobbering unrelated hooks", async () => {
    const file = settingsFile("merge");
    writeFileSync(
      file,
      JSON.stringify({
        model: "keep-me",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo pre" }],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: "echo user-own", args: ["x"] }],
            },
          ],
        },
      }),
      "utf8",
    );
    const home = freshHome("hooks-home-merge");
    mkdirSync(home, { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// cli\n", "utf8");

    await installHooks({ home, settingsPath: file, cliPath, nodePath: process.execPath });
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      model: string;
      hooks: Record<string, { hooks: { command?: string; args?: string[] }[] }[]>;
    };
    expect(doc.model).toBe("keep-me");
    expect(doc.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe("echo pre");
    const upsCmds = (doc.hooks.UserPromptSubmit ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => h.command),
    );
    expect(upsCmds).toContain("echo user-own");
    expect(upsCmds).toContain(process.execPath);
  });

  it("uninstall removes only our handlers", async () => {
    const file = settingsFile("uninstall");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo keep", args: ["x"] }] },
          ],
        },
      }),
      "utf8",
    );
    const home = freshHome("hooks-home-un");
    mkdirSync(home, { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// cli\n", "utf8");
    await installHooks({ home, settingsPath: file, cliPath, nodePath: process.execPath });
    const removed = await uninstallHooks({ settingsPath: file });
    expect(removed.action).toBe("removed");
    expect(removed.removed).toBeGreaterThanOrEqual(2); // UPS + SessionStart

    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      hooks?: Record<string, { hooks: { command?: string; args?: string[] }[] }[]>;
    };
    const all = Object.values(doc.hooks ?? {}).flatMap((gs) =>
      gs.flatMap((g) => g.hooks ?? []),
    );
    expect(all.every((h) => !isShimHandler(h))).toBe(true);
    expect(all.some((h) => h.command === "echo keep")).toBe(true);
  });

  it("doctor check: orphan when cli path missing → not resolvable", async () => {
    const file = settingsFile("orphan");
    const home = freshHome("hooks-home-orphan");
    const missingCli = path.join(home, "missing-cli.js");
    // Install pointing at a path we then do not create.
    await installHooks({
      home,
      settingsPath: file,
      cliPath: missingCli,
      nodePath: process.execPath,
    });
    expect(existsSync(missingCli)).toBe(false);
    const check = checkShimHooks({ settingsPath: file });
    expect(check.written).toBe(true);
    expect(check.resolvable).toBe(false);
    expect(check.note).toMatch(/orphan/i);
  });

  it("reinstall is idempotent (unchanged when identical)", async () => {
    const file = settingsFile("idem");
    const home = freshHome("hooks-home-idem");
    mkdirSync(home, { recursive: true });
    const cliPath = path.join(home, "cli.js");
    writeFileSync(cliPath, "// cli\n", "utf8");
    const a = await installHooks({ home, settingsPath: file, cliPath, nodePath: process.execPath });
    expect(a.action).toBe("installed");
    const b = await installHooks({ home, settingsPath: file, cliPath, nodePath: process.execPath });
    expect(b.action).toBe("unchanged");
  });
});
