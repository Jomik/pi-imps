import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatImpStatusDisplay, formatSummonDisplay, formatWaitDisplay } from "./display.js";
import { spawnImpSession } from "./session.js";
import { allImps, findImp, uncollectedImps } from "./state.js";
import type { AgentConfig, Imp, ImpSettings } from "./types.js";

// ─── LLM result formatting (JSON) ────────────────────────────────────────────

function impToJson(imp: Imp): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    name: imp.name,
    status: imp.status,
  };
  if (imp.agentName !== "ephemeral") obj.agent = imp.agentName;
  if (imp.status === "failed" && imp.error) obj.error = imp.error;
  if (imp.output) obj.output = imp.output;
  return obj;
}

// ─── summon ────────────────────────────────────────────────────────────────

const SummonParams = Type.Object({
  task: Type.String({ description: "What the imp should do" }),
  agent: Type.Optional(Type.String({ description: "Named agent to use, or omit for ephemeral" })),
});

interface SummonDetails {
  name: string;
  agentName: string;
}

export function summonTool(
  imps: Map<string, Imp>,
  agents: () => AgentConfig[],
  namePool: { allocate(): string; release(name: string): void },
  settings: () => ImpSettings,
): ToolDefinition<typeof SummonParams, SummonDetails | undefined> {
  return {
    name: "summon",
    label: "Summon Imp",
    description:
      "Summon an imp to work on a task in the background. Returns immediately with a name. Use wait to collect results.",
    promptSnippet: "Summon an imp for background task delegation",
    promptGuidelines: ["You can summon multiple imps (including parallel tool calls), then wait for all or first."],
    parameters: SummonParams,
    async execute(
      _toolCallId: string,
      params: { task: string; agent?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ) {
      const name = namePool.allocate();

      // Resolve agent config
      let config: AgentConfig | undefined;
      let agentName = "ephemeral";
      if (params.agent) {
        config = agents().find((a) => a.name === params.agent);
        if (!config) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown agent: ${params.agent}. Available: ${
                  agents()
                    .map((a) => a.name)
                    .join(", ") || "none"
                }`,
              },
            ],
            details: undefined,
          };
        }
        agentName = config.name;
      }

      // Create done promise for wait coordination
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const controller = new AbortController();

      const imp: Imp = {
        name,
        agentName,
        task: params.task,
        status: "running",
        startedAt: Date.now(),
        turns: 0,
        tokens: { input: 0, output: 0 },
        controller,
        done,
        resolveDone,
      };

      imps.set(name, imp);

      // Spawn session — fire and forget
      const parentModel = ctx.model;
      if (!parentModel) {
        imp.status = "failed";
        imp.error = "No model available";
        imp.completedAt = Date.now();
        resolveDone();
        return {
          content: [{ type: "text", text: "Failed to summon: no model available" }],
          details: undefined,
        };
      }

      spawnImpSession({
        task: params.task,
        config,
        cwd: ctx.cwd,
        parentModel,
        modelRegistry: ctx.modelRegistry,
        signal: controller.signal,
        settings: settings(),
        onTurnEnd: (turns) => {
          imp.turns = turns;
        },
        onToolActivity: (activity) => {
          imp.activity = activity;
        },
        onUsageUpdate: (tokens) => {
          imp.tokens = tokens;
        },
        onComplete: (result) => {
          if (imp.status === "dismissed") return; // already dismissed
          imp.output = result.output;
          imp.completedAt = Date.now();
          if (result.truncated) {
            imp.status = "truncated";
          } else if (result.error) {
            imp.status = "failed";
            imp.error = result.error;
          } else {
            imp.status = "completed";
          }
          namePool.release(imp.name);
          resolveDone();
        },
      })
        .then((session) => {
          if (imp.status === "dismissed") {
            // Dismissed before session was ready — abort now
            session.abort().catch(() => {});
            return;
          }
          imp.session = session;
        })
        .catch((err) => {
          if (imp.status === "dismissed") return; // already dismissed
          imp.status = "failed";
          imp.error = err instanceof Error ? err.message : String(err);
          imp.completedAt = Date.now();
          namePool.release(imp.name);
          resolveDone();
        });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name,
              ...(agentName !== "ephemeral" && { agent: agentName }),
            }),
          },
        ],
        details: { name, agentName },
      };
    },
    renderResult(result, _options, theme: Theme, context) {
      const details = result.details as SummonDetails | undefined;
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (details) {
        text.setText(formatSummonDisplay(details.name, details.agentName, theme));
      } else {
        // Fallback (error cases)
        const msg = result.content[0];
        text.setText(msg?.type === "text" ? msg.text : "");
      }
      return text;
    },
  };
}

// ─── wait ──────────────────────────────────────────────────────────────────

const WaitParams = Type.Object({
  mode: Type.Union([Type.Literal("all"), Type.Literal("first")], {
    description: "all: wait for every imp, first: return when any completes",
  }),
  names: Type.Optional(
    Type.Array(Type.String(), {
      description: "Wait for specific imps only (default: all uncollected)",
    }),
  ),
});

interface WaitDetails {
  imps: Imp[];
}

export function waitTool(
  imps: Map<string, Imp>,
): ToolDefinition<typeof WaitParams, WaitDetails, { animationFrame: number }> {
  return {
    name: "wait",
    label: "Wait for Imps",
    description:
      "Block until imps complete. Streams live progress. mode=all waits for every uncollected imp, mode=first returns when any one completes.",
    promptGuidelines: [
      "Collected imps are removed from the session. Failures are returned as results, not exceptions.",
      "wait({ mode: 'first' }) returns the first to complete; others keep running. Call wait again or dismiss.",
    ],
    parameters: WaitParams,
    async execute(
      _toolCallId: string,
      params: { mode: "all" | "first"; names?: string[] },
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WaitDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WaitDetails>> {
      let waiting = uncollectedImps(imps);
      if (params.names) {
        const nameSet = new Set(params.names);
        waiting = waiting.filter((imp) => nameSet.has(imp.name));
      }

      if (waiting.length === 0) {
        return {
          content: [{ type: "text", text: "No uncollected imps to wait for." }],
          details: { imps: [] },
        };
      }

      // Stream progress via onUpdate at intervals
      const emitUpdate = () => {
        if (!onUpdate) return;
        onUpdate({
          content: [
            {
              type: "text",
              text: JSON.stringify(waiting.map(impToJson)),
            },
          ],
          details: { imps: waiting },
        });
      };

      const interval = setInterval(emitUpdate, 200);

      // Also emit immediately
      emitUpdate();

      try {
        let resolved: Imp[];

        if (params.mode === "all") {
          await Promise.all(waiting.map((imp) => imp.done));
          resolved = waiting.filter((imp) => imp.status !== "dismissed");
        } else {
          // Race: resolve with the actual winner, not insertion order
          const winner = await Promise.race(waiting.map((imp) => imp.done.then(() => imp)));
          resolved = winner && winner.status !== "dismissed" ? [winner] : [];
        }

        // Remove collected imps from map
        for (const imp of resolved) {
          imps.delete(imp.name);
        }

        // Final update
        emitUpdate();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(resolved.map(impToJson)),
            },
          ],
          details: { imps: resolved },
        };
      } finally {
        clearInterval(interval);
      }
    },
    renderCall(args, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const mode = args.mode === "first" ? "race" : "all";
      text.setText(`${theme.fg("toolTitle", theme.bold("wait"))} ${theme.fg("dim", mode)}`);
      return text;
    },
    renderResult(result, _options, theme: Theme, context) {
      const mode = context.args?.mode ?? "all";
      context.state.animationFrame = (context.state.animationFrame ?? 0) + 1;
      const compact = formatWaitDisplay(result.details?.imps ?? [], mode, theme, context.state.animationFrame);
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(compact);
      return text;
    },
  };
}

// ─── dismiss ───────────────────────────────────────────────────────────────

const DismissParams = Type.Object({
  name: Type.String({ description: 'Imp name or "all"' }),
});

interface DismissDetails {
  names: string[];
}

export function dismissTool(
  imps: Map<string, Imp>,
  namePool: { allocate(): string; release(name: string): void },
): ToolDefinition<typeof DismissParams, DismissDetails | undefined> {
  return {
    name: "dismiss",
    label: "Dismiss Imp",
    description: 'Dismiss imp(s) and remove from session. Pass an imp name or "all".',
    parameters: DismissParams,
    async execute(
      _toolCallId: string,
      params: { name: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ) {
      const dismissed: Imp[] = [];

      if (params.name === "all") {
        for (const imp of imps.values()) {
          if (imp.status === "running") {
            dismissImp(imp, namePool);
          }
          dismissed.push(imp);
        }
        imps.clear();
      } else {
        const imp = findImp(imps, params.name);
        if (!imp) {
          return {
            content: [{ type: "text", text: `No imp found: ${params.name}` }],
            details: undefined,
          };
        }
        if (imp.status === "running") {
          dismissImp(imp, namePool);
        }
        imps.delete(imp.name);
        dismissed.push(imp);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              dismissed: dismissed.map((i) => i.name),
            }),
          },
        ],
        details: { names: dismissed.map((i) => i.name) },
      };
    },
    renderResult(result, _options, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details as DismissDetails | undefined;
      if (details && details.names.length > 0) {
        text.setText(
          theme.fg("dim", "Dismissed ") + details.names.map((n) => theme.fg("accent", n)).join(theme.fg("dim", ", ")),
        );
      } else {
        const msg = result.content[0];
        text.setText(theme.fg("dim", msg?.type === "text" ? msg.text : ""));
      }
      return text;
    },
  };
}

function dismissImp(imp: Imp, namePool: { release(name: string): void }): void {
  imp.status = "dismissed";
  imp.completedAt = Date.now();
  imp.controller.abort();
  imp.session?.abort().catch(() => {});
  imp.resolveDone();
  namePool.release(imp.name);
}

// ─── list_imps ─────────────────────────────────────────────────────────────

const ListImpsParams = Type.Object({});

export function listImpsTool(imps: Map<string, Imp>): ToolDefinition<typeof ListImpsParams, Imp[]> {
  return {
    name: "list_imps",
    label: "List Imps",
    description: "List running and recently completed imps with status and basic stats.",
    promptGuidelines: ["Shows status only, not imp output. Use wait to collect full results."],
    parameters: ListImpsParams,
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<Imp[]>> {
      const all = allImps(imps);
      const text = JSON.stringify(all.map(impToJson));
      return {
        content: [{ type: "text", text }],
        details: all,
      };
    },
    renderResult(result, _options, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = result.details ?? [];
      if (details.length === 0) {
        text.setText(theme.fg("dim", "No imps."));
      } else {
        text.setText(details.map((imp) => formatImpStatusDisplay(imp, theme, imp.name.charCodeAt(0))).join("\n"));
      }
      return text;
    },
  };
}

// ─── helpers for shutdown ──────────────────────────────────────────────────

export function dismissAllImps(imps: Map<string, Imp>, namePool: { release(name: string): void }): void {
  for (const imp of imps.values()) {
    if (imp.status === "running") {
      dismissImp(imp, namePool);
    }
  }
}
