# FIMemory

**A local store your AI tools can read, once connected and told to.**

FIMemory (FI Memory, by Future Industries) keeps your notes on your own
computer, and connects your AI tools to them so you stop re-explaining the
same project every session. The store is an ordinary folder of your own files:
no proprietary format, no server, no account, nothing uploaded anywhere.
New stores are **encrypted at rest by default**. You choose a passphrase, a
24-word recovery phrase prints once, and the files stay private wherever they
travel: a git host, a cloud backup, a USB stick. Prefer files you can open in
a text editor directly? Plaintext is one explicit choice away at setup, and an
encrypted store exports back to readable Markdown any time, gated by nothing
but your key.

## Start here

Two commands.

```
npm i -g fimemory
fimemory setup
```

If that first command fails with `EACCES: permission denied` (common on macOS,
where npm's default global folder is root-owned), give npm a folder you own and
retry. No sudo needed:

```
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm i -g fimemory
```

Then close and reopen any AI tool that was already running, because they read
their settings when they start.

That is the whole install. `setup` creates the store if you do not have one,
connects every AI tool it finds on this machine, then checks its own work and
prints what landed and what did not. Running it again is safe and boring:
everything already in place reports `unchanged` and nothing is rewritten. When
you are not sure whether it worked, run it again.

Creating a store on a terminal, `setup` walks you through encryption: you
choose a passphrase (or press one key to opt out with `--plaintext`), it
prints your 24-word recovery phrase once and asks you to prove you wrote it
down, then leaves the store unlocked on this machine for about 8 hours. In a
script or CI there is no prompt: pass `--passphrase "..."`, set
`GESTALT_PASSPHRASE`, or say `--plaintext`. With none of those it refuses
cleanly rather than guessing. Lose both the passphrase and the 24-word phrase
and the data is gone, by design; that is what "your key, not our servers"
costs, and the guided run will not let it happen silently.

One step `setup` cannot finish for you is Claude Code, which manages its own
config file. `setup` checks whether the `claude` command exists on this
machine: if it does, it prints a single `claude mcp add` line for you to
paste. If it does not (the VSCode extension and the desktop app install no
command line), it prints the exact JSON block and the file to put it in
instead. Either way it lands under Next steps rather than scrolling past.

If a step fails, the run keeps going and the failure gets its own line. Fix that
line, run `fimemory setup` again, and the steps that already worked stay put.

Three commands you will want later:

- `fimemory onboard` is the guided first step AFTER setup: it walks you
  through approving your first suggested edit, asks three questions about how
  you work and writes the answers into the store, then shows a search
  answering with your own facts. A wired store that holds nothing about you
  feels broken even when nothing is; this is the shortest way past that.
- `fimemory doctor` reads the whole setup back and tells you in plain words
  what is missing and what to do about it. A half-finished install is the most
  common way this goes wrong.
- `fimemory setup --plaintext` does the same install with an UNENCRYPTED
  store: every file readable in a text editor, by you and by any person or
  program with access to the folder. It is a real choice, stated plainly, not
  a hidden downgrade. A store that started plaintext can adopt encryption
  later with `fimemory encrypt` (cheapest before real content accumulates).

Before, a working install and a dead one looked identical. Now the install tells
you which one you have.

## Honest expectations

- **Installed and used by a person on Windows, macOS and Linux.** Not a runner
  claim: these are hand installs on real machines that then did real work, with
  two different AI tools reading and writing one store daily for months. The
  Windows box and the Mac each run Claude Code and Grok against it; the Linux
  box runs it headless. CI additionally builds, typechecks, tests, and
  global-installs the packed package on Linux and macOS runners every push.
  What that still does not cover is the long tail of host apps: a runner has no
  desktop session, so for any client other than the ones named below we have not
  watched the config `setup` wrote actually get loaded. On Linux the clipboard
  commands need `xclip`, or `wl-clipboard` on Wayland, and neither is installed
  by default. Run `fimemory doctor` if something looks wrong, and please report
  it.
- **It isn't cheaper than not remembering.** It's correct for a small
  premium, and far cheaper than pasting everything.
- **Agents read it when connected and told to.** `setup` writes the MCP
  config, the rule text and the retrieval hook for you, but no memory product
  can force a host to consult it unprompted on every turn.
- **Automated Sync is not shipped.** Multi-machine works via your own git remote,
  under your own account. No Sync service exists yet, so nothing you write
  ever leaves your machine unless you configure a remote yourself.
- **The shipped scope is your machines, several agents.** Point two machines at
  one private git remote: `fimemory join <url>` on the second machine, then
  `fimemory pull` before and after sessions. Edits to the same note never
  silently merge; the losing side becomes a pending proposal for you to review.
  Team features beyond your own remote are not in it.

## What `setup` actually runs

Five steps, in this order:

1. `init`, only when there is no store at `~/.fimemory` (an existing
   `~/.gestalt` from an earlier install is detected and kept). Skipped, never
   overwritten, when one is already there.
2. `install-mcp`, which writes the MCP server entry into each host config file
   it finds. This is what gives an assistant the ability to read the store.
3. `install-hooks`, which writes Claude Code's retrieval hook into
   `~/.claude/settings.json`. Skipped when `~/.claude` does not exist.
4. `install-rules`, which writes the memory rule block into each host's rules
   file. This is what makes an assistant actually use the store.
5. `doctor`, which reads all of it back and reports.

Hooks run before rules on purpose. The `shim` rule text tells the model that
relevant notes may already be in the turn, injected by the retrieval hook. That
sentence is only true once the hook is installed, so the hook goes first and its
outcome picks the wording: hook installed means Claude Code gets the shim
wording, hook skipped means every host gets the search-first wording, which is
true unconditionally. Writing the shim wording without the hook would tell the
model to stop searching in exchange for an injection that never arrives, which
is worse than doing nothing.

Every step is wrapped so that a failure becomes that step's line and the run
continues. A rules file you cannot write must never cost you the MCP
registration, and neither may cost you the doctor verdict that says which of
them landed. `setup` also runs on a locked encrypted store, which is the normal
case on a second machine, and lets `doctor` report the lock.

The individual verbs still exist and still work on their own:
`init`, `install-mcp`, `install-hooks`, `install-rules`, `doctor`.

## Which tool gets what

| Tool | MCP config | Rule block | Retrieval hook |
| --- | --- | --- | --- |
| Claude Code | printed command, not a written file | `~/.claude/CLAUDE.md` | yes, `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` | `~/.codex/AGENTS.md` | no, see below |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` | no, see below |
| Grok CLI | `~/.grok/config.toml` | `~/.grok/AGENTS.md` | no, see below |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` \* | `~/.codeium/windsurf/memories/global_rules.md` \* | no, see below |
| Cursor | `~/.cursor/mcp.json` \* | none written, see below | no, see below |
| Claude Desktop | `claude_desktop_config.json` \* | none written, see below | no, see below |

\* **Vendor-documented, unverified on disk.** Windsurf, Cursor and Claude
Desktop are not installed on any machine we have checked, so we have never seen
these paths exist. If one of them ignores the store after `setup` says
`installed`, that is the first thing to suspect: check the app's own settings
for where it really keeps rules, and re-run `fimemory install-rules --file <path>`.
Every other row in the table has been seen on disk.

- **Claude Code** is the one host `install-mcp` does not write. The Claude Code
  CLI owns the schema of `~/.claude.json`, so we print
  `claude mcp add fimemory -s user -- ...` instead. Its rule block and its hook
  are written for you.
- **Cursor**: we write no Cursor rules file. Where Cursor keeps user-level
  rules, and whether it loads `~/.cursor/rules`, is **unverified**. Cursor is
  not installed on any machine we have checked and no Cursor documentation is on
  this disk. An earlier version of this page stated those limits as fact; they
  had never been read from a source, which is the same mistake as the
  `~/.grok/GROK.md` one below, so they are gone. Third-party evidence points
  the other way: Grok's own `12-project-rules.md` lists `~/.cursor/rules/` as
  a rules directory it scans. If you know the file Cursor reads,
  `install-rules --file <path>` writes the same block there.
- **Claude Desktop**: we write no Claude Desktop rules file. Whether it has an
  on-disk rules file at all is **unverified**. It is not installed on any machine we
  have checked. Its MCP config is written.
- **Gemini CLI** lets you rename its context file with `contextFileName` in
  `~/.gemini/settings.json`. `install-rules` reads that and honors it, so the
  block lands in the file Gemini actually reads.
- **Anything else**, including hosts we have never heard of: `install-mcp`
  prints a generic JSON snippet to paste into that client's own config.

**Verified end to end by a person: Claude Code and Grok, on Windows 11 and
macOS.** Those are the combinations that have been installed and used for real
work, daily, against a shared store. Every other host in the table gets its
config and rules written; an honest per-host matrix ships as it is measured, not
before.

If a host lives somewhere unusual: `install-rules`, `install-mcp` and
`doctor` all follow `CODEX_HOME`, `GEMINI_CLI_HOME` and `GROK_HOME` when
they are set, so all three agree about where a host lives. Claude Desktop's
config path depends on your platform (and on `APPDATA` on Windows). The
remaining paths, Cursor's and Windsurf's, are fixed.

### The hook, precisely

`install-hooks` writes exactly one file: Claude Code's
`~/.claude/settings.json`. That is a statement about this software. It is not a
claim that other tools lack hooks, and the version of this sentence that made
that claim was checked on 2026-07-31 and was false.

**Grok CLI**, verified first-hand against grok 0.2.117 on disk, 2026-07-31. Grok
scans `~/.claude/settings.json` for hooks by default
(`[compat.claude] hooks = true`, documented in
`~/.grok/docs/user-guide/05-configuration.md`, and the Hook Locations table in
`10-hooks.md` lists that file as a global always-trusted source). It does load
our two handlers. It cannot deliver an injection, for two independent reasons:

1. **Grok discards the hook's stdout.** This is the one that matters, because it
   cannot be worked around. We measured it: four output shapes (Claude's
   `hookSpecificOutput`, a top-level `additionalContext`, plain text,
   `systemMessage`), each confirmed to have actually fired by a marker file it
   wrote, each producing no injected context, against a positive control that
   proved the harness could surface injected context at all. Measured in
   headless `-p` mode; the interactive TUI was not measured. Grok's own docs do
   not settle it. `10-hooks.md` says only `PreToolUse` and the stop events can
   decide and "every other event is passive", and its Passive Hooks section says
   stdout is ignored "for events like `SessionStart` or `PostToolUse`", naming
   examples rather than `UserPromptSubmit`, which is why the experiment is the
   authority here and not the documentation.
2. **Its handler format has no `args` field.** The Key Fields table in
   `10-hooks.md` enumerates `type`, `command`, `url`, `timeout` and `env`, and
   our entire invocation lives in `args`. Grok spawns the interpreter with no
   arguments and that process dies immediately. This one looks fixable, because
   `command` accepts an inline shell command, but fixing it only makes the hook
   run. It would still inject nothing, because of (1).

Nothing is blocked either way: Grok fails open. But "fails open" is not "silent".
`10-hooks.md` says every hook failure is *recorded for the UI scrollback*, so
you will see a hook failure line on every Grok prompt. If you want it gone, set
`[compat.claude] hooks = false` in `~/.grok/config.toml`. Do **not** delete the
handlers from `~/.claude/settings.json`. That is the file Claude Code actually
uses, and removing them there turns off the one host where the hook works.

**Grok also reads `~/.claude/CLAUDE.md`.** A rules file is not private to the
host whose directory it sits in. Grok's `12-project-rules.md` says that with
Claude compatibility on (the default) it scans your home-level `~/.claude/` for
`CLAUDE.md` among others, and `grok inspect --json` on a real machine listed
that exact file. So on a Claude Code + Grok box the shim wording written "for
Claude Code" was reaching Grok too. It now does not: when a detected host that
cannot run the hook shares a rules file, that file gets the search-first
wording, whoever nominally owns it. `fimemory doctor` reports which body each
rules file carries, not just that a block is there.

**Codex CLI** has hooks. Read in its shipped binary, `@openai/codex` 0.145.0,
2026-08-01: the event set includes `user_prompt_submit`, `session_start`,
`pre_tool_use` and `stop`; the binary carries `hooks/src/events/` source paths
and a `hooks/hooks.json` loader. We write no Codex hook config, so our hook does
not run there. Whether our handler *would* work under Codex, meaning its handler
schema and whether a `user_prompt_submit` hook's stdout is injected, is
**unverified**, and no claim is made in either direction.

**Gemini CLI** has hooks, and ships a first-party import of the very file we
write. Read in `@google/gemini-cli` 0.52.0, 2026-08-01: `UserPromptSubmit` maps
to Gemini's `BeforeAgent` event, and `gemini hooks migrate` reads
`<cwd>/.claude/settings.json` and imports its hooks. **One warning if you use
that command**: its importer copies only `command`, `type` and `timeout`, and
drops `args`, exactly like Grok. Run it in a directory whose
`.claude/settings.json` carries our handlers and you get a node process that
fails on every prompt. We write no Gemini hook config, so this only happens if
you run the migration yourself.

**Windsurf and Claude Desktop**: whether they support hooks at all is
**unverified**. Neither is installed on any machine we have checked. We write no
hook config for either, and claim no limit beyond that.

**Cursor**: Grok's docs record a Cursor hooks file (`~/.cursor/hooks.json`). We
do not write it and we have not tested our handler against it.

`fimemory install-rules --list-hosts` prints all of this for your machine: which
hosts are detected, where each keeps its rules file, and the per-host hook
reason with its source.

### Why the rule block is the part that matters

`install-mcp` gives your assistant the ability to read the store.
`install-rules --mode shim` is what makes it read the store *without being
asked*, by injecting the relevant notes ahead of your prompt. In our own
measurements that costs a fraction of what letting the assistant search the
store through tool calls costs. Without it, the tools are present and mostly
idle.

The shim wording is written only into a file that is read *exclusively* by hosts
where the retrieval hook actually runs, which today means Claude Code on a
machine without Grok CLI. Every other file gets the search-first block instead,
the wording that tells those assistants to call `fimemory_search` themselves,
since nothing is injected for them. Install Grok CLI and `~/.claude/CLAUDE.md`
drops back to the search-first wording on the next `setup`, because Grok reads
that file too.

## When something looks wrong

`fimemory doctor` checks the store mode, the key sources, the MCP registration
in each host config, the rule blocks, the retrieval hook, the catalog index and
when the store was last read. It names what is missing and what to do about it,
and exits non-zero when something is actually broken. A store whose index is
missing or does not list notes that are on disk is a failure, not a warning:
search reads the index, so a blind index means an assistant quietly finds
nothing.

## Encryption at rest (the default)

New stores are sealed with XChaCha20-Poly1305 behind an Argon2id passphrase,
and a 24-word recovery phrase prints once at creation (`fimemory encrypt`
brings an older or `--plaintext` store into the same state). Lose both the
passphrase and that phrase and the data is gone, by design. There is no
account and no reset, which is exactly why the phrase matters.

Tools open the store with `GESTALT_PASSPHRASE`. Set it the way your own shell
wants it:

```
$env:GESTALT_PASSPHRASE = 'your passphrase here'          # PowerShell
set "GESTALT_PASSPHRASE=your passphrase here"             # cmd.exe
GESTALT_PASSPHRASE='your passphrase here' fimemory list   # macOS, Linux
```

One unlock keeps commands fast for about 8 hours (`sessionKeyCacheTtlHours`,
0 disables it). `fimemory lock` ends it early.

The day-2 truth, so nothing surprises you: when that window expires and no
passphrase is in the environment, CLI commands ask again, MCP tools answer
every call with a clear "store is locked" error that names the fix (set
`GESTALT_PASSPHRASE` where the tool runs, or `fimemory unlock` in any
terminal; a running server picks the unlock up on its next call, no
restart), and the per-prompt retrieval hook stays silent rather than blocking
your prompt. `fimemory doctor` is what names THAT state out loud. GUI apps
(Claude Desktop and friends) read the OS user environment, not your shell
profile, so put the variable where the desktop session sees it.

Honesty about the boundary: once your store is unlocked, a connected MCP client
has read access equivalent to a filesystem tool. That is true of every memory
MCP; we say it plainly.

## Uninstall

One command per layer, and each one touches only what its installer wrote:

```
fimemory uninstall-mcp      # remove the MCP entry from every host config
fimemory uninstall-rules    # remove the memory rule block, nothing else in the file
fimemory uninstall-hooks    # remove our two handlers from Claude Code's settings
```

There is no single teardown verb yet, so `uninstall-mcp` prints the other two
commands and the whole back-out stays on one screen.

`uninstall-mcp` is the same scan as `install-mcp` with an empty substitution:
same hosts, same files, same rule that a host's config directory decides whether
it is installed. It deletes our entry and nothing else. A config it cannot parse
is refused and left byte-identical rather than rewritten, and refusing is exit 1,
so `fimemory uninstall-mcp && rm -rf ~/.fimemory` stops instead of continuing.
A host with nothing of ours in it is a success and exits 0.

Claude Code is symmetric with the install: we print
`claude mcp remove fimemory -s user` and read `~/.claude.json` read-only, purely
to tell you whether an entry is registered there.

### Passphrase ordering, before you remove anything

If you ever ran `install-mcp --env-passthrough GESTALT_PASSPHRASE`, the
passphrase to your encrypted store is sitting in those host config files in
plain text. Removing our entry deletes it with the entry, and for some people
that config file is the only copy that exists. So the order matters in both
directions:

- **Keeping the store:** make sure you can still open it, with a passphrase you
  remember or your 24-word recovery phrase, BEFORE you remove anything. Run
  `fimemory uninstall-mcp --dry-run` first. It names the environment variables
  it would remove, never their values, and writes nothing at all.
- **Discarding the store:** remove the config first, then the store folder. That
  order is the right one, and it leaves no passphrase lying in a config file.
- Claude Code's own binary states that `claude mcp remove` permanently deletes
  the server config including env vars and headers, so the printed command takes
  those values with it too.

The store itself is your folder, so removing it is removing a directory:
`~/.fimemory` (or `~/.gestalt` on an install that predates the rename), or
wherever you pointed `--home`. Export first if you want to
keep the notes.

## Your files, your exit

`fimemory export --plaintext <dir>` writes every note, log, and suggested
edit as plain Markdown outside the store. The escape hatch is real, and it
works on day one.

## Naming note

Everything user-facing is `fimemory`: the command, the MCP server key, and the
tool ids (`fimemory_search`, `fimemory_get`, ...). Installs that predate the
rename keep working: a store at `~/.gestalt`, `GESTALT_*` environment
variables, and an old `gestalt` MCP entry are all still detected and honoured.

## License

Source-available under **FSL-1.1-ALv2** (see [LICENSE.md](./LICENSE.md)).
Free to use and modify. You may not sell it or run it as a competing
service. Each version becomes Apache-2.0 two years after its release.
