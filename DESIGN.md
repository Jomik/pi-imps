# pi-imps Design

## Problem

Orchestrating multiple isolated agent sessions from a single parent session is useful — parallel research, divide-and-conquer implementation, review alongside building. But existing solutions over-engineer the problem with dashboards, analytics, delegation nag systems, config ceremony, and TUI widgets that belong in separate extensions.

We need a small, composable primitive: summon an agent, get its result, done.

## Principles

1. **Minimal core** — summon, wait, dismiss. Everything else is optional or external.
2. **Zero config** — sensible defaults, no settings files. Agent frontmatter is the only configuration surface.
3. **Composable** — other extensions can build on top. Don't bake in observability chrome, custom renderers, or delegation strategies.
4. **No recursion** — imps are leaf workers. Only the parent session spawns imps. Enforced by not loading pi-imps on child sessions — imp tools are never registered, nothing to filter out.
5. **Quiet** — no injected messages, no delegation reminders, no rotating hints. The LLM decides when to delegate based on its system prompt.

## Core API Surface

### Tools (LLM-callable)

#### `summon`

Summon an imp. Returns immediately with a generated name. Non-blocking — the imp runs in the background.

```
summon({
  task: string,           // what the imp should do
  agent?: string,         // named agent, or ephemeral
}) → { name: string }
```

The LLM can call `summon` multiple times (including parallel tool calls) to launch several imps, then collect results with `wait`.

No auto-delivery — the LLM must explicitly call `wait` to collect results. If it never waits, results are visible via `list_imps` but not injected into context.

#### `wait`

Block until imps complete. Streams live progress into the tool call UI via `AgentToolUpdateCallback` — the user sees imp activity (tool calls, turns, status) in real time without extra widgets.

```
wait({
  mode: "all" | "first",  // all: wait for every imp, first: return when any completes
  names?: string[],        // optional: wait for specific imps only (default: all uncollected)
}) → result(s)
```

`all` = Promise.all — wait for everything, return all results.
`first` = Promise.race — return the first imp to complete, others keep running.

When `names` is provided, `wait` targets only those imps. When omitted, it targets all uncollected imps in the current session. Collected imps are removed from the session — subsequent `wait` calls skip them.

`wait` is chainable. After `wait({ mode: "first" })` returns one result, call `wait` again to collect the rest.

Imp failures are returned as results with `failed` status, not thrown exceptions. The LLM sees which imps succeeded and which failed (with error message) and decides how to proceed. If no uncollected imps exist, `wait` returns an empty result.

The result payload is the imp's final assistant message — no summarization or truncation. The delegator controls verbosity through its task description (e.g. "summarize briefly" vs "full analysis").

#### `dismiss`

Dismiss running imp(s). Useful after `wait({ mode: "first" })` to kill remaining imps.

```
dismiss({
  name: string,           // imp name or "all"
})
```

#### `list_imps`

List running and recently completed imps with status and basic stats.

### Scoping

All imp state is session-scoped. `wait`/`dismiss`/`list_imps` only see imps from the current session. Session switch or shutdown dismisses all running imps.

### Agent Discovery

Scan global (`~/.pi/agent/agents/`) and project-local (`.pi/agents/`) directories for agent `.md` files with YAML frontmatter.

### System Prompt

Available agents are injected into the system prompt at session start, matching pi's pattern for skills (XML block).

### Footer

Running imp count in the status line. Minimal — just the count.

### Imp Sessions

Ephemeral, in-memory, no persistence. Ephemeral imps inherit the parent's model; named agents use their frontmatter model.

### Tools

Configurable at two levels:

- **Settings**: default tool allowlist for all imps
- **Agent frontmatter**: per-agent override

Absence means all tools. Empty list means no tools.

At summon time, pi-imps resolves the allowlist and filters extensions accordingly — extensions that provide no allowed tools are excluded entirely (no prompt injection, no event hooks, no tools). Core pi tools (read, edit, bash, write) follow the same rule: available unless explicitly excluded.

**Additional extensions** (settings-only) always load on imp sessions regardless of the tool allowlist. Use for permission systems, sandboxing, logging, or other extensions that must not be filtered out. Agent frontmatter cannot override this.


### Turn Limit

A global safety net to prevent runaway imps. Default: 30 turns. Configurable in settings, not per-summon.

The imp is unaware of the limit. It works normally until the final turn, when a directive is injected:

> FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.

After that turn the session ends. The result returned to the delegator carries a `truncated` status (distinct from `completed` or `failed`), so the LLM knows the imp was cut off and can decide whether to re-delegate the remainder.

The limit is a circuit breaker, not a budget. It exists to catch genuine runaways — loops, wrong approaches, hallucination spirals — not to manage workflow. If a task legitimately needs more than 25 turns, it should be decomposed into smaller subtasks.
### Names

Generated per imp, recycled when freed.

