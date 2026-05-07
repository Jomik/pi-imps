import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
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
 * Load pi-imps settings from the "pi-imps" key in global settings.json.
 * Falls back to defaults for missing fields.
 */
export function loadImpSettings(settingsManager?: SettingsManager): ImpSettings {
  const sm = settingsManager ?? SettingsManager.create(process.cwd(), getAgentDir());
  const raw = sm.getGlobalSettings() as Record<string, unknown>;
  return parseImpSettings(raw["pi-imps"] as Record<string, unknown> | undefined);
}
