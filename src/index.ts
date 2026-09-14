import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDiagnostic, buildAgentsBlock, discoverAgents } from "./agents.js";
import { createImpsCommand } from "./command.js";
import { createNamePool } from "./names.js";
import { initOrcaWorker, parseImpTurnLimit } from "./orca.js";
import { OrcaCoordinator } from "./orca-coordinator.js";
import { loadImpSettings } from "./settings.js";
import { runningImps } from "./state.js";
import { dismissAllImps, dismissTool, type ImpSpawner, listImpsTool, summonTool, waitTool } from "./tools.js";
import type { AgentConfig, Imp } from "./types.js";

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

  if (pi.getFlag("is-imp")) {
    const turnLimit = parseImpTurnLimit(pi.getFlag("imp-turn-limit") as string | undefined);
    initOrcaWorker(pi, turnLimit);
    return;
  }

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
        // intentionally left unwired here: Orca-dispatched imps report
        // turns/tokens as zero.
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

  // ── Agent discovery ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
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
  });

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
}
