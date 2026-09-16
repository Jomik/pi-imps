# pi-imps Design

## Problem

Orchestrating multiple isolated agent sessions from a single parent session is useful — parallel research, divide-and-conquer implementation, review alongside building. But existing solutions over-engineer the problem with dashboards, analytics, delegation nag systems, config ceremony, and TUI widgets that belong in separate extensions.

We need a small, composable primitive: summon an agent, get its result, done.

## Principles

1. **Minimal core** — summon, wait, dismiss. Everything else is optional or external.
2. **Low config** — sensible defaults, minimal setup. Configuration lives in `~/.pi/agent/imps.json` (optional). Agent frontmatter is the per-agent configuration surface.
3. **Composable** — other extensions can build on top. Don't bake in observability chrome, custom renderers, or delegation strategies.
4. **No recursion** — imps are leaf workers. Only the parent session spawns imps. For ordinary in-process summoned imp sessions, this is enforced by not loading pi-imps on the child session — imp tools are never registered, nothing to filter out. Orca-dispatched workers are launched with the `is-imp` flag set (see Orca Worker Bridge below), which initializes worker mode instead of ordinary pi-imps and never registers summon/wait/dismiss/list_imps in the first place — nothing to filter out, preserving the same leaf-worker invariant.
5. **Quiet** — no injected messages, no delegation reminders, no rotating hints. The LLM decides when to delegate based on its system prompt.
6. **Isolated bridges** — host-specific bridges (e.g. Orca) are selected by an explicit launch flag (`is-imp`) on the single pi-imps entrypoint, never active by default alongside ordinary pi-imps behavior. The main extension has no knowledge of Orca beyond that flag check.

## Core API Surface

### Tools (LLM-callable)

#### `summon`

Summon an imp. Returns immediately with a generated name. Non-blocking — the imp runs in the background.

```
summon({
  task: string,           // what the imp should do (minimum 10 characters)
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

Absence of frontmatter `tools` falls back to the settings `toolAllowlist`. Only when both frontmatter `tools` and the settings `toolAllowlist` are absent does the imp inherit the same tools as the parent session (no filtering applied). An empty list (`tools: []`) means no tools. Additive tools can only expand the base, never restrict it.

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

The `/imps tools [agent-name]` command provides an interactive TUI flow for inspecting and managing tool access. It is unavailable in RPC, print, and JSON modes; those modes return without querying Armory or changing configuration. The optional agent-name argument offers completion from discovered agents. When omitted, the command opens an agent selector; cancellation exits. An unknown name produces an explicit warning. If no agents are discovered, the command reports that state and exits.

The first selection offers **List granted tools**, **Grant project tools**, **Remove project grants**, or **Done**. Listing shows every currently registered tool the selected agent would receive if summoned now, sorted by name with all applicable source badges. Access starts from explicit agent-frontmatter tools, otherwise the default global allowlist, otherwise every registered parent-session tool, then adds global and project per-agent grants. Configured names that are not currently registered are excluded because the child session would not receive them.

Granting synchronously queries `pi-armory:project-tools:v1` only when **Grant project tools** is selected. Armory responds exactly once with names read directly from the current project's `.pi/armory.json`; global and session-only Armory tools are excluded, while project names remain present when shadowed by session tools. No response means Armory is absent or incompatible; an empty response means Armory is present but the project config contains no tools. Each query result is consumed immediately and never cached.

Grant candidates are project Armory tools that are currently registered in the parent session and are not already available to the agent from its frontmatter, the default allowlist, or global/project grants. The TUI presents them as a searchable toggle-list built from pi's native `SettingsList`: Enter or Space toggles the highlighted row, and each toggle is persisted immediately as its own atomic write — there is no staged selection and no separate apply step. A row can be toggled granted/ungranted repeatedly during the same open screen; each direction persists on its own. Remove candidates are every current project grant, including stale or currently unregistered names, so obsolete grants remain removable; they are presented the same way in a second toggle-list, toggled between removed/kept. Remove options show any `agent`, `default`, or `global` sources that will continue providing access after the project grant is removed. Escape closes either screen without undoing toggles already applied.

Each toggle persists all selected additions or removals as they happen and affects subsequently summoned imps immediately. Removing a project grant removes only that source; access inherited from another source remains unchanged. Existing settings for other agents and unrecognized tool names are preserved. Missing Armory support, an empty project Armory config, and a malformed or unreadable project config are reported in the TUI; invalid config is never overwritten. A write failure during a toggle reverts the toggled row to its prior value, reports the error, and leaves the screen open — it does not change the in-memory grant state, overwrite the existing config, or crash the command.

The first version does not support non-TUI clients, edit global settings or agent frontmatter, add persistent UI, or launch and manage external agent hosts such as Orca or Herdr.

### Orca Worker Bridge

When Pi is launched as an Orca-dispatched worker, it must not load ordinary pi-imps. This is the controlled-launch contract `OrcaCoordinator` itself follows when `orca.enabled` is `true` (see Orca Imp Execution above): it creates an Orca terminal in the current worktree running Pi with the main extension manifest disabled, pi-imps' single entrypoint loaded explicitly, and the `is-imp` custom flag set so that same entrypoint initializes worker mode instead of ordinary pi-imps, e.g.:

```
pi --no-extensions -e ./node_modules/pi-imps/src/index.ts --is-imp   # abbreviated/illustrative
```

...then dispatches the task into that already-running terminal. Custom flag values are only available once Pi's CLI has finished parsing, not during extension factory execution, so mode selection happens at the first `session_start` event rather than at load time: `src/index.ts` registers only its custom flags and a single bootstrap `session_start` handler at factory time, then reads the `is-imp` flag from inside that handler. When it is set, that same handler initializes worker mode and returns before registering any ordinary session hooks, tools, or commands — no agent discovery, no summon/wait/dismiss, and no available-agents system-prompt block. Its only responsibilities:

- Register the same hidden inline `tool_result` handler used by ordinary imp child sessions (see Child-Session Error Normalization) so an empty/whitespace-only error result from a tool called inside the worker's own run is replaced with a generic non-empty message. Worker mode exposes no completion tool to the model.
- On Pi's `input` event, verify the full raw input text: the strict injected dispatched-worker preamble must parse, and the parsed worker handle must exactly match `ORCA_TERMINAL_HANDLE`. The input must additionally contain an exact standalone `=== TASK ===` marker line followed by a non-empty task remainder. Any omission or mismatch leaves the input unchanged (`{ action: "continue" }`) and never updates the private dispatch context.
- For a verified input, the private dispatch context is updated and the handler returns `{ action: "transform", text: <task text only> }` — the Orca preamble, worker/task/dispatch identifiers, capability token, coordinator instructions, and the embedded `orca orchestration send` command are all scrubbed from what the model sees. Attached images are left untouched.
- A reused worker session can receive a fresh dispatch preamble on a later input, resetting the private lifecycle state for the new assignment.

The parsed dispatch metadata (worker handle, capability, dispatch id, task id) stays private to the extension and is never exposed as tool output; all private dispatch identifiers are additionally redacted from reporting diagnostics. This worker-mode bridge itself (as opposed to `OrcaCoordinator`, which does the launching) does not create or merge worktrees, rename terminals, proxy other Orca orchestration operations, or provide a generic host adapter.

Worker mode independently enforces the resolved turn limit (`--imp-turn-limit`, default 30, strict whole number ≥ 2) using private in-memory lifecycle state (turn count, last observed assistant output, terminal stop reason/error, and exactly-once completion sealing/in-flight guards) reset on every freshly verified dispatch. All `turn_end`/`agent_settled` lifecycle enforcement — the FINAL TURN directive, the automatic completion report, and the abort — is gated on there being a verified active dispatch; an invalid or unverified worker input never sets one, so it can never trigger a directive, a report attempt, or an abort. On the penultimate turn it queues the existing FINAL TURN directive as a steer message. On the final turn it awaits a `truncated` completion report before aborting the run so the report attempt is never interrupted mid-flight; a failed report stays unsealed so `agent_settled` can retry it as `truncated`. Otherwise, `agent_settled` applies the same terminal-assistant rules as an in-process imp: a non-empty normal response reports `completed`; stop reasons `error`, `aborted`, or `length`, and empty terminal output, report `failed` with a non-empty diagnostic. Completion is reported over the internal status subject exactly-once/in-flight-guarded by `reportImpCompletion`, using one of three stable, non-model-controlled subjects — `pi-imps:completed`, `pi-imps:failed`, `pi-imps:truncated` — that `OrcaCoordinator`'s mailbox consumer parses without trusting model-provided text or any embedded identifier.


### Child-Session Error Normalization

Every imp child session, and the Orca-dispatched worker's own run, registers a hidden inline `tool_result` handler (not a discoverable extension, no LLM-callable tools, survives the tool-allowlist filter). When a tool result is marked `isError` but carries no meaningful content — an empty content array, or only empty/whitespace text — the handler replaces it with a single text block: `Tool "<toolName>" failed without an error message`. Successful results, non-empty text errors, and image-bearing results are left unchanged. This only normalizes what the provider sees; it performs no persistent logging and captures no provider payloads.

### Turn Limit

A global safety net to prevent runaway imps. Default: 30 turns. Configurable in settings, not per-summon. Per-agent frontmatter `turns` overrides the global `turnLimit` when set (minimum 2).

The imp is unaware of the limit. It works normally until the final turn, when a directive is injected:

> FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.

After that turn the session ends. The result returned to the delegator carries a `truncated` status (distinct from `completed` or `failed`), so the LLM knows the imp was cut off and can decide whether to re-delegate the remainder.

The limit is a circuit breaker, not a budget. It exists to catch genuine runaways — loops, wrong approaches, hallucination spirals — not to manage workflow. If an imp hits the limit, the task was too broad or under-specified; decompose it or tighten the prompt rather than raising the limit.
### Names

Generated per imp, recycled when freed.

### Orca Imp Execution

Global settings gain an `orca` block: `{ "orca": { "enabled": boolean } }`, defaulting to `false`. Only the nested `enabled` boolean is parsed; a missing or malformed `orca` block (non-object, non-boolean `enabled`) defaults to `false`, consistent with the rest of `imps.json`'s lenient parsing. `enabled: false` (the default) keeps ordinary in-process imp spawning unchanged and is unaffected by anything below.

When `orca.enabled` is `true`, `summon` routes through an `OrcaCoordinator` instead of spawning an in-process session, entirely behind the same `summon`/`wait`/`dismiss`/`list_imps` schemas — the LLM-facing surface is unchanged. Support is local-POSIX only: `darwin`/`linux`, the current worktree only. There is no remote launch, no Windows support, and pi-imps never creates a child worktree or merges one — every imp runs in the same worktree the parent session is already in. If Orca is unavailable, reports no current worktree, or the platform is unsupported, the summon fails explicitly (surfaced as a `failed` imp result) — there is no silent fallback to local in-process spawning.

One coordinator is created per active session (reused across a reload that has no intervening session switch/shutdown; torn down and recreated on session switch/shutdown), and it owns exactly one lazily-created Orca orchestration run plus one serialized mailbox consumer for that run. Multiple imps can run concurrently — each gets its own terminal, task, and dispatch against the shared run — and the mailbox consumer routes each `worker_done` delivery back to its dispatch regardless of arrival order. Running multiple imps concurrently in distinct terminals is exactly how Orca-backed summon behaves; there is no artificial serialization.

Each Orca-dispatched imp is launched as a controlled worker, built from the exact same resolution an in-process imp session uses:

- Same resolved model, thinking level (including the `max`→`xhigh` mapping), system prompt, and turn limit as an in-process session for that agent.
- Same allowed-tool extension providers, selected the same way (agent frontmatter `tools`, settings `toolAllowlist`, and global+project additive `agents.<name>.tools` grants), plus `additionalExtensions`, which always load regardless of the tool allowlist — unchanged semantics, just also applied to the Orca launch path.
- Launched with `--no-extensions --no-skills --no-prompt-templates --no-themes --no-session` plus only the resolved extension paths and pi-imps' own worker entrypoint, so no unrelated host extensions, skills, prompt templates, or themes leak into the worker. `--no-session` keeps the terminal visible while active but prevents Pi from writing an on-disk transcript for Orca's transcript-backed Agent Session History.
- Launched with the resolved model, thinking level, and turn limit passed explicitly as CLI arguments (`--model`, `--thinking`, `--imp-turn-limit`), and `--is-imp`, which puts the worker into Orca worker mode instead of ordinary pi-imps: it reports terminal completion and enforces the turn limit locally, but never registers summon/wait/dismiss/list_imps and never discovers agents — no recursive delegation.
- The resolved system prompt is written verbatim to a uniquely named file inside a freshly created private temp directory (`fs.mkdtemp`, mode 0700), with the file itself restricted to mode 0600. Only that file's absolute path — never the prompt content — is passed to `--system-prompt` and appears in the terminal command handed to Orca; Pi natively reads an existing path supplied to `--system-prompt`. The temp file (and its private directory) is removed immediately once `terminal wait --for tui-idle` reports satisfied (Pi has finished loading it), or immediately on any earlier preparation/terminal-create/terminal-wait failure. A failure to remove it is never swallowed: it fails the launch (while existing dispatch/terminal cleanup still runs) rather than silently leaving the prompt on disk.
- `--tools` is passed unchanged only when an explicit tool allowlist was resolved; when there is no explicit allowlist, `--tools` is omitted entirely and every tool among the selected extensions/builtins is available. Worker completion is lifecycle-driven and cannot be configured away.
- Orca's injected dispatched-worker preamble (identifiers, capability token, coordinator instructions, the embedded reporting command) is scrubbed before the model ever sees the prompt; only the task text remains.

Completion and turn-limit enforcement have parity with in-process imps: the worker reports a normal non-empty terminal assistant response as `completed`, provider failure stop reasons or empty terminal output as `failed`, and a limit-triggered cutoff as `truncated`. The worker independently counts turns against the same resolved limit and injects the same FINAL TURN directive on the penultimate turn. These three outcomes are carried over Orca's mailbox as stable, non-model-controlled status subjects, never trusting model-provided text for the routing itself.

Every terminal pi-imps explicitly creates for an Orca-dispatched imp is explicitly closed by pi-imps on that imp's completion, on `dismiss`, and on coordinator shutdown (session switch/shutdown) — it is not left for the user or Orca to clean up. Calling Orca's `worker-release` alone does not close the terminal; pi-imps always follows it with an explicit `terminal close`.

The mailbox consumer retries exactly one transient `check`/`ack` execution or protocol failure — abort-aware, using a short delay so an in-progress shutdown never triggers a spurious retry — before treating the mailbox as fatally broken. A persistent failure, or a second failure right after that one retry, fails every still-active dispatch exactly once: each gets a full `worker-stop` / `worker-release` / `terminal close` cleanup sequence before its `onComplete` fires. Spawn's own orchestration and worker-lifecycle commands are never retried. If `worker-start` itself fails, or reports a non-ready state, after already returning a usable `dispatchId`, that dispatch is stopped and released the same way before its terminal is closed. A task created by a spawn that later fails may remain durable in Orca's orchestration store, since pi-imps has no safe task-delete operation to invoke.

Orca workers currently expose no token or turn telemetry over the orchestration protocol. `list_imps`/`wait` stats for Orca-dispatched imps therefore remain zero or unavailable — this reflects a missing telemetry channel, not that the imp actually used zero turns or tokens.

Separately from the resolved tool/`additionalExtensions` extensions above, every direct child entry of `${getAgentDir()}/extensions` whose basename starts exactly with `orca-` is discovered and always passed to the launched worker via its own `-e` flag, appended after the normal tool-selected/`additionalExtensions` paths and deduped against them (first occurrence wins, preserving order). Matching entries are regular `.ts`/`.js` files, directories, and symlinks (of any target type); non-matching basenames and other entry kinds are ignored. Discovery passes each matched entry's own absolute path straight through to Pi's `-e` loader, which natively resolves a single file, an index directory, or a package manifest — no local symlink-target inspection or manifest resolution happens here. A missing (or non-directory) `extensions/` path yields no matches; any other read failure fails the launch with a concise, actionable error. These host-integration extensions are not ordinary tool-providing extensions: they always load for Orca-dispatched workers regardless of the resolved tool allowlist or `additionalExtensions`, because they provide Orca host status/prefill/title integration that must attach to every worker unconditionally. There is no new configuration surface for this — it is pure directory-naming convention under the existing global extensions directory.

