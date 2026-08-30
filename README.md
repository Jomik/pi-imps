# pi-imps

Lightweight subagent orchestration for [pi](https://github.com/mariozechner/pi-coding-agent). Summon background agents, collect their results, done.

## Installation

```bash
pi install npm:pi-imps
```

Or try it without installing:

```bash
pi -e npm:pi-imps
```

## Why

You're working in pi and need to run multiple tasks in parallel — review code while building, research while implementing, test from several angles at once. pi-imps gives the LLM four tools (`summon`, `wait`, `dismiss`, `list_imps`) and gets out of the way. No dashboards, no delegation nag systems, no config ceremony.

## How it works

The LLM summons **imps** — isolated background agent sessions that run tasks independently. Each imp gets a generated name, works silently, and reports back when collected.

<!-- TODO: add a GIF showing summon → wait → result flow -->

The LLM calls `summon` to launch imps, `wait` to collect results, and the output streams live in the tool call UI.

### Tools

| Tool | What it does |
|------|-------------|
| `summon` | Launch a background imp. Requires a named `agent`. Returns immediately with a name. |
| `wait` | Block until imps finish. `mode: "all"` waits for everything; `mode: "first"` returns the first to complete. Optional `names` array to target specific imps. |
| `dismiss` | Kill running imps by name or `"all"`. |
| `list_imps` | Check status without blocking. |

### Agents

Imps can use **named agents** — markdown files with a system prompt and optional configuration in YAML frontmatter. Place them in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local). Project-local agents override same-named global agents.

```markdown
---
name: reviewer
description: Security review specialist
model: claude-sonnet-4.6
tools: read, bash, grep
---
You are a security reviewer. Focus on authentication, authorization, and input validation...
```

| Field | Required | Description |
|-------|----------|-------------|
| `description` | yes | Shown to the LLM in the available agents list |
| `name` | no | Override the filename-derived agent name |
| `model` | no | Model to use. Omit to inherit the parent session's model |
| `tools` | no | Restrict which tools the agent can use. Omit to fall back to the global `toolAllowlist`, or all tools if no global allowlist is set |
| `turns` | no | Per-agent turn limit (minimum 2). Overrides the global `turnLimit` setting |

### Tool allowlist

Control which tools imps have access to at two levels:

- **`~/.pi/agent/imps.json`**: default for all imps
- **Agent frontmatter**: per-agent override

```json
{
  "toolAllowlist": ["read", "edit", "bash", "write"]
}
```

This is the default for all imps. An agent's `tools` frontmatter overrides it — so a specific agent can have broader or narrower access than the default. Absence means all tools; an empty list means no tools.

When a tool allowlist is active, extensions that provide no allowed tools are **excluded entirely** — no prompt injection, no event hooks, nothing. If you need a tool-less extension on imp sessions (e.g. logging, analytics), add it to `additionalExtensions`.

### Additional extensions

Some extensions should always load on imp sessions regardless of the tool allowlist — permission systems, sandboxing, audit logging. Configure in `~/.pi/agent/imps.json`:

```json
{
  "additionalExtensions": ["pi-sandbox"]
}
```

Agent frontmatter cannot override additional extensions.

### Commands

#### `/imps tools <agent-name>`

Open an interactive TUI to manage per-project additive tool grants for a named agent.

```
/imps tools mason
```

The agent name autocompletes from discovered agents. Unknown subcommands or agent names show concise usage guidance.

The picker shows two side-by-side searchable columns. Tools already enabled by the agent's frontmatter `tools` are hidden from both columns.

**Granted** — tools currently granted to this agent. Global grants (from `~/.pi/agent/imps.json`) show `global` and are read-only. Project grants (from `.pi/imps.json`) can be removed with Enter.

**Available** — registered tools not yet granted. Press Enter to grant a tool to the project config.

Each move is persisted immediately to `.pi/imps.json` and affects subsequently summoned imps. Tools already present in `.pi/imps.json` that are not currently registered in the session are preserved on every write.

| Key | Action |
|-----|--------|
| `← →` or `Tab` | Switch active column |
| `↑ ↓` or type | Navigate / search within column |
| `Enter` or `Space` | Move selected tool to other column |
| `Esc` | Close |

> **Project grants are additive.** Removing a project grant cannot revoke access provided by the agent's frontmatter `tools` or global settings. The TUI only edits `.pi/imps.json`. Project grants also have no effect when the agent's base already allows all tools (no frontmatter `tools` and no global `toolAllowlist`).

Requires interactive mode (TUI). Not available in print or RPC mode.

### Turn limit

A safety net to prevent runaway imps. Default: **30 turns**. The imp works normally until its final turn, when it receives a directive to wrap up. After that turn, the session ends with a `truncated` status so the LLM knows the imp was cut off.

The limit is a circuit breaker, not a budget. If an imp hits it, the task was too broad or under-specified — decompose it or tighten the prompt rather than raising the limit.

### Imp status

Each imp has a status visible in `wait` and `list_imps` results:

| Status | Meaning |
|--------|---------|
| `running` | Still working |
| `completed` | Finished successfully |
| `failed` | Errored out (error message included) |
| `truncated` | Hit the turn limit and was cut off |
| `dismissed` | Killed via `dismiss` |

### No recursion

Imps are leaf workers. They cannot summon sub-imps — pi-imps is not loaded on imp sessions. Only the parent session orchestrates.

## Settings reference

All settings are optional. Create `~/.pi/agent/imps.json` to configure pi-imps:

```json
{
  "$schema": "https://github.com/Jomik/pi-imps/blob/main/imps.schema.json",
  "turnLimit": 30,
  "toolAllowlist": ["read", "edit", "bash", "write", "web_search"],
  "additionalExtensions": ["pi-sandbox"],
  "agents": {
    "mason": { "tools": ["run_tests"] }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `turnLimit` | number | 30 | Max turns per imp (minimum 2) |
| `toolAllowlist` | string[] | all tools | Default tool allowlist for all imps. Overridden by agent frontmatter `tools`. |
| `additionalExtensions` | string[] | none | Extensions that always load on imp sessions regardless of tool filtering |
| `agents` | object | none | Per-agent additive tool grants. Keys are agent names. Tools are unioned with the effective base allowlist: agent frontmatter `tools` when present, otherwise global `toolAllowlist`. |

### Project config

A project-level `.pi/imps.json` in the project root supports the same `agents` format. Tool grants from project config are additive — they are unioned with any grants from the global config, not overriding them. This lets projects grant access to project-specific tools (e.g. `run_tests`) without modifying global agent definitions.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification — principles, API surface, scoping rules, and implementation details.
