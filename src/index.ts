import { closeSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { type AgentDiagnostic, buildAgentsBlock, discoverAgents } from "./agents.js";
import { createImpsCommand } from "./command.js";
import { createNamePool } from "./names.js";
import { initOrcaWorker, parseImpTurnLimit } from "./orca.js";
import { OrcaCoordinator } from "./orca-coordinator.js";
import { loadImpSettings } from "./settings.js";
import { runningImps } from "./state.js";
import { dismissAllImps, dismissTool, type ImpSpawner, listImpsTool, summonTool, waitTool } from "./tools.js";
import type { AgentConfig, Imp } from "./types.js";

/**
 * Register ordinary pi-imps parent-mode state, tools, commands, and
 * lifecycle hooks exactly once. Returns the per-session discovery/coordinator
 * logic that must rerun on every `session_start` event (including the first),
 * without re-registering anything above.
 */
function initParentMode(pi: ExtensionAPI): (event: SessionStartEvent, ctx: ExtensionContext) => void {
  const imps: Map<string, Imp> = new Map();
  const namePool = createNamePool();
  const agents: AgentConfig[] = [];
  // Cached once per session_start; empty string means no agents.
  let agentsBlock = "";

  const settings = loadImpSettings();

  // One coordinator per active session when Orca is enabled. session_start
  // reuses an existing coordinator if one is already active (e.g. a reload
  // without an intervening switch/shutdown), so active records and the
  // mailbox consumer are never orphaned. session_before_switch and
  // session_shutdown clear and await shutdown; the next session_start then
  // creates a fresh one.
  let coordinator: OrcaCoordinator | undefined;

  const orcaSpawner: ImpSpawner | undefined = settings.orca.enabled
    ? async (opts) => {
        if (!coordinator) {
          throw new Error("Orca coordinator is not available; cannot summon an Orca-dispatched imp.");
        }
        // Orca worker telemetry (turn counts, token usage) is not available
        // over the orchestration protocol, so onTurnEnd/onUsageUpdate are
        // intentionally left unwired here: display code hides the stats
        // suffix for Orca-dispatched imps instead of showing misleading zeros.
        return coordinator.spawn({
          name: opts.name,
          task: opts.task,
          signal: opts.signal,
          cwd: opts.cwd,
          config: opts.config,
          parentModel: opts.parentModel,
          parentThinkingLevel: opts.parentThinkingLevel,
          modelRegistry: opts.modelRegistry,
          settings: opts.settings,
          onActivity: opts.onToolActivity,
          onComplete: opts.onComplete,
        });
      }
    : undefined;

  // ── System prompt injection ─────────────────────────────────────────────

  pi.on("before_agent_start", (event) => {
    if (!agentsBlock) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${agentsBlock}` };
  });

  // ── Footer: running imp count ──────────────────────────────────────────

  function updateFooter(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    const count = runningImps(imps).length;
    ctx.ui.setStatus("imps", count > 0 ? `${count} imp${count !== 1 ? "s" : ""}` : undefined);
  }

  pi.on("turn_start", (_event, ctx) => updateFooter(ctx));
  pi.on("turn_end", (_event, ctx) => updateFooter(ctx));
  pi.on("tool_execution_end", (_event, ctx) => updateFooter(ctx));

  // ── Cleanup on shutdown / session switch ────────────────────────────────

  pi.on("session_before_switch", async () => {
    dismissAllImps(imps, namePool);
    imps.clear();
    if (coordinator) {
      const active = coordinator;
      coordinator = undefined;
      await active.shutdown();
    }
  });

  pi.on("session_shutdown", async () => {
    dismissAllImps(imps, namePool);
    imps.clear();
    if (coordinator) {
      const active = coordinator;
      coordinator = undefined;
      await active.shutdown();
    }
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool(summonTool(imps, agents, namePool, settings, () => pi.getThinkingLevel(), orcaSpawner));
  pi.registerTool(waitTool(imps));
  pi.registerTool(dismissTool(imps, namePool));
  pi.registerTool(listImpsTool(imps));

  pi.registerCommand("imps", createImpsCommand(pi, agents, settings));

  // ── Agent discovery (rerun every session_start, including the first) ────

  return function onSessionStart(_event, ctx) {
    const diagnostics: AgentDiagnostic[] = [];
    const discovered = discoverAgents(ctx.cwd, diagnostics);
    agents.splice(0, agents.length, ...discovered);
    agentsBlock = buildAgentsBlock(discovered);

    if (diagnostics.length > 0) {
      const summary = diagnostics.map((d) => `- ${d.filePath}: ${d.message}`).join("\n");
      ctx.ui.notify(`pi-imps: ${diagnostics.length} invalid agent definition(s) skipped:\n${summary}`, "warning");
    }

    if (settings.orca.enabled && !coordinator) {
      coordinator = new OrcaCoordinator((command, args, options) => pi.exec(command, args, options));
    }
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("is-imp", {
    description: "Run as an Orca-dispatched imp worker instead of an ordinary pi-imps session",
    type: "boolean",
    default: false,
  });

  // Registered unconditionally so the flag exists in both modes; only worker
  // mode reads and validates it (parent mode never uses it).
  pi.registerFlag("imp-turn-limit", {
    description: "Turn limit enforced by Orca-dispatched imp worker mode (only used with --is-imp)",
    type: "string",
    default: "30",
  });
  pi.registerFlag("imp-ready-file", {
    description: "Internal Orca worker readiness marker path (only used with --is-imp)",
    type: "string",
    default: "",
  });

  // Pi's custom flag values are only available once the CLI has finished
  // parsing; reading `getFlag` during factory execution can observe stale or
  // unavailable values. Mode selection is therefore deferred to the first
  // `session_start` event, which is the only handler registered here at
  // factory time — no parent or worker tools/hooks/commands are registered
  // before then.
  let bootstrapped = false;
  let isWorker = false;
  let onParentSessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => void) | undefined;

  pi.on("session_start", (event, ctx) => {
    if (!bootstrapped) {
      bootstrapped = true;

      if (pi.getFlag("is-imp")) {
        isWorker = true;
        const turnLimit = parseImpTurnLimit(pi.getFlag("imp-turn-limit") as string | undefined);
        initOrcaWorker(pi, turnLimit);
        const readyFile = pi.getFlag("imp-ready-file");
        if (readyFile !== undefined && readyFile !== "") {
          if (typeof readyFile !== "string" || !readyFile.trim() || !isAbsolute(readyFile)) {
            throw new Error("--imp-ready-file must be a nonempty absolute path");
          }
          try {
            closeSync(openSync(readyFile, "wx", 0o600));
          } catch (err) {
            throw new Error(`Failed to create Orca worker readiness marker: ${String(err)}`);
          }
        }
        return;
      }

      onParentSessionStart = initParentMode(pi);
    }

    // Worker mode has nothing further to do on session_start: reused Orca
    // dispatches arrive through the `input` event, not new initialization.
    if (isWorker) return;

    onParentSessionStart?.(event, ctx);
  });
}
