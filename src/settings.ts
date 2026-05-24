import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ImpSettings, ProjectImpConfig } from "./types.js";

const DEFAULTS: ImpSettings = {
  turnLimit: 30,
  toolAllowlist: undefined,
  additionalExtensions: [],
  agents: {},
};

/**
 * Parse imp settings from a raw settings block.
 * Exported for testing.
 */
export function parseImpSettings(block: Record<string, unknown> | undefined): ImpSettings {
  if (!block || typeof block !== "object") return { ...DEFAULTS };

  const turnLimit = typeof block.turnLimit === "number" && block.turnLimit >= 2 ? block.turnLimit : DEFAULTS.turnLimit;

  const toolAllowlist = Array.isArray(block.toolAllowlist) ? (block.toolAllowlist as string[]) : DEFAULTS.toolAllowlist;

  const additionalExtensions = Array.isArray(block.additionalExtensions)
    ? (block.additionalExtensions as string[])
    : DEFAULTS.additionalExtensions;

  const agents = parseAgentsConfig(block.agents);

  return { turnLimit, toolAllowlist, additionalExtensions, agents };
}

/** Parse and validate a raw agents config object. */
function parseAgentsConfig(raw: unknown): Record<string, { tools?: string[] }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, { tools?: string[] }> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      const tools = Array.isArray(entry.tools)
        ? entry.tools.filter((v): v is string => typeof v === "string" && v.length > 0)
        : undefined;
      result[key] = tools !== undefined ? { tools } : {};
    }
  }
  return result;
}

/**
 * Load pi-imps settings from ~/.pi/agent/imps.json.
 * Returns defaults if the file doesn't exist.
 * Throws on invalid JSON or read errors (permissions, etc.).
 */
export function loadImpSettings(agentDir?: string): ImpSettings {
  const dir = agentDir ?? getAgentDir();
  const configPath = join(dir, "imps.json");
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULTS };
    }
    throw err;
  }
  const raw = JSON.parse(content);
  return parseImpSettings(raw);
}

/**
 * Load project-level imp config from <cwd>/.pi/imps.json.
 * Returns empty config if the file doesn't exist.
 * Throws on invalid JSON or read errors (permissions, etc.).
 */
export function loadProjectConfig(cwd: string): ProjectImpConfig {
  const configPath = join(cwd, ".pi", "imps.json");
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return {};
    }
    throw err;
  }
  const raw = JSON.parse(content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const agents = parseAgentsConfig(raw.agents);
  return { agents };
}
