/**
 * shellQuote, round-tripped through a REAL shell.
 *
 * Asserting a quoting function against its own expected output cannot catch this
 * class of bug — the failure lives in the gap between what we print and what a
 * shell does with it. Three rounds of that gap, all caught by running rather
 * than reading:
 *
 *   1. DOUBLE quotes. Fine for C:\\Users\\..., and everywhere else they dropped a
 *      backslash from UNC paths, expanded $vars, and COMMAND-SUBSTITUTED
 *      backticks in a line we tell users to paste.
 *   2. A DENYLIST of dangerous characters. Two passes at it still missed &,
 *      which is legal in a filename and reserved in PowerShell — and the
 *      semicolon case had only ever passed because that path also had a space.
 *      Hence the allowlist: enumerating what is dangerous is a losing game.
 *   3. The harness itself. Passing the script through bash's or PowerShell's
 *      ARGV means Node escapes it for CreateProcess first, which mangles
 *      backslash-heavy strings and looks exactly like a quoting bug. Both
 *      helpers below write a script FILE.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/followUp.js";

const UNC = "\\\\192.168.1.38\\fleet\\wn-pass";
const NEWLINE = String.fromCharCode(10);
const SQ_ = String.fromCharCode(39);
const BS_ = String.fromCharCode(92);

/** Every one of these is a legal filename and meaningful to at least one shell. */
const HOSTILE: Array<[string, string]> = [
  ["spaces", "/home/testuser/my store"],
  ["windows", "C:\\Users\\testuser\\wn-c"],
  ["UNC", UNC],
  ["dollar", "/home/testuser/my\$store/x"],
  ["backtick", "/home/testuser/a`echo RAN`b"],
  ["double quote", '/home/testuser/a"b'],
  ["semicolon", "/home/testuser/a;b"],
  ["ampersand", "/home/testuser/a&b"],
  ["pipe", "/home/testuser/a|b"],
  ["parens", "/home/testuser/a(1)b"],
  ["subshell", "/home/testuser/a\$(1+1)b"],
  ["brackets", "/home/testuser/a[0]b"],
  ["braces", "/home/testuser/a{x}b"],
  ["glob", "/home/testuser/a*b?c"],
  ["bang", "/home/testuser/a!b"],
  ["hash", "/home/testuser/a#b"],
  ["caret", "/home/testuser/a^b"],
  ["redirect", "/home/testuser/a>b<c"],
  ["newline", "/home/testuser/a" + NEWLINE + "b"],
];

const probe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
const haveBash = probe.status === 0 && probe.stdout === "ok";
const posixQuoting = process.platform !== "win32";

/** What bash actually receives. Script FILE, never argv — see the header. */
function throughBash(quoted: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sq-"));
  const script = path.join(dir, "run.sh");
  writeFileSync(script, "printf '%s' " + quoted, "utf8");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("bash exited " + String(r.status) + ": " + r.stderr);
  return r.stdout;
}

describe("shellQuote", () => {
  it("leaves an inert path bare", () => {
    expect(shellQuote("/home/testuser/store")).toBe("/home/testuser/store");
    expect(shellQuote("C:/Users/testuser/wn-b")).toBe("C:/Users/testuser/wn-b");
  });

  it("quotes every character a shell could act on", () => {
    for (const [label, p] of HOSTILE) {
      expect(shellQuote(p), label).not.toBe(p);
    }
  });

  it("uses single quotes — double quotes are what expanded $ and ran backticks", () => {
    expect(shellQuote("/a b").startsWith("'")).toBe(true);
    expect(shellQuote("/a b").startsWith('"')).toBe(false);
  });

  it("is an allowlist, so an unlisted metacharacter is quoted rather than missed", () => {
    // The bug this pins: & was not on any denylist we wrote, twice.
    expect(shellQuote("/home/testuser/a&b")).toBe("'/home/testuser/a&b'");
    expect(shellQuote("/home/testuser/a;b")).toBe("'/home/testuser/a;b'");
  });

  it.skipIf(!haveBash || !posixQuoting)("bash receives every hostile path byte for byte", () => {
    for (const [label, p] of [["plain", "/home/testuser/store"] as [string, string], ...HOSTILE]) {
      expect(throughBash(shellQuote(p)), label).toBe(p);
    }
  });

  it.skipIf(!haveBash || !posixQuoting)("an embedded single quote survives POSIX escaping", () => {
    const p = "/home/testuser/it" + String.fromCharCode(39) + "s";
    expect(throughBash(shellQuote(p))).toBe(p);
  });

  it.skipIf(!haveBash)("a backtick is never executed", () => {
    if (!posixQuoting) return; // win32 emits PowerShell quoting; see the note below
    const p = "/home/testuser/a" + String.fromCharCode(96) + "echo RAN" + String.fromCharCode(96) + "b";
    const got = throughBash(shellQuote(p));
    expect(got).toBe(p);
    // NOT "output lacks RAN" — the literal path contains RAN either way.
    expect(got).toContain(String.fromCharCode(96));
  });

  /**
   * The win32 branch, verified on the platform that uses it.
   *
   * The bash rows above skip on Windows because we emit PowerShell quoting
   * there — which would leave the branch that actually ships to Windows users
   * untested on Windows. These rows close that: same round trip, same
   * script-file discipline, against real powershell.exe.
   *
   * ARGUMENT position, not expression position. Our printed lines put the path
   * after a command, where a bare path is legal; testing it inside
   * [Console]::Write(...) directly would fail a correct bare path and send you
   * chasing a bug that is not there.
   */
  const psProbe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write('ok')"], {
    encoding: "utf8",
  });
  const havePS = process.platform === "win32" && psProbe.stdout === "ok";

  function throughPowerShell(quoted: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "sq-ps-"));
    const script = path.join(dir, "run.ps1");
    writeFileSync(
      script,
      ["function Show { param([string]$p) [Console]::Write($p) }", "Show " + quoted].join(
        String.fromCharCode(10),
      ),
      "utf8",
    );
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error("powershell exited " + String(r.status) + ": " + r.stderr);
    return r.stdout;
  }

  it.skipIf(!havePS)("PowerShell receives every hostile path byte for byte", () => {
    for (const [label, p] of [["plain", "C:/Users/testuser/store"] as [string, string], ...HOSTILE]) {
      expect(throughPowerShell(shellQuote(p)), label).toBe(p);
    }
  });

  it.skipIf(!havePS)("PowerShell: an embedded single quote survives '' doubling", () => {
    const p = "C:/Users/testuser/it" + String.fromCharCode(39) + "s";
    expect(throughPowerShell(shellQuote(p))).toBe(p);
  });

  it.skipIf(!havePS)("PowerShell: & is quoted rather than treated as the call operator", () => {
    const p = "C:/Users/testuser/a&b";
    expect(throughPowerShell(shellQuote(p))).toBe(p);
  });

  /**
   * The shared form: DOUBLE quotes, literal in bash AND PowerShell.
   *
   * An embedded single quote is the only case the two shells escape
   * differently, and this closes most of it. Inside bash double quotes only
   * $ ` " \\ and newline are special, and a backslash only when it precedes
   * one of those; inside PowerShell double quotes only $ and backtick are, and a
   * backslash is not an escape at all. Rule those out and the same bytes
   * survive both — which is what covers a Windows user in Git Bash whose store
   * path contains o'brien.
   *
   * Proposed by the Mac from the bash side, verified here against real
   * powershell.exe, plus one case its guard missed: a TRAILING backslash, where
   * the \" would escape the closing quote in bash.
   */
  it("uses double quotes for a quoted path that is literal in both shells", () => {
    expect(shellQuote("/home/testuser/it" + SQ_ + "s")).toBe('"/home/testuser/it' + SQ_ + 's"');
    expect(shellQuote("C:" + BS_ + "Users" + BS_ + "o" + SQ_ + "brien" + BS_ + "store")).toBe(
      '"C:' + BS_ + "Users" + BS_ + "o" + SQ_ + "brien" + BS_ + 'store"',
    );
  });

  it("falls back to platform quoting only for the impossible combinations", () => {
    // quote + trailing backslash: the backslash would escape bash's closing ".
    expect(shellQuote("C:" + BS_ + "o" + SQ_ + "brien" + BS_).startsWith('"')).toBe(false);
    // quote + UNC doubled backslash: bash collapses it inside double quotes.
    expect(shellQuote(BS_ + BS_ + "host" + BS_ + "o" + SQ_ + "brien").startsWith('"')).toBe(false);
    // quote + $: would expand.
    expect(shellQuote("/home/testuser/it" + SQ_ + "s$x").startsWith('"')).toBe(false);
  });

  /**
   * KNOWN LIMITATION, asserted so it stays known.
   *
   * A path containing BOTH a single quote and one of $ ` " \\ or a trailing
   * backslash has no form literal in both shells, so it follows the platform.
   * On Windows that means PowerShell quoting, which Git Bash cannot parse.
   * Verified: powershell.exe 22/22 and bash 22/22 on the hostile list; only
   * this combination diverges.
   */
  it("documents the one combination with no shared form", () => {
    const p = BS_ + BS_ + "host" + BS_ + "o" + SQ_ + "brien";
    expect(shellQuote(p)).toBe(
      process.platform === "win32"
        ? SQ_ + BS_ + BS_ + "host" + BS_ + "o" + SQ_ + SQ_ + "brien" + SQ_
        : SQ_ + BS_ + BS_ + "host" + BS_ + "o" + SQ_ + BS_ + SQ_ + SQ_ + "brien" + SQ_,
    );
  });
});
