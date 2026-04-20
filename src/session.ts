import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSession, Extension, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import type { AgentConfig, ImpSettings } from "./types.js";

const OWN_PACKAGE_NAME = pkg.name;

const FINAL_TURN_DIRECTIVE =
  "FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.";

export interface SpawnImpSessionOptions {
  task: string;
  config: AgentConfig | undefined; // undefined = ephemeral
  cwd: string;
  parentModel: Model<Api>;
  modelRegistry: ModelRegistry;
  signal: AbortSignal;
  settings: ImpSettings;
  onTurnEnd: (turns: number) => void;
  onToolActivity: (activity: string) => void;
  onUsageUpdate: (tokens: { input: number; output: number }) => void;
  onComplete: (result: { output: string; error?: string; truncated?: boolean }) => void;
}

/**
 * Spawn an imp session. Returns the AgentSession handle.
 *
 * Creates an in-memory session with:
 * - pi-imps filtered out (no recursion)
 * - Extensions filtered by tool allowlist (agent frontmatter > settings default)
 * - Additional extensions always loaded
 * - Turn limit with FINAL TURN directive injection
 */
export async function spawnImpSession(opts: SpawnImpSessionOptions): Promise<AgentSession> {
  const {
    task,
    config,
    cwd,
    parentModel,
    modelRegistry,
    signal,
    settings,
    onTurnEnd,
    onToolActivity,
    onUsageUpdate,
    onComplete,
  } = opts;

  const systemPrompt = config?.systemPrompt;

  const toolAllowlist = resolveToolAllowlist(config?.tools, settings.toolAllowlist);

  const loader = new DefaultResourceLoader({
    cwd,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: systemPrompt || undefined,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((ext) =>
        shouldIncludeExtension(ext, toolAllowlist, settings.additionalExtensions),
      ),
    }),
  });
  await loader.reload();

  // Resolve model: named agent's model or parent model
  let model = parentModel;
  if (config?.model) {
    const all = modelRegistry.getAll();
    const resolved = all.find((m) => m.name === config.model || m.id === config.model);
    if (resolved) model = resolved;
  }

  // Create core tools, filtered by allowlist
  let tools = createCodingTools(cwd);
  if (toolAllowlist) {
    tools = tools.filter((t) => toolAllowlist.includes(t.name));
  }

  const { session } = await createAgentSession({
    cwd,
    model,
    tools,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(),
    modelRegistry,
    resourceLoader: loader,
  });

  // Bind extensions with no UI context (headless imp)
  await session.bindExtensions({ shutdownHandler: async () => {} });

  // Wire event subscription for progress tracking
  let turnCount = 0;
  let lastOutput = "";
  let totalUsage = { input: 0, output: 0 };
  let truncated = false;

  const turnLimit = settings.turnLimit;

  function extractAssistantText(content: Array<{ type: string; text?: string }>) {
    const parts = content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    lastOutput = parts.map((c) => c.text).join("");
  }

  session.subscribe((event) => {
    if (signal.aborted) return;

    if (event.type === "tool_execution_start") {
      const toolName = event.toolName;
      const argsStr = formatToolArgs(event.args);
      onToolActivity(`→ ${toolName}${argsStr ? ` ${argsStr}` : ""}`);
    }

    if (event.type === "turn_end") {
      turnCount++;
      onTurnEnd(turnCount);
      // Extract usage from the assistant message
      const msg = event.message;
      if (msg.role === "assistant" && "usage" in msg) {
        const { usage: u } = msg;
        totalUsage = {
          input: totalUsage.input + u.input,
          output: totalUsage.output + u.output,
        };
        onUsageUpdate(totalUsage);
      }

      // Turn limit: inject FINAL TURN directive on the penultimate turn
      // so the agent sees it during its final (last) turn
      if (turnCount === turnLimit - 1) {
        session.steer(FINAL_TURN_DIRECTIVE).catch(() => {});
      }

      // Turn limit: abort after the final turn
      if (turnCount >= turnLimit) {
        truncated = true;
        session.abort().catch(() => {});
      }
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const msg = event.message;
      if (msg.role === "assistant" && msg.content) {
        extractAssistantText(msg.content);
      }
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message;
      if (msg.content) {
        extractAssistantText(msg.content);
      }
    }
  });

  // Start the session — non-blocking, completion handled via promise
  session
    .prompt(task)
    .then(() => {
      onComplete({ output: lastOutput, truncated });
    })
    .catch((err) => {
      // Abort due to truncation is not an error
      if (truncated) {
        onComplete({ output: lastOutput, truncated: true });
        return;
      }
      onComplete({
        output: lastOutput,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return session;
}

/**
 * Resolve tool allowlist: agent frontmatter > settings default > all.
 * Returns undefined (all tools) or a string array (only those tools).
 */
export function resolveToolAllowlist(
  agentTools: string[] | undefined,
  settingsTools: string[] | undefined,
): string[] | undefined {
  return agentTools ?? settingsTools;
}

/**
 * Decide whether an extension should be included in an imp session.
 *
 * - pi-imps is always excluded (no recursion)
 * - Additional extensions always included
 * - If no allowlist, all extensions included
 * - Otherwise, only extensions providing at least one allowed tool
 */
export function shouldIncludeExtension(
  ext: Extension,
  toolAllowlist: string[] | undefined,
  additionalExtensions: string[],
  name?: string,
): boolean {
  const extName = name ?? getExtensionPackageName(ext);

  // Always exclude ourselves (no recursion)
  if (extName === OWN_PACKAGE_NAME) return false;

  // Additional extensions always load
  if (extName && additionalExtensions.includes(extName)) return true;

  // If no allowlist, keep everything
  if (!toolAllowlist) return true;

  // Keep extension only if it provides at least one allowed tool
  const extToolNames = Array.from(ext.tools.keys());
  return extToolNames.some((t) => toolAllowlist.includes(t));
}

/**
 * Resolve the package name of an extension.
 *
 * Package extensions: read name from baseDir/package.json.
 * Top-level extensions: extract segment after baseDir/extensions/,
 * try package.json in that dir, fall back to segment name.
 */
export function getExtensionPackageName(ext: Extension): string | undefined {
  const si = ext.sourceInfo;

  // Package extensions: read from baseDir/package.json
  if (si.origin === "package" && si.baseDir) {
    return readPackageName(join(si.baseDir, "package.json"));
  }

  // Top-level: extract segment after baseDir/extensions/
  if (si.baseDir) {
    const prefix = `${si.baseDir}/extensions/`;
    if (si.path.startsWith(prefix)) {
      const segment = si.path.slice(prefix.length).split("/")[0];
      const pkgName = readPackageName(join(si.baseDir, "extensions", segment, "package.json"));
      if (pkgName) return pkgName;
      // Single-file extension: use filename without .ts
      return segment.replace(/\.ts$/, "");
    }
  }

  return undefined;
}

function readPackageName(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const name = JSON.parse(readFileSync(path, "utf-8")).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function formatToolArgs(args: Record<string, unknown>): string {
  // Show first string arg value, truncated
  for (const [, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? `${v.slice(0, 57)}...` : v;
    }
  }
  return "";
}
