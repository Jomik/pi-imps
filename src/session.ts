import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  Extension,
  ExtensionFactory,
  ModelRegistry,
  ModelRuntime,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultPackageManager,
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

/**
 * Extract the `ModelRuntime` backing a `ModelRegistry` compatibility facade.
 *
 * `createAgentSession` (pi >=0.80.8) accepts `modelRuntime`, not the removed
 * `modelRegistry` option. `ModelRegistry` wraps a `ModelRuntime` in a private
 * `runtime` field; we read it directly rather than silently constructing a
 * fresh runtime, which would lose the parent's configured providers/auth.
 * Throws if the backing runtime is absent, e.g. after an incompatible pi SDK
 * upgrade changes the field name.
 */
export function getBackingModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
  const runtime = (modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) {
    throw new Error(
      "pi-imps: ModelRegistry has no backing ModelRuntime — incompatible @earendil-works/pi-coding-agent version",
    );
  }
  return runtime;
}

export const FINAL_TURN_DIRECTIVE =
  "FINAL TURN. Do not start new work. Save any pending changes, commit your progress, and respond with: (1) what you completed, (2) what remains unfinished.";

/**
 * Path `DefaultResourceLoader` assigns to the first inline factory
 * (index 0 → `<inline:1>`). `InlineExtension` always comes first, before
 * any named builtin factories, so this path deterministically identifies it.
 */
const INLINE_EXTENSION_PATH = "<inline:1>";

/**
 * True when a nominally-failed tool result carries no meaningful content:
 * no content blocks, or only empty/whitespace text blocks. Image content
 * always counts as meaningful.
 */
function isEmptyToolResultContent(content: ToolResultEvent["content"]): boolean {
  if (content.length === 0) return true;
  return content.every((block) => block.type === "text" && block.text.trim() === "");
}

/** Normalizes empty error tool results before provider serialization. */
export function normalizeEmptyToolError(event: ToolResultEvent) {
  if (!event.isError) return undefined;
  if (!isEmptyToolResultContent(event.content)) return undefined;
  return {
    content: [{ type: "text" as const, text: `Tool "${event.toolName}" failed without an error message` }],
  };
}

/** Hidden inline extension registering `normalizeEmptyToolError` on every imp child session. */
const InlineExtension: ExtensionFactory = (pi) => {
  pi.on("tool_result", normalizeEmptyToolError);
};

export interface ImpResourceLoader {
  loader: DefaultResourceLoader;
  toolAllowlist: string[] | undefined;
}

/**
 * Build the `DefaultResourceLoader` and resolved tool allowlist shared by
 * in-process imp spawning and Orca launch preparation.
 *
 * The caller is responsible for `await loader.reload()` before reading
 * `loader.getExtensions()` or passing the loader to `createAgentSession`.
 */
export async function buildImpResourceLoader(
  cwd: string,
  config: AgentConfig,
  settings: ImpSettings,
): Promise<ImpResourceLoader> {
  const projectConfig = loadProjectConfig(cwd);
  const agentKey = config.name;
  const globalAgentTools = settings.agents[agentKey]?.tools;
  const projectAgentTools = projectConfig.agents?.[agentKey]?.tools;
  const additiveTools = mergeAdditiveTools(globalAgentTools, projectAgentTools);

  const toolAllowlist = resolveToolAllowlist(config.tools, settings.toolAllowlist, additiveTools);
  const extensionFactories: NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]> =
    [InlineExtension];
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager,
  });
  const requestedPaths = new Map<string, string[]>();
  for (const source of new Set(settings.additionalExtensions)) {
    try {
      const paths = source.startsWith("builtin:")
        ? [source]
        : (await packageManager.resolveExtensionSources([source], { temporary: true })).extensions
            .filter((resource) => resource.enabled)
            .map((resource) => resource.path);
      if (paths.length === 0) throw new Error("source is missing or contains no enabled extensions");
      for (const path of paths) {
        if (
          readPackageName(join(path, "package.json")) === OWN_PACKAGE_NAME ||
          getExtensionPackageName({ path, resolvedPath: path } as Extension) === OWN_PACKAGE_NAME
        ) {
          throw new Error("pi-imps cannot be requested: imps are leaf workers and cannot spawn recursive sessions");
        }
      }
      requestedPaths.set(source, paths);
    } catch (error) {
      throw new Error(`additionalExtensions: "${source}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const additionalExtensionPaths = [...new Set([...requestedPaths.values()].flat())];
  const codemodeGranted = toolAllowlist?.includes("codemode");
  const codemodeRequested = requestedPaths.has("builtin:codemode");
  if (codemodeGranted || codemodeRequested) {
    // Older supported SDKs lack this export; ordinary sessions must still work.
    const createCodemodeExtension = (
      piSdk as typeof piSdk & {
        createCodemodeExtension?: (options: { mode: "on" }) => ExtensionFactory;
      }
    ).createCodemodeExtension;
    if (typeof createCodemodeExtension !== "function") {
      throw new Error(
        `pi-imps: explicit codemode grants or additionalExtensions source "builtin:codemode" require Pi's createCodemodeExtension factory; upgrade @earendil-works/pi-coding-agent to 0.99.2 or newer, or remove codemode from the imp's tool grants and additionalExtensions`,
      );
    }
    const codemode = {
      name: "codemode",
      builtin: true,
      replaceable: true,
      factory: createCodemodeExtension({ mode: "on" }),
    };
    extensionFactories.push(codemode);
    if (!additionalExtensionPaths.includes("builtin:codemode")) additionalExtensionPaths.push("builtin:codemode");
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: config.systemPrompt || undefined,
    extensionFactories,
    ...(additionalExtensionPaths.length ? { additionalExtensionPaths } : {}),
    extensionsOverride: (base) => {
      for (const [source, paths] of requestedPaths) {
        for (const path of paths) {
          const identity = extensionPathIdentity(path);
          const error = base.errors.find((entry) => extensionPathIdentity(entry.path) === identity);
          if (error) throw new Error(`additionalExtensions: "${source}" (${path}): ${error.error}`);
          if (!base.extensions.some((ext) => extensionPathIdentity(ext.resolvedPath || ext.path) === identity)) {
            throw new Error(`additionalExtensions: "${source}" (${path}): requested extension was not loaded`);
          }
        }
      }
      return {
        ...base,
        extensions: selectImpExtensions(base.extensions, toolAllowlist, additionalExtensionPaths),
      };
    },
  });

  return { loader, toolAllowlist };
}

/**
 * Require each requested flag to be boolean on exactly one selected extension.
 * Duplicate registrations are ambiguous even if both declare a boolean flag.
 */
export function validateImpFlags(requested: string[], selected: Extension[]): string[] {
  for (const name of requested) {
    const registrations = selected.flatMap((ext) => {
      const flag = ext.flags.get(name);
      return flag ? [flag] : [];
    });
    if (registrations.length !== 1 || registrations[0].type !== "boolean") {
      const reason =
        registrations.length === 0
          ? "is not registered by a selected extension"
          : registrations.length > 1
            ? "is registered by multiple selected extensions"
            : "is not a boolean flag";
      throw new Error(`impFlags: "${name}" ${reason}; check the imp's tool allowlist and additionalExtensions`);
    }
  }
  return [...new Set(requested)];
}

/**
 * Resolve the model an imp session/launch uses: the named agent's configured
 * model, or the parent session's model when the agent has none.
 */
export function resolveImpModel(
  config: AgentConfig,
  parentModel: Model<Api>,
  modelRegistry: ModelRegistry,
): Model<Api> {
  if (!config.model) return parentModel;
  const available = modelRegistry.getAvailable();
  const resolved = available.find((m) => m.name === config.model || m.id === config.model);
  if (!resolved) {
    throw new Error(`Model "${config.model}" not found in registry`);
  }
  return resolved;
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

  // Load project config and resolve per-agent additive tools, plus extensions
  const { loader, toolAllowlist } = await buildImpResourceLoader(cwd, config, settings);
  await loader.reload();

  // Validate against the loader's selected extensions before creating a worker.
  const impFlags = validateImpFlags(settings.impFlags, loader.getExtensions().extensions);

  // Resolve model: named agent's model or parent model
  const model = resolveImpModel(config, parentModel, modelRegistry);

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: resolveImpThinkingLevel(config.thinking ?? parentThinkingLevel),
    tools: toolAllowlist,
    sessionManager: SessionManager.inMemory(),
    settingsManager: createImpSettingsManager(cwd),
    modelRuntime: getBackingModelRuntime(modelRegistry),
    resourceLoader: loader,
  });

  for (const name of impFlags) session.extensionRunner.setFlagValue(name, true);

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
  // pi-imps's own hidden inline extension always loads regardless of allowlist.
  if (ext.path === INLINE_EXTENSION_PATH) return true;

  const extName = name ?? getExtensionPackageName(ext);

  // Always exclude ourselves (no recursion)
  if (extName === OWN_PACKAGE_NAME) return false;

  // Additional extensions always load
  if (
    additionalExtensions.some(
      (path) => extensionPathIdentity(path) === extensionPathIdentity(ext.resolvedPath || ext.path),
    )
  ) {
    return true;
  }

  // If no allowlist, keep everything
  if (!toolAllowlist) return true;

  // Keep extension only if it provides at least one allowed tool
  const extToolNames = Array.from(ext.tools.keys());
  return extToolNames.some((t) => toolAllowlist.includes(t));
}

/**
 * Select the subset of extensions to load for an imp session.
 *
 * Pure filter over `shouldIncludeExtension`; does not mutate `extensions`.
 * Returns the original `Extension` objects (with their `resolvedPath`s)
 * unchanged so callers can derive source information from the result.
 */
export function selectImpExtensions(
  extensions: Extension[],
  toolAllowlist: string[] | undefined,
  additionalExtensions: string[],
): Extension[] {
  return extensions.filter((ext) => shouldIncludeExtension(ext, toolAllowlist, additionalExtensions));
}

/**
 * Resolve the package name of an extension (or its name for builtin: identifiers).
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
  // Builtin identifiers are not files; walking from them can find pi-imps itself.
  if (ext.path?.startsWith("builtin:")) return ext.path.slice("builtin:".length);
  const resolvedPath = extensionPathIdentity(ext.resolvedPath || ext.path);
  if (!resolvedPath) return undefined;
  if (resolvedPath.startsWith("builtin:")) return resolvedPath.slice("builtin:".length);

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

/** Match Pi's canonical-path deduplication, preserving builtin and inline identifiers. */
function extensionPathIdentity(path: string): string {
  if (path.startsWith("builtin:") || path.startsWith("<")) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
