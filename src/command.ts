import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import { loadProjectConfig, updateProjectAgentTools } from "./settings.js";
import type { AgentConfig, ImpSettings } from "./types.js";

const USAGE = "/imps tools [agent-name]";

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

/**
 * Compute the effective set of currently registered tools an agent would receive
 * if summoned now: explicit agent tools, otherwise the default allowlist, otherwise
 * every registered parent tool; unioned with global and project grants; intersected
 * with currently registered tools (excluding configured-but-unregistered names).
 *
 * Sorted for stable display order. Exported for testing.
 */
export function computeEffectiveTools(
  agentTools: ReadonlySet<string>,
  defaultTools: ReadonlySet<string>,
  globalTools: ReadonlySet<string>,
  projectTools: ReadonlySet<string>,
  registeredToolNames: ReadonlySet<string>,
): string[] {
  const union = new Set<string>([...agentTools, ...defaultTools, ...globalTools, ...projectTools]);
  const effective: string[] = [];
  for (const name of union) {
    if (registeredToolNames.has(name)) effective.push(name);
  }
  return effective.sort();
}

/** Format a List option's label with all applicable source badges. */
function formatListLabel(toolName: string, badges: readonly string[]): string {
  if (badges.length === 0) return toolName;
  return `${toolName} (${badges.join(", ")})`;
}

/**
 * Show a one-shot informational/error message as a bordered TUI dialog. Dismissed with
 * Enter or Escape. In RPC/print/JSON modes `ctx.ui.custom` resolves immediately with
 * `undefined` (no dialog is actually shown), which is the intended degrade-to-no-op behavior.
 */
async function showMessage(ctx: ExtensionCommandContext, message: string): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(message, 1, 0));
    container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done(undefined);
      },
    };
  });
}

/**
 * Show a single-selection TUI dialog built from `SelectList`. Returns the chosen value,
 * or `undefined` on cancellation (Escape) — or immediately in RPC/print/JSON modes, where
 * `ctx.ui.custom` degrades to a no-op, so the command exits without further side effects.
 */
async function selectOne(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const items: SelectItem[] = options.map((value) => ({ value, label: value }));
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

interface MultiSelectOption {
  id: string;
  label: string;
}

/**
 * Show a searchable toggle-list TUI dialog built from `SettingsList` (fuzzy search
 * enabled), using pi's native SettingsList semantics unmodified: Enter or Space toggles
 * the highlighted row between `values[0]` (off) and `values[1]` (on), immediately
 * invoking `onToggle` with the row's id and the direction it moved. Escape closes the
 * dialog (`onCancel`) — it does not undo any toggles already applied.
 *
 * `onToggle` is expected to persist the change synchronously and throw on failure. On a
 * thrown error, the row is reverted to its prior value and the error is reported via
 * `ctx.ui.notify` without closing the dialog, so the user can keep working the list.
 *
 * There is no staged/selected set and no explicit apply step — every toggle is a
 * standalone, immediately-persisted action.
 */
async function toggleList(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly MultiSelectOption[],
  values: readonly [off: string, on: string],
  onToggle: (id: string, turningOn: boolean) => void,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const [offValue, onValue] = values;
    const items: SettingItem[] = options.map((o) => ({
      id: o.id,
      label: o.label,
      currentValue: offValue,
      values: [offValue, onValue],
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        const turningOn = newValue === onValue;
        try {
          onToggle(id, turningOn);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          settingsList.updateValue(id, turningOn ? offValue : onValue);
          tui.requestRender();
          ctx.ui.notify(`Failed to update project config: ${msg}`, "error");
        }
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    const hint = "type to search · space/enter toggle · esc close";
    container.addChild(new Text(theme.fg("dim", hint), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * Create the `/imps` command registration options.
 *
 * Only the `tools [agent-name]` subcommand is supported. It is an interactive-TUI-only
 * flow — RPC, print, and JSON modes return without querying Armory or mutating config.
 * Non-TUI modes are detected via `ctx.mode` when present (any value other than `"tui"`
 * exits immediately, before any config read, Armory query, or mutation); when `ctx.mode`
 * is absent (legacy pi), the guard falls back to `ctx.hasUI` — print/JSON modes are
 * caught directly, and RPC is caught because `ctx.ui.custom` degrades to a no-op there,
 * which every dialog in this flow (including the very first one shown) relies on.
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
      // TUI-only guard, checked before any config read, Armory query, or mutation.
      // Prefer the explicit `mode` discriminator on newer pi ("tui" | "rpc" | "print" | "json")
      // when present; fall back to the legacy `hasUI` flag when it is not (older pi versions
      // that lack `ctx.mode`, where RPC's `ctx.ui.custom` no-op degrade already prevents any
      // further side effects even though `hasUI` alone can't distinguish RPC from TUI there).
      const mode = (ctx as { mode?: unknown }).mode;
      if (typeof mode === "string") {
        if (mode !== "tui") return;
      } else if (!ctx.hasUI) {
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0];
      const explicitAgentName = parts[1];

      if (subcommand !== "tools" || parts.length > 2) {
        await showMessage(ctx, `Usage: ${USAGE}`);
        return;
      }

      let agent: AgentConfig;
      if (explicitAgentName) {
        const found = agents.find((a) => a.name === explicitAgentName);
        if (!found) {
          await showMessage(ctx, `Unknown agent: "${explicitAgentName}". Usage: ${USAGE}`);
          return;
        }
        agent = found;
      } else {
        if (agents.length === 0) {
          await showMessage(ctx, "No agents discovered.");
          return;
        }
        const sortedNames = [...agents].map((a) => a.name).sort();
        const selectedName = await selectOne(ctx, "Select an agent", sortedNames);
        if (selectedName === undefined) return;
        const found = agents.find((a) => a.name === selectedName);
        if (!found) {
          await showMessage(ctx, `Unknown agent: "${selectedName}". Usage: ${USAGE}`);
          return;
        }
        agent = found;
      }
      const agentName = agent.name;

      // Load project config — report error and abort if malformed.
      let projectConfig: ReturnType<typeof loadProjectConfig>;
      try {
        projectConfig = loadProjectConfig(ctx.cwd);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await showMessage(ctx, `Cannot read project config: ${msg}`);
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

      for (;;) {
        const action = await selectOne(ctx, `Project tool grants for agent: ${agentName}`, [
          "List granted tools",
          "Grant project tools",
          "Remove project grants",
          "Done",
        ]);
        if (action === undefined || action === "Done") return;

        if (action === "List granted tools") {
          const effectiveTools = computeEffectiveTools(
            agentTools,
            defaultTools,
            globalTools,
            currentProjectTools,
            registeredToolNames,
          );
          if (effectiveTools.length === 0) {
            await showMessage(ctx, `No tools would be granted to agent "${agentName}" if summoned now.`);
            continue;
          }
          const lines = effectiveTools.map((name) =>
            formatListLabel(name, computeBadges(name, agentTools, defaultTools, globalTools, currentProjectTools)),
          );
          await showMessage(ctx, `Tools granted to agent "${agentName}" if summoned now:\n${lines.join("\n")}`);
          continue;
        }

        if (action === "Grant project tools") {
          // Synchronous, exactly-once, uncached Armory query — queried fresh on each
          // Grant selection, never cached or emitted for other menu actions.
          const projectToolNames = queryArmoryProjectTools(pi);
          if (projectToolNames === undefined) {
            await showMessage(ctx, "Armory project tools are unavailable (Armory is not installed or incompatible).");
            continue;
          }
          if (projectToolNames.length === 0) {
            await showMessage(ctx, "Armory is installed, but this project has no configured tools.");
            continue;
          }
          const candidates = computeGrantCandidates(
            projectToolNames,
            registeredToolNames,
            agentTools,
            defaultTools,
            globalTools,
            currentProjectTools,
          );
          if (candidates.length === 0) {
            await showMessage(ctx, "No project tools are available to grant.");
            continue;
          }
          const options = candidates.map((name) => ({ id: name, label: name }));
          // Each toggle persists immediately (one atomic write per toggle); toggling a row
          // back to "not granted" during the same open screen undoes just that write. A
          // failed write leaves currentProjectTools untouched and reverts the row's display.
          await toggleList(ctx, "Grant project tools", options, ["not granted", "granted"], (name, turningOn) => {
            const toolsToWrite = turningOn
              ? computeGrantResult(name, currentProjectTools)
              : computeRevokeResult(name, currentProjectTools);
            updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
            currentProjectTools = new Set(toolsToWrite);
          });
          continue;
        }

        // action === "Remove project grants"
        const removeCandidates = computeRemoveCandidates([...currentProjectTools]);
        if (removeCandidates.length === 0) {
          await showMessage(ctx, "No project grants to remove.");
          continue;
        }
        const options = removeCandidates.map((name) => ({
          id: name,
          label: formatRemoveLabel(name, computeBadges(name, agentTools, defaultTools, globalTools, new Set())),
        }));
        // Each toggle persists immediately; toggling a row back to "kept" during the same
        // open screen re-grants it. A failed write leaves currentProjectTools untouched and
        // reverts the row's display.
        await toggleList(ctx, "Remove project grants", options, ["kept", "removed"], (name, turningOn) => {
          const toolsToWrite = turningOn
            ? computeRevokeResult(name, currentProjectTools)
            : computeGrantResult(name, currentProjectTools);
          updateProjectAgentTools(ctx.cwd, agentName, toolsToWrite);
          currentProjectTools = new Set(toolsToWrite);
        });
      }
    },
  };
}
