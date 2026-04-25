import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentSource } from "./types.js";

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!existsSync(dir)) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    if (typeof frontmatter.description !== "string") continue;

    const name = typeof frontmatter.name === "string" ? frontmatter.name : entry.name.replace(/\.md$/, "");

    const turnLimit = parseTurnLimit(frontmatter.turns);

    agents.push({
      name,
      description: frontmatter.description,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      tools: parseToolsList(frontmatter.tools),
      turnLimit,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

/**
 * Discover agents from global (~/.pi/agent/agents/) and project-local (.pi/agents/) directories.
 * Project agents override user agents with the same name.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  const agentDir = getAgentDir();
  const userDir = join(agentDir, "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = loadAgentsFromDir(projectDir, "project");

  // Project overrides user on same name
  const byName = new Map<string, AgentConfig>();
  for (const a of userAgents) byName.set(a.name, a);
  for (const a of projectAgents) byName.set(a.name, a);

  return Array.from(byName.values());
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

/**
 * Parse tools from frontmatter. Handles:
 * - YAML array: ["read", "bash"]
 * - Comma-separated string: "read, bash"
 * - Absent/null/other: undefined (all tools)
 */
export function parseToolsList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
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
