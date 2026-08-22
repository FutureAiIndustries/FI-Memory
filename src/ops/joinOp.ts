import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { BIN, readEnv } from "../brand.js";
import path from "node:path";
import { GestaltError } from "../errors.js";
import { resolveHome, storePaths } from "../paths.js";
import { runDoctor } from "./doctor.js";
import { installRules } from "./installRules.js";
import { checkShimHooks, installHooks } from "./installHooks.js";
import { reindexStore } from "./reindexOp.js";
import {
  keyringExists,
  storeHasSealedContent,
  unlockWithPassphrase,
} from "../store/keyring.js";
import { activateDek } from "../store/codec.js";
import { loadOrCreateMachineId } from "../store/machineId.js";

/**
 * `fimemory join <git-url>` — TEAM-PLAYBOOK join flow.
 *
 * 1. Clone the private remote to the store path.
 * 2. Verify store shape.
 * 3. Keyring out-of-band step (NEVER from git): import via `--keyring` or
 *    print clear instructions. Passphrase alone cannot open a clone.
 * 4. Passphrase guide (NEVER echo or store the passphrase).
 * 5. Reindex — index.json is gitignored; without this, search answers nothing.
 * 6. install-rules (+ shim hooks) and final doctor + success check line.
 */

export interface JoinOptions {
  gitUrl: string;
  /** Destination store home. Default: resolveHome(). */
  home?: string;
  /** Skip git clone (tests with a pre-populated fixture tree). */
  skipClone?: boolean;
  /** Injected git runner for tests. */
  gitClone?: (url: string, dest: string) => { ok: boolean; message: string };
  /** When true, also install retrieve hooks (default true for shim mode). */
  installHooks?: boolean;
  /**
   * Rewrite the machine's rules file. Default true.
   *
   * Users had no way to say no. `rulesFile` existed, but only to redirect the
   * write somewhere harmless in tests — the write itself was unconditional.
   */
  installRules?: boolean;
  /**
   * Rewire this machine even when its hooks currently point at a DIFFERENT
   * store. Default false, which is the whole point: see the guard below.
   */
  forceRewire?: boolean;
  /**
   * Claude settings.json to read the existing wiring from, and to write hooks
   * to. Default: the real `~/.claude/settings.json`.
   *
   * Injectable for the same reason `rulesFile` is: the rewire guard reads the
   * machine's CURRENT wiring, so without this a test inherits whatever the
   * developer's box happens to be wired to and join behaves differently on
   * every machine it runs on.
   */
  settingsPath?: string;
  /**
   * Rules file to write. Default: the host default (`~/.claude/CLAUDE.md`).
   *
   * The counterpart to `installHooks: false`. Without it, join's rules step had
   * no opt-out at all, so every test that reached it rewrote the developer's
   * LIVE global rules file — swapping in the shim body over whatever was
   * installed there, silently and with no backup.
   */
  rulesFile?: string;
  /**
   * Path to a portable keyring.json delivered out of band. Copied into the
   * store root. NEVER read from the git remote — that is the whole security
   * story. Omit to print OOB instructions instead.
   */
  keyringFile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JoinResult {
  home: string;
  cloned: boolean;
  storeShapeOk: boolean;
  encrypted: boolean;
  keyringPresent: boolean;
  passphraseGuide: string[];
  rulesPath: string | null;
  doctorHealthy: boolean;
  successCheck: string;
  steps: string[];
  warnings: string[];
  reindexed: boolean;
}

const SUCCESS_CHECK =
  'Ask your AI: "What does this team already know that I should not re-decide?" — if it answers from the store, you\'re in.';

export async function joinStore(opts: JoinOptions): Promise<JoinResult> {
  const home = path.resolve(opts.home ?? resolveHome());
  const steps: string[] = [];
  const warnings: string[] = [];
  let cloned = false;
  const env = opts.env ?? process.env;

  // ── 1. Clone ──────────────────────────────────────────────────────────────
  if (!opts.skipClone) {
    if (existsSync(path.join(home, "topics")) || existsSync(path.join(home, "config.json"))) {
      throw new GestaltError(
        "E_EXISTS",
        `A store already exists at ${home}.`,
        "Pick another --home, or use the existing store (fimemory doctor).",
      );
    }
    if (existsSync(home) && readdirSync(home).length > 0) {
      throw new GestaltError(
        "E_EXISTS",
        `Destination ${home} is not empty.`,
        "Choose an empty path with --home, or remove the directory first.",
      );
    }
    const parent = path.dirname(home);
    mkdirSync(parent, { recursive: true });
    const runner =
      opts.gitClone ??
      ((url: string, dest: string) => {
        const r = spawnSync("git", ["clone", url, dest], {
          encoding: "utf8",
          env,
        });
        if (r.status !== 0) {
          return {
            ok: false,
            message: (r.stderr || r.stdout || `git clone failed (${r.status})`).trim(),
          };
        }
        return { ok: true, message: "cloned" };
      });
    const result = runner(opts.gitUrl, home);
    if (!result.ok) {
      throw new GestaltError(
        "E_IO",
        `Could not clone ${opts.gitUrl}: ${result.message}`,
        "Check the URL, your git credentials, and that the remote is private-accessible.",
      );
    }
    cloned = true;
    steps.push(`cloned ${opts.gitUrl} → ${home}`);
  } else {
    steps.push(`using existing tree at ${home} (skipClone)`);
  }

  // Ensure per-machine / derived paths stay gitignored.
  try {
    const gi = path.join(home, ".gitignore");
    const required = [".gestalt.lock", ".gestalt.lock.owner", ".*.tmp-*", "keyring.json", "index.json", "machine-id"];
    let body = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    let changed = false;
    for (const line of required) {
      if (!body.split("\n").some((l) => l.trim() === line)) {
        body = body.endsWith("\n") || body === "" ? body + line + "\n" : body + "\n" + line + "\n";
        changed = true;
      }
    }
    if (changed || !existsSync(gi)) writeFileSync(gi, body || required.join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }

  // Sticky per-clone machine id (proposal seqs are machine-scoped).
  try {
    const mid = loadOrCreateMachineId(home);
    steps.push(`machine-id ${mid} (local, gitignored)`);
  } catch {
    /* ignore */
  }

  // ── 2. Verify store shape ─────────────────────────────────────────────────
  const paths = storePaths(home);
  const hasConfig = existsSync(paths.config);
  const hasTopics = existsSync(paths.topicsDir);
  const sealed = storeHasSealedContent(home);
  const encrypted = keyringExists(home) || sealed;
  if (!hasConfig || !hasTopics) {
    throw new GestaltError(
      "E_SCHEMA",
      `Cloned tree at ${home} does not look like a FIMemory/Gestalt store (need config.json + topics/).`,
      "Confirm the remote is a store clone, not the product source repo.",
    );
  }
  steps.push("store shape ok (config.json + topics/)");

  // ── 3. Keyring OOB (NEVER from git) ───────────────────────────────────────
  let keyringPresent = keyringExists(home);
  if (encrypted && !keyringPresent && opts.keyringFile) {
    const src = path.resolve(opts.keyringFile);
    if (!existsSync(src)) {
      throw new GestaltError(
        "E_NOT_FOUND",
        `Keyring file not found: ${src}`,
        "Pass the path to the keyring.json the owner sent you out of band.",
      );
    }
    // Refuse if the source is inside a .git object path — belt and braces.
    if (src.includes(`${path.sep}.git${path.sep}`) || src.endsWith(`${path.sep}.git`)) {
      throw new GestaltError(
        "E_SCHEMA",
        "Refusing to import a keyring from inside a .git directory.",
        "Copy keyring.json out of band (password manager / secure channel), not from the git remote.",
      );
    }
    copyFileSync(src, path.join(home, "keyring.json"));
    keyringPresent = true;
    steps.push(`keyring imported from ${src} (out of band — never from git)`);
  }

  const keyringGuide: string[] = [];
  if (encrypted && !keyringPresent) {
    // The 24-word phrase LEADS (measured 2026-08-01, TEAM-PLAYBOOK correction):
    // `recover` rebuilds keyring.json from the phrase alone, so a second
    // machine needs only the repo + the phrase — the keyring file never has to
    // travel. Copying the keyring is the fallback for someone who holds the
    // passphrase but not the phrase.
    keyringGuide.push(
      "This store is encrypted, and keyring.json is NOT in the clone (it is gitignored on purpose).",
      "The passphrase alone cannot open a fresh clone. The simplest way in is the 24-word recovery phrase:",
      "  fimemory recover --mnemonic \"...\" --passphrase \"<a new passphrase for THIS machine>\"",
      "  # rebuilds keyring.json right here — nothing has to travel except the phrase (keep it offline)",
      "Or, if you have the keyring file instead: get keyring.json from the owner OUT OF BAND",
      "(password manager or in person — never chat an AI can read, never the git remote), then:",
      "  fimemory join <git-url> --keyring /path/to/keyring.json",
      "  # or: place keyring.json in the store root by hand, then re-run join / unlock",
      "Then, in order: fimemory unlock  →  fimemory reindex (if join deferred it)  →  fimemory pull",
      "(`pull` refuses while the store is locked — the conflict resolver never runs without a key).",
    );
    warnings.push(
      "keyring.json missing — passphrase alone cannot open this clone. Import it out of band (see guide).",
    );
    steps.push("keyring missing — OOB import instructions printed");
  } else if (encrypted) {
    steps.push("keyring present");
  }

  // Doctor (may report locked — expected before passphrase).
  const doctor1 = runDoctor({ home, env });
  const storeShapeOk = doctor1.storePresent && doctor1.mode !== "absent";
  if (!storeShapeOk) {
    throw new GestaltError(
      "E_SCHEMA",
      "Doctor does not see a store at the join path.",
      "fimemory doctor --home " + home,
    );
  }
  steps.push(`doctor after clone: mode=${doctor1.mode} healthy=${doctor1.healthy}`);

  // ── 4. Passphrase guide (NEVER echo or store) ─────────────────────────────
  const passphraseGuide = encrypted
    ? [
        ...keyringGuide,
        "This store is encrypted at rest. The passphrase is machine-local only.",
        "Get it from the owner OUT OF BAND (password manager or in person — never chat an AI can read).",
        "Plant it for this machine, then unlock:",
        "  export GESTALT_PASSPHRASE='(paste here in your own shell — not in git, not in chat)'",
        "  fimemory unlock",
        "  # or: fimemory unlock --passphrase '...'   (still not committed anywhere)",
        "The recovery phrase is offline-only. Join never writes or prints either secret.",
      ]
    : [
        "This store is plaintext. No passphrase step required.",
        "If the team later encrypts, you will re-join with a passphrase out of band.",
      ];
  steps.push(encrypted ? "passphrase setup guide printed (not stored)" : "plaintext store — no passphrase");

  // ── 5. Reindex (catalog is gitignored — clone has none) ───────────────────
  let reindexed = false;
  if (keyringPresent || !encrypted) {
    // Prefer unlock from env passphrase so sealed notes can be catalogued.
    const pass = readEnv("PASSPHRASE", env);
    let unlockedHere = false;
    if (encrypted && typeof pass === "string" && pass.length > 0 && keyringPresent) {
      try {
        activateDek(unlockWithPassphrase(home, pass));
        unlockedHere = true;
        steps.push("unlocked with GESTALT_PASSPHRASE for reindex");
      } catch (err) {
        warnings.push(
          `could not unlock for reindex: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const { index, warnings: rw } = await reindexStore(home);
      reindexed = true;
      steps.push(
        `reindex: ${Object.keys(index.topics).length} topic(s), lastTimestamp=${index.lastTimestamp ?? "null"}`,
      );
      for (const w of rw) warnings.push(w.message);
    } catch (err) {
      warnings.push(
        `reindex failed (search will answer nothing until it succeeds): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      steps.push("reindex failed — run `fimemory reindex` after unlock");
    }
    void unlockedHere;
  } else {
    steps.push("reindex deferred until keyring is imported and store is unlocked");
    warnings.push("Run `fimemory reindex` after importing keyring.json and unlocking.");
  }

  // ── 6. install-rules + hooks ──────────────────────────────────────────────
  //
  // JOIN USED TO REWIRE THE MACHINE UNCONDITIONALLY, and that is how you lose a
  // tester's memory. On a box that already has a working store, rewriting the
  // rules file and repointing the hooks makes every AI tool read the store you
  // just joined. No error, no prompt; the symptom is "my memory went empty",
  // which reads as data loss. Found on a real machine in the 2026-08-18
  // two-machine gate — the wiring had been hash-backed up beforehand and was
  // restored from that backup.
  //
  // So: joining a SECOND store never steals the first. Wiring happens when the
  // machine has none, or when it already points here, or when asked outright.
  const wiredHome = currentlyWiredHome(opts.settingsPath);
  const pointsElsewhere = wiredHome !== null && path.resolve(wiredHome) !== path.resolve(home);
  const rewire = opts.forceRewire === true || !pointsElsewhere;
  if (!rewire) {
    steps.push(`left this machine's AI wiring alone — it points at ${wiredHome ?? "another store"}`);
    warnings.push(
      `This machine's AI tools are wired to ${wiredHome ?? "another store"}, so join did NOT ` +
        `repoint them at ${home}. The store is cloned and ready either way. To switch this ` +
        `machine over deliberately: ${BIN} join <url> --home ${home} --force-rewire`,
    );
  }

  let rulesPath: string | null = null;
  if (rewire && opts.installRules !== false) {
    try {
      const rules = await installRules({
        mode: "shim",
        ...(opts.rulesFile !== undefined ? { file: opts.rulesFile } : {}),
      });
      rulesPath = rules.path;
      steps.push(`install-rules mode=shim → ${rules.path} (${rules.action})`);
    } catch (err) {
      warnings.push(`install-rules failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (rewire && opts.installHooks !== false) {
    try {
      const hr = await installHooks({
        home,
        ...(opts.settingsPath !== undefined ? { settingsPath: opts.settingsPath } : {}),
      });
      steps.push(`install-hooks ${hr.action} → ${hr.path}`);
    } catch (err) {
      warnings.push(`install-hooks failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Final doctor + success check ──────────────────────────────────────────
  const doctor2 = runDoctor({ home, env });
  steps.push(`doctor final: mode=${doctor2.mode} healthy=${doctor2.healthy}`);
  if (doctor2.mode === "encrypted-locked") {
    warnings.push(
      "Store is still LOCKED — complete the passphrase step above, then re-run fimemory doctor.",
    );
  }

  return {
    home,
    cloned,
    storeShapeOk,
    encrypted,
    keyringPresent,
    passphraseGuide,
    rulesPath,
    doctorHealthy: doctor2.healthy,
    successCheck: SUCCESS_CHECK,
    steps,
    warnings,
    reindexed,
  };
}

/**
 * The store this machine's hooks currently read, or null if it has none.
 *
 * Read from the installed handler's own argv rather than from any config we
 * keep, because the handler's argv is what actually runs on every prompt — a
 * record that disagrees with it would be the thing lying to us.
 */
function currentlyWiredHome(settingsPath?: string): string | null {
  let check: ReturnType<typeof checkShimHooks>;
  try {
    check = checkShimHooks(settingsPath !== undefined ? { settingsPath } : {});
  } catch {
    return null;
  }
  if (!check.written || !check.args) return null;
  const i = check.args.indexOf("--home");
  const val = i >= 0 ? check.args[i + 1] : undefined;
  return val !== undefined && val.trim() !== "" ? val : null;
}
