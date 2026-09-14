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
 * worktrees or reuse terminals — every spawn gets its own
 * task/terminal/dispatch against the shared run. Spawn and worker-lifecycle
 * commands are never retried; only a transient mailbox `check`/`ack`
 * execution/protocol failure gets exactly one retry before the mailbox is
 * treated as fatally broken.
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
  /** Called with concise lifecycle stage labels as the spawn progresses; never includes task/system-prompt content. */
  onActivity: (activity: string) => void;
  onComplete: (result: OrcaSpawnResult) => void;
}

export interface OrcaSpawnHandle {
  /** Idempotent: safe to call more than once, and safe after completion has already settled. */
  abort(): Promise<void>;
}

/** Maximum length of any actionable error text surfaced by the coordinator. */
const MAX_ERROR_LENGTH = 500;

/** Bound actionable error text to a fixed length. Never includes command args, task text, or system prompt. */
function boundedError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= MAX_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_LENGTH)}\u2026`;
}

interface RunCreateResult {
  run?: { id?: unknown };
}

interface TerminalCreateResult {
  terminal?: { handle?: unknown };
}

interface TerminalWaitResult {
  wait?: { satisfied?: unknown; status?: unknown };
}

interface TaskCreateResult {
  task?: { id?: unknown };
}

interface WorkerStartResult {
  dispatchId?: unknown;
  state?: unknown;
  stage?: unknown;
}

interface RawMailboxMessage {
  type?: unknown;
  from_handle?: unknown;
  subject?: unknown;
  body?: unknown;
  payload?: unknown;
}

interface CheckResult {
  deliveryId?: unknown;
  messages?: RawMailboxMessage[];
}

interface ActiveRecord {
  readonly dispatchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly terminalHandle: string;
  readonly onComplete: (result: OrcaSpawnResult) => void;
  /** True once completion or abort has been finalized; guards exactly-once settlement. */
  settled: boolean;
}

interface ParsedMailboxPayload {
  dispatchId: string;
  taskId: string;
  outcome: "succeeded" | "failed";
}

/**
 * Run one `orca <args>` call, requiring exit 0, parseable JSON, `ok: true`,
 * and a `result` object — the real Orca envelope shape is
 * `{ ok: true, result: {...} }`. Returns the unwrapped `result` payload.
 * Never includes `args` in thrown text.
 */
async function execOrca<R>(exec: OrcaExecFn, args: string[], label: string, signal?: AbortSignal): Promise<R> {
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await exec("orca", args, signal ? { signal } : undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(boundedError(`Orca ${label} failed to run: ${message || "unknown error"}`));
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(boundedError(`Orca ${label} failed (exit ${result.code}): ${detail || "no output"}`));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      boundedError(`Orca ${label} returned malformed JSON: ${(result.stdout || "").trim() || "(empty output)"}`),
    );
  }

  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
    throw new Error(
      boundedError(`Orca ${label} reported a non-ok status: ${(result.stdout || "").trim() || "(empty output)"}`),
    );
  }

  const envelopeResult = (parsed as { result?: unknown }).result;
  if (!envelopeResult || typeof envelopeResult !== "object") {
    throw new Error(boundedError(`Orca ${label} reported no result payload.`));
  }

  return envelopeResult as R;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(boundedError(`Orca ${label} reported no usable id.`));
  }
  return value;
}

/**
 * Parse a `worker_done` message payload. Per the real Orca protocol the
 * payload only ever carries `taskId`, `dispatchId`, and `outcome`; every
 * other field (`type`, `from_handle`, `subject`, `body`) lives at the
 * message level, not inside the payload.
 */
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
  const { dispatchId, taskId, outcome } = obj;
  if (typeof dispatchId !== "string" || !dispatchId) return undefined;
  if (typeof taskId !== "string" || !taskId) return undefined;
  if (outcome !== "succeeded" && outcome !== "failed") return undefined;

  return { dispatchId, taskId, outcome };
}

export class OrcaCoordinator {
  private readonly exec: OrcaExecFn;
  private runPromise: Promise<{ id: string }> | undefined;
  private readonly active = new Map<string, ActiveRecord>();
  private mailboxRunning = false;
  private mailboxLoopPromise: Promise<void> | undefined;
  private mailboxAbortController: AbortController | undefined;
  private shuttingDown = false;

  /** Default delay before the single retry attempt for a transient mailbox check/ack failure. Overridable for deterministic fast tests. */
  private readonly mailboxRetryDelayMs: number;

  constructor(exec: OrcaExecFn, mailboxRetryDelayMs = 250) {
    this.exec = exec;
    this.mailboxRetryDelayMs = mailboxRetryDelayMs;
  }

  /**
   * Spawn one Orca-dispatched imp: shares the coordinator's single lazily
   * created orchestration run, and creates its own task/terminal/dispatch.
   * Resolves with an abort handle only once the dispatch is fully ready
   * (worker-start reports `state: "ready"` and the active record is
   * registered).
   */
  async spawn(opts: OrcaSpawnOptions): Promise<OrcaSpawnHandle> {
    if (this.shuttingDown) {
      throw new Error("Orca coordinator is shutting down; refusing to spawn a new imp.");
    }

    opts.onActivity("preparing");
    const plan = await prepareOrcaLaunch({
      cwd: opts.cwd,
      config: opts.config,
      parentModel: opts.parentModel,
      parentThinkingLevel: opts.parentThinkingLevel,
      modelRegistry: opts.modelRegistry,
      settings: opts.settings,
      exec: this.exec,
      signal: opts.signal,
    });

    let terminalHandle: string | undefined;
    let capturedDispatchId: string | undefined;
    try {
      const run = await this.ensureRun();

      opts.onActivity("starting terminal");
      const terminalResult = await execOrca<TerminalCreateResult>(
        this.exec,
        ["terminal", "create", "--worktree", "current", "--title", opts.name, "--command", plan.command, "--json"],
        "terminal create",
        opts.signal,
      );
      terminalHandle = requireNonEmptyString(terminalResult.terminal?.handle, "terminal create");

      opts.onActivity("waiting for Pi");
      const waitResult = await execOrca<TerminalWaitResult>(
        this.exec,
        ["terminal", "wait", "--terminal", terminalHandle, "--for", "tui-idle", "--timeout-ms", "60000", "--json"],
        "terminal wait",
        opts.signal,
      );
      if (waitResult.wait?.satisfied !== true) {
        throw new Error(
          boundedError(`Orca terminal wait did not become satisfied (status: ${String(waitResult.wait?.status)})`),
        );
      }

      opts.onActivity("dispatching");
      const taskResult = await execOrca<TaskCreateResult>(
        this.exec,
        ["orchestration", "task-create", "--run", run.id, "--task-title", opts.name, "--spec", opts.task, "--json"],
        "task create",
        opts.signal,
      );
      const taskId = requireNonEmptyString(taskResult.task?.id, "task create");

      const workerResult = await execOrca<WorkerStartResult>(
        this.exec,
        ["orchestration", "worker-start", "--run", run.id, "--task", taskId, "--terminal", terminalHandle, "--json"],
        "worker start",
        opts.signal,
      );
      if (typeof workerResult.dispatchId === "string" && workerResult.dispatchId) {
        capturedDispatchId = workerResult.dispatchId;
      }
      if (workerResult.state !== "ready") {
        throw new Error(
          boundedError(`Orca worker start did not reach ready state (state: ${String(workerResult.state)})`),
        );
      }
      const dispatchId = requireNonEmptyString(workerResult.dispatchId, "worker start");

      const record: ActiveRecord = {
        dispatchId,
        runId: run.id,
        taskId,
        terminalHandle,
        onComplete: opts.onComplete,
        settled: false,
      };

      this.active.set(dispatchId, record);
      this.ensureMailbox(run.id);

      opts.onActivity("working");

      return { abort: () => this.abortDispatch(record) };
    } catch (err) {
      if (capturedDispatchId) {
        await this.safeExec(
          ["orchestration", "worker-stop", "--dispatch", capturedDispatchId, "--json"],
          "worker stop (cleanup)",
        );
        await this.safeExec(
          ["orchestration", "worker-release", "--dispatch", capturedDispatchId, "--json"],
          "worker release (cleanup)",
        );
      }
      if (terminalHandle) {
        await this.safeExec(["terminal", "close", "--terminal", terminalHandle, "--json"], "terminal close (cleanup)");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(boundedError(message || "Failed to spawn Orca-dispatched imp"));
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
      this.runPromise = execOrca<RunCreateResult>(
        this.exec,
        ["orchestration", "run-create", "--objective", "pi-imps session", "--json"],
        "run create",
      )
        .then((result) => ({ id: requireNonEmptyString(result.run?.id, "run create") }))
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
    await this.safeExec(["orchestration", "worker-stop", "--dispatch", record.dispatchId, "--json"], "worker stop");
    await this.safeExec(
      ["orchestration", "worker-release", "--dispatch", record.dispatchId, "--json"],
      "worker release",
    );
    await this.safeExec(["terminal", "close", "--terminal", record.terminalHandle, "--json"], "terminal close");
  }

  /** Settle one active dispatch as complete: cleanup, then invoke `onComplete` exactly once. */
  private async completeDispatch(record: ActiveRecord, result: OrcaSpawnResult): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    this.active.delete(record.dispatchId);
    await this.safeExec(
      ["orchestration", "worker-release", "--dispatch", record.dispatchId, "--json"],
      "worker release",
    );
    await this.safeExec(["terminal", "close", "--terminal", record.terminalHandle, "--json"], "terminal close");
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
      // If new active records were registered between the loop's exit
      // condition being checked and this callback running, `ensureMailbox`
      // calls made in that window saw `mailboxRunning === true` and were
      // no-ops. Restart here so those dispatches are never left unwatched.
      if (!this.shuttingDown && this.active.size > 0) {
        this.ensureMailbox(runId);
      }
    });
  }

  /**
   * Resolves after `mailboxRetryDelayMs`, rejecting immediately if `signal`
   * is (or becomes) aborted, so a retry is never attempted once shutdown
   * has begun.
   */
  private delay(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, this.mailboxRetryDelayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  /**
   * Run one mailbox `check`/`ack` call, retrying exactly once after a short
   * delay on a transient execution/protocol failure. Never retries if the
   * signal is already aborted. Only mailbox calls use this — spawn and
   * worker-lifecycle commands are never retried.
   */
  private async execMailboxWithRetry<R>(args: string[], label: string, signal: AbortSignal): Promise<R> {
    try {
      return await execOrca<R>(this.exec, args, label, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      await this.delay(signal);
      return execOrca<R>(this.exec, args, label, signal);
    }
  }

  /** Serialized mailbox loop: one `check --wait` consumer at a time, draining/ack-ing every delivery it receives. */
  private async runMailboxLoop(runId: string, signal: AbortSignal): Promise<void> {
    while (!this.shuttingDown && this.active.size > 0) {
      let resp: CheckResult;
      try {
        resp = await this.execMailboxWithRetry<CheckResult>(
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

      const ok = await this.drainDelivery(resp, runId, signal);
      if (!ok) return;
    }
  }

  /**
   * Process and ack one delivery, then keep draining/ack-ing any further
   * delivery the ack call itself returns, so nothing is silently dropped.
   * Returns false on a fatal ack failure (already handled via `failAllActive`).
   */
  private async drainDelivery(delivery: CheckResult, runId: string, signal: AbortSignal): Promise<boolean> {
    let current: CheckResult | undefined = delivery;
    while (current) {
      for (const message of current.messages ?? []) {
        await this.routeMailboxMessage(message);
      }

      const deliveryId = current.deliveryId;
      if (typeof deliveryId !== "string" || !deliveryId) return true;

      let ackResult: CheckResult;
      try {
        ackResult = await this.execMailboxWithRetry<CheckResult>(
          ["orchestration", "check", "--run", runId, "--ack", deliveryId, "--json"],
          "mailbox ack",
          signal,
        );
      } catch (err) {
        await this.failAllActive(err instanceof Error ? err.message : String(err));
        return false;
      }

      current = ackResult;
    }
    return true;
  }

  /**
   * Route one `worker_done` message to its dispatch, ignoring anything
   * unknown, stale, or unparseable. Requires `type: "worker_done"`, a
   * matching task id and `from_handle`, an exact lifecycle subject, and an
   * `outcome` consistent with that subject (`completed` -> `succeeded`,
   * `failed`/`truncated` -> `failed`).
   */
  private async routeMailboxMessage(message: RawMailboxMessage): Promise<void> {
    if (message.type !== "worker_done") return;
    if (typeof message.from_handle !== "string" || !message.from_handle) return;
    if (typeof message.subject !== "string") return;
    if (typeof message.body !== "string") return;

    const parsed = parseMailboxPayload(message.payload);
    if (!parsed) return;

    const record = this.active.get(parsed.dispatchId);
    if (!record) return;
    if (parsed.taskId !== record.taskId || message.from_handle !== record.terminalHandle) return;

    const status = parseImpLifecycleStatus(message.subject);
    if (!status) return;

    const expectedOutcome = status === "completed" ? "succeeded" : "failed";
    if (parsed.outcome !== expectedOutcome) return;

    const body = message.body;
    if (status === "completed") {
      await this.completeDispatch(record, { output: body });
    } else if (status === "failed") {
      await this.completeDispatch(record, {
        output: body,
        error: body.trim() ? body : STABLE_NO_OUTPUT_FALLBACK,
      });
    } else {
      await this.completeDispatch(record, { output: body, truncated: true });
    }
  }

  /** Fatal mailbox error: fail every still-active dispatch exactly once, closing its terminal, then stop consuming. */
  private async failAllActive(message: string): Promise<void> {
    const bounded = boundedError(`Orca mailbox failed: ${message || "unknown error"}`);
    const records = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      records
        .filter((record) => !record.settled)
        .map(async (record) => {
          record.settled = true;
          await this.safeExec(
            ["orchestration", "worker-stop", "--dispatch", record.dispatchId, "--json"],
            "worker stop (mailbox failure)",
          );
          await this.safeExec(
            ["orchestration", "worker-release", "--dispatch", record.dispatchId, "--json"],
            "worker release (mailbox failure)",
          );
          await this.safeExec(
            ["terminal", "close", "--terminal", record.terminalHandle, "--json"],
            "terminal close (mailbox failure)",
          );
          record.onComplete({ output: "", error: bounded });
        }),
    );
  }
}
