import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_CONFIG_UNRESOLVED, defaultHostConfigFiles } from "../src/ops/installMcp.js";

/**
 * Claude Desktop's config path is the ONE host location that genuinely differs
 * per operating system, and until this file existed it was the only platform
 * branch in the codebase with no assertion anywhere: the string `darwin`
 * appeared exactly once in the whole test tree, in a test about something else.
 * The darwin and linux arms therefore could not be wrong-and-noticed, on the two
 * platforms nobody on this project has ever run the product on.
 *
 * Adding OS runners does not fix that by itself — a macOS runner exercises
 * whichever arm it happens to be on and asserts nothing about the result. So
 * `defaultHostConfigFiles` takes an injectable `platform`, and these tests pin
 * all three arms from any machine, on every leg of the matrix.
 *
 * WHAT THESE TESTS DO NOT PROVE, said plainly: that the darwin and linux paths
 * are the paths Claude Desktop actually reads. Those two are inferences from
 * Electron's userData convention, not measurements — nobody here owns a Mac,
 * Claude Desktop is not installed on the owner's Windows box either, and there
 * is no vendor documentation for them on this disk. These tests pin the values
 * so a change to them is deliberate and visible; confirming them needs a person
 * with the app installed. See the comment on `defaultDesktopConfigPath`.
 */

const desktop = (opts: Parameters<typeof defaultHostConfigFiles>[0]): string =>
  defaultHostConfigFiles(opts).find((h) => h.target === "claude-desktop")!.file;

describe("Claude Desktop config path — one arm per platform, all three pinned", () => {
  it("win32: %APPDATA%\\Claude\\claude_desktop_config.json", () => {
    const file = desktop({
      homeDir: path.join("C:", "Users", "someone"),
      env: { APPDATA: path.join("C:", "Users", "someone", "AppData", "Roaming") },
      platform: "win32",
    });
    expect(file).toBe(
      path.join("C:", "Users", "someone", "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("darwin: ~/Library/Application Support/Claude/… (INFERRED, never verified on a Mac)", () => {
    const file = desktop({ homeDir: path.join("/Users", "someone"), env: {}, platform: "darwin" });
    expect(file).toBe(
      path.join("/Users", "someone", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    // APPDATA is a Windows variable and must not leak into the darwin arm.
    expect(
      desktop({ homeDir: path.join("/Users", "someone"), env: { APPDATA: "/nope" }, platform: "darwin" }),
    ).toBe(file);
  });

  it("linux: ~/.config/Claude/… (INFERRED; there may be no Linux build at all)", () => {
    const file = desktop({ homeDir: path.join("/home", "someone"), env: {}, platform: "linux" });
    expect(file).toBe(path.join("/home", "someone", ".config", "Claude", "claude_desktop_config.json"));
  });
});

describe("Claude Desktop config path — an absent APPDATA is not a path", () => {
  const home = path.join("C:", "Users", "someone");

  it.each([
    ["undefined", {} as NodeJS.ProcessEnv],
    ["empty string", { APPDATA: "" }],
    ["whitespace", { APPDATA: "   " }],
  ])("APPDATA %s → the unresolved sentinel, never a relative path", (_label, env) => {
    const file = desktop({ homeDir: home, env, platform: "win32" });
    expect(file).toBe(DESKTOP_CONFIG_UNRESOLVED);
    // The bug this replaced: `env["APPDATA"] ?? home` with APPDATA="" produced
    // `Claude/claude_desktop_config.json`, which existsSync and the atomic
    // writer resolve against the PROCESS CWD — so `setup` wrote a config (with
    // a plaintext passphrase, when --env-passthrough was used) into whatever
    // directory the user happened to be standing in, and doctor, run from
    // somewhere else, reported the host unconfigured forever.
    expect(path.isAbsolute(file)).toBe(false); // it is not a path at all…
    expect(file).not.toContain("Claude"); // …and cannot be mistaken for one
    expect(file).not.toContain(path.sep);
  });

  it("does not fall back to the user's home directory", () => {
    // The old `?? home` fallback produced <home>\Claude\claude_desktop_config.json,
    // which is not where Claude Desktop looks on ANY platform: a file written,
    // reported installed, and never read.
    const file = desktop({ homeDir: home, env: {}, platform: "win32" });
    expect(file.startsWith(home)).toBe(false);
  });
});
