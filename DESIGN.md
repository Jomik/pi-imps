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

The terminal assistant outcome is authoritative when the session prompt resolves. Provider errors and assistant stop reasons `error`, `aborted`, or `length` produce `failed` results. Any partial text is preserved alongside the error. A nominally successful terminal response with no text also fails with a diagnostic that includes its stop reason. Model-provided error details are preferred; stable fallback messages are used when none are available, so a failed result's `error` is never empty. Imp turn-limit termination remains `truncated` and takes precedence over model completion status. Thinking content and new completion metadata are not exposed.

When the delegator reports a failed imp's error to the user, it quotes the exact `error` text verbatim rather than paraphrasing it into a generic message. In the TUI, a failed imp's status row is followed by that exact error text as a concise failure reason; a truncated imp's status row is labeled "turn limit reached".

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

Scan global (`~/.pi/agent/agents/`) and project-local (`.pi/agents/`) directories for agent `.md` files with YAML frontmatter. Each file is validated when discovered: read and YAML failures, missing required fields, and invalid values for supported optional fields make that definition invalid. Unknown extra frontmatter fields remain allowed.

Invalid definitions are excluded while valid agents continue loading. Project definitions remain authoritative: an invalid project definition must not silently fall back to a global agent with the same effective name. All discovery problems are aggregated into one human-facing warning with file paths during session startup or reload. Diagnostics are not injected into the system prompt or returned by imp tools.

### System Prompt

Available agents are injected into the system prompt at session start, matching pi's pattern for skills (XML block).

### Footer

Running imp count in the status line. Minimal — just the count.

### Imp Sessions

In-memory, no persistence. Named agents use their frontmatter model when configured; otherwise they inherit the parent's model. Named agents use their frontmatter `thinking` level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) when configured; otherwise they inherit the parent's current thinking level. The host-only `max` value is mapped to `xhigh` at the SDK boundary after agent-or-parent resolution.

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

The `/imps tools [agent-name]` command provides a standard-dialog flow for inspecting and managing tool access in both the interactive TUI and RPC clients such as Paseo. It uses only the host's selection dialogs, not custom terminal UI. It is unavailable in print/JSON modes, where no host UI exists — the handler returns immediately without any query or config side effects. The optional agent-name argument offers completion from discovered agents. When omitted, the command opens an agent selector; cancellation exits. An unknown name produces an explicit warning. If no agents are discovered, the command reports that state and exits.

The first selection offers **List granted tools**, **Grant project tool**, **Remove project grant**, or **Done**. Listing shows every currently registered tool the selected agent would receive if summoned now, sorted by name with all applicable source badges. Access starts from explicit agent-frontmatter tools, otherwise the default global allowlist, otherwise every registered parent-session tool, then adds global and project per-agent grants. Configured names that are not currently registered are excluded because the child session would not receive them.

Granting synchronously queries `pi-armory:project-tools:v1` only when **Grant project tool** is selected. Armory responds exactly once with names read directly from the current project's `.pi/armory.json`; global and session-only Armory tools are excluded, while project names remain present when shadowed by session tools. No response means Armory is absent or incompatible; an empty response means Armory is present but the project config contains no tools. Each query result is consumed immediately and never cached.

Grant candidates are project Armory tools that are currently registered in the parent session and are not already available to the agent from its frontmatter, the default allowlist, or global/project grants. Remove candidates are every current project grant, including stale or currently unregistered names, so obsolete grants remain removable. Removing a project grant removes only that source; access inherited from another source remains unchanged. Remove options show any `agent`, `default`, or `global` sources that will continue providing access after the project grant is removed; grant options need no source badges.

Each change is persisted immediately and affects subsequently summoned imps. Existing settings for other agents and unrecognized tool names are preserved. Missing Armory support and an empty project Armory config produce distinct messages through a standard dialog that RPC clients can display. Read or write failures likewise use a standard dialog and never overwrite invalid config.

The first version does not edit global settings or agent frontmatter, provide bulk grants, add custom search or terminal UI, or add persistent UI.


### Child-Session Error Normalization

Every imp child session registers a hidden inline `tool_result` handler (not a discoverable extension, no LLM-callable tools, survives the tool-allowlist filter). When a tool result is marked `isError` but carries no meaningful content — an empty content array, or only empty/whitespace text — the handler replaces it with a single text block: `Tool "<toolName>" failed without an error message`. Successful results, non-empty text errors, and image-bearing results are left unchanged. This only normalizes what the provider sees; it performs no persistent logging and captures no provider payloads.

### Turn Limit

A global safety net to prevent runaway imps. Default: 30 turns. Configurable in settings, not per-summon.

The imp is unaware of the limit. It works normally until the final turn, when a directive is injected:

> FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.

After that turn the session ends. The result returned to the delegator carries a `truncated` status (distinct from `completed` or `failed`), so the LLM knows the imp was cut off and can decide whether to re-delegate the remainder.

The limit is a circuit breaker, not a budget. It exists to catch genuine runaways — loops, wrong approaches, hallucination spirals — not to manage workflow. If an imp hits the limit, the task was too broad or under-specified; decompose it or tighten the prompt rather than raising the limit.
### Names

Generated per imp, recycled when freed.

