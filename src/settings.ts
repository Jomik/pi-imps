import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ImpSettings } from "./types.js";

const DEFAULTS: ImpSettings = {
  turnLimit: 30,
  toolAllowlist: undefined,
  additionalExtensions: [],
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

  return { turnLimit, toolAllowlist, additionalExtensions };
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
