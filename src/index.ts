import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDiagnostic, buildAgentsBlock, discoverAgents } from "./agents.js";
import { createImpsCommand } from "./command.js";
import { createNamePool } from "./names.js";
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

  // ── System prompt injection ────────────────────────────────────────────

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
