import type { Theme } from "@mariozechner/pi-coding-agent";
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
      const activity = imp.activity ?? "◌";
      return `${base}: ${activity} — ${imp.turns} turns, ${formatTokens(imp.tokens.input + imp.tokens.output)} tokens`;
    }
    case "completed":
      return `${base}: ✓ ${imp.turns} turns, ${formatTokens(imp.tokens.input + imp.tokens.output)} tokens`;
    case "failed":
      return `${base}: ✗ ${imp.error ?? "unknown error"}`;
    case "dismissed":
      return `${base}: dismissed`;
    case "truncated":
      return `${base}: ! truncated at ${imp.turns} turns, ${formatTokens(imp.tokens.input + imp.tokens.output)} tokens`;
  }
}

/**
 * Format wait results for the LLM.
 */
export function formatWaitResult(imps: Imp[]): string {
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
 * Format summon result for TUI display (themed).
 */
export function formatSummonDisplay(name: string, agentName: string, theme: Theme): string {
  if (agentName === "ephemeral") {
    return theme.fg("accent", name) + " has answered your summons!";
  }
  return theme.fg("accent", name) + " the " + theme.fg("muted", agentName) + " has answered your summons!";
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
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "dismissed":
      return "dismissed";
    case "running":
      return "running";
    case "truncated":
      return "truncated";
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
interface CompactImp {
  name: string;
  agentName: string;
  status: string;
  activity?: string;
  turns: number;
  tokens: number;
}

function formatCompactStatus(imp: CompactImp, theme?: Theme): string {
  const name = theme ? theme.fg("accent", imp.name) : imp.name;
  const agent =
    imp.agentName === "ephemeral" ? "" : theme ? " the " + theme.fg("muted", imp.agentName) : ` (${imp.agentName})`;
  const base = `${name}${agent}`;
  const tokens = formatTokens(imp.tokens);
  const dim = (s: string) => (theme ? theme.fg("dim", s) : s);
  switch (imp.status) {
    case "running": {
      const activity = imp.activity ?? dim("◌");
      return `${base}: ${activity} ${dim(`\u2014 ${imp.turns} turns, ${tokens} tokens`)}`;
    }
    case "completed":
      return `${base}: ${theme ? theme.fg("success", "\u2713") : "\u2713"} ${dim(`${imp.turns} turns, ${tokens} tokens`)}`;
    case "failed":
      return `${base}: ${theme ? theme.fg("error", "\u2717 failed") : "\u2717 failed"}`;
    case "dismissed":
      return `${base}: ${dim("dismissed")}`;
    case "truncated":
      return `${base}: ${theme ? theme.fg("warning", "\u26a0") : "\u26a0"} ${dim(`truncated at ${imp.turns} turns, ${tokens} tokens`)}`;
    default:
      return `${base}: ${imp.status}`;
  }
}

/**
 * Format compact wait result for TUI display (themed).
 */
export function formatWaitResultCompact(imps: CompactImp[], mode: "all" | "first", theme?: Theme): string {
  if (imps.length === 0) return theme ? theme.fg("dim", "No uncollected imps.") : "No uncollected imps.";
  const lines = imps.map((imp) => formatCompactStatus(imp, theme));
  if (mode === "all") {
    const allDone = imps.every((i) => i.status !== "running");
    if (allDone) lines.push(theme ? theme.fg("success", "All completed") : "All completed");
  } else {
    const winner = imps[0];
    if (winner && winner.status !== "running") {
      const name = theme ? theme.fg("accent", winner.name) : winner.name;
      const agent =
        winner.agentName === "ephemeral"
          ? ""
          : theme
            ? " the " + theme.fg("muted", winner.agentName)
            : ` (${winner.agentName})`;
      const tokens = formatTokens(winner.tokens);
      const stats = `${winner.turns} turns, ${tokens} tokens`;
      const line = `${name}${agent} finished first ${theme ? theme.fg("dim", "\u2014 " + stats) : "\u2014 " + stats}`;
      return line;
    }
    // Race still running — show all imp statuses
    return lines.join("\n");
  }
  return lines.join("\n");
}
