import { spawnSync } from "node:child_process";

/**
 * Best-effort clipboard access via the platform's native tool. Purely a
 * convenience — `pack` always prints to stdout and `ingest` always reads stdin,
 * so a missing clipboard tool never blocks the flow.
 *
 * ── the Linux desktop, honestly ─────────────────────────────────────────────
 *
 * This used to be one command for every non-Windows non-macOS system: `xclip`.
 * Two things are wrong with that on a stock Linux desktop, and both look
 * identical to the user because a non-zero exit was mapped to "nothing on the
 * clipboard":
 *
 *   - xclip is not installed by default on Ubuntu, Debian, Fedora, Arch or
 *     RHEL. The spawn fails with ENOENT and the user is told their clipboard is
 *     empty, never that a package is missing.
 *   - xclip talks X11. Under a native Wayland session — the default on Ubuntu
 *     22.04+ and Fedora — it does not drive the clipboard of Wayland clients.
 *     `wl-copy`/`wl-paste` (the wl-clipboard package) do.
 *
 * So: prefer wl-clipboard when the session says Wayland, fall back to xclip, and
 * distinguish "the tool is not installed" (ENOENT) from "the tool ran and the
 * clipboard was empty". `clipboardHint()` is what the CLI prints for the first
 * case, and it names the package to install.
 *
 * NOT MEASURED ANYWHERE, and no CI runner can close this: there is no clipboard
 * test in the suite, and the GitHub runners are headless with no DISPLAY and no
 * WAYLAND_DISPLAY, so even the degrades-gracefully path goes unexercised. This
 * needs a person on a real Ubuntu desktop, once under Wayland and once under
 * Xorg. The published README says so rather than implying it.
 */

/** True when the current session is Wayland, so wl-clipboard is the right tool. */
function isWayland(env: NodeJS.ProcessEnv): boolean {
  if ((env.WAYLAND_DISPLAY ?? "").trim() !== "") return true;
  return (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase() === "wayland";
}

interface Cmd {
  cmd: string;
  args: string[];
  /** The package to suggest when this command is not installed. */
  pkg: string;
}

function writeCommands(env: NodeJS.ProcessEnv = process.env): Cmd[] {
  if (process.platform === "win32") return [{ cmd: "clip", args: [], pkg: "clip" }];
  if (process.platform === "darwin") return [{ cmd: "pbcopy", args: [], pkg: "pbcopy" }];
  const wl: Cmd = { cmd: "wl-copy", args: [], pkg: "wl-clipboard" };
  const x: Cmd = { cmd: "xclip", args: ["-selection", "clipboard"], pkg: "xclip" };
  return isWayland(env) ? [wl, x] : [x, wl];
}

function readCommands(env: NodeJS.ProcessEnv = process.env): Cmd[] {
  if (process.platform === "win32")
    return [{ cmd: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"], pkg: "powershell" }];
  if (process.platform === "darwin") return [{ cmd: "pbpaste", args: [], pkg: "pbpaste" }];
  const wl: Cmd = { cmd: "wl-paste", args: ["--no-newline"], pkg: "wl-clipboard" };
  const x: Cmd = { cmd: "xclip", args: ["-selection", "clipboard", "-o"], pkg: "xclip" };
  return isWayland(env) ? [wl, x] : [x, wl];
}

/** ENOENT means the binary is not installed; anything else means it ran. */
function notInstalled(r: ReturnType<typeof spawnSync>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * The advice to print when the clipboard could not be used because no tool is
 * installed. `null` when a tool DID run — then the clipboard really was empty,
 * or really did refuse, and telling the user to install something would be
 * wrong. Callers decide whether to show it; nothing here writes to stderr.
 */
export function clipboardHint(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === "win32" || process.platform === "darwin") return null;
  return isWayland(env)
    ? "No clipboard tool found. This looks like a Wayland session: install wl-clipboard (`sudo apt install wl-clipboard`), or xclip on X11."
    : "No clipboard tool found. Install xclip (`sudo apt install xclip`), or wl-clipboard if you are on Wayland.";
}

/** `toolRan: false` means no clipboard tool is installed — the one case where
 * `clipboardHint()` is the right thing to say. Everything else means a tool ran
 * and gave its answer. */
export interface ClipboardOutcome<T> {
  value: T;
  toolRan: boolean;
}

export function copyToClipboardDetailed(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardOutcome<boolean> {
  for (const c of writeCommands(env)) {
    try {
      const r = spawnSync(c.cmd, c.args, { input: text, encoding: "utf8" });
      if (notInstalled(r)) continue; // try the other tool before giving up
      return { value: r.status === 0, toolRan: true };
    } catch {
      /* try the next candidate */
    }
  }
  return { value: false, toolRan: false };
}

export function readClipboardDetailed(
  env: NodeJS.ProcessEnv = process.env,
): ClipboardOutcome<string | null> {
  for (const c of readCommands(env)) {
    try {
      const r = spawnSync(c.cmd, c.args, { encoding: "utf8" });
      if (notInstalled(r)) continue;
      return { value: r.status === 0 ? r.stdout : null, toolRan: true };
    } catch {
      /* try the next candidate */
    }
  }
  return { value: null, toolRan: false };
}

export function copyToClipboard(text: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return copyToClipboardDetailed(text, env).value;
}

export function readFromClipboard(env: NodeJS.ProcessEnv = process.env): string | null {
  return readClipboardDetailed(env).value;
}
