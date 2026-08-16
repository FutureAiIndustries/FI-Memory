# FIMemory — Claude Code plugin

Local-first shared memory for AI tools, as a one-command plugin install.
The plugin bundles what `fimemory install-rules --mode shim` wires by hand:

- **MCP server** (`fimemory` — tools `fimemory_search` / `fimemory_get` /
  `fimemory_log` …) for explicit reads and writes.
- **Prompt-time retrieval hooks** (`UserPromptSubmit` + `SessionStart` →
  `fimemory hook-retrieve`): relevant store context is injected *before* the
  model answers, marked ALREADY-RETRIEVED, so agentic search loops become
  unnecessary. Measured on our 15-probe battery: agentic-grade correctness
  (14/15) at 39% lower cost than tool-loop retrieval.

## Install

```bash
npm install -g fimemory          # the runtime + CLI (the hooks call this bin)
fimemory init                    # create the store (~/.fimemory)
```

Then in Claude Code:

```
/plugin marketplace add <org>/<export-repo>     # final URL set at launch
/plugin install fimemory@futureindustries
```

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

## Pre-publish checklist (OPEN — verify before this plugin ships)

- [ ] **Tool-id surface under plugin namespace**: the host may prefix plugin MCP
  tools, so `fimemory_search` can reach the model as
  `mcp__plugin_fimemory_fimemory__fimemory_search`. The §2.5b rule block names
  bare `fimemory_*` ids, so under the plugin the names the block tells the model
  to call are not the names the model is offered. Measure it under the plugin
  prefix before the plugin becomes a primary install path — this is the same
  failure mode as a stale rules block, and it does not announce itself: the
  model is simply told to call a tool it cannot see.
  **2026-08-06:** the ids moved `gestalt_*` → `fimemory_*`, so any prefix
  measurement taken before that date is against a surface that no longer
  exists.
- [ ] **Double-hook dedupe**: a user with `install-rules --mode shim` hooks in
  `settings.json` AND this plugin would inject twice. Doctor must detect the
  `--shim-id fimemory-v1` marker in both surfaces and warn; consider an
  `install-rules --rules-only` flag for plugin users.
- [ ] **Rules body**: the plugin cannot write the §2.5b CLAUDE.md block; decide
  whether SessionStart inject alone carries enough framing or the README
  instructs a one-time `fimemory install-rules --rules-only`.
- [ ] Cold-install smoke on a clean machine: npm → plugin → first prompt
  injects within budget.
