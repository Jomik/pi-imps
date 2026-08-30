# pi-imps Design

## Problem

Orchestrating multiple isolated agent sessions from a single parent session is useful — parallel research, divide-and-conquer implementation, review alongside building. But existing solutions over-engineer the problem with dashboards, analytics, delegation nag systems, config ceremony, and TUI widgets that belong in separate extensions.

We need a small, composable primitive: summon an agent, get its result, done.

## Principles

1. **Minimal core** — summon, wait, dismiss. Everything else is optional or external.
2. **Low config** — sensible defaults, minimal setup. Configuration lives in `~/.pi/agent/imps.json` (optional). Agent frontmatter is the per-agent configuration surface.
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
  agent: string,          // named agent to use
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

In-memory, no persistence. Named agents use their frontmatter model when configured; otherwise they inherit the parent's model.

### Tools

Configurable at three levels:

- **Settings** (`~/.pi/agent/imps.json`): default tool allowlist and per-agent additive tools
- **Agent frontmatter**: per-agent baseline tools
- **Project config** (`.pi/imps.json`): per-agent additive tools scoped to this project

Resolution at summon time:

1. Determine the **base allowlist**:
   - Agent with `tools` in frontmatter → use frontmatter tools
   - Agent without `tools` → use settings `toolAllowlist` (or undefined = all tools)
2. Compute **additive tools**: union of `agents.<key>.tools` from global `imps.json` and project `.pi/imps.json`, where `<key>` is the agent name
3. Merge: if base is undefined (all tools), result is undefined (all tools) — additive tools are redundant since all tools are already available. If base is defined, result is `base ∪ additive`.
4. Filter extensions: exclude any that provide no tools in the final allowlist

Absence of frontmatter `tools` means the imp inherits the same tools as the parent session (no filtering applied). An empty list (`tools: []`) means no tools. Additive tools can only expand the base, never restrict it.

If a tool name in the config doesn't correspond to a registered tool, it's silently ignored — the imp simply doesn't get that tool. (Future: surface a warning to the user.)

**Additional extensions** (global `imps.json` only, `additionalExtensions` key) always load on imp sessions regardless of the tool allowlist. Use for permission systems, sandboxing, logging, or other extensions that must not be filtered out. Agent frontmatter and project config cannot override this.

#### Project-level imps.json

Project config lives at `.pi/imps.json` (project root). Both project and global `~/.pi/agent/imps.json` can contain an `agents` object with per-agent tool grants. Their `tools` arrays are unioned (not overridden) — if global grants `["a"]` and project grants `["b"]`, the agent gets both.

```json
{
  "agents": {
    "mason": { "tools": ["run_tests", "run_checks"] },
    "sentinel": { "tools": ["run_tests", "run_checks"] }
  }
}
```

This allows projects to grant agents access to project-specific tools (e.g. armory tools like `run_tests`) without modifying global agent definitions.

#### Project tool grants UI

The `/imps tools <imp-name>` TUI command provides a simpler way to manage project-level additive tool grants. The imp-name argument offers completion from discovered agents. Missing or unknown names produce usage guidance rather than opening another selection step.

The picker shows two side-by-side searchable columns: **Granted** and **Available**. It lists tools currently registered in the parent pi session that are not already enabled by the selected agent's frontmatter `tools`; search uses the TUI's built-in fuzzy matching. Project grants can move between columns. Tools granted by global pi-imps settings appear in **Granted** as read-only entries unless they are already hidden by frontmatter. The picker does not otherwise classify tools by registration source or depend on pi-armory configuration details.

Left/right arrows or Tab change the active column, up/down arrows navigate it, and Enter or Space moves the selected tool to the other column. Escape closes the picker. The layout truncates tool names as needed on narrow terminals rather than switching to a separate responsive layout. The UI states that project grants are additive: removing a project grant cannot remove access provided by another scope, and project grants have no effect when the agent's base already allows all tools.

Each project-grant change is persisted to the project config and affects subsequently summoned imps. Existing settings for other agents and unrecognized tool names are preserved. If the existing config cannot be read or parsed, the command reports the error and does not overwrite it.

The first version does not edit global settings or agent frontmatter, show complete effective merged permissions, identify pi-armory tool provenance, provide bulk grants, or add persistent UI.


### Turn Limit

A global safety net to prevent runaway imps. Default: 30 turns. Configurable in settings, not per-summon.

The imp is unaware of the limit. It works normally until the final turn, when a directive is injected:

> FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.

After that turn the session ends. The result returned to the delegator carries a `truncated` status (distinct from `completed` or `failed`), so the LLM knows the imp was cut off and can decide whether to re-delegate the remainder.

The limit is a circuit breaker, not a budget. It exists to catch genuine runaways — loops, wrong approaches, hallucination spirals — not to manage workflow. If an imp hits the limit, the task was too broad or under-specified; decompose it or tighten the prompt rather than raising the limit.
### Names

Generated per imp, recycled when freed.

