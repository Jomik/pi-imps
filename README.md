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
| `summon` | Launch a background imp. Returns immediately with a name. |
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
| `tools` | no | Restrict which tools the agent can use. Omit to allow all tools |

Ephemeral imps (summoned without an `agent` name) inherit the parent session's model.

### Tool allowlist

Control which tools imps have access to at two levels:

- **Settings** (`~/.pi/agent/settings.json`): default for all imps
- **Agent frontmatter**: per-agent override

```json
"pi-imps": {
  "toolAllowlist": ["read", "edit", "bash", "write"]
}
```

This is the default for all imps. An agent's `tools` frontmatter overrides it — so a specific agent can have broader or narrower access than the default. Absence means all tools; an empty list means no tools.

When a tool allowlist is active, extensions that provide no allowed tools are **excluded entirely** — no prompt injection, no event hooks, nothing. If you need a tool-less extension on imp sessions (e.g. logging, analytics), add it to `additionalExtensions`.

### Additional extensions

Some extensions should always load on imp sessions regardless of the tool allowlist — permission systems, sandboxing, audit logging. Configure these in settings:

```json
"pi-imps": {
  "additionalExtensions": ["pi-sandbox"]
}
```

Agent frontmatter cannot override additional extensions.

### Turn limit

A safety net to prevent runaway imps. Default: **30 turns**. The imp works normally until its final turn, when it receives a directive to wrap up. After that turn, the session ends with a `truncated` status so the LLM knows the imp was cut off.

The limit is a circuit breaker, not a budget. If a task needs more than 25 turns, decompose it.

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

All settings are optional. Add a `"pi-imps"` key to `~/.pi/agent/settings.json`:

```json
"pi-imps": {
  "turnLimit": 30,
  "toolAllowlist": ["read", "edit", "bash", "write", "web_search"],
  "additionalExtensions": ["pi-sandbox"]
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `turnLimit` | number | 30 | Max turns per imp (minimum 2) |
| `toolAllowlist` | string[] | all tools | Default tool allowlist for all imps. Overridden by agent frontmatter `tools`. |
| `additionalExtensions` | string[] | none | Extensions that always load on imp sessions regardless of tool filtering |

## Design

See [DESIGN.md](./DESIGN.md) for the full specification — principles, API surface, scoping rules, and implementation details.
