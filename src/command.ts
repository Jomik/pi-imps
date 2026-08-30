import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { loadProjectConfig, updateProjectAgentTools } from "./settings.js";
import type { AgentConfig, ImpSettings } from "./types.js";

// Extend ExtensionContext with the mode discriminator available in pi-coding-agent >= 0.75.
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionContext {
    /** Execution mode — "tui" in interactive mode, "rpc" or "print" otherwise. */
    mode?: "tui" | "rpc" | "print";
  }
}

const USAGE = "/imps tools <agent-name>";

/**
 * Build SettingItem list for the tools TUI.
 *
 * - Tools in `globalTools` appear as read-only single-value items labelled "global".
 * - All other tools show "yes" / "no" depending on membership in `projectTools`.
 *
 * Exported for testing.
 */
export function buildToolItems(
  allTools: string[],
  globalTools: ReadonlySet<string>,
  projectTools: ReadonlySet<string>,
): SettingItem[] {
  return allTools.map((toolName) => {
    if (globalTools.has(toolName)) {
      return {
        id: toolName,
        label: toolName,
        description: "Granted via global settings (read-only)",
        currentValue: "global",
        values: ["global"],
      };
    }
    return {
      id: toolName,
      label: toolName,
      currentValue: projectTools.has(toolName) ? "yes" : "no",
      values: ["yes", "no"],
    };
  });
}

/**
 * Apply a single toggle event from SettingsList and return the merged tools
 * array to persist (known toggled tools + unknown preserved tools), or `null`
 * if the tool is globally granted and therefore read-only.
 *
 * Mutates `currentProjectTools` in place.
 * Exported for testing.
 */
export function applyToolToggle(
  id: string,
  newValue: string,
  globalTools: ReadonlySet<string>,
  currentProjectTools: Set<string>,
  unknownProjectTools: readonly string[],
): string[] | null {
  if (globalTools.has(id)) return null;

  if (newValue === "yes") {
    currentProjectTools.add(id);
  } else {
    currentProjectTools.delete(id);
  }

  return [...currentProjectTools, ...unknownProjectTools];
}

/**
 * Create the `/imps` command registration options.
 *
 * Only the `tools <agent-name>` subcommand is supported.  Missing or unknown
 * subcommands / agent names produce concise usage guidance instead of opening
 * the TUI.  When the interactive UI is unavailable (print / RPC mode) the
 * command reports that the TUI is required.
 */
export function createImpsCommand(
  pi: ExtensionAPI,
  agents: AgentConfig[],
  settings: ImpSettings,
) {
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

      if (ctx.mode !== "tui") {
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

      const globalTools = new Set<string>(settings.agents[agentName]?.tools ?? []);
      const existingProjectToolNames = projectConfig.agents?.[agentName]?.tools ?? [];
      const allToolNames = pi.getAllTools().map((t) => t.name).sort();

      // Tools in the project config that are not currently registered — preserve
      // them on every write so they are not silently dropped.
      const unknownProjectTools = existingProjectToolNames.filter((t) => !allToolNames.includes(t));

      // Mutable set tracking which known tools are currently toggled on.
      const currentProjectTools = new Set<string>(existingProjectToolNames.filter((t) => allToolNames.includes(t)));

      const items = buildToolItems(allToolNames, globalTools, currentProjectTools);

      await ctx.ui.custom((tui, _theme, _kb, done) => {
        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 20),
          getSettingsListTheme(),
          (id, newValue) => {
            const toolsToWrite = applyToolToggle(id, newValue, globalTools, currentProjectTools, unknownProjectTools);
            if (toolsToWrite === null) return; // global — read-only

            try {
              updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Failed to update project config: ${msg}`, "error");
            }
          },
          () => done(undefined),
        );

        const header = new Text(
          `Project tool grants for agent: ${agentName}\nProject grants are additive — removing a project grant cannot remove access provided by frontmatter or global settings.\n`,
        );

        const container = new Container();
        container.addChild(header);
        container.addChild(settingsList);

        return {
          render(width: number): string[] {
            return container.render(width);
          },
          invalidate(): void {
            container.invalidate();
          },
          handleInput(data: string): void {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}
