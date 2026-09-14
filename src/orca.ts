import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FINAL_TURN_DIRECTIVE, normalizeEmptyToolError } from "./session.js";

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
 *
 * The worker independently enforces the resolved turn limit (§ Turn Limit)
 * and reports completion, failure, or truncation exactly once through a
 * stable internal status subject the future parent can parse without
 * trusting model-provided text.
 */

export const ORCA_DISPATCHED_WORKER_PREAMBLE =
  "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.";

/** Stable fallback body when no assistant output was recorded before completion. */
export const STABLE_NO_OUTPUT_FALLBACK = "No assistant output was recorded before the task ended.";

/** Default worker turn limit used when `--imp-turn-limit` is not overridden. */
export const DEFAULT_IMP_TURN_LIMIT = 30;

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

/**
 * Stable, non-model-controlled worker lifecycle status. `completed` maps
 * from a successful `agent_done` call, `failed` from a failed `agent_done`
 * call or a settle with no report, and `truncated` from turn-limit
 * enforcement. The model can only influence the report body, never this
 * status.
 */
export type ImpLifecycleStatus = "completed" | "failed" | "truncated";

/** Exact, namespaced subject values encoding a worker's lifecycle status. No identifiers or model text. */
const STATUS_SUBJECTS: Record<ImpLifecycleStatus, string> = {
  completed: "pi-imps:completed",
  failed: "pi-imps:failed",
  truncated: "pi-imps:truncated",
};

/** Build the stable subject line encoding a worker's lifecycle status. */
export function buildStatusSubject(_workerHandle: string, status: ImpLifecycleStatus): string {
  return STATUS_SUBJECTS[status];
}

/**
 * Parse the stable lifecycle status from a `worker_done` subject line.
 * Returns undefined for anything that isn't an exact pi-imps status subject.
 */
export function parseImpLifecycleStatus(subject: string): ImpLifecycleStatus | undefined {
  for (const status of Object.keys(STATUS_SUBJECTS) as ImpLifecycleStatus[]) {
    if (subject === STATUS_SUBJECTS[status]) return status;
  }
  return undefined;
}

/** Map the stable internal status to Orca's `worker_done --outcome` values. */
function statusToOrcaOutcome(status: ImpLifecycleStatus): "succeeded" | "failed" {
  return status === "completed" ? "succeeded" : "failed";
}

/** Build the exact `pi.exec("orca", args)` argument vector for a completion report. */
export function buildOrcaSendArgs(dispatch: OrcaWorkerDispatch, status: ImpLifecycleStatus, body: string): string[] {
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
    buildStatusSubject(dispatch.workerHandle, status),
    "--body",
    body,
    "--task-id",
    dispatch.taskId,
    "--dispatch-id",
    dispatch.dispatchId,
    "--outcome",
    statusToOrcaOutcome(status),
    "--json",
  ];
}

/**
 * Strictly extract the task text following an exact standalone `=== TASK ===`
 * marker line. Requires the marker to appear on its own line and to be
 * followed by a non-empty (post-trim) remainder. Returns undefined when the
 * marker is missing, not standalone, or the remainder is empty or
 * whitespace-only.
 */
export function extractTaskAfterMarker(text: string): string | undefined {
  const markerMatch = text.match(/^=== TASK ===$/m);
  if (!markerMatch || markerMatch.index === undefined) return undefined;

  const remainder = text.slice(markerMatch.index + markerMatch[0].length).replace(/^\r?\n/, "");
  const task = remainder.trim();
  if (!task) return undefined;
  return task;
}

/**
 * Redact all private dispatch identifiers (worker handle, task id, dispatch
 * id, capability) from diagnostic text before it can reach the model or UI.
 */
function redactDispatchIdentifiers(text: string, dispatch: OrcaWorkerDispatch): string {
  let redacted = text;
  for (const identifier of [dispatch.workerHandle, dispatch.taskId, dispatch.dispatchId, dispatch.capability]) {
    if (identifier) redacted = redacted.split(identifier).join("[redacted]");
  }
  return redacted;
}

interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
}

export type OrcaExecFn = (command: string, args: string[]) => Promise<ExecResultLike>;

/**
 * Private per-dispatch lifecycle state: turn count, last observed assistant
 * output, and exactly-once completion sealing. A fresh dispatch always gets
 * fresh state (see `initOrcaWorker`'s `input` handler).
 */
export interface ImpLifecycleState {
  turnCount: number;
  lastOutput: string;
  completionSealed: boolean;
  completionInFlight: boolean;
}

export function createImpLifecycleState(): ImpLifecycleState {
  return { turnCount: 0, lastOutput: "", completionSealed: false, completionInFlight: false };
}

/**
 * Report worker completion exactly once for the given dispatch/state pair.
 *
 * Throws a generic, non-secret error (never exposing dispatch identifiers)
 * when there is no active dispatch, when completion was already sealed by a
 * prior successful report, or when a report is already in flight. A failed
 * send does not seal completion, so it may be retried; only a successful
 * send seals it.
 */
export async function reportImpCompletion(
  dispatch: OrcaWorkerDispatch | undefined,
  state: ImpLifecycleState,
  status: ImpLifecycleStatus,
  body: string,
  exec: OrcaExecFn,
): Promise<void> {
  if (!dispatch) {
    throw new Error("No active dispatch for this session; cannot report completion.");
  }
  if (state.completionSealed) {
    throw new Error("Completion has already been reported for this task.");
  }
  if (state.completionInFlight) {
    throw new Error("A completion report is already in progress for this task.");
  }

  state.completionInFlight = true;
  try {
    const args = buildOrcaSendArgs(dispatch, status, body);

    let result: ExecResultLike;
    try {
      result = await exec("orca", args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to report completion: ${redactDispatchIdentifiers(message || "unknown error", dispatch)}`,
      );
    }

    if (result.code !== 0) {
      const detail = redactDispatchIdentifiers((result.stderr || result.stdout || "no output").trim(), dispatch);
      throw new Error(`The completion report was rejected (exit ${result.code}): ${detail || "no output"}`);
    }

    state.completionSealed = true;
  } finally {
    state.completionInFlight = false;
  }
}

const AgentDoneParams = Type.Object({
  outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")], {
    description: "Whether the dispatched task succeeded or failed",
  }),
  summary: Type.String({ description: "Concise summary of the outcome", minLength: 1 }),
});

/** Reports the model-initiated completion outcome exactly once. */
export type AgentDoneReport = (outcome: "succeeded" | "failed", summary: string) => Promise<void>;

/**
 * Build the `agent_done` tool for a verified Orca dispatched worker.
 *
 * Takes a single injected `report` function so all dispatch lookup, status
 * mapping, exactly-once sealing, and exec/redaction logic lives in one place
 * (`reportImpCompletion`), shared with the internal turn-limit and settle
 * reporting paths.
 */
export function createAgentDoneTool(report: AgentDoneReport): ToolDefinition<typeof AgentDoneParams, undefined> {
  return {
    name: "agent_done",
    label: "Report Completion",
    description:
      "Report the outcome of this delegated task and end the assignment. Call exactly once when the task is finished, whether it succeeded or failed.",
    promptSnippet: "agent_done — report the outcome of a delegated task and end the assignment",
    promptGuidelines: [
      "Call agent_done exactly once when the delegated task is finished, whether it succeeded or failed.",
    ],
    parameters: AgentDoneParams,
    async execute(_toolCallId, params) {
      await report(params.outcome, params.summary);

      return {
        content: [{ type: "text", text: `Reported ${params.outcome}.` }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

/** Parse `--imp-turn-limit`: a strict whole number >= 2. Falls back to the default when unset. */
export function parseImpTurnLimit(raw: string | undefined): number {
  const value = raw ?? String(DEFAULT_IMP_TURN_LIMIT);
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 2) {
    throw new Error(`Invalid --imp-turn-limit "${value}": expected a whole number >= 2.`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Extract the assistant text from an `AgentMessage`-shaped value, or
 * undefined when the message isn't an assistant message with text content.
 */
function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return undefined;
  const parts = m.content.filter(
    (c): c is { type: "text"; text: string } =>
      !!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
  );
  return parts.map((c) => c.text).join("");
}

/**
 * Initialize Orca-dispatched worker mode on an already-created `ExtensionAPI`.
 *
 * Not a second extension entrypoint — invoked by `src/index.ts`'s default
 * export when the `is-imp` flag is set, before any ordinary pi-imps session
 * hooks/tools/commands are registered. Registers `agent_done` exactly once,
 * backed by private mutable dispatch context and lifecycle state.
 *
 * Verifies Orca's injected dispatched-worker preamble on the raw `input`
 * event text, strips it down to the task text after an exact standalone
 * `=== TASK ===` marker line, and transforms the input so no Orca preamble,
 * identifiers, capability, coordinator instructions, or embedded CLI command
 * ever reach the model. Each verified fresh dispatch resets private turn
 * count, last assistant output, and exactly-once completion state.
 *
 * Independently enforces `turnLimit`: queues the existing `FINAL_TURN_DIRECTIVE`
 * on the penultimate turn, and on the final turn (or on settling without a
 * report) sends an authenticated internal completion with a stable status
 * the model never controls.
 */
export function initOrcaWorker(pi: ExtensionAPI, turnLimit: number): void {
  let dispatch: OrcaWorkerDispatch | undefined;
  let state: ImpLifecycleState = createImpLifecycleState();

  const report: AgentDoneReport = (outcome, summary) => {
    const status: ImpLifecycleStatus = outcome === "succeeded" ? "completed" : "failed";
    return reportImpCompletion(dispatch, state, status, summary, (command, args) => pi.exec(command, args));
  };

  pi.registerTool(createAgentDoneTool(report));

  pi.on("tool_result", normalizeEmptyToolError);

  pi.on("input", (event) => {
    const verified = verifyOrcaWorkerDispatch(event.text);
    if (!verified) return { action: "continue" };

    const task = extractTaskAfterMarker(event.text);
    if (!task) return { action: "continue" };

    dispatch = verified;
    state = createImpLifecycleState();
    return { action: "transform", text: task };
  });

  pi.on("turn_end", async (event, ctx) => {
    state.turnCount++;

    const text = extractAssistantText(event.message);
    if (text !== undefined) state.lastOutput = text;

    if (state.completionSealed) return;

    if (state.turnCount === turnLimit - 1) {
      pi.sendUserMessage(FINAL_TURN_DIRECTIVE, { deliverAs: "steer" });
      return;
    }

    if (state.turnCount >= turnLimit) {
      const body = state.lastOutput.trim() || STABLE_NO_OUTPUT_FALLBACK;
      try {
        await reportImpCompletion(dispatch, state, "truncated", body, (command, args) => pi.exec(command, args));
      } catch {
        // A failed send stays unsealed (see reportImpCompletion), allowing
        // agent_settled's natural later attempt; no explicit retry here.
      } finally {
        // Never abort while pi.exec is in flight — the report attempt above
        // has already settled by the time we reach here.
        ctx.abort();
      }
    }
  });

  pi.on("agent_settled", async () => {
    if (state.completionSealed) return;
    const body = state.lastOutput.trim() || STABLE_NO_OUTPUT_FALLBACK;
    try {
      await reportImpCompletion(dispatch, state, "failed", body, (command, args) => pi.exec(command, args));
    } catch {
      // No parent backend exists yet to observe this failure; swallowing
      // it here avoids an unhandled rejection since there is no retry path.
    }
  });
}
