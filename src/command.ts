import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, type SettingsListTheme, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadProjectConfig, updateProjectAgentTools } from "./settings.js";
import type { AgentConfig, ImpSettings } from "./types.js";

const USAGE = "/imps tools <agent-name>";

/**
 * Compute the source badges that apply to a tool, in stable display order.
 *
 * Sources are mutually exclusive in pairs: `agent` and `default` cannot both
 * appear (the agent either has explicit frontmatter tools or falls back to the
 * default). `global` and `project` are independent and may combine with either
 * baseline source.
 *
 * Returns an array such as ["agent", "global"] or ["default", "project"],
 * or [] if the tool has no source (i.e. it belongs in Available).
 *
 * Exported for testing.
 */
export function computeBadges(
  toolName: string,
  agentTools: ReadonlySet<string>,
  defaultTools: ReadonlySet<string>,
  globalTools: ReadonlySet<string>,
  projectTools: ReadonlySet<string>,
): string[] {
  const badges: string[] = [];
  if (agentTools.has(toolName)) badges.push("agent");
  if (defaultTools.has(toolName)) badges.push("default");
  if (globalTools.has(toolName)) badges.push("global");
  if (projectTools.has(toolName)) badges.push("project");
  return badges;
}

/**
 * Compute the agent and default tool source sets for a given agent and settings.
 *
 * - `agentTools`: tools from the agent's frontmatter `tools` field (set when defined).
 *   Empty set when the agent has no frontmatter tools (undefined) or explicitly empty ([]).
 * - `defaultTools`: the baseline fallback when `agent.tools` is undefined.
 *   Populated from `settings.toolAllowlist` when defined, otherwise from `allToolNames` (all tools).
 *   Empty set when the agent has explicit frontmatter tools (including explicit empty []).
 *
 * These two sets are mutually exclusive — if the agent defines its own tools list,
 * `defaultTools` is always empty.
 *
 * Exported for testing.
 */
export function computeBaseToolSources(
  agent: AgentConfig,
  settings: ImpSettings,
  allToolNames: readonly string[],
): { agentTools: Set<string>; defaultTools: Set<string> } {
  if (agent.tools !== undefined) {
    // Agent has explicit frontmatter tools (possibly empty []).
    return { agentTools: new Set(agent.tools), defaultTools: new Set() };
  }
  // No frontmatter tools — use settings toolAllowlist or all tools.
  const defaultTools = settings.toolAllowlist !== undefined ? new Set(settings.toolAllowlist) : new Set(allToolNames);
  return { agentTools: new Set(), defaultTools };
}

/**
 * Partition all registered tool names into the Granted and Available columns.
 *
 * - Granted: tools present in any of agentTools, defaultTools, globalTools, or projectTools.
 * - Available: all other tools.
 *
 * Every tool in `allToolNames` appears exactly once across the two columns.
 * Exported for testing.
 */
export function partitionTools(
  allToolNames: string[],
  agentTools: ReadonlySet<string>,
  defaultTools: ReadonlySet<string>,
  globalTools: ReadonlySet<string>,
  projectTools: ReadonlySet<string>,
): { granted: string[]; available: string[] } {
  const granted: string[] = [];
  const available: string[] = [];
  for (const name of allToolNames) {
    if (agentTools.has(name) || defaultTools.has(name) || globalTools.has(name) || projectTools.has(name)) {
      granted.push(name);
    } else {
      available.push(name);
    }
  }
  return { granted, available };
}

/**
 * Compute the tools array to persist after granting a tool to a project.
 *
 * Pure — does not mutate currentProjectTools. Includes unknown preserved tools.
 * Exported for testing.
 */
export function computeGrantResult(
  toolName: string,
  currentProjectTools: ReadonlySet<string>,
  unknownProjectTools: readonly string[],
): string[] {
  const updated = new Set(currentProjectTools);
  updated.add(toolName);
  return [...updated, ...unknownProjectTools];
}

/**
 * Compute the tools array to persist after revoking a project-granted tool.
 *
 * Returns null when the tool has no project source (inherited-only — read-only).
 * Pure — does not mutate currentProjectTools. Includes unknown preserved tools.
 * Exported for testing.
 */
export function computeRevokeResult(
  toolName: string,
  currentProjectTools: ReadonlySet<string>,
  unknownProjectTools: readonly string[],
): string[] | null {
  if (!currentProjectTools.has(toolName)) return null; // no project source — read-only
  const updated = new Set(currentProjectTools);
  updated.delete(toolName);
  return [...updated, ...unknownProjectTools];
}

function buildGrantedItem(
  toolName: string,
  agentTools: ReadonlySet<string>,
  defaultTools: ReadonlySet<string>,
  globalTools: ReadonlySet<string>,
  projectTools: ReadonlySet<string>,
): SettingItem {
  const badges = computeBadges(toolName, agentTools, defaultTools, globalTools, projectTools);
  const badgeText = badges.map((b) => `[${b}]`).join(" ");
  return {
    id: toolName,
    label: toolName,
    currentValue: badgeText,
    values: [badgeText],
  };
}

function buildAvailableItem(toolName: string): SettingItem {
  return { id: toolName, label: toolName, currentValue: "", values: [""] };
}

/**
 * Side-by-side two-pane tool picker.
 *
 * Left column (Granted): tools with any source (agent, default, global, project).
 * Right column (Available): tools with no source.
 *
 * Only the `project` source is editable:
 * - Enter on Available adds a project grant and moves it to Granted.
 * - Enter on Granted with a project source removes only that source; a project-only
 *   tool moves to Available, while a multi-source tool remains Granted with updated badges.
 * - Enter on Granted without a project source is a no-op (inherited-only — read-only).
 *
 * Left/right arrows and Tab switch the active column. Up/down, typing, and Enter are
 * routed to the active SettingsList. Escape closes from the active list.
 * Each column has independent fuzzy search.
 *
 * Exported for testing.
 */
export class TwoPaneToolPicker {
  private grantedList: SettingsList;
  private availableList: SettingsList;
  private activeColumn: 0 | 1; // 0 = Granted, 1 = Available

  constructor(
    private readonly allToolNames: string[],
    private readonly agentTools: ReadonlySet<string>,
    private readonly defaultTools: ReadonlySet<string>,
    private readonly globalTools: ReadonlySet<string>,
    private readonly currentProjectTools: Set<string>,
    private readonly unknownProjectTools: readonly string[],
    private readonly theme: SettingsListTheme,
    private readonly maxVisible: number,
    private readonly onPersist: (tools: string[]) => boolean,
    private readonly onDone: () => void,
  ) {
    const { granted, available } = partitionTools(
      allToolNames,
      agentTools,
      defaultTools,
      globalTools,
      currentProjectTools,
    );
    this.activeColumn = available.length > 0 ? 1 : 0;
    this.grantedList = this.buildGrantedList(granted);
    this.availableList = this.buildAvailableList(available);
  }

  private buildGrantedList(grantedToolNames: string[]): SettingsList {
    const items = grantedToolNames.map((name) =>
      buildGrantedItem(name, this.agentTools, this.defaultTools, this.globalTools, this.currentProjectTools),
    );
    return new SettingsList(
      items,
      this.maxVisible,
      this.theme,
      (id, _newValue) => {
        const toolsToWrite = computeRevokeResult(id, this.currentProjectTools, this.unknownProjectTools);
        if (toolsToWrite === null) return; // inherited-only — read-only
        if (this.onPersist(toolsToWrite) === false) return;
        this.currentProjectTools.delete(id);
        this.rebuildLists();
      },
      () => this.onDone(),
      { enableSearch: true },
    );
  }

  private buildAvailableList(availableToolNames: string[]): SettingsList {
    const items = availableToolNames.map((name) => buildAvailableItem(name));
    return new SettingsList(
      items,
      this.maxVisible,
      this.theme,
      (id, _newValue) => {
        const toolsToWrite = computeGrantResult(id, this.currentProjectTools, this.unknownProjectTools);
        if (this.onPersist(toolsToWrite) === false) return;
        this.currentProjectTools.add(id);
        this.rebuildLists();
      },
      () => this.onDone(),
      { enableSearch: true },
    );
  }

  private rebuildLists(): void {
    // ponytail: rebuilding resets search and selection after a move; preserve them if this proves disruptive.
    const { granted, available } = partitionTools(
      this.allToolNames,
      this.agentTools,
      this.defaultTools,
      this.globalTools,
      this.currentProjectTools,
    );
    this.grantedList = this.buildGrantedList(granted);
    this.availableList = this.buildAvailableList(available);
    // Keep current column; switch if it becomes empty while the other is not.
    if (this.activeColumn === 1 && available.length === 0 && granted.length > 0) {
      this.activeColumn = 0;
    } else if (this.activeColumn === 0 && granted.length === 0 && available.length > 0) {
      this.activeColumn = 1;
    }
  }

  invalidate(): void {
    this.grantedList.invalidate();
    this.availableList.invalidate();
  }

  render(width: number): string[] {
    // Split width evenly: left column gets floor(width/2)-1 chars, 1-char gap, right gets rest.
    const leftWidth = Math.max(1, Math.floor(width / 2) - 1);
    const rightWidth = Math.max(1, width - leftWidth - 1);

    // Column headers — the active column is marked with ▶.
    const grantedHeaderRaw = truncateToWidth(
      `${this.activeColumn === 0 ? "▶ " : "  "}Granted`,
      leftWidth,
      "",
      true, // pad to leftWidth so right column aligns
    );
    const availableHeaderRaw = truncateToWidth(`${this.activeColumn === 1 ? "▶ " : "  "}Available`, rightWidth);
    const headerLine = truncateToWidth(
      this.theme.label(grantedHeaderRaw, this.activeColumn === 0) +
        " " +
        this.theme.label(availableHeaderRaw, this.activeColumn === 1),
      width,
    );

    const grantedLines = this.grantedList.render(leftWidth);
    const availableLines = this.availableList.render(rightWidth);
    const maxLines = Math.max(grantedLines.length, availableLines.length);

    const result: string[] = [headerLine];
    for (let i = 0; i < maxLines; i++) {
      const leftLine = grantedLines[i] ?? "";
      const rightLine = availableLines[i] ?? "";
      // Pad left side to leftWidth so the gap falls at the correct column.
      const leftPadded = truncateToWidth(leftLine, leftWidth, "", true);
      result.push(truncateToWidth(`${leftPadded} ${rightLine}`, width));
    }
    return result;
  }

  handleInput(data: string): void {
    // Intercept column-switching keys before routing to the active SettingsList.
    // Tab toggles columns; right arrow goes to Available; left arrow goes to Granted.
    if (data === "\t") {
      this.activeColumn = this.activeColumn === 0 ? 1 : 0;
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      // Right arrow — switch to Available
      this.activeColumn = 1;
      return;
    }
    if (data === "\x1b[D" || data === "\x1bOD") {
      // Left arrow — switch to Granted
      this.activeColumn = 0;
      return;
    }
    const activeList = this.activeColumn === 0 ? this.grantedList : this.availableList;
    activeList.handleInput?.(data);
  }
}

/**
 * Create the `/imps` command registration options.
 *
 * Only the `tools <agent-name>` subcommand is supported.  Missing or unknown
 * subcommands / agent names produce concise usage guidance instead of opening
 * the TUI.  When the interactive UI is unavailable (print / RPC mode) the
 * command reports that the TUI is required.
 */
export function createImpsCommand(pi: ExtensionAPI, agents: AgentConfig[], settings: ImpSettings) {
  return {
    description: "Manage project tool grants for imp agents",

    getArgumentCompletions(prefix: string) {
      // No space yet — complete the subcommand name.
      if (!prefix.includes(" ")) {
        if ("tools".startsWith(prefix)) {
          return [{ value: "tools", label: "tools" }];
        }
        return null;
      }

      // After "tools " — complete agent names.
      if (prefix.startsWith("tools ")) {
        const agentPrefix = prefix.slice("tools ".length);
        const filtered = agents.map((a) => a.name).filter((n) => n.startsWith(agentPrefix));
        if (filtered.length === 0) return null;
        return filtered.map((n) => ({ value: `tools ${n}`, label: n }));
      }

      return null;
    },

    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0];
      const agentName = parts[1];

      if (subcommand !== "tools") {
        ctx.ui.notify(`Usage: ${USAGE}`, "info");
        return;
      }

      if (!agentName) {
        ctx.ui.notify(`Usage: ${USAGE}`, "info");
        return;
      }

      if (parts.length > 2) {
        ctx.ui.notify(`Usage: ${USAGE}`, "info");
        return;
      }

      const agent = agents.find((a) => a.name === agentName);
      if (!agent) {
        ctx.ui.notify(`Unknown agent: "${agentName}". Usage: ${USAGE}`, "warning");
        return;
      }

      // `mode` was added in pi-coding-agent 0.75; fall back to `hasUI` on 0.74.
      const mode = "mode" in ctx ? (ctx as { mode: string }).mode : undefined;
      const tuiUnavailable = mode !== undefined ? mode !== "tui" : !ctx.hasUI;
      if (tuiUnavailable) {
        ctx.ui.notify("/imps tools requires the interactive TUI (not available in print/RPC mode)", "warning");
        return;
      }

      // Load project config — report error and abort if malformed.
      let projectConfig: ReturnType<typeof loadProjectConfig>;
      try {
        projectConfig = loadProjectConfig(ctx.cwd);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cannot read project config: ${msg}`, "error");
        return;
      }

      const allToolNames = pi
        .getAllTools()
        .map((t) => t.name)
        .sort();

      // Compute the agent and default tool source sets.
      const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allToolNames);

      // Global grants: per-agent tools from global imps.json settings.
      const globalTools = new Set<string>(settings.agents[agentName]?.tools ?? []);

      const existingProjectToolNames = projectConfig.agents?.[agentName]?.tools ?? [];

      // Unknown project tools: names in the project config that are not registered in this
      // session. Preserved verbatim on every write so they are not silently dropped.
      const unknownProjectTools = existingProjectToolNames.filter((t) => !allToolNames.includes(t));

      // Mutable set tracking which registered tools are currently project-granted.
      const currentProjectTools = new Set<string>(existingProjectToolNames.filter((t) => allToolNames.includes(t)));

      const maxVisible = Math.min(allToolNames.length + 2, 20);

      await ctx.ui.custom((tui, _theme, _kb, done) => {
        const theme = getSettingsListTheme();

        const headerText = new Text(
          `Project tool grants for agent: ${agentName}\n` +
            `Source badges: [agent] = frontmatter tools · [default] = fallback baseline (toolAllowlist or all tools) · [global] = global settings · [project] = this project\n` +
            `Only [project] grants are editable here. Removing a project grant cannot revoke access provided by another source.\n` +
            `Controls: ← → or Tab to switch column · Enter/Space to move tool · ↑ ↓ / type to navigate · Esc to close\n`,
        );

        const picker = new TwoPaneToolPicker(
          allToolNames,
          agentTools,
          defaultTools,
          globalTools,
          currentProjectTools,
          unknownProjectTools,
          theme,
          maxVisible,
          (toolsToWrite) => {
            try {
              updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
              return true as const;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Failed to update project config: ${msg}`, "error");
              return false as const;
            }
          },
          () => done(undefined),
        );

        return {
          render(width: number): string[] {
            return [...headerText.render(width), ...picker.render(width)];
          },
          invalidate(): void {
            headerText.invalidate?.();
            picker.invalidate();
          },
          handleInput(data: string): void {
            picker.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}
