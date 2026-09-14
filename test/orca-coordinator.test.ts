import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrcaExecFn } from "../src/orca.js";
import { OrcaCoordinator } from "../src/orca-coordinator.js";
import type { AgentConfig, ImpSettings } from "../src/types.js";

// ─── deterministic fake `orca` CLI ─────────────────────────────────────────
//
// Models exactly the envelope shapes the coordinator relies on:
// - orchestration run-create / task-create / worker-start
// - terminal create / wait-tui-idle / close
// - orchestration worker-stop / worker-release
// - orchestration check --wait --types worker_done / check --ack
//
// Deliveries are injected via `pushDelivery`; `check --wait` pops the next
// queued delivery (or an empty one, simulating a timeout/no-message poll).
// `check --ack <id>` pops any delivery separately queued as the "next
// delivery" chained onto that specific ack (via `chainAckDelivery`).

interface Envelope {
  ok: boolean;
  [k: string]: unknown;
}

interface DeliveryMessage {
  payload: string | { dispatchId: string; taskId: string; from: string; subject: string; body: string };
}

interface Delivery {
  id: string;
  messages: DeliveryMessage[];
}

function ok(body: Record<string, unknown> = {}): Envelope {
  return { ok: true, ...body };
}

/** Resolves after `ms`, rejecting immediately if `signal` is (or becomes) aborted — models a real long-poll network call. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

class FakeOrcaCli {
  runSeq = 0;
  terminalSeq = 0;
  taskSeq = 0;
  workerSeq = 0;
  dispatchSeq = 0;

  runId: string | undefined;
  closedTerminals: string[] = [];
  stoppedWorkers: string[] = [];
  releasedWorkers: string[] = [];

  private deliveryQueue: Delivery[] = [];
  private ackChain = new Map<string, Delivery>();

  failNextRunCreate = false;
  failCheck: Error | undefined;
  failAckFor: string | undefined;

  /** Queue a `check --wait` response (in order). */
  pushDelivery(delivery: Delivery) {
    this.deliveryQueue.push(delivery);
  }

  /** Register the envelope that `check --ack <deliveryId>` should return. */
  chainAckDelivery(deliveryId: string, delivery: Delivery) {
    this.ackChain.set(deliveryId, delivery);
  }

  exec: OrcaExecFn = async (command, args, options) => {
    expect(command).toBe("orca");
    if (options?.signal?.aborted) {
      throw new Error("aborted");
    }

    const [group, action] = args;

    if (group === "status" || (group === "worktree" && action === "current")) {
      return { stdout: JSON.stringify(ok()), stderr: "", code: 0 };
    }

    if (group === "orchestration" && action === "run-create") {
      if (this.failNextRunCreate) {
        return { stdout: "", stderr: "run-create exploded", code: 1 };
      }
      if (!this.runId) {
        this.runId = `run_${++this.runSeq}`;
      }
      return { stdout: JSON.stringify(ok({ run: { id: this.runId } })), stderr: "", code: 0 };
    }

    if (group === "terminal" && action === "create") {
      const id = `term_${++this.terminalSeq}`;
      return { stdout: JSON.stringify(ok({ terminal: { id } })), stderr: "", code: 0 };
    }

    if (group === "terminal" && action === "wait-tui-idle") {
      return { stdout: JSON.stringify(ok({ state: "idle" })), stderr: "", code: 0 };
    }

    if (group === "terminal" && action === "close") {
      const idx = args.indexOf("--terminal");
      this.closedTerminals.push(args[idx + 1]);
      return { stdout: JSON.stringify(ok()), stderr: "", code: 0 };
    }

    if (group === "orchestration" && action === "task-create") {
      const id = `task_${++this.taskSeq}`;
      return { stdout: JSON.stringify(ok({ task: { id } })), stderr: "", code: 0 };
    }

    if (group === "orchestration" && action === "worker-start") {
      const workerId = `worker_${++this.workerSeq}`;
      const dispatchId = `dispatch_${++this.dispatchSeq}`;
      return {
        stdout: JSON.stringify(ok({ worker: { id: workerId, handle: `handle_${workerId}` }, dispatchId })),
        stderr: "",
        code: 0,
      };
    }

    if (group === "orchestration" && action === "worker-stop") {
      const idx = args.indexOf("--worker");
      this.stoppedWorkers.push(args[idx + 1]);
      return { stdout: JSON.stringify(ok()), stderr: "", code: 0 };
    }

    if (group === "orchestration" && action === "worker-release") {
      const idx = args.indexOf("--worker");
      this.releasedWorkers.push(args[idx + 1]);
      return { stdout: JSON.stringify(ok()), stderr: "", code: 0 };
    }

    if (group === "orchestration" && action === "check") {
      if (args.includes("--ack")) {
        const idx = args.indexOf("--ack");
        const deliveryId = args[idx + 1];
        if (this.failAckFor && deliveryId === this.failAckFor) {
          return { stdout: "", stderr: "ack exploded", code: 1 };
        }
        const chained = this.ackChain.get(deliveryId);
        return { stdout: JSON.stringify(ok(chained ? { delivery: chained } : {})), stderr: "", code: 0 };
      }
      // Models a real `--wait` long poll: always yields to a macrotask (and
      // observes abort promptly) instead of resolving in a tight microtask
      // loop, which would otherwise starve the event loop across iterations.
      await delay(0, options?.signal);
      if (this.failCheck) {
        return { stdout: "", stderr: this.failCheck.message, code: 1 };
      }
      const next = this.deliveryQueue.shift();
      return { stdout: JSON.stringify(ok(next ? { delivery: next } : {})), stderr: "", code: 0 };
    }

    throw new Error(`unexpected fake orca command: ${args.join(" ")}`);
  };
}

function payloadMessage(
  fields: {
    dispatchId: string;
    taskId: string;
    from: string;
    subject: string;
    body: string;
  },
  asString = false,
) {
  return { payload: asString ? JSON.stringify(fields) : fields };
}

function makeModel(): Model<Api> {
  return {
    id: "claude-3",
    name: "claude-3",
    provider: "anthropic",
    api: "anthropic-messages",
  } as unknown as Model<Api>;
}

function makeModelRegistry(): ModelRegistry {
  return { getAvailable: () => [makeModel()] } as unknown as ModelRegistry;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "coder",
    description: "Test agent",
    systemPrompt: "You are a coder.",
    source: "user",
    filePath: "/tmp/coder.md",
    ...overrides,
  };
}

function makeSettings(overrides: Partial<ImpSettings> = {}): ImpSettings {
  return {
    turnLimit: 30,
    toolAllowlist: undefined,
    additionalExtensions: [],
    agents: {},
    orca: { enabled: true },
    ...overrides,
  };
}

/**
 * Wraps `cli.exec` in a stable indirection function so that reassigning or
 * `vi.spyOn`-wrapping `cli.exec` after construction (as several tests below
 * do) is still observed by the coordinator, which only ever holds the one
 * function reference passed to its constructor.
 */
function makeCoordinator(cli: FakeOrcaCli): OrcaCoordinator {
  return new OrcaCoordinator((command, args, options) => cli.exec(command, args, options));
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-imps-orca-coordinator-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseSpawnOpts(overrides: Partial<Parameters<OrcaCoordinator["spawn"]>[0]> = {}) {
  return {
    name: "imp-a",
    task: "do the thing",
    signal: new AbortController().signal,
    cwd,
    config: makeAgent(),
    parentModel: makeModel(),
    parentThinkingLevel: "high" as const,
    modelRegistry: makeModelRegistry(),
    settings: makeSettings(),
    onActivity: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  };
}

describe("OrcaCoordinator.spawn", () => {
  it("shares one run across two concurrent spawns, but creates distinct terminals/tasks/dispatches", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);

    const execSpy = vi.spyOn(cli, "exec");
    const [handleA, handleB] = await Promise.all([
      coordinator.spawn(baseSpawnOpts({ name: "imp-a" })),
      coordinator.spawn(baseSpawnOpts({ name: "imp-b" })),
    ]);

    expect(handleA.abort).toBeInstanceOf(Function);
    expect(handleB.abort).toBeInstanceOf(Function);
    expect(cli.runSeq).toBe(1);
    expect(cli.terminalSeq).toBe(2);
    expect(cli.taskSeq).toBe(2);
    expect(cli.dispatchSeq).toBe(2);

    const runCreateCalls = execSpy.mock.calls.filter((c) => c[1][1] === "run-create");
    expect(runCreateCalls).toHaveLength(1);
  });

  it("uses the exact current-worktree terminal-create command and never creates a worktree", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const execSpy = vi.spyOn(cli, "exec");

    await coordinator.spawn(baseSpawnOpts({ name: "imp-a" }));

    const terminalCreateCall = execSpy.mock.calls.find((c) => c[1][0] === "terminal" && c[1][1] === "create");
    expect(terminalCreateCall?.[1]).toEqual(
      expect.arrayContaining(["terminal", "create", "--worktree", "current", "--title", "imp-a"]),
    );
    expect(execSpy.mock.calls.some((c) => c[1].join(" ").includes("worktree create"))).toBe(false);
    expect(execSpy.mock.calls.some((c) => c[1][0] === "worktree" && c[1][1] === "create")).toBe(false);
  });

  it("rejects and closes the created terminal when worker-start fails", async () => {
    const cli = new FakeOrcaCli();
    const originalExec = cli.exec;
    cli.exec = async (command, args, options) => {
      if (args[0] === "orchestration" && args[1] === "worker-start") {
        return { stdout: "", stderr: "worker-start exploded", code: 1 };
      }
      return originalExec(command, args, options);
    };
    const coordinator = makeCoordinator(cli);

    await expect(coordinator.spawn(baseSpawnOpts())).rejects.toThrow(/worker-start exploded/);
    expect(cli.closedTerminals).toHaveLength(1);
  });

  it("cancels command operations and closes the created terminal on abort during a partial spawn", async () => {
    const cli = new FakeOrcaCli();
    const controller = new AbortController();
    const originalExec = cli.exec;
    cli.exec = async (command, args, options) => {
      if (args[0] === "orchestration" && args[1] === "task-create") {
        controller.abort();
      }
      return originalExec(command, args, options);
    };
    const coordinator = makeCoordinator(cli);

    await expect(coordinator.spawn(baseSpawnOpts({ signal: controller.signal }))).rejects.toThrow(/aborted/);
    expect(cli.closedTerminals).toHaveLength(1);
  });
});

describe("OrcaCoordinator mailbox routing", () => {
  it("routes out-of-order worker_done messages by dispatch id, and completed/failed/truncated map correctly", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);

    const onCompleteA = vi.fn();
    const onCompleteB = vi.fn();
    const onCompleteC = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ name: "imp-a", onComplete: onCompleteA }));
    await coordinator.spawn(baseSpawnOpts({ name: "imp-b", onComplete: onCompleteB }));
    await coordinator.spawn(baseSpawnOpts({ name: "imp-c", onComplete: onCompleteC }));

    // dispatch_1 -> imp-a, dispatch_2 -> imp-b, dispatch_3 -> imp-c
    // Deliver out of order: c (truncated), a (completed), b (failed).
    cli.pushDelivery({
      id: "delivery-1",
      messages: [
        payloadMessage({
          dispatchId: "dispatch_3",
          taskId: "task_3",
          from: "handle_worker_3",
          subject: "pi-imps:truncated",
          body: "partial work",
        }),
        payloadMessage(
          {
            dispatchId: "dispatch_1",
            taskId: "task_1",
            from: "handle_worker_1",
            subject: "pi-imps:completed",
            body: "all done",
          },
          true,
        ),
        payloadMessage({
          dispatchId: "dispatch_2",
          taskId: "task_2",
          from: "handle_worker_2",
          subject: "pi-imps:failed",
          body: "blew up",
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(onCompleteC).toHaveBeenCalled();
      expect(onCompleteA).toHaveBeenCalled();
      expect(onCompleteB).toHaveBeenCalled();
    });
    await coordinator.shutdown();

    expect(onCompleteC).toHaveBeenCalledWith({ output: "partial work", truncated: true });
    expect(onCompleteA).toHaveBeenCalledWith({ output: "all done" });
    expect(onCompleteB).toHaveBeenCalledWith({ output: "blew up", error: "blew up" });
  });

  it("maps a failed message with an empty body to the stable fallback error", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onComplete = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ onComplete }));

    cli.pushDelivery({
      id: "delivery-1",
      messages: [
        payloadMessage({
          dispatchId: "dispatch_1",
          taskId: "task_1",
          from: "handle_worker_1",
          subject: "pi-imps:failed",
          body: "",
        }),
      ],
    });

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    await coordinator.shutdown();

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ output: "", error: expect.stringMatching(/.+/) }),
    );
  });

  it("ignores an unknown dispatch id, a mismatched task/from, and an invalid subject, but always acks", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onComplete = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ onComplete }));

    cli.pushDelivery({
      id: "delivery-1",
      messages: [
        payloadMessage({
          dispatchId: "dispatch_unknown",
          taskId: "task_1",
          from: "handle_worker_1",
          subject: "pi-imps:completed",
          body: "x",
        }),
        payloadMessage({
          dispatchId: "dispatch_1",
          taskId: "wrong-task",
          from: "handle_worker_1",
          subject: "pi-imps:completed",
          body: "x",
        }),
        payloadMessage({
          dispatchId: "dispatch_1",
          taskId: "task_1",
          from: "someone-else",
          subject: "pi-imps:completed",
          body: "x",
        }),
        payloadMessage({
          dispatchId: "dispatch_1",
          taskId: "task_1",
          from: "handle_worker_1",
          subject: "not-a-real-subject",
          body: "x",
        }),
      ],
    });

    const execSpy = vi.spyOn(cli, "exec");
    await vi.waitFor(() => {
      expect(execSpy.mock.calls.filter((c) => c[1].includes("--ack"))).toHaveLength(1);
    });
    await coordinator.shutdown();

    expect(onComplete).not.toHaveBeenCalled();
    // The single delivery was acked exactly once even though every message was ignored.
    expect(execSpy.mock.calls.filter((c) => c[1].includes("--ack"))).toHaveLength(1);
  });

  it("serializes ack flow: an ack response chaining another delivery is drained and acked too", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onComplete = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ onComplete }));

    cli.pushDelivery({
      id: "delivery-1",
      messages: [
        payloadMessage({
          dispatchId: "dispatch_missing", // ignored: keeps this delivery's onComplete count at zero
          taskId: "task_x",
          from: "handle_x",
          subject: "pi-imps:completed",
          body: "irrelevant",
        }),
      ],
    });
    cli.chainAckDelivery("delivery-1", {
      id: "delivery-2",
      messages: [
        payloadMessage({
          dispatchId: "dispatch_1",
          taskId: "task_1",
          from: "handle_worker_1",
          subject: "pi-imps:completed",
          body: "final",
        }),
      ],
    });

    const execSpy = vi.spyOn(cli, "exec");
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    await coordinator.shutdown();

    expect(onComplete).toHaveBeenCalledWith({ output: "final" });
    expect(execSpy.mock.calls.filter((c) => c[1].includes("--ack"))).toHaveLength(2);
  });

  it("never runs two concurrent mailbox check consumers", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);

    let inFlight = 0;
    let maxInFlight = 0;
    const originalExec = cli.exec;
    cli.exec = async (command, args, options) => {
      if (args[0] === "orchestration" && args[1] === "check") {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const result = await originalExec(command, args, options);
        inFlight--;
        return result;
      }
      return originalExec(command, args, options);
    };

    await Promise.all([
      coordinator.spawn(baseSpawnOpts({ name: "imp-a" })),
      coordinator.spawn(baseSpawnOpts({ name: "imp-b" })),
    ]);

    cli.pushDelivery({ id: "d1", messages: [] });
    cli.pushDelivery({ id: "d2", messages: [] });

    await coordinator.shutdown();

    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

describe("OrcaCoordinator abort / shutdown / fatal mailbox", () => {
  it("abort is idempotent, does not call onComplete, and always closes the externally-created terminal", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onComplete = vi.fn();

    const handle = await coordinator.spawn(baseSpawnOpts({ onComplete }));
    await handle.abort();
    await handle.abort(); // idempotent second call

    expect(onComplete).not.toHaveBeenCalled();
    expect(cli.closedTerminals).toHaveLength(1);
    expect(cli.stoppedWorkers).toHaveLength(1);
    expect(cli.releasedWorkers).toHaveLength(1);
  });

  it("a fatal mailbox error fails every active imp exactly once with a non-empty error, closing terminals", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onCompleteA = vi.fn();
    const onCompleteB = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ name: "imp-a", onComplete: onCompleteA }));
    await coordinator.spawn(baseSpawnOpts({ name: "imp-b", onComplete: onCompleteB }));

    cli.failCheck = new Error("mailbox exploded");

    // Give the mailbox loop a tick to hit the failing check call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCompleteA).toHaveBeenCalledTimes(1);
    expect(onCompleteA.mock.calls[0][0].error).toEqual(expect.stringMatching(/.+/));
    expect(onCompleteB).toHaveBeenCalledTimes(1);
    expect(cli.closedTerminals).toHaveLength(2);

    await coordinator.shutdown();
  });

  it("shutdown aborts the mailbox and every active handle, and refuses new spawns", async () => {
    const cli = new FakeOrcaCli();
    const coordinator = makeCoordinator(cli);
    const onComplete = vi.fn();

    await coordinator.spawn(baseSpawnOpts({ onComplete }));
    await coordinator.shutdown();

    expect(onComplete).not.toHaveBeenCalled();
    expect(cli.closedTerminals).toHaveLength(1);

    await expect(coordinator.spawn(baseSpawnOpts())).rejects.toThrow(/shutting down/);
  });
});
