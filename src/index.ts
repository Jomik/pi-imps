import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDiagnostic, buildAgentsBlock, discoverAgents } from "./agents.js";
import { createImpsCommand } from "./command.js";
import { createNamePool } from "./names.js";
import {
  createAgentDoneTool,
  ORCA_RESTRICTED_TOOLS,
  type OrcaWorkerDispatch,
  verifyOrcaWorkerDispatch,
} from "./orca.js";
import { loadImpSettings } from "./settings.js";
import { runningImps } from "./state.js";
import { dismissAllImps, dismissTool, listImpsTool, summonTool, waitTool } from "./tools.js";
import type { AgentConfig, Imp } from "./types.js";

export default function (pi: ExtensionAPI): void {
  const imps: Map<string, Imp> = new Map();
  const namePool = createNamePool();
  const agents: AgentConfig[] = [];
  // Cached once per session_start; empty string means no agents.
  let agentsBlock = "";

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
  });

  // ── System prompt injection / Orca dispatched-worker detection ─────────

  // Private to this session; never exposed via tool results or logs.
  let orcaDispatch: OrcaWorkerDispatch | undefined;
  let agentDoneRegistered = false;

  pi.on("before_agent_start", (event) => {
    const dispatch = verifyOrcaWorkerDispatch(event.prompt);
    if (dispatch) {
      // Reused worker sessions may receive a fresh dispatch preamble — update
      // private context without re-registering the tool.
      orcaDispatch = dispatch;

      if (!agentDoneRegistered) {
        pi.registerTool(
          createAgentDoneTool(
            () => orcaDispatch,
            (command, args) => pi.exec(command, args),
          ),
        );
        agentDoneRegistered = true;
      }

      const active = new Set(pi.getActiveTools());
      for (const name of ORCA_RESTRICTED_TOOLS) active.delete(name);
      active.add("agent_done");
      pi.setActiveTools([...active]);

      // Suppress the available-agents block; no recursive summoning for workers.
      return { systemPrompt: event.systemPrompt };
    }

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

  pi.on("session_before_switch", () => {
    dismissAllImps(imps, namePool);
    imps.clear();
  });

  pi.on("session_shutdown", () => {
    dismissAllImps(imps, namePool);
    imps.clear();
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  const settings = loadImpSettings();

  pi.registerTool(summonTool(imps, agents, namePool, settings, () => pi.getThinkingLevel()));
  pi.registerTool(waitTool(imps));
  pi.registerTool(dismissTool(imps, namePool));
  pi.registerTool(listImpsTool(imps));

  pi.registerCommand("imps", createImpsCommand(pi, agents, settings));
}
