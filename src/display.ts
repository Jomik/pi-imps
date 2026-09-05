import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ImpSnapshot } from "./types.js";

const SPINNER = "·•✧✦✧•";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatAgentSuffix(agent: string, theme: Theme): string {
  return ` the ${theme.fg("muted", agent)}`;
}

function formatStats(imp: ImpSnapshot, theme: Theme): string {
  const i = formatTokens(imp.tokens.input);
  const o = formatTokens(imp.tokens.output);
  return theme.fg("dim", `(${imp.turns}⟳ ${i}↓ ${o}↑)`);
}

/**
 * Format a single imp as a themed one-liner.
 *
 * Shows the imp's exact `error` text beneath a failed status row, and a
 * "turn limit reached" label beneath a truncated status row.
 */
export function formatImpStatusDisplay(imp: ImpSnapshot, theme: Theme, animationFrame: number): string {
  const name = theme.fg("accent", imp.name);
  const base = `${name}${formatAgentSuffix(imp.agent, theme)}`;
  const stats = formatStats(imp, theme);

  switch (imp.status) {
    case "running": {
      const frame = SPINNER[animationFrame % SPINNER.length];
      const activity = imp.activity ?? theme.fg("dim", "idle");
      return `${theme.fg("accent", frame)} ${base} ${stats}\n  ${activity}`;
    }
    case "completed":
      return `${theme.fg("success", "✓")} ${base} ${stats}`;
    case "failed": {
      const error = imp.error || theme.fg("dim", "Imp failed with no error message");
      return `${theme.fg("error", "✗")} ${base}\n  ${theme.fg("error", error)}`;
    }
    case "dismissed":
      return `${theme.fg("dim", "⊘")} ${base}`;
    case "truncated":
      return `${theme.fg("warning", "!")} ${base} ${stats}\n  ${theme.fg("warning", "turn limit reached")}`;
    default:
      return `${base}: ${imp.status}`;
  }
}

/**
 * Format summon result for TUI display (themed).
 */
export function formatSummonDisplay(name: string, agent: string, theme: Theme): string {
  return `${theme.fg("accent", name)} the ${theme.fg("muted", agent)} has answered your summons!`;
}

const TASK_PREVIEW_LENGTH = 60;

/**
 * Format the task preview block beneath the summon header.
 *
 * Collapsed: one-line truncated preview with an expand hint.
 * Expanded:  full task text with a collapse hint.
 */
export function formatSummonTaskPreview(
  task: string,
  expanded: boolean,
  theme: Theme,
  expandHint = "expand",
  collapseHint = "collapse",
): string {
  const hint = theme.fg("muted", expanded ? collapseHint : expandHint);
  if (expanded) {
    return `  ${theme.fg("dim", "task:")}\n  ${task}\n  ${hint}`;
  }
  const compactTask = task.trim().replace(/\s+/g, " ");
  const preview =
    compactTask.length > TASK_PREVIEW_LENGTH ? `${compactTask.slice(0, TASK_PREVIEW_LENGTH)}\u2026` : compactTask;
  return `  ${theme.fg("dim", `"${preview}"`)}  ${hint}`;
}

/**
 * Format compact wait result for TUI display (themed).
 */
export function formatWaitDisplay(
  imps: ImpSnapshot[],
  mode: "all" | "first",
  theme: Theme,
  animationFrame = 0,
): string {
  if (imps.length === 0) return theme.fg("dim", "No uncollected imps.");

  const lines = imps.map((imp, i) => formatImpStatusDisplay(imp, theme, animationFrame + i));

  if (mode === "first") {
    const winner = imps[0];
    if (winner && (winner.status === "failed" || winner.status === "truncated")) {
      return formatImpStatusDisplay(winner, theme, animationFrame);
    }
    if (winner && winner.status !== "running") {
      const name = theme.fg("accent", winner.name);
      const agent = formatAgentSuffix(winner.agent, theme);
      return `${name}${agent} finished first ${formatStats(winner, theme)}`;
    }
  }

  return lines.join("\n");
}
