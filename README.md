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
| `summon` | Launch a background imp. Requires a named `agent` and a task description (minimum 10 characters). Returns immediately with a name. |
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
| `thinking` | no | Thinking level to use (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omit to inherit the parent session's thinking level. `max` is mapped to `xhigh` at the SDK boundary after resolution, whether it came from agent frontmatter or was inherited from the parent. |
| `tools` | no | Restrict which tools the agent can use. Omit to fall back to the global `toolAllowlist`, or all tools if no global allowlist is set |
| `turns` | no | Per-agent turn limit (minimum 2). Overrides the global `turnLimit` setting |

Agent definitions are validated at startup and on reload; invalid files are skipped and reported in a single warning, and unknown extra frontmatter keys are allowed.

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

#### `/imps tools [agent-name]`

Inspect and manage the selected agent's tool access — including per-project additive tool grants — through an interactive TUI flow. Requires the interactive TUI; it is unavailable in RPC, print, and JSON modes, where no host UI exists — the command returns immediately without querying Armory or changing config.

```
/imps tools mason
/imps tools
```

The agent name autocompletes from discovered agents and is optional. When omitted, an agent selector dialog lists all discovered agent names sorted alphabetically; cancelling it exits, and if no agents are discovered the command reports that and exits. Unknown subcommands and extra trailing arguments show usage guidance; an unknown explicit agent name produces an explicit warning.

The first selection offers:

- **List granted tools** — a dialog listing every currently registered tool the agent would receive if summoned now, sorted by name, with all applicable source badges (`agent`, `default`, `global`, `project`). Reports a concise empty state when no tools would be granted.
- **Grant project tools** — queries `pi-armory` (via extension `pi.events`) fresh for this project's configured Armory tool names, then offers project Armory tools that are registered in the parent session and not already available to the agent via frontmatter `tools`, the default allowlist, or global/project grants. If Armory isn't installed or is incompatible, or if it's installed but the project has no configured tools, a dialog reports which case applies and returns to the menu. Candidates are presented in a searchable toggle-list; toggling a row on grants it immediately.
- **Remove project grants** — pick from every current project grant, including stale or currently unregistered names, so obsolete grants remain removable, presented in a searchable toggle-list. Options show any `agent`, `default`, or `global` sources that will keep providing access after the project grant is removed. Toggling a row removes it immediately.
- **Done** — close.

Both **Grant project tools** and **Remove project grants** open a searchable toggle-list dialog (pi's native `SettingsList`): type to filter the list, use the arrow keys to navigate, and press Enter or Space to toggle the highlighted row. Each toggle is written to `.pi/imps.json` immediately as its own atomic update and affects subsequently summoned imps right away — there is no staged selection and no separate apply step. A row can be toggled back and forth during the same open screen (granted/ungranted on the Grant screen, removed/kept on the Remove screen), and each direction persists on its own. Escape closes the screen; it does not undo toggles already applied. Removing a project grant removes only that source; access from another source is unaffected. Existing settings for other agents and unrecognized tool names are preserved. A write failure reverts the row to its prior value, reports the error, and leaves the dialog open — it does not overwrite the existing config or crash the command.

> **Project grants are additive.** Removing a project grant cannot revoke access provided by `agent`, `default`, or `global` sources. Project grants also have no effect when the agent's base already allows all tools (no frontmatter `tools` and no global `toolAllowlist`).

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

### Orca-backed imps (optional)

By default, `summon` runs imps in-process, in the same Pi process as the parent session. Enable Orca-backed imp execution by setting `orca.enabled` in the **global** `~/.pi/agent/imps.json`:

```json
{ "orca": { "enabled": true } }
```

Default is `false` (local in-process mode). This only affects *how* a summoned imp runs — the `summon`, `wait`, `dismiss`, and `list_imps` tool schemas and behavior seen by the LLM are unchanged either way.

When enabled, each summoned imp runs as an Orca-dispatched worker in its own terminal in the **current worktree** — local POSIX hosts only (`darwin`/`linux`). There is no remote launch, no Windows support, and pi-imps never creates or merges a child worktree. Multiple imps can run concurrently, each in its own terminal; internally, each session still has exactly one orchestration run and one mailbox consumer per pi-imps session, regardless of how many imps are active.

If Orca is unavailable, reports no current worktree, or the platform is unsupported, `summon` fails explicitly — the imp comes back with a `failed` status and an actionable error. There is no silent fallback to local in-process spawning.

Each Orca-dispatched imp is a controlled worker with the same effective configuration as an in-process imp: the same resolved model, thinking level, system prompt, and turn limit, and the same resolved tool allowlist/extensions (including `additionalExtensions`, which always load regardless of the tool allowlist — same semantics as local imps). It's launched with `--no-extensions --no-skills --no-prompt-templates --no-themes` plus only those resolved extension paths, with the resolved model, thinking level, and turn limit passed explicitly as CLI arguments, and with `--is-imp`, which puts it into a restricted worker mode without summon/wait/dismiss/list_imps or agent discovery. The system prompt itself is written verbatim to a 0600 file inside a uniquely named 0700 temp directory, and only that file's absolute path — never the prompt content — is passed to `--system-prompt` and appears in the terminal command; the temp file is removed as soon as the terminal reports the Pi TUI is idle (i.e. Pi has loaded it), or immediately on any earlier launch failure. `--tools` is passed unchanged only when an explicit tool allowlist was resolved. Orca's injected worker preamble (identifiers, capability token, coordinator instructions) is scrubbed before the model ever sees the prompt.

Completion follows the same terminal-assistant semantics as local imps: a normal non-empty final response reports `completed`; provider stop reasons `error`, `aborted`, or `length`, and empty final responses, report `failed`. Turn-limit enforcement also matches local imps: the same final-turn wrap-up directive is sent, and a limit-triggered cutoff always reports `truncated`.

Every terminal pi-imps creates for an Orca-dispatched imp is explicitly closed when that imp completes, is dismissed, or the session ends — cleanup isn't left to Orca's `worker-release` alone (which does not close the terminal by itself).

**Known limitation:** Orca workers currently expose no token/turn telemetry over the orchestration protocol, so `list_imps`/`wait` stats for Orca-dispatched imps stay at zero or unavailable. This means missing telemetry, not that the imp actually used zero turns or tokens.

**Host integration extensions:** Any globally-installed extension whose top-level directory entry under `~/.pi/agent/extensions/` has a basename starting with `orca-` is always explicitly loaded for Orca-dispatched workers (in addition to the resolved tool/`additionalExtensions` extensions above), regardless of the resolved tool allowlist. This is separate from `additionalExtensions`: it is not configured in `imps.json`, it isn't restricted to the current agent or project, and it can't be disabled per-agent. It exists so Orca host-status/prefill/title integrations can attach to a worker unconditionally, without every project or agent needing to opt in via `additionalExtensions`.

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
  },
  "orca": { "enabled": false }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `turnLimit` | number | 30 | Max turns per imp (minimum 2) |
| `toolAllowlist` | string[] | all tools | Default tool allowlist for all imps. Overridden by agent frontmatter `tools`. |
| `orca.enabled` | boolean | `false` | Run summoned imps as Orca-dispatched workers in the current worktree instead of in-process. Requires a local POSIX host (darwin/linux) and an available Orca with a current worktree; see [Orca-backed imps](#orca-backed-imps-optional). |
| `additionalExtensions` | string[] | none | Extensions that always load on imp sessions regardless of tool filtering |
| `agents` | object | none | Per-agent additive tool grants. Keys are agent names. Tools are unioned with the effective base allowlist: agent frontmatter `tools` when present, otherwise global `toolAllowlist`. |

### Project config

A project-level `.pi/imps.json` in the project root supports the same `agents` format. Tool grants from project config are additive — they are unioned with any grants from the global config, not overriding them. This lets projects grant access to project-specific tools (e.g. `run_tests`) without modifying global agent definitions.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification — principles, API surface, scoping rules, and implementation details.
