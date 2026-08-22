import { BIN } from "../brand.js";
import { readEnv } from "../brand.js";
import { GestaltError } from "../errors.js";
import { validatePassphrase } from "../store/keyring.js";

/**
 * The guided encrypted-by-default first run (0.5, the trust lane).
 *
 * Since 0.5 a NEW store created through the CLI is encrypted unless the user
 * says otherwise — the decided shape (docs/ENCRYPTED-DEFAULT-FLIP-PREP.html,
 * DECIDED 2026-07-17): encrypted default, a guided flow that ends with the
 * user CONFIRMING the 24-word phrase is recorded, a one-keystroke `--plaintext`
 * opt-out, and the risk of each mode stated in plain language at the fork.
 *
 * The flip lives ONLY at the CLI boundary. `runInit`/`runSetup` keep their
 * plaintext-unless-asked library default on purpose: the demo store's
 * byte-identical determinism contract (ops/demoStore.ts), ~140 test call
 * sites, and every library embedder (the Nexus wizard lane in index.ts) keep
 * their existing meaning, and "the CLI asked the human" stays the one place
 * the new default is decided.
 *
 * The non-interactive rule is the load-bearing half: no TTY and no passphrase
 * source FAILS CLOSED naming both remedies. Encrypted-by-default that silently
 * falls back to plaintext exactly where nobody is watching would make the
 * default a lie; a generated passphrase would make recovery one.
 */

/** Injectable IO so the guided flow is testable without a TTY (the same
 * pattern as OnboardIO — ops/onboard.ts). */
export interface FirstRunIO {
  out: (line?: string) => void;
  /** Ask one question, input echoed. */
  ask: (question: string) => Promise<string>;
  /** Ask one question with the input NOT echoed (passphrases). */
  askHidden: (question: string) => Promise<string>;
  /** Release the underlying terminal interface, when there is one. */
  close?: () => void;
}

export interface FirstRunPlan {
  encrypted: boolean;
  /** The passphrase to hand to runInit/runSetup (and to the post-init cache
   * warm). Always present when `encrypted` — whichever source supplied it. */
  passphrase?: string;
  source: "flag" | "env" | "prompt" | "plaintext";
}

/** The plain-language fork, shown once on a TTY when neither flag was given.
 * Kept short: two costs, one keystroke to continue, one word to opt out. */
const FORK_LINES: readonly string[] = [
  "Your new store will be ENCRYPTED at rest (a passphrase, plus a 24-word recovery phrase shown once).",
  "  Encrypted: the files stay sealed wherever they travel (git hosts, cloud backups). Lose BOTH the",
  "             passphrase and the 24-word phrase and the data is gone — there is no reset without them.",
  "  Plaintext: any person or program with file access can read your memory. Choose it deliberately.",
];

/**
 * Decide mode + passphrase for a CLI-driven store creation. Never creates
 * anything; the caller runs init/setup with the plan. Throws E_SCHEMA
 * (fail closed) when encrypted is wanted, nothing supplies a passphrase, and
 * there is no TTY to ask on.
 */
export async function planFirstRun(opts: {
  explicitEncrypted: boolean;
  explicitPlaintext: boolean;
  /** `--passphrase` value (truthy only — the empty flag is the caller's
   * usage error, same presence rules as the unlock gate). */
  passphraseFlag?: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  io: FirstRunIO;
  /** The verb on screen, so the fail-closed hint names what the reader typed. */
  command: "init" | "setup";
}): Promise<FirstRunPlan> {
  const { io } = opts;
  let encrypted = !opts.explicitPlaintext;

  if (encrypted && !opts.explicitEncrypted && opts.interactive) {
    // The fork — only when the user has not already chosen with a flag.
    for (const line of FORK_LINES) io.out(line);
    const answer = (
      await io.ask('Press Enter to continue encrypted, or type "plaintext" to opt out: ')
    )
      .trim()
      .toLowerCase();
    if (answer === "plaintext" || answer === "p") encrypted = false;
    io.out();
  }

  if (!encrypted) return { encrypted: false, source: "plaintext" };

  if (opts.passphraseFlag) {
    return { encrypted: true, passphrase: opts.passphraseFlag, source: "flag" };
  }
  const fromEnv = readEnv("PASSPHRASE", opts.env);
  if (fromEnv !== undefined) {
    return { encrypted: true, passphrase: fromEnv, source: "env" };
  }
  if (!opts.interactive) {
    // FAIL CLOSED — never silently plaintext, never a generated passphrase.
    throw new GestaltError(
      "E_SCHEMA",
      "New stores are encrypted by default, and that needs a passphrase.",
      `${BIN} ${opts.command} --passphrase "<a memorable sentence>" (or set GESTALT_PASSPHRASE) — ` +
        `or choose an unencrypted store with ${BIN} ${opts.command} --plaintext`,
    );
  }
  const passphrase = await promptPassphrase(io);
  return { encrypted: true, passphrase, source: "prompt" };
}

/** Ask for a passphrase (hidden), validate against the keyring floor, and
 * require a matching re-type. Loops until both pass; EOF/abort throws. */
export async function promptPassphrase(io: FirstRunIO): Promise<string> {
  for (;;) {
    const first = (
      await io.askHidden("Choose a passphrase (a memorable sentence — 12+ characters, or 4+ different words): ")
    ).trim();
    try {
      validatePassphrase(first);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      io.out(`  That passphrase is not usable: ${msg}`);
      continue;
    }
    const again = (await io.askHidden("Type it again to confirm: ")).trim();
    if (again !== first) {
      io.out("  Those did not match — start again.");
      continue;
    }
    return first;
  }
}

export interface ConfirmMnemonicResult {
  confirmed: boolean;
  attempts: number;
}

/**
 * The recorded-it drill: ask for two sampled words of the phrase just printed.
 * Stronger than a bare "yes" and still ten seconds of work. Three misses give
 * up LOUDLY rather than hold the store hostage — it already exists, and the
 * phrase is still on screen directly above.
 */
export async function confirmMnemonic(
  io: FirstRunIO,
  mnemonic: string,
  opts: { pick?: (wordCount: number) => [number, number]; maxAttempts?: number } = {},
): Promise<ConfirmMnemonicResult> {
  const words = mnemonic.trim().split(/\s+/);
  const pick =
    opts.pick ??
    ((n: number): [number, number] => {
      const a = Math.floor(Math.random() * n);
      let b = Math.floor(Math.random() * (n - 1));
      if (b >= a) b += 1;
      return a < b ? [a, b] : [b, a];
    });
  const [i, j] = pick(words.length);
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = (
      await io.ask(
        `Prove it is written down — type word ${String(i + 1)} and word ${String(j + 1)} of the phrase above, separated by a space: `,
      )
    )
      .trim()
      .toLowerCase()
      .split(/\s+/);
    if (answer.length === 2 && answer[0] === words[i] && answer[1] === words[j]) {
      io.out("  Confirmed — your recovery phrase is recorded.");
      return { confirmed: true, attempts: attempt };
    }
    io.out(
      attempt < maxAttempts
        ? `  That does not match — look at word ${String(i + 1)} and word ${String(j + 1)} above and try again.`
        : "  NOT CONFIRMED. The phrase above is the ONLY way back into this store if the passphrase is lost — record it before closing this terminal.",
    );
  }
  return { confirmed: false, attempts: maxAttempts };
}

/**
 * The real-terminal IO. ONE readline interface for the whole guided session,
 * on purpose: closing and reopening between questions discards whatever input
 * readline had already buffered, so a pasted passphrase-plus-Enter (or any
 * fast typing across a prompt boundary) silently fed the NEXT question's
 * answer to nobody and the flow hung. (Caught by a piped smoke, 2026-08-21.)
 *
 * Hidden input works by muting the interface's output sink: with
 * `terminal: true` readline itself performs the echo, and a sink that drops
 * writes while muted suppresses it — no raw-mode handling of our own, no
 * dependency. The question is printed directly so the user still sees it.
 */
export async function ttyFirstRunIO(): Promise<FirstRunIO> {
  const readline = await import("node:readline");
  const { Writable } = await import("node:stream");

  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, enc: BufferEncoding, cb: () => void): void {
      if (!muted) process.stdout.write(chunk as Buffer, enc);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write("\n");
    process.exit(130);
  });

  // Our own line queue instead of rl.question(): question() DROPS any line
  // that arrives while no question is pending, so a paste of two lines (a
  // passphrase and its confirmation, say) answered the first prompt and fed
  // the second to nobody — the flow hung on input the user had already given.
  const lines: string[] = [];
  let waiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  let closed = false;
  const endedEarly = (): GestaltError =>
    new GestaltError(
      "E_SCHEMA",
      "Interactive input ended before the guided setup finished.",
      `Run again, or use the non-interactive spellings: --passphrase "..." / GESTALT_PASSPHRASE / --plaintext.`,
    );
  rl.on("line", (l: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(l);
    } else {
      lines.push(l);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(endedEarly());
    }
  });
  const nextLine = (): Promise<string> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (closed) return Promise.reject(endedEarly());
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
    });
  };

  const askWith = async (q: string, hidden: boolean): Promise<string> => {
    if (hidden) {
      // The prompt goes straight to the terminal (the muted sink would eat
      // it); the typed input's echo is what the muting suppresses.
      muted = true;
      process.stdout.write(q);
    } else {
      // setPrompt/prompt (not a bare write) so readline knows the prompt
      // width and redraws line edits correctly.
      rl.setPrompt(q);
      rl.prompt();
    }
    try {
      const line = await nextLine();
      if (hidden) process.stdout.write("\n");
      return line;
    } finally {
      if (hidden) muted = false;
      rl.setPrompt("");
    }
  };

  return {
    out: (line = "") => {
      process.stdout.write(line + "\n");
    },
    ask: (q) => askWith(q, false),
    askHidden: (q) => askWith(q, true),
    close: () => {
      rl.close();
    },
  };
}
