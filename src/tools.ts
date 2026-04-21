import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  formatDismissResult,
  formatImpStatus,
  formatSummonResult,
  formatWaitResult,
  formatWaitResultCompact,
} from "./format.js";
import { spawnImpSession } from "./session.js";
import { allImps, findImp, uncollectedImps } from "./state.js";
import type { AgentConfig, Imp, ImpSettings } from "./types.js";

// ─── summon ────────────────────────────────────────────────────────────────

const SummonParams = Type.Object({
  task: Type.String({ description: "What the imp should do" }),
  agent: Type.Optional(Type.String({ description: "Named agent to use, or omit for ephemeral" })),
});

export function summonTool(
  imps: Map<string, Imp>,
  agents: () => AgentConfig[],
  namePool: { allocate(): string; release(name: string): void },
  settings: () => ImpSettings,
): ToolDefinition<typeof SummonParams> {
  return {
    name: "summon",
    label: "Summon Imp",
    description:
      "Summon an imp to work on a task in the background. Returns immediately with a name. Use wait to collect results.",
    promptSnippet: "Summon an imp for background task delegation",
    promptGuidelines: [
      "Use summon to delegate tasks to background imps. Call wait to collect results.",
      "You can summon multiple imps (including parallel tool calls), then wait for all or first.",
    ],
    parameters: SummonParams,
    async execute(
      _toolCallId: string,
      params: { task: string; agent?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
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
        collected: false,
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
        content: [{ type: "text", text: formatSummonResult(name, agentName) }],
        details: undefined,
      };
    },
  };
}

// ─── wait ──────────────────────────────────────────────────────────────────

const WaitParams = Type.Object({
  mode: Type.Union([Type.Literal("all"), Type.Literal("first")], {
    description: "all: wait for every imp, first: return when any completes",
  }),
});

interface WaitDetails {
  imps: Array<{
    name: string;
    agentName: string;
    status: string;
    activity?: string;
    turns: number;
    tokens: number;
  }>;
}

export function waitTool(imps: Map<string, Imp>): ToolDefinition<typeof WaitParams, WaitDetails> {
  return {
    name: "wait",
    label: "Wait for Imps",
    description:
      "Block until imps complete. Streams live progress. mode=all waits for every uncollected imp, mode=first returns when any one completes.",
    promptGuidelines: [
      "wait targets all uncollected imps. Once returned by wait, an imp is 'collected' and skipped by subsequent wait calls.",
      "wait({ mode: 'first' }) returns the first imp to complete; others keep running. Call wait again to collect the rest, or dismiss to kill them.",
      "Imp failures are returned as results with failed status, not thrown exceptions.",
    ],
    parameters: WaitParams,
    async execute(
      _toolCallId: string,
      params: { mode: "all" | "first" },
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WaitDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WaitDetails>> {
      const waiting = uncollectedImps(imps);

      if (waiting.length === 0) {
        return {
          content: [{ type: "text", text: "No uncollected imps to wait for." }],
          details: { imps: [] },
        };
      }

      // Stream progress via onUpdate at intervals
      const emitUpdate = () => {
        if (!onUpdate) return;
        const impDetails = waiting.map((imp) => ({
          name: imp.name,
          agentName: imp.agentName,
          status: imp.status,
          activity: imp.activity,
          turns: imp.turns,
          tokens: imp.tokens.input + imp.tokens.output,
        }));
        onUpdate({
          content: [{ type: "text", text: waiting.map(formatImpStatus).join("\n") }],
          details: { imps: impDetails },
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

        // Mark collected
        for (const imp of resolved) {
          imp.collected = true;
        }

        // Final update
        emitUpdate();

        return {
          content: [{ type: "text", text: formatWaitResult(resolved) }],
          details: {
            imps: resolved.map((imp) => ({
              name: imp.name,
              agentName: imp.agentName,
              status: imp.status,
              activity: imp.activity,
              turns: imp.turns,
              tokens: imp.tokens.input + imp.tokens.output,
            })),
          },
        };
      } finally {
        clearInterval(interval);
      }
    },
    renderCall(args, theme: Theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const mode = args.mode === "first" ? "race" : "all";
      text.setText(theme.fg("toolTitle", theme.bold("wait")) + " " + theme.fg("dim", mode));
      return text;
    },
    renderResult(result, _options, theme: Theme, context) {
      const mode = context.args?.mode ?? "all";
      const compact = formatWaitResultCompact(result.details?.imps ?? [], mode, theme);
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

export function dismissTool(
  imps: Map<string, Imp>,
  namePool: { allocate(): string; release(name: string): void },
): ToolDefinition<typeof DismissParams> {
  return {
    name: "dismiss",
    label: "Dismiss Imp",
    description: 'Abort running imp(s). Pass an imp name or "all".',
    promptGuidelines: ["Use dismiss after wait({ mode: 'first' }) to kill remaining imps you no longer need."],
    parameters: DismissParams,
    async execute(
      _toolCallId: string,
      params: { name: string },
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const dismissed: Imp[] = [];

      if (params.name === "all") {
        for (const imp of imps.values()) {
          if (imp.status === "running") {
            dismissImp(imp, namePool);
            dismissed.push(imp);
          }
        }
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
          dismissed.push(imp);
        } else {
          return {
            content: [{ type: "text", text: `${imp.name} is already ${imp.status}` }],
            details: undefined,
          };
        }
      }

      return {
        content: [{ type: "text", text: formatDismissResult(dismissed) }],
        details: undefined,
      };
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

export function listImpsTool(imps: Map<string, Imp>): ToolDefinition<typeof ListImpsParams> {
  return {
    name: "list_imps",
    label: "List Imps",
    description: "List running and recently completed imps with status and basic stats.",
    promptGuidelines: [
      "Use list_imps to check imp status without blocking. Results from list_imps are not injected into context — use wait to collect full output.",
    ],
    parameters: ListImpsParams,
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const all = allImps(imps);
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "No imps." }],
          details: undefined,
        };
      }

      const text = all.map(formatImpStatus).join("\n");
      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
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
