import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export interface SpawnImpSessionOptions {
  task: string;
  config: AgentConfig | undefined; // undefined = ephemeral
  cwd: string;
  parentModel: Model<any>;
  modelRegistry: ModelRegistry;
  signal: AbortSignal;
  onTurnEnd: (turns: number) => void;
  onToolActivity: (activity: string) => void;
  onUsageUpdate: (tokens: { input: number; output: number }) => void;
  onComplete: (result: { output: string; error?: string }) => void;
}

/**
 * Spawn an imp session. Returns the AgentSession handle.
 *
 * Creates an in-memory session with pi-imps filtered out of extensions
 * (no recursion). Named agents use their frontmatter model; ephemeral
 * imps inherit the parent model.
 */
export async function spawnImpSession(opts: SpawnImpSessionOptions): Promise<AgentSession> {
  const {
    task, config, cwd, parentModel, modelRegistry, signal,
    onTurnEnd, onToolActivity, onUsageUpdate, onComplete,
  } = opts;

  const systemPrompt = config?.systemPrompt;

  const loader = new DefaultResourceLoader({
    cwd,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: systemPrompt || undefined,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (ext) => !ext.resolvedPath.includes("pi-imps"),
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

  const { session } = await createAgentSession({
    cwd,
    model,
    tools: createCodingTools(cwd),
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

  function extractAssistantText(
    content: Array<{ type: string; text?: string }>,
  ) {
    const parts = content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    lastOutput = parts.map((c) => c.text).join("");
  }

  session.subscribe((event) => {
    if (signal.aborted) return;

    if (event.type === "tool_execution_start") {
      const toolName = event.toolName;
      const argsStr = formatToolArgs(event.args);
      onToolActivity(`→ ${toolName}${argsStr ? " " + argsStr : ""}`);
    }

    if (event.type === "turn_end") {
      turnCount++;
      onTurnEnd(turnCount);
      // Extract usage from the assistant message
      const msg = event.message;
      if (msg.role === "assistant" && "usage" in msg) {
        const u = (msg as any).usage;
        if (u) {
          totalUsage = { input: totalUsage.input + (u.input ?? 0), output: totalUsage.output + (u.output ?? 0) };
          onUsageUpdate(totalUsage);
        }
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
      onComplete({ output: lastOutput });
    })
    .catch((err) => {
      onComplete({
        output: lastOutput,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return session;
}

function formatToolArgs(args: Record<string, unknown>): string {
  // Show first string arg value, truncated
  for (const [, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + "..." : v;
    }
  }
  return "";
}
