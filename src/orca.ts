import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Strict Orca-dispatched-worker bridge.
 *
 * Detects Orca's injected dispatched-worker preamble, extracts the worker
 * terminal handle / task id / dispatch id / capability from the embedded
 * `worker_done` command, and exposes an `agent_done` tool that reports the
 * outcome through Orca via `pi.exec("orca", ...)` — no shell access.
 *
 * All parsed identifiers are private to this module's callers; the capability
 * is never returned in a tool result and is redacted from any diagnostic text.
 */

export const ORCA_DISPATCHED_WORKER_PREAMBLE =
  "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.";

/** Tool names removed from the active set for a verified Orca dispatched worker. */
export const ORCA_RESTRICTED_TOOLS = ["summon", "wait", "dismiss", "list_imps"] as const;

export interface OrcaWorkerDispatch {
  readonly workerHandle: string;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly capability: string;
}

/**
 * Strictly parse Orca's dispatched-worker preamble.
 *
 * Requires the prompt to begin with the exact worker preamble sentence and
 * contain a line-anchored `Your task ID is: <taskId>` sentence, plus an
 * embedded `orca orchestration send ... --type worker_done ...` command
 * line (optionally indented with leading horizontal whitespace, as Orca's
 * real preamble does). The worker handle, capability, dispatch id, and task
 * id are extracted from that command line's `--from`, `--dispatch-capability`,
 * `--dispatch-id`, and `--task-id` flags respectively — whitespace-delimited
 * values only; the command's quoted `--subject`/`--body` text is never
 * parsed on its own, but because Orca's flag order is fixed (subject/body
 * before task-id/dispatch-id), the *last* occurrence of `--task-id` and
 * `--dispatch-id` in the command line is used so flag-like text quoted
 * inside `--subject`/`--body` cannot be mistaken for the real trailing
 * flags. The command's `--task-id` value must equal the declared task id.
 * Returns undefined on any mismatch or omission.
 */
export function parseOrcaWorkerDispatch(prompt: string): OrcaWorkerDispatch | undefined {
  if (!prompt.startsWith(ORCA_DISPATCHED_WORKER_PREAMBLE)) return undefined;

  const taskIdMatch = prompt.match(/^Your task ID is:\s*(\S+)\s*$/m);
  if (!taskIdMatch) return undefined;
  const taskId = taskIdMatch[1];

  const commandLineMatch = prompt.match(/^[ \t]*orca orchestration send .*--type worker_done.*$/m);
  if (!commandLineMatch) return undefined;
  const commandLine = commandLineMatch[0];

  const fromMatch = commandLine.match(/--from\s+(\S+)/);
  const capabilityMatch = commandLine.match(/--dispatch-capability\s+(\S+)/);
  const taskIdFlagMatch = lastMatch(commandLine, /--task-id\s+(\S+)/g);
  const dispatchIdMatch = lastMatch(commandLine, /--dispatch-id\s+(\S+)/g);
  if (!fromMatch || !capabilityMatch || !taskIdFlagMatch || !dispatchIdMatch) return undefined;

  const workerHandle = fromMatch[1];
  const capability = capabilityMatch[1];
  const dispatchId = dispatchIdMatch[1];
  if (taskIdFlagMatch[1] !== taskId) return undefined;

  return { workerHandle, taskId, dispatchId, capability };
}

/** Return the last match of a global regex, or undefined if there are none. */
function lastMatch(text: string, globalRe: RegExp): RegExpMatchArray | undefined {
  const matches = [...text.matchAll(globalRe)];
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

/**
 * Parse and verify a dispatch: the parsed worker handle must exactly equal
 * `env.ORCA_TERMINAL_HANDLE`. Returns undefined for invalid, incomplete, or
 * mismatched prompts, leaving normal parent behavior unchanged.
 */
export function verifyOrcaWorkerDispatch(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): OrcaWorkerDispatch | undefined {
  const dispatch = parseOrcaWorkerDispatch(prompt);
  if (!dispatch) return undefined;
  if (!env.ORCA_TERMINAL_HANDLE || env.ORCA_TERMINAL_HANDLE !== dispatch.workerHandle) return undefined;
  return dispatch;
}

/** Build the exact `pi.exec("orca", args)` argument vector for a completion report. */
export function buildOrcaSendArgs(
  dispatch: OrcaWorkerDispatch,
  outcome: "succeeded" | "failed",
  summary: string,
): string[] {
  return [
    "orchestration",
    "send",
    "--from",
    dispatch.workerHandle,
    "--dispatch-capability",
    dispatch.capability,
    "--type",
    "worker_done",
    "--subject",
    `Worker ${dispatch.workerHandle} ${outcome}`,
    "--body",
    summary,
    "--task-id",
    dispatch.taskId,
    "--dispatch-id",
    dispatch.dispatchId,
    "--outcome",
    outcome,
    "--json",
  ];
}

/** Redact a capability token from diagnostic text before it can reach the model or UI. */
function redactCapability(text: string, capability: string): string {
  return capability ? text.split(capability).join("[redacted]") : text;
}

interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
}

export type OrcaExecFn = (command: string, args: string[]) => Promise<ExecResultLike>;

const AgentDoneParams = Type.Object({
  outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")], {
    description: "Whether the dispatched task succeeded or failed",
  }),
  summary: Type.String({ description: "Concise summary of the outcome", minLength: 1 }),
});

/**
 * Build the `agent_done` tool for a verified Orca dispatched worker.
 *
 * `getDispatch` is read at call time (not captured at registration time) so a
 * reused worker session can receive a fresh dispatch preamble — updating
 * private context — without re-registering the tool.
 */
export function createAgentDoneTool(
  getDispatch: () => OrcaWorkerDispatch | undefined,
  exec: OrcaExecFn,
): ToolDefinition<typeof AgentDoneParams, undefined> {
  return {
    name: "agent_done",
    label: "Report Completion to Orca",
    description:
      "Report this dispatched worker's outcome to Orca and end the assignment. Call exactly once when the task is finished, whether it succeeded or failed.",
    parameters: AgentDoneParams,
    async execute(_toolCallId, params) {
      const dispatch = getDispatch();
      if (!dispatch) {
        // Throwing (rather than returning) sets `isError: true` on the tool
        // result per ToolDefinition conventions, so this failure is actionable.
        throw new Error("No active Orca dispatch for this session; cannot report completion.");
      }

      const args = buildOrcaSendArgs(dispatch, params.outcome, params.summary);

      let result: ExecResultLike;
      try {
        result = await exec("orca", args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to report completion to Orca: ${redactCapability(message || "unknown error", dispatch.capability)}`,
        );
      }

      if (result.code !== 0) {
        const detail = redactCapability((result.stderr || result.stdout || "no output").trim(), dispatch.capability);
        throw new Error(`Orca rejected the completion report (exit ${result.code}): ${detail || "no output"}`);
      }

      return {
        content: [{ type: "text", text: `Reported ${params.outcome} to Orca.` }],
        details: undefined,
      };
    },
  };
}
