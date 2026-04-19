import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, Imp } from "./types.js";
import { runningImps } from "./state.js";
import { discoverAgents } from "./agents.js";
import { buildAgentsBlock } from "./format.js";
import { createNamePool } from "./names.js";
import { summonTool, waitTool, dismissTool, listImpsTool, dismissAllImps } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  const imps: Map<string, Imp> = new Map();
  const namePool = createNamePool();
  let agents: AgentConfig[] = [];

  // ── Agent discovery ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    agents = discoverAgents(ctx.cwd);
  });

  // ── System prompt injection ────────────────────────────────────────────

  pi.on("before_agent_start", (event) => {
    if (agents.length === 0) return;
    const block = buildAgentsBlock(agents);
    return { systemPrompt: event.systemPrompt + "\n\n" + block };
  });

  // ── Footer: running imp count ──────────────────────────────────────────

  function updateFooter(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    const count = runningImps(imps).length;
    ctx.ui.setStatus(
      "imps",
      count > 0 ? `🧿 ${count} imp${count !== 1 ? "s" : ""}` : undefined,
    );
  }

  pi.on("turn_start", (_event, ctx) => updateFooter(ctx));
  pi.on("turn_end", (_event, ctx) => updateFooter(ctx));
  pi.on("tool_execution_end", (_event, ctx) => updateFooter(ctx));

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    dismissAllImps(imps, namePool);
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool(summonTool(imps, () => agents, namePool));
  pi.registerTool(waitTool(imps));
  pi.registerTool(dismissTool(imps, namePool));
  pi.registerTool(listImpsTool(imps));
}
