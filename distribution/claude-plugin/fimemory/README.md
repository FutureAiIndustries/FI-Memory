# FIMemory — Claude Code plugin

Local-first shared memory for AI tools. The plugin carries the **prompt-time
retrieval hooks** (`UserPromptSubmit` + `SessionStart` → `fimemory
hook-retrieve`): relevant store context is injected *before* the model
answers, marked ALREADY-RETRIEVED, so agentic search loops become
unnecessary. In our own measurements that costs a fraction of what tool-loop
retrieval costs.

The plugin deliberately does **not** register the MCP server. `fimemory
setup` writes the MCP entry into each host's own config, which is the
measured surface — the tools reach the model under their bare `fimemory_*`
ids, exactly as the rules block names them. (A plugin-registered server can
surface under a host-prefixed name the rules never mention; bundling one here
would ship a second, unmeasured install path.)

## Install

```bash
npm install -g fimemory     # the runtime + CLI — the hooks call this bin
fimemory setup              # store + MCP + rules (+ hooks; see note below)
```

Then in Claude Code:

```
/plugin marketplace add FutureAiIndustries/FI-Memory
/plugin install fimemory@futureindustries
```

**If you ran `fimemory setup`, the retrieval hook already exists in
`~/.claude/settings.json`, and the plugin adds a second copy.** That is safe:
since 0.3.1 `hook-retrieve` dedupes per (session, prompt) — the first
invocation injects, the second exits empty — so two surfaces never double
your context cost. Keep the plugin copy if you prefer hooks managed by the
plugin system; keep the settings.json copy if you also use hosts that have no
plugin manager. Either alone works; both together is fine.

## Encrypted stores

The store passphrase is **machine-local only**. Set `GESTALT_PASSPHRASE` in
your OS user environment (never in chat, never in synced dotfiles, never in
plugin config), or run `fimemory unlock` per TTL window. When the store is
locked the hook **fails open**: empty inject, exit 0, your prompt is never
blocked. `fimemory doctor` audits hook health and the last inject.

## Fail-open guarantees (design invariants)

- Hook self-caps at ~300 ms; missing store / locked store / any error →
  exit 0 with empty output. The worst case is "no memory", never "Claude broken".
- Hooks never exit 2 (prompt-block) — forbidden for a memory shim.
- Empty retrieval injects nothing (no "store empty" noise).
- The double-hook guard fails open too: if its marker directory is unusable,
  retrieval proceeds — a duplicated injection is a cost, a starved one is a
  broken product.

## Status of the 0.3.0 hold items

The plugin was deliberately held out of the 0.3.0 launch on four findings.
Where they stand as of 0.3.1:

- **Prefixed tool ids** — resolved by removal: the plugin no longer registers
  an MCP server, so the only tool surface is the one `setup` writes, under
  the bare ids the rules name.
- **PATH bin sequencing** — resolved by the 0.3.0 npm publish: `fimemory` is
  a real global bin. A plugin installed *without* it fails open on every
  prompt (empty inject); the install steps above put the bin first.
- **Double-hook** — resolved structurally: `hook-retrieve` dedupes per
  (session, prompt) with an exclusive tmp marker (0.3.1).
- **Cold-install smoke** (npm → plugin → first prompt injects within budget)
  — **still open**; run it on a clean machine before recommending the plugin
  as the primary install path. Rules framing note: the plugin does not write
  the CLAUDE.md rules block; `fimemory setup` (or `install-rules`) does.
