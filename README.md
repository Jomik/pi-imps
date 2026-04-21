# pi-imps

Lightweight subagent orchestration for [pi](https://github.com/mariozechner/pi-coding-agent). Summon background agents, collect their results, done.

## Why

You're working in pi and need to run multiple tasks in parallel — review code while building, research while implementing, test from several angles at once. pi-imps gives the LLM three tools (`summon`, `wait`, `dismiss`) and gets out of the way. No dashboards, no delegation nag systems, no config ceremony.

## How it works

The LLM summons **imps** — isolated background agent sessions that run tasks independently. Each imp gets a generated name, works silently, and reports back when collected.

```
┌ summon({ task: "research auth best practices for Node.js APIs", agent: "explorer" })
└ Summoned kevin (explorer)

┌ summon({ task: "review src/auth.ts for security issues", agent: "researcher" })
└ Summoned stuart (researcher)

┌ wait({ mode: "all" })
│ kevin (explorer):    ✓ 3 turns, 12.4k tokens
│ stuart (researcher): → read src/auth.ts
```

Lines update in real time as imps work. When all finish, the LLM gets their full output and decides what to do next.

### Tools

| Tool | What it does |
|------|-------------|
| `summon` | Launch a background imp. Returns immediately with a name. |
| `wait` | Block until imps finish. `mode: "all"` waits for everything; `mode: "first"` returns the first to complete. |
| `dismiss` | Kill running imps by name or `"all"`. |
| `list_imps` | Check status without blocking. |

### Agents

Imps can use **named agents** — markdown files with a system prompt and optional configuration in YAML frontmatter. Place them in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local).

```markdown
---
description: Security review specialist
model: claude-sonnet-4.6
tools: read, bash, grep
---
You are a security reviewer. Focus on authentication, authorization, and input validation...
```

The `tools` field restricts which tools the agent can use. Omit it to allow all tools.

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

```json
"pi-imps": {
  "turnLimit": 30
}
```

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
