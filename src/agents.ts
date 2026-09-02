import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentSource, ThinkingLevel } from "./types.js";

/** A single problem found while discovering/validating an agent definition file. */
export interface AgentDiagnostic {
  readonly filePath: string;
  readonly message: string;
}

interface LoadResult {
  agents: AgentConfig[];
  /** Effective claimed names of files that failed validation (frontmatter name, else filename stem). */
  invalidNames: string[];
}

/**
 * Validate the `tools` frontmatter field.
 * Valid: comma-separated non-empty string, or an array containing only non-empty strings
 * (an empty array is valid — no tools).
 */
function isValidToolsField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof value === "string") {
    return (parseToolsList(value)?.length ?? 0) > 0;
  }
  return false;
}

function loadAgentsFromDir(dir: string, source: AgentSource, diagnostics?: AgentDiagnostic[]): LoadResult {
  if (!existsSync(dir)) return { agents: [], invalidNames: [] };

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch (err) {
    diagnostics?.push({
      filePath: dir,
      message: `failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { agents: [], invalidNames: [] };
  }

  const agents: AgentConfig[] = [];
  const invalidNames: string[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    const stem = entry.name.replace(/\.md$/, "");

    const report = (message: string, claimedName?: string) => {
      diagnostics?.push({ filePath, message });
      invalidNames.push(claimedName ?? stem);
    };

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      report(`failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
    } catch (err) {
      report(`failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Determine the effective claimed name up front so any later validation failure
    // still masks a same-name global agent (for project files).
    const claimedName =
      typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0 ? frontmatter.name : stem;

    if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
      report("missing, non-string, or blank `description`", claimedName);
      continue;
    }

    if (
      frontmatter.name !== undefined &&
      (typeof frontmatter.name !== "string" || frontmatter.name.trim().length === 0)
    ) {
      report("`name` must be a non-blank string", claimedName);
      continue;
    }

    if (
      frontmatter.model !== undefined &&
      (typeof frontmatter.model !== "string" || frontmatter.model.trim().length === 0)
    ) {
      report("`model` must be a non-blank string", claimedName);
      continue;
    }

    if (frontmatter.thinking !== undefined && parseThinkingLevel(frontmatter.thinking) === undefined) {
      report(`invalid \`thinking\` value: ${JSON.stringify(frontmatter.thinking)}`, claimedName);
      continue;
    }

    if (frontmatter.turns !== undefined && parseTurnLimit(frontmatter.turns) === undefined) {
      report(`invalid \`turns\` value: ${JSON.stringify(frontmatter.turns)}`, claimedName);
      continue;
    }

    if (frontmatter.tools !== undefined && !isValidToolsField(frontmatter.tools)) {
      report(`invalid \`tools\` value: ${JSON.stringify(frontmatter.tools)}`, claimedName);
      continue;
    }

    agents.push({
      name: claimedName,
      description: frontmatter.description,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      tools: parseToolsList(frontmatter.tools),
      turnLimit: parseTurnLimit(frontmatter.turns),
      thinking: parseThinkingLevel(frontmatter.thinking),
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return { agents, invalidNames };
}

/**
 * Discover agents from global (~/.pi/agent/agents/) and project-local (.pi/agents/) directories.
 * Project agents override user agents with the same name.
 *
 * When `diagnostics` is provided, any invalid definitions found during discovery are pushed
 * into it (file path + reason) instead of aborting discovery. Passing it is optional so
 * existing callers that don't care about diagnostics stay simple.
 */
export function discoverAgents(cwd: string, diagnostics?: AgentDiagnostic[]): AgentConfig[] {
  const agentDir = getAgentDir();
  const userDir = join(agentDir, "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const userResult = loadAgentsFromDir(userDir, "user", diagnostics);
  const projectResult = loadAgentsFromDir(projectDir, "project", diagnostics);

  // Project overrides user on same name
  const byName = new Map<string, AgentConfig>();
  for (const a of userResult.agents) byName.set(a.name, a);
  for (const a of projectResult.agents) byName.set(a.name, a);

  // An invalid project definition must not silently fall back to a same-name global agent —
  // unless a valid project agent with that same name already claimed it.
  const validProjectNames = new Set(projectResult.agents.map((a) => a.name));
  for (const name of projectResult.invalidNames) {
    if (!validProjectNames.has(name)) byName.delete(name);
  }

  // Sort by name for deterministic, cache-stable ordering across sessions
  return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Parse a turn limit value from frontmatter.
 * Returns the number if it is an integer >= 2, else undefined.
 */
export function parseTurnLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value)) return undefined;
  if (value < 2) return undefined;
  return value;
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Parse a thinking level value from frontmatter.
 * Returns the ThinkingLevel if recognized, else undefined.
 * Invalid values are silently ignored (same pattern as parseTurnLimit).
 */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  if (VALID_THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  return undefined;
}

/**
 * Parse tools from frontmatter. Handles:
 * - YAML array: ["read", "bash"]
 * - Comma-separated string: "read, bash"
 * - Absent/null/other: undefined (all tools)
 */
export function parseToolsList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return undefined;
}

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
