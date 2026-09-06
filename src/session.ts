import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  Extension,
  ExtensionFactory,
  ModelRegistry,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import { loadProjectConfig } from "./settings.js";
import type { AgentConfig, ImpSettings, ThinkingLevel } from "./types.js";

export type { ThinkingLevel };

const OWN_PACKAGE_NAME = pkg.name;

type SdkThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
const MAX_COMPAT_THINKING_LEVEL: SdkThinkingLevel = "xhigh";

/** Map host-only levels to the highest level supported by the local SDK boundary. */
export function resolveImpThinkingLevel(level: ThinkingLevel): SdkThinkingLevel {
  return level === "max" ? MAX_COMPAT_THINKING_LEVEL : (level as SdkThinkingLevel);
}

const FINAL_TURN_DIRECTIVE =
  "FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.";

/**
 * Path prefix `DefaultResourceLoader` assigns to extensions loaded from an
 * inline `ExtensionFactory` (as opposed to a file on disk). pi-imps registers
 * exactly one such inline extension per imp session (the empty-error
 * normalizer below), so this prefix uniquely identifies it.
 */
const INLINE_EXTENSION_PATH_PREFIX = "<inline:";

/**
 * True when a nominally-failed tool result carries no meaningful content:
 * no content blocks, or only empty/whitespace text blocks. Image content
 * always counts as meaningful.
 */
function isEmptyToolResultContent(content: ToolResultEvent["content"]): boolean {
  if (content.length === 0) return true;
  return content.every((block) => block.type === "text" && block.text.trim() === "");
}

/**
 * Named `tool_result` handler that normalizes empty error results before
 * provider serialization. Left as a standalone named function (rather than
 * inline arrow) so it's identifiable in stack traces / debugging.
 */
export function normalizeEmptyToolError(event: ToolResultEvent): ToolResultEventResult | void {
  if (!event.isError) return;
  if (!isEmptyToolResultContent(event.content)) return;
  return {
    content: [{ type: "text", text: `Tool "${event.toolName}" failed without an error message` }],
  };
}

/**
 * Build the hidden inline extension that registers `normalizeEmptyToolError`
 * on every imp child session. Not user-visible, provides no LLM-callable
 * tools, and is never persisted or logged.
 */
function createEmptyErrorNormalizerExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", normalizeEmptyToolError);
  };
}

export interface SpawnImpSessionOptions {
  task: string;
  config: AgentConfig;
  cwd: string;
  parentModel: Model<Api>;
  parentThinkingLevel: ThinkingLevel;
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
    parentThinkingLevel,
    modelRegistry,
    signal,
    settings,
    onTurnEnd,
    onToolActivity,
    onUsageUpdate,
    onComplete,
  } = opts;

  const systemPrompt = config.systemPrompt;

  // Load project config and resolve per-agent additive tools
  const projectConfig = loadProjectConfig(cwd);
  const agentKey = config.name;
  const globalAgentTools = settings.agents[agentKey]?.tools;
  const projectAgentTools = projectConfig.agents?.[agentKey]?.tools;
  const additiveTools = mergeAdditiveTools(globalAgentTools, projectAgentTools);

  const toolAllowlist = resolveToolAllowlist(config.tools, settings.toolAllowlist, additiveTools);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: systemPrompt || undefined,
    extensionFactories: [createEmptyErrorNormalizerExtension()],
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
  if (config.model) {
    const available = modelRegistry.getAvailable();
    const resolved = available.find((m) => m.name === config.model || m.id === config.model);
    if (!resolved) {
      throw new Error(`Model "${config.model}" not found in registry`);
    }
    model = resolved;
  }

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: resolveImpThinkingLevel(config.thinking ?? parentThinkingLevel),
    tools: toolAllowlist,
    sessionManager: SessionManager.inMemory(),
    settingsManager: createImpSettingsManager(cwd),
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
  let providerError: string | undefined;
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;

  const turnLimit = resolveTurnLimit(config.turnLimit, settings.turnLimit);

  function extractAssistantText(content: Array<{ type: string; text?: string }>) {
    const parts = content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    lastOutput = parts.map((c) => c.text).join("");
  }

  session.subscribe((event) => {
    if (signal.aborted) return;

    if (event.type === "auto_retry_end" && !event.success) {
      providerError = event.finalError ?? "Provider request failed";
    }

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
      lastStopReason = msg.stopReason;
      lastErrorMessage = msg.errorMessage;
    }
  });

  // Start the session — non-blocking, completion handled via promise
  session
    .prompt(task)
    .then(() => {
      if (truncated) {
        onComplete({ output: lastOutput, truncated: true });
        return;
      }
      if (lastStopReason === "error" || lastStopReason === "aborted" || lastStopReason === "length") {
        onComplete({ output: lastOutput, error: resolveCompletionError() });
        return;
      }
      if (lastOutput.trim() === "") {
        onComplete({ output: lastOutput, error: resolveCompletionError() });
        return;
      }
      onComplete({ output: lastOutput });
    })
    .catch((err) => {
      // Abort due to truncation is not an error
      if (truncated) {
        onComplete({ output: lastOutput, truncated: true });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      onComplete({
        output: lastOutput,
        error: message || "Imp session rejected with no error message",
      });
    });

  function resolveCompletionError(): string {
    const agentStateError = session.state.errorMessage;
    return (
      lastErrorMessage ||
      agentStateError ||
      providerError ||
      `Imp failed to complete (stopReason: ${lastStopReason ?? "unknown"})`
    );
  }

  return session;
}

/**
 * Resolve tool allowlist: agent frontmatter > settings default > all.
 * additiveTools are unioned in when the base is defined (project/global can only add).
 * Returns undefined (all tools) or a string array (only those tools).
 */
export function resolveToolAllowlist(
  agentTools: string[] | undefined,
  settingsTools: string[] | undefined,
  additiveTools?: string[],
): string[] | undefined {
  const base = agentTools ?? settingsTools;
  // If base is undefined → all tools; project config can't restrict further
  if (base === undefined) return undefined;
  // Base is defined (possibly empty); union with additive tools
  if (!additiveTools || additiveTools.length === 0) return base;
  const result = [...base];
  for (const tool of additiveTools) {
    if (!result.includes(tool)) result.push(tool);
  }
  return result;
}

/** Union two optional tool arrays, deduplicating. Returns undefined if both are absent. */
function mergeAdditiveTools(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Resolve turn limit: agent frontmatter > settings default.
 */
export function resolveTurnLimit(agentLimit: number | undefined, settingsLimit: number): number {
  return agentLimit ?? settingsLimit;
}

/**
 * Create a settings manager for imp sessions with only runtime settings copied.
 *
 * Imps deliberately do not receive the caller's full settings because resource
 * loading, model selection, persistence, and UI behavior are controlled by
 * pi-imps. Runtime settings keep built-in tools and provider behavior aligned
 * with the user's environment without expanding the imp configuration surface.
 */
export function createImpSettingsManager(
  cwd: string,
  settingsManager: SettingsManager = SettingsManager.create(cwd, getAgentDir()),
): SettingsManager {
  const settings = {
    ...settingsManager.getGlobalSettings(),
    ...settingsManager.getProjectSettings(),
  };

  return SettingsManager.inMemory({
    branchSummary: settings.branchSummary,
    compaction: settings.compaction,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    enableInstallTelemetry: settings.enableInstallTelemetry,
    followUpMode: settings.followUpMode,
    images: settings.images,
    retry: settings.retry,
    shellCommandPrefix: settings.shellCommandPrefix,
    shellPath: settings.shellPath,
    steeringMode: settings.steeringMode,
    thinkingBudgets: settings.thinkingBudgets,
    transport: settings.transport,
  });
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
  // Inline extensions registered by pi-imps itself (e.g. the empty-error
  // normalizer) always load: they provide no LLM-callable tools and would
  // otherwise be filtered out by an allowlist.
  if (ext.path.startsWith(INLINE_EXTENSION_PATH_PREFIX)) return true;

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
 * Walks up the directory tree from `ext.resolvedPath` (falling back to
 * `ext.path`) looking for the nearest `package.json` and returns its `name`
 * field.  This is independent of `ext.sourceInfo`, which may not yet have
 * been populated by `applyExtensionSourceInfo()` at the time the
 * `extensionsOverride` callback fires.
 *
 * Falls back to the resolved file's basename without `.ts` if no
 * `package.json` is found anywhere up to the filesystem root.
 */
export function getExtensionPackageName(ext: Extension): string | undefined {
  const resolvedPath = ext.resolvedPath || ext.path;
  if (!resolvedPath) return undefined;

  // Walk up from the file's directory to find the nearest package.json
  let dir = dirname(resolvedPath);
  for (;;) {
    const pkgName = readPackageName(join(dir, "package.json"));
    if (pkgName !== undefined) return pkgName;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback: filename without .ts
  const base = basename(resolvedPath);
  return base.replace(/\.ts$/, "") || undefined;
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
