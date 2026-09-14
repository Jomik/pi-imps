import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OrcaExecFn } from "./orca.js";
import { parseImpLifecycleStatus, STABLE_NO_OUTPUT_FALLBACK } from "./orca.js";
import { prepareOrcaLaunch } from "./orca-launch.js";
import type { AgentConfig, ImpSettings, ThinkingLevel } from "./types.js";

/**
 * Orca imp coordinator.
 *
 * Owns exactly one lazily-created orchestration run, one active-dispatch
 * record map keyed by `dispatchId`, and one serialized mailbox consumer
 * draining `worker_done` deliveries for that run. Does not create child
 * worktrees, retry failed operations, or reuse terminals — every spawn gets
 * its own task/terminal/dispatch against the shared run.
 *
 * Never logs command args, the system prompt, the task spec, or the
 * dispatch capability; only bounded, actionable error text is surfaced.
 */

export interface OrcaSpawnResult {
  readonly output: string;
  readonly error?: string;
  readonly truncated?: boolean;
}

export interface OrcaSpawnOptions {
  name: string;
  task: string;
  signal: AbortSignal;
  cwd: string;
  config: AgentConfig;
  parentModel: Model<Api>;
  parentThinkingLevel: ThinkingLevel;
  modelRegistry: ModelRegistry;
  settings: ImpSettings;
  /** Reserved for future activity-message routing; not invoked in this version (only `worker_done` is consumed). */
  onActivity: (activity: string) => void;
  onComplete: (result: OrcaSpawnResult) => void;
}

export interface OrcaSpawnHandle {
  /** Idempotent: safe to call more than once, and safe after completion has already settled. */
  abort(): Promise<void>;
}

interface OrcaEnvelope {
  ok: unknown;
  [key: string]: unknown;
}

interface RunCreateResponse extends OrcaEnvelope {
  run?: { id?: unknown };
}

interface TerminalCreateResponse extends OrcaEnvelope {
  terminal?: { id?: unknown };
}

interface WaitIdleResponse extends OrcaEnvelope {
  state?: unknown;
}

interface TaskCreateResponse extends OrcaEnvelope {
  task?: { id?: unknown };
}

interface WorkerStartResponse extends OrcaEnvelope {
  worker?: { id?: unknown; handle?: unknown };
  dispatchId?: unknown;
}

interface RawDeliveryMessage {
  payload?: unknown;
}

interface CheckResponse extends OrcaEnvelope {
  delivery?: { id?: unknown; messages?: RawDeliveryMessage[] };
}

interface ActiveRecord {
  readonly dispatchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly terminalId: string;
  readonly workerId: string;
  readonly workerHandle: string;
  readonly onComplete: (result: OrcaSpawnResult) => void;
  /** True once completion or abort has been finalized; guards exactly-once settlement. */
  settled: boolean;
}

interface ParsedMailboxPayload {
  dispatchId: string;
  taskId: string;
  from: string;
  subject: string;
  body: string;
}

/** Run one `orca <args>` call, requiring exit 0, parseable JSON, and `ok: true`. Never includes `args` in thrown text. */
async function execOrca<T extends OrcaEnvelope>(
  exec: OrcaExecFn,
  args: string[],
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec("orca", args, signal ? { signal } : undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Orca ${label} failed to run: ${message || "unknown error"}`);
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(`Orca ${label} failed (exit ${result.code}): ${detail || "no output"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Orca ${label} returned malformed JSON: ${(result.stdout || "").trim() || "(empty output)"}`);
  }

  if (!parsed || typeof parsed !== "object" || (parsed as OrcaEnvelope).ok !== true) {
    throw new Error(`Orca ${label} reported a non-ok status: ${(result.stdout || "").trim() || "(empty output)"}`);
  }

  return parsed as T;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Orca ${label} reported no usable id/state.`);
  }
  return value;
}

/** Parse a `worker_done` message payload, which may arrive as a JSON string or already-decoded object. */
function parseMailboxPayload(payload: unknown): ParsedMailboxPayload | undefined {
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;

  const obj = value as Record<string, unknown>;
  const { dispatchId, taskId, from, subject, body } = obj;
  if (typeof dispatchId !== "string" || !dispatchId) return undefined;
  if (typeof taskId !== "string" || !taskId) return undefined;
  if (typeof from !== "string" || !from) return undefined;
  if (typeof subject !== "string") return undefined;
  if (typeof body !== "string") return undefined;

  return { dispatchId, taskId, from, subject, body };
}

export class OrcaCoordinator {
  private readonly exec: OrcaExecFn;
  private runPromise: Promise<{ id: string }> | undefined;
  private readonly active = new Map<string, ActiveRecord>();
  private mailboxRunning = false;
  private mailboxLoopPromise: Promise<void> | undefined;
  private mailboxAbortController: AbortController | undefined;
  private shuttingDown = false;

  constructor(exec: OrcaExecFn) {
    this.exec = exec;
  }

  /**
   * Spawn one Orca-dispatched imp: shares the coordinator's single lazily
   * created orchestration run, and creates its own task/terminal/dispatch.
   * Resolves with an abort handle only once the dispatch is fully ready
   * (worker-start has succeeded and the active record is registered).
   */
  async spawn(opts: OrcaSpawnOptions): Promise<OrcaSpawnHandle> {
    if (this.shuttingDown) {
      throw new Error("Orca coordinator is shutting down; refusing to spawn a new imp.");
    }

    const plan = await prepareOrcaLaunch({
      cwd: opts.cwd,
      config: opts.config,
      parentModel: opts.parentModel,
      parentThinkingLevel: opts.parentThinkingLevel,
      modelRegistry: opts.modelRegistry,
      settings: opts.settings,
      exec: this.exec,
    });

    let terminalId: string | undefined;
    try {
      const run = await this.ensureRun();

      const terminalResp = await execOrca<TerminalCreateResponse>(
        this.exec,
        ["terminal", "create", "--worktree", "current", "--title", opts.name, "--command", plan.command, "--json"],
        "terminal create",
        opts.signal,
      );
      terminalId = requireNonEmptyString(terminalResp.terminal?.id, "terminal create");

      const idleResp = await execOrca<WaitIdleResponse>(
        this.exec,
        ["terminal", "wait-tui-idle", "--terminal", terminalId, "--timeout-ms", "60000", "--json"],
        "terminal wait-tui-idle",
        opts.signal,
      );
      if (idleResp.state !== undefined && idleResp.state !== "idle") {
        throw new Error(`Orca terminal wait-tui-idle reported unexpected state: ${String(idleResp.state)}`);
      }

      const taskResp = await execOrca<TaskCreateResponse>(
        this.exec,
        ["orchestration", "task-create", "--run", run.id, "--title", opts.name, "--spec", opts.task, "--json"],
        "task create",
        opts.signal,
      );
      const taskId = requireNonEmptyString(taskResp.task?.id, "task create");

      const workerResp = await execOrca<WorkerStartResponse>(
        this.exec,
        ["orchestration", "worker-start", "--run", run.id, "--task", taskId, "--terminal", terminalId, "--json"],
        "worker start",
        opts.signal,
      );
      const workerId = requireNonEmptyString(workerResp.worker?.id, "worker start");
      const workerHandle = requireNonEmptyString(workerResp.worker?.handle, "worker start");
      const dispatchId = requireNonEmptyString(workerResp.dispatchId, "worker start");

      const record: ActiveRecord = {
        dispatchId,
        runId: run.id,
        taskId,
        terminalId,
        workerId,
        workerHandle,
        onComplete: opts.onComplete,
        settled: false,
      };

      this.active.set(dispatchId, record);
      this.ensureMailbox(run.id);

      return { abort: () => this.abortDispatch(record) };
    } catch (err) {
      if (terminalId) {
        await this.safeExec(["terminal", "close", "--terminal", terminalId, "--json"], "terminal close (cleanup)");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message || "Failed to spawn Orca-dispatched imp");
    }
  }

  /** Abort all active dispatches and the mailbox consumer; refuses further spawns. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.mailboxAbortController?.abort();
    const records = [...this.active.values()];
    await Promise.all(records.map((record) => this.abortDispatch(record)));
    if (this.mailboxLoopPromise) {
      await this.mailboxLoopPromise.catch(() => {});
    }
  }

  /** Lazily create the single orchestration run shared by every spawn on this coordinator. */
  private ensureRun(): Promise<{ id: string }> {
    if (!this.runPromise) {
      this.runPromise = execOrca<RunCreateResponse>(
        this.exec,
        ["orchestration", "run-create", "--objective", "pi-imps session", "--json"],
        "run create",
      )
        .then((resp) => ({ id: requireNonEmptyString(resp.run?.id, "run create") }))
        .catch((err) => {
          // Allow a later spawn to retry run creation instead of being
          // permanently stuck on a one-time failure.
          this.runPromise = undefined;
          throw err;
        });
    }
    return this.runPromise;
  }

  /** Best-effort cleanup call: failures are swallowed so they never overwrite a valid completion/abort outcome. */
  private async safeExec(args: string[], label: string): Promise<void> {
    try {
      await execOrca(this.exec, args, label);
    } catch {
      // Best-effort; nothing to report to.
    }
  }

  /** Idempotently abort one active dispatch. Never invokes `onComplete` — the caller (dismiss) owns that outcome. */
  private async abortDispatch(record: ActiveRecord): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    this.active.delete(record.dispatchId);
    await this.safeExec(["orchestration", "worker-stop", "--worker", record.workerId, "--json"], "worker stop");
    await this.safeExec(["orchestration", "worker-release", "--worker", record.workerId, "--json"], "worker release");
    await this.safeExec(["terminal", "close", "--terminal", record.terminalId, "--json"], "terminal close");
  }

  /** Settle one active dispatch as complete: cleanup, then invoke `onComplete` exactly once. */
  private async completeDispatch(record: ActiveRecord, result: OrcaSpawnResult): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    this.active.delete(record.dispatchId);
    await this.safeExec(["orchestration", "worker-release", "--worker", record.workerId, "--json"], "worker release");
    await this.safeExec(["terminal", "close", "--terminal", record.terminalId, "--json"], "terminal close");
    record.onComplete(result);
  }

  /** Start the single serialized mailbox consumer for `runId`, if not already running. */
  private ensureMailbox(runId: string): void {
    if (this.mailboxRunning) return;
    this.mailboxRunning = true;
    this.mailboxAbortController = new AbortController();
    const signal = this.mailboxAbortController.signal;
    this.mailboxLoopPromise = this.runMailboxLoop(runId, signal).finally(() => {
      this.mailboxRunning = false;
    });
  }

  /** Serialized mailbox loop: one `check --wait` consumer at a time, draining/ack-ing every delivery it receives. */
  private async runMailboxLoop(runId: string, signal: AbortSignal): Promise<void> {
    while (!this.shuttingDown && this.active.size > 0) {
      let resp: CheckResponse;
      try {
        resp = await execOrca<CheckResponse>(
          this.exec,
          [
            "orchestration",
            "check",
            "--run",
            runId,
            "--wait",
            "--types",
            "worker_done",
            "--timeout-ms",
            "30000",
            "--json",
          ],
          "mailbox check",
          signal,
        );
      } catch (err) {
        await this.failAllActive(err instanceof Error ? err.message : String(err));
        return;
      }

      const ok = await this.drainDelivery(resp.delivery, signal);
      if (!ok) return;
    }
  }

  /**
   * Process and ack one delivery, then keep draining/ack-ing any further
   * delivery the ack call itself returns, so nothing is silently dropped.
   * Returns false on a fatal ack failure (already handled via `failAllActive`).
   */
  private async drainDelivery(
    delivery: { id?: unknown; messages?: RawDeliveryMessage[] } | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    let current = delivery;
    while (current) {
      for (const message of current.messages ?? []) {
        await this.routeMailboxMessage(message);
      }

      const deliveryId = current.id;
      if (typeof deliveryId !== "string" || !deliveryId) return true;

      let ackResp: CheckResponse;
      try {
        ackResp = await execOrca<CheckResponse>(
          this.exec,
          ["orchestration", "check", "--ack", deliveryId, "--json"],
          "mailbox ack",
          signal,
        );
      } catch (err) {
        await this.failAllActive(err instanceof Error ? err.message : String(err));
        return false;
      }

      current = ackResp.delivery;
    }
    return true;
  }

  /** Route one `worker_done` message to its dispatch, ignoring anything unknown, stale, or unparseable. */
  private async routeMailboxMessage(message: RawDeliveryMessage): Promise<void> {
    const parsed = parseMailboxPayload(message.payload);
    if (!parsed) return;

    const record = this.active.get(parsed.dispatchId);
    if (!record) return;
    if (parsed.taskId !== record.taskId || parsed.from !== record.workerHandle) return;

    const status = parseImpLifecycleStatus(parsed.subject);
    if (!status) return;

    if (status === "completed") {
      await this.completeDispatch(record, { output: parsed.body });
    } else if (status === "failed") {
      await this.completeDispatch(record, {
        output: parsed.body,
        error: parsed.body.trim() ? parsed.body : STABLE_NO_OUTPUT_FALLBACK,
      });
    } else {
      await this.completeDispatch(record, { output: parsed.body, truncated: true });
    }
  }

  /** Fatal mailbox error: fail every still-active dispatch exactly once, closing its terminal, then stop consuming. */
  private async failAllActive(message: string): Promise<void> {
    const records = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      records
        .filter((record) => !record.settled)
        .map(async (record) => {
          record.settled = true;
          await this.safeExec(
            ["terminal", "close", "--terminal", record.terminalId, "--json"],
            "terminal close (mailbox failure)",
          );
          record.onComplete({ output: "", error: `Orca mailbox failed: ${message || "unknown error"}` });
        }),
    );
  }
}
