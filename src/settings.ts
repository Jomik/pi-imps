import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * Assert that a raw project config has valid object shapes.
 * Throws with a descriptive message on non-object root, non-object `agents` field, or non-object agent entries.
 * Shared between loadProjectConfig and updateProjectAgentTools to avoid duplicate parsing.
 */
function validateProjectConfigShape(raw: unknown): asserts raw is Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Project config root must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if ("agents" in obj) {
    if (obj.agents === null || typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
      throw new Error("Project config 'agents' must be an object");
    }
    for (const [key, value] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Project config entry for '${key}' must be an object`);
      }
    }
  }
}

/**
 * Load project-level imp config from <cwd>/.pi/imps.json.
 * Returns empty config if the file doesn't exist (ENOENT/ENOTDIR).
 * Throws on invalid JSON, read errors (permissions, EISDIR, etc.), or shape-invalid config
 * (non-object root, non-object `agents`, or non-object agent entries).
 */
export function loadProjectConfig(cwd: string): ProjectImpConfig {
  const configPath = join(cwd, ".pi", "imps.json");
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return {};
    }
    throw err;
  }
  const raw = JSON.parse(content);
  validateProjectConfigShape(raw);
  const agents = parseAgentsConfig(raw.agents);
  return { agents };
}

/**
 * Atomically update a single agent's tools in the project `.pi/imps.json`.
 *
 * Preserves all other top-level config, other agents, unknown properties in the
 * target entry, and any tool names in `tools` that are unknown to the session.
 * The caller is responsible for merging unknown preserved tool names into the
 * `tools` array before calling this function.
 *
 * Throws if the existing file cannot be parsed or has a non-object root,
 * agents field, or target agent entry — so the caller can report and avoid
 * silently overwriting a broken config.
 */
export function updateProjectAgentTools(cwd: string, agentName: string, tools: string[]): void {
  const piDir = join(cwd, ".pi");
  const configPath = join(piDir, "imps.json");

  let raw: Record<string, unknown> = {};
  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    validateProjectConfigShape(parsed);
    raw = parsed;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // File absent — will create it below.
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const agents = (raw.agents as Record<string, unknown> | undefined) ?? {};

  // Merge: preserve existing entry properties (unknown keys), update tools.
  const existingEntry = (agents[agentName] as Record<string, unknown> | undefined) ?? {};
  const updatedEntry = { ...existingEntry, tools };

  const newConfig: Record<string, unknown> = {
    ...raw,
    agents: { ...agents, [agentName]: updatedEntry },
  };

  // ponytail: Deliberate single-process read-modify-write. Concurrent parent
  // sessions that write to the same project config can race. Upgrade path:
  // wrap this block with a proper file lock (e.g. proper-lockfile) around the
  // read-modify-write cycle if multi-session writes become necessary.
  //
  // Atomic write: create .pi dir if needed, write to tmp, rename into place.
  mkdirSync(piDir, { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(newConfig, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, configPath);
}
