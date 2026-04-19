import type { AgentConfig, Imp, ImpStatus } from "./types.js";

/**
 * Build the <available_agents> XML block for system prompt injection.
 */
export function buildAgentsBlock(agents: AgentConfig[]): string {
  if (agents.length === 0) return "";

  const lines = ["<available_agents>"];
  for (const a of agents) {
    lines.push("  <agent>");
    lines.push(`    <name>${a.name}</name>`);
    lines.push(`    <description>${a.description}${a.model ? ` [model: ${a.model}]` : ""}</description>`);
    lines.push(`    <source>${a.source}</source>`);
    lines.push("  </agent>");
  }
  lines.push("</available_agents>");
  return lines.join("\n");
}

/**
 * Format a single imp's status for list_imps or wait streaming.
 */
export function formatImpStatus(imp: Imp): string {
  const agent = imp.agentName === "ephemeral" ? "" : ` (${imp.agentName})`;
  const base = `${imp.name}${agent}`;

  switch (imp.status) {
    case "running": {
      const activity = imp.activity ?? "working...";
      return `${base}: ${activity} — ${imp.turns} turns, ${formatTokens(imp.tokens.input + imp.tokens.output)} tokens`;
    }
    case "completed":
      return `${base}: ✓ ${imp.turns} turns, ${formatTokens(imp.tokens.input + imp.tokens.output)} tokens`;
    case "failed":
      return `${base}: ✗ ${imp.error ?? "unknown error"}`;
    case "dismissed":
      return `${base}: dismissed`;
  }
}

/**
 * Format wait results for the LLM.
 */
export function formatWaitResult(imps: Imp[], mode: "all" | "first"): string {
  const lines: string[] = [];

  for (const imp of imps) {
    const agent = imp.agentName === "ephemeral" ? "" : ` (${imp.agentName})`;
    const header = `── ${imp.name}${agent} — ${statusLabel(imp.status)}`;
    lines.push(header);

    if (imp.status === "failed") {
      lines.push(`Error: ${imp.error ?? "unknown"}`);
    } else if (imp.output) {
      lines.push(imp.output);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format summon result for the LLM.
 */
export function formatSummonResult(name: string, agentName: string): string {
  const agent = agentName === "ephemeral" ? "ephemeral" : agentName;
  return `Summoned ${name} (${agent})`;
}

/**
 * Format dismiss result for the LLM.
 */
export function formatDismissResult(dismissed: Imp[]): string {
  if (dismissed.length === 0) return "No imps to dismiss.";
  const names = dismissed.map((i) => i.name).join(", ");
  return `Dismissed: ${names}`;
}

function statusLabel(status: ImpStatus): string {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "dismissed": return "dismissed";
    case "running": return "running";
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
