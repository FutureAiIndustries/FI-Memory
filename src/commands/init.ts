import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, serializeConfig } from "../config.js";
import { GestaltError } from "../errors.js";
import type { Warning } from "../errors.js";
import { buildExample } from "../example.js";
import {
  fsPath,
  proposalPath,
  resolveHome,
  storePaths,
  topicLogPath,
  topicNotePath,
} from "../paths.js";
import type { HomeOpts } from "../paths.js";
import { wipeSessionCache } from "../sessionKeyCache.js";
import { activateDek, clearActiveKey, encryptFile } from "../store/codec.js";
import { initKeyring, STORE_MARKER_CONTENT } from "../store/keyring.js";
import type { Argon2Params } from "../store/keyring.js";
import { parseLog, serializeLog } from "../store/log.js";
import { serializeSchemaFile } from "../store/schema.js";

export interface InitOptions extends HomeOpts {
  /** Create an encrypted store (keyring + at-rest encryption). */
  encrypted?: boolean;
  /** Passphrase for an encrypted store (else falls back to GESTALT_PASSPHRASE). */
  passphrase?: string;
  /** Argon2id params override (tests use tiny params for speed). */
  argon2?: Omit<Argon2Params, "salt">;
  /** Allow below-floor Argon2 params (tests only). */
  allowWeakParams?: boolean;
}

export interface InitResult {
  home: string;
  created: string[];
  topicCount: number;
  pendingProposals: number;
  warnings: Warning[];
  encrypted: boolean;
  /** The 24-word recovery phrase — present ONLY for encrypted init; show ONCE. */
  mnemonic?: string;
  kid?: string;
  /** Present ONLY when re-init could not delete a stale cached session key:
   * the PREVIOUS store's DEK is still on disk (and warm-usable for its TTL)
   * until `fimemory lock` succeeds. The init itself proceeded. */
  sessionKeyWipeFailed?: { path: string; error: string };
}

/**
 * Create a fresh store: directory tree, `config.json` (frozen defaults), and
 * the `gestalt-example` worked example (SPEC §5.1). With `encrypted: true` it
 * also bootstraps a keyring (passphrase → Argon2id → wrapped DEK + a 24-word
 * recovery phrase) and writes the store encrypted at rest.
 *
 * Refuses (E_EXISTS) if a store already exists here, so re-running `init` can
 * never clobber a user's real memory. Past that check, EVERY re-init
 * invalidates this home's cached session key (E2c) — encrypted or PLAINTEXT —
 * and a wipe that fails is surfaced on the result, never swallowed. The
 * encrypted path is side-effect clean:
 * it activates the DEK only to write the example, then clears it — callers
 * unlock explicitly for subsequent operations.
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const home = resolveHome(opts);
  const paths = storePaths(home);

  if (existsSync(fsPath(paths.config))) {
    throw new GestaltError(
      "E_EXISTS",
      `A FIMemory store already exists at ${home}.`,
      `fimemory status --home "${home}"`,
    );
  }

  // No store lives at this home (just proven above) — so a cached session key
  // for it belongs to a store that was DELETED, and re-init must invalidate it
  // UNCONDITIONALLY (SPEC E2c: "recover/re-init invalidate the entry"). This
  // wipe used to live only inside initKeyring, reached only under `encrypted`,
  // so a PLAINTEXT re-init over a deleted encrypted store left the old DEK
  // warm-usable for its TTL — and the loud warning below could never fire.
  // Hoisted here, EVERY re-init kills the entry, whatever the NEW store's
  // mode; the outcome is surfaced on the result, never discarded. (Placed
  // after the E_EXISTS check on purpose: a REFUSED init over a live store
  // must not end that store's warm session.)
  const staleWipe = wipeSessionCache(home);

  // A REFUSED init must leave NOTHING behind. The directory tree is created
  // before the encrypted bootstrap can reject a missing passphrase, so
  // `setup --encrypted` with no passphrase used to fail loudly and still leave
  // `topics/` on disk with no config.json — a skeleton that doctor accepted as
  // a store and reported "Store: plaintext / Healthy." over. Track exactly what
  // this run creates so the throw paths can take it back out.
  //
  // Deliberately conservative: only entries this run CREATED are removed, and
  // directories go via `rmdirSync`, which refuses a non-empty directory. If
  // anything unexpected is in there it stays, and the operator sees it.
  // mode 0700: the store holds the user's notes, and on an encrypted store the
  // keyring sits in this same directory. Without an explicit mode these land
  // 0755 under the standard umask 022, so on a shared Linux box or a Mac with a
  // second account the whole store is world-listable and world-readable. Inert
  // on Windows. HONEST LIMIT, and it is the reason there is a tripwire for this
  // in .github/scripts/posix-modes.mjs: mkdirSync's mode applies only to
  // directories it CREATES, so a store that already exists from an older build
  // keeps 0755 and nothing here tightens it.
  const madeDirs: string[] = [];
  for (const dir of [paths.home, paths.topicsDir, paths.logsDir, paths.proposalsDir, paths.ledgersDir]) {
    if (!existsSync(fsPath(dir))) madeDirs.push(dir);
    mkdirSync(fsPath(dir), { recursive: true, mode: 0o700 });
  }
  const madeFiles: string[] = [];
  const rollbackSkeleton = (): void => {
    for (const f of madeFiles) {
      try {
        unlinkSync(fsPath(f));
      } catch {
        /* best effort */
      }
    }
    for (const dir of [...madeDirs].reverse()) {
      try {
        rmdirSync(fsPath(dir));
      } catch {
        /* non-empty or already gone — leave it and say nothing */
      }
    }
  };

  // Phase 0 dual-machine (NEXUS-PHASE0-HANDOFF C1): store template git rules.
  // Written PLAIN (never through the codec) — git itself must read them.
  // keyring.json is per-machine (Decision 3); index.json is derived (reindex);
  // ledgers/*.jsonl merge=union — each line sealed on encrypted stores (F3;
  // line-oriented AEAD, not whole-file).
  const gitattributesPath = path.join(paths.home, ".gitattributes");
  const gitignorePath = path.join(paths.home, ".gitignore");
  if (!existsSync(fsPath(gitattributesPath))) madeFiles.push(gitattributesPath);
  if (!existsSync(fsPath(gitignorePath))) madeFiles.push(gitignorePath);
  writeFileSync(
    fsPath(gitattributesPath),
    [
      "# FIMemory store — dual-machine merge rules (Phase 0).",
      "* -text",
      "logs/*.log.md merge=union",
      "ledgers/*.jsonl merge=union",
      "",
    ].join("\n"),
    // 0600 like everything else this creates — see the `write` helper below.
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    fsPath(gitignorePath),
    [
      "# Per-machine / derived — never sync (NEXUS-PHASE0-HANDOFF C1 / Decision 3).",
      ".gestalt.lock",
      "keyring.json",
      "index.json",
      "machine-id",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  const example = buildExample();

  let mnemonic: string | undefined;
  let kid: string | undefined;
  let sessionKeyWipeFailed: { path: string; error: string } | undefined =
    staleWipe.outcome === "failed"
      ? { path: staleWipe.path, error: staleWipe.error }
      : undefined;
  let exampleEntries: ReturnType<typeof parseLog>["entries"] | null = null;

  if (opts.encrypted) {
    // EVERY throw below happens AFTER the tree exists, so each one undoes it.
    if ((opts.env ?? process.env).GESTALT_KEY) {
      rollbackSkeleton();
      throw new GestaltError(
        "E_SCHEMA",
        "GESTALT_KEY is set — it would shadow the passphrase keyring.",
        "Unset GESTALT_KEY, then create the passphrase-managed store.",
      );
    }
    const passphrase =
      opts.passphrase ?? (opts.env ?? process.env).GESTALT_PASSPHRASE;
    if (!passphrase) {
      rollbackSkeleton();
      throw new GestaltError(
        "E_SCHEMA",
        "Creating an encrypted store needs a passphrase.",
        `fimemory init --encrypted --passphrase "<a memorable sentence>"`,
      );
    }
    // Parse the example log to entries while still in PLAINTEXT mode (before the
    // key is active), so we can re-serialize it per-entry-encrypted below.
    clearActiveKey();
    exampleEntries = parseLog(example.log).entries;
    let kr: ReturnType<typeof initKeyring>;
    try {
      kr = initKeyring(home, passphrase, opts.argon2, {
        allowWeakParams: opts.allowWeakParams,
      });
    } catch (err) {
      // A rejected passphrase (too short, weak Argon2 params) lands here.
      rollbackSkeleton();
      throw err;
    }
    activateDek(kr.dek); // the codec now encrypts on write
    mnemonic = kr.mnemonic;
    kid = kr.kid;
    // initKeyring ran its OWN wipe (a NEW keyring invalidates any cached key,
    // whoever the caller — kept as the keyring-level invariant; the overlap
    // with the hoisted wipe above is harmless). It is the LATER observation,
    // so it supersedes in BOTH directions: a failure is surfaced even if the
    // hoisted wipe passed, and a success — `wiped`, or `nothing`, the
    // unlink's own ENOENT, provably absent — clears an earlier failure,
    // because the entry is now known gone. Never swallowed (mirrors recover):
    // on failure the previous store's DEK is still cached until `gestalt
    // lock` succeeds.
    sessionKeyWipeFailed =
      kr.sessionWipe.outcome === "failed"
        ? { path: kr.sessionWipe.path, error: kr.sessionWipe.error }
        : undefined;
  }

  const created: string[] = [];
  // Every write routes through the codec: identity in a plaintext store, sealing
  // notes + index + proposals in an encrypted one; config stays plaintext.
  // mode 0600 on every file this creates. Under umask 022 an unmoded
  // writeFileSync lands 0644, and because writeFileAtomicPlain PRESERVES an
  // existing mode, every later write through the runtime would keep the store's
  // notes world-readable for the life of the store. The default install is a
  // PLAINTEXT store, so on POSIX these bytes are the user's memory in the clear.
  // Inert on Windows. Measured on the POSIX legs by .github/scripts/posix-modes.mjs.
  const write = (p: string, content: string): void => {
    writeFileSync(fsPath(p), encryptFile(p, content), { encoding: "utf8", mode: 0o600 });
    created.push(p);
  };

  try {
    write(paths.config, serializeConfig(DEFAULT_CONFIG));
    // Plaintext store-format version (Phase B). Same write() path — schema.json
    // is classified as never-encrypted in the codec.
    write(paths.schema, serializeSchemaFile());
    if (opts.encrypted) {
      // Authenticated store-mode marker: an always-present sealed blob that is
      // the canonical "encrypted? / does this DEK open it?" oracle for the CLI
      // gate and every unlock path (R3). Written first so it's the anchor.
      write(paths.storeMarker, STORE_MARKER_CONTENT);
    }
    write(topicNotePath(home, example.id), example.note);
    if (opts.encrypted) {
      // Logs are per-entry encrypted — re-serialize the parsed example entries.
      writeFileSync(
        fsPath(topicLogPath(home, example.id)),
        serializeLog(example.id, exampleEntries!),
        { encoding: "utf8", mode: 0o600 },
      );
      created.push(topicLogPath(home, example.id));
    } else {
      write(topicLogPath(home, example.id), example.log);
    }
    write(
      proposalPath(home, example.proposal.seq, example.id),
      example.proposal.content,
    );
    write(paths.index, JSON.stringify(example.index, null, 2) + "\n");
  } catch (err) {
    // Roll back a half-written store (incl. the keyring) so nothing is wedged
    // and re-init works cleanly — the recovery phrase was never shown yet.
    if (opts.encrypted) created.push(storePaths(home).home + "/keyring.json");
    for (const p of created) {
      try {
        unlinkSync(fsPath(p));
      } catch {
        /* best effort */
      }
    }
    // …and the skeleton too, so a half-written store leaves no `topics/` for
    // doctor to mistake for a real one.
    rollbackSkeleton();
    throw err;
  }

  if (opts.encrypted) clearActiveKey(); // no lingering process key — unlock explicitly

  return {
    home,
    created,
    topicCount: Object.keys(example.index.topics).length,
    pendingProposals: 1,
    warnings: [],
    encrypted: Boolean(opts.encrypted),
    mnemonic,
    kid,
    ...(sessionKeyWipeFailed ? { sessionKeyWipeFailed } : {}),
  };
}
