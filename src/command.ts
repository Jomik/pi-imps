import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig, updateProjectAgentTools } from "./settings.js";
import type { AgentConfig, ImpSettings } from "./types.js";

const USAGE = "/imps tools <agent-name>";

/** Armory contract: synchronous, exactly-once, uncached query for this project's configured tool names. */
const PROJECT_TOOLS_EVENT = "pi-armory:project-tools:v1";

interface ProjectToolsRequestV1 {
  respond(toolNames: string[]): void;
}

/**
 * Synchronously query pi-armory for the current project's configured Armory tool names.
 *
 * Armory (if present and compatible) responds exactly once via `respond`. `undefined` means
 * Armory is absent or incompatible — no response was received. An empty array means Armory is
 * present but the project's `.pi/armory.json` has no tools configured. The result must be
 * consumed immediately by the caller and is never cached across invocations.
 *
 * Exported for testing.
 */
export function queryArmoryProjectTools(pi: ExtensionAPI): string[] | undefined {
  let projectTools: string[] | undefined;
  pi.events.emit(PROJECT_TOOLS_EVENT, {
    respond(toolNames: string[]) {
      projectTools ??= [...toolNames];
    },
  } satisfies ProjectToolsRequestV1);
  return projectTools;
}

/**
 * Compute the source badges that apply to a tool, in stable display order.
 *
 * Sources are mutually exclusive in pairs: `agent` and `default` cannot both
 * appear (the agent either has explicit frontmatter tools or falls back to the
 * default). `global` and `project` are independent and may combine with either
 * baseline source.
 *
 * Returns an array such as ["agent", "global"] or ["default", "project"],
 * or [] if the tool has no source.
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
 * Compute grant candidates: project Armory tool names that are currently registered in
 * the parent session and are not already effectively available to the agent from its
 * frontmatter, the default allowlist, global grants, or current project grants.
 *
 * Deduplicated and sorted for stable display order.
 * Exported for testing.
 */
export function computeGrantCandidates(
  queryToolNames: readonly string[],
  registeredToolNames: ReadonlySet<string>,
  agentTools: ReadonlySet<string>,
  defaultTools: ReadonlySet<string>,
  globalTools: ReadonlySet<string>,
  currentProjectTools: ReadonlySet<string>,
): string[] {
  const candidates = new Set<string>();
  for (const name of queryToolNames) {
    if (!registeredToolNames.has(name)) continue;
    if (agentTools.has(name) || defaultTools.has(name) || globalTools.has(name) || currentProjectTools.has(name)) {
      continue;
    }
    candidates.add(name);
  }
  return [...candidates].sort();
}

/**
 * Compute remove candidates: every current project grant, including names that are
 * absent from the Armory query or unregistered in this session, so stale grants remain
 * removable. Deduplicated and sorted for stable display order.
 *
 * Exported for testing.
 */
export function computeRemoveCandidates(currentProjectTools: readonly string[]): string[] {
  return [...new Set(currentProjectTools)].sort();
}

/**
 * Compute the tools array to persist after granting a tool to a project.
 *
 * Pure — does not mutate currentProjectTools. currentProjectTools may include names
 * unregistered in this session; they are preserved verbatim.
 * Exported for testing.
 */
export function computeGrantResult(toolName: string, currentProjectTools: ReadonlySet<string>): string[] {
  const updated = new Set(currentProjectTools);
  updated.add(toolName);
  return [...updated];
}

/**
 * Compute the tools array to persist after revoking a project-granted tool.
 *
 * Pure — does not mutate currentProjectTools. currentProjectTools may include names
 * unregistered in this session; they are preserved verbatim (other than the removed one).
 * Exported for testing.
 */
export function computeRevokeResult(toolName: string, currentProjectTools: ReadonlySet<string>): string[] {
  const updated = new Set(currentProjectTools);
  updated.delete(toolName);
  return [...updated];
}

/** Format a Remove option's label with any remaining (non-project) sources. */
function formatRemoveLabel(toolName: string, remainingSources: readonly string[]): string {
  if (remainingSources.length === 0) return toolName;
  return `${toolName} (still available via: ${remainingSources.join(", ")})`;
}

const DIALOG_OK = ["OK"];

/** Show a one-shot informational/error dialog through the standard select UI, so RPC clients (e.g. Paseo) can display it. */
async function showDialogMessage(ctx: ExtensionCommandContext, message: string): Promise<void> {
  await ctx.ui.select(message, DIALOG_OK);
}

/**
 * Create the `/imps` command registration options.
 *
 * Only the `tools <agent-name>` subcommand is supported. Missing or unknown
 * subcommands / agent names produce concise usage guidance. The tools flow
 * uses only standard `ctx.ui.select` dialogs, so it works identically in the
 * interactive TUI and in RPC clients such as Paseo.
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
        await showDialogMessage(ctx, `Usage: ${USAGE}`);
        return;
      }

      if (!agentName) {
        await showDialogMessage(ctx, `Usage: ${USAGE}`);
        return;
      }

      if (parts.length > 2) {
        await showDialogMessage(ctx, `Usage: ${USAGE}`);
        return;
      }

      const agent = agents.find((a) => a.name === agentName);
      if (!agent) {
        await showDialogMessage(ctx, `Unknown agent: "${agentName}". Usage: ${USAGE}`);
        return;
      }

      // Load project config — report error and abort if malformed. Uses a standard
      // dialog (not notify) so RPC clients like Paseo can see the failure.
      let projectConfig: ReturnType<typeof loadProjectConfig>;
      try {
        projectConfig = loadProjectConfig(ctx.cwd);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await showDialogMessage(ctx, `Cannot read project config: ${msg}`);
        return;
      }

      const allToolNames = pi
        .getAllTools()
        .map((t) => t.name)
        .sort();
      const registeredToolNames = new Set(allToolNames);

      // Compute the agent and default tool source sets.
      const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allToolNames);

      // Global grants: per-agent tools from global imps.json settings.
      const globalTools = new Set<string>(settings.agents[agentName]?.tools ?? []);

      const existingProjectToolNames = projectConfig.agents?.[agentName]?.tools ?? [];

      // The full set of current project-granted tool names, including any that are
      // unregistered in this session — kept so stale grants remain removable and are
      // preserved verbatim on every write.
      let currentProjectTools = new Set<string>(existingProjectToolNames);

      // Synchronous, exactly-once, uncached Armory query.
      const projectToolNames = queryArmoryProjectTools(pi);
      if (projectToolNames === undefined) {
        await showDialogMessage(ctx, "Armory project tools are unavailable (Armory is not installed or incompatible).");
      } else if (projectToolNames.length === 0) {
        await showDialogMessage(ctx, "Armory is installed, but this project has no configured tools.");
      }

      for (;;) {
        const action = await ctx.ui.select(`Project tool grants for agent: ${agentName}`, [
          "Grant project tool",
          "Remove project grant",
          "Done",
        ]);
        if (action === undefined || action === "Done") return;

        if (action === "Grant project tool") {
          const candidates = computeGrantCandidates(
            projectToolNames ?? [],
            registeredToolNames,
            agentTools,
            defaultTools,
            globalTools,
            currentProjectTools,
          );
          if (candidates.length === 0) {
            await showDialogMessage(ctx, "No project tools are available to grant.");
            continue;
          }
          const picked = await ctx.ui.select("Select a tool to grant", candidates);
          if (picked === undefined) continue;

          const toolsToWrite = computeGrantResult(picked, currentProjectTools);
          try {
            updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await showDialogMessage(ctx, `Failed to update project config: ${msg}`);
            continue;
          }
          currentProjectTools = new Set(toolsToWrite);
          continue;
        }

        // action === "Remove project grant"
        const removeCandidates = computeRemoveCandidates([...currentProjectTools]);
        if (removeCandidates.length === 0) {
          await showDialogMessage(ctx, "No project grants to remove.");
          continue;
        }
        const labeled = removeCandidates.map((name) => ({
          name,
          label: formatRemoveLabel(name, computeBadges(name, agentTools, defaultTools, globalTools, new Set())),
        }));
        const picked = await ctx.ui.select(
          "Select a project grant to remove",
          labeled.map((l) => l.label),
        );
        if (picked === undefined) continue;
        const match = labeled.find((l) => l.label === picked);
        if (!match) continue;

        const toolsToWrite = computeRevokeResult(match.name, currentProjectTools);
        try {
          updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await showDialogMessage(ctx, `Failed to update project config: ${msg}`);
          continue;
        }
        currentProjectTools = new Set(toolsToWrite);
      }
    },
  };
}
