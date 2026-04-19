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

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.description) continue;

    const name = frontmatter.name ?? entry.name.replace(/\.md$/, "");

    agents.push({
      name,
      description: frontmatter.description,
      model: frontmatter.model,
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
