import { describe, expect, it, vi } from "vitest";
import {
  buildOrcaSendArgs,
  buildStatusSubject,
  createAgentDoneTool,
  createImpLifecycleState,
  DEFAULT_IMP_TURN_LIMIT,
  extractTaskAfterMarker,
  ORCA_DISPATCHED_WORKER_PREAMBLE,
  parseImpLifecycleStatus,
  parseImpTurnLimit,
  parseOrcaWorkerDispatch,
  reportImpCompletion,
  verifyOrcaWorkerDispatch,
} from "../src/orca.js";

function validPrompt(overrides?: Partial<{ handle: string; taskId: string; dispatchId: string; capability: string }>) {
  const handle = overrides?.handle ?? "worker-7";
  const taskId = overrides?.taskId ?? "task_fba7406bf543";
  const dispatchId = overrides?.dispatchId ?? "dispatch-456";
  const capability = overrides?.capability ?? "cap-secret-xyz";
  return `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: ${taskId}

When finished, report completion by running:

orca orchestration send --from ${handle} --dispatch-capability ${capability} --type worker_done --subject "Task complete" --body "Implemented the feature and tests pass." --task-id ${taskId} --dispatch-id ${dispatchId} --outcome succeeded
`;
}

describe("parseOrcaWorkerDispatch", () => {
  it("extracts handle, task id, dispatch id, and capability from a well-formed prompt", () => {
    const dispatch = parseOrcaWorkerDispatch(validPrompt());
    expect(dispatch).toEqual({
      workerHandle: "worker-7",
      taskId: "task_fba7406bf543",
      dispatchId: "dispatch-456",
      capability: "cap-secret-xyz",
    });
  });

  it("does not require a standalone Dispatch ID line", () => {
    // validPrompt() already omits any "Dispatch ID:" line; this asserts that
    // omission alone does not cause rejection.
    expect(parseOrcaWorkerDispatch(validPrompt())).toBeDefined();
  });

  it("rejects a prompt that does not begin with the strict preamble", () => {
    const prompt = `Some other preamble.\n${validPrompt().slice(ORCA_DISPATCHED_WORKER_PREAMBLE.length)}`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a prompt missing the worker_done command", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}\n\nYour task ID is: task_fba7406bf543\n`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a prompt missing the task id sentence", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

orca orchestration send --from worker-7 --dispatch-capability cap1 --type worker_done --subject "s" --body "b" --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded
`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a command whose --task-id disagrees with the declared task id", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: task_fba7406bf543

orca orchestration send --from worker-7 --dispatch-capability cap1 --type worker_done --subject "s" --body "b" --task-id task_other --dispatch-id dispatch-456 --outcome succeeded
`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a command missing --dispatch-capability", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: task_fba7406bf543

orca orchestration send --from worker-7 --type worker_done --subject "s" --body "b" --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded
`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a command missing --dispatch-id", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: task_fba7406bf543

orca orchestration send --from worker-7 --dispatch-capability cap1 --type worker_done --subject "s" --body "b" --task-id task_fba7406bf543 --outcome succeeded
`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects a command missing --from", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: task_fba7406bf543

orca orchestration send --dispatch-capability cap1 --type worker_done --subject "s" --body "b" --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded
`;
    expect(parseOrcaWorkerDispatch(prompt)).toBeUndefined();
  });

  it("rejects an ordinary user prompt unrelated to Orca", () => {
    expect(parseOrcaWorkerDispatch("Please fix the failing test in src/foo.ts")).toBeUndefined();
  });

  it("parses a verbatim-style Orca preamble with a two-space-indented command and fake flags embedded in quoted --subject/--body text", () => {
    const prompt = `${ORCA_DISPATCHED_WORKER_PREAMBLE}

Your task ID is: task_fba7406bf543

When finished, report completion by running:

  orca orchestration send --from worker-7 --dispatch-capability cap-secret-xyz --type worker_done --subject "--task-id task_bogus --dispatch-id dispatch-bogus" --body "Fake flags here: --task-id task_bogus --dispatch-id dispatch-bogus" --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded
`;

    const dispatch = parseOrcaWorkerDispatch(prompt);
    expect(dispatch).toEqual({
      workerHandle: "worker-7",
      taskId: "task_fba7406bf543",
      dispatchId: "dispatch-456",
      capability: "cap-secret-xyz",
    });
  });
});

describe("verifyOrcaWorkerDispatch", () => {
  it("returns the dispatch when ORCA_TERMINAL_HANDLE exactly matches the parsed worker handle", () => {
    const dispatch = verifyOrcaWorkerDispatch(validPrompt({ handle: "worker-7" }), {
      ORCA_TERMINAL_HANDLE: "worker-7",
    } as NodeJS.ProcessEnv);
    expect(dispatch?.workerHandle).toBe("worker-7");
  });

  it("rejects when the terminal handle does not match", () => {
    const dispatch = verifyOrcaWorkerDispatch(validPrompt({ handle: "worker-7" }), {
      ORCA_TERMINAL_HANDLE: "worker-9",
    } as NodeJS.ProcessEnv);
    expect(dispatch).toBeUndefined();
  });

  it("rejects when ORCA_TERMINAL_HANDLE is unset", () => {
    const dispatch = verifyOrcaWorkerDispatch(validPrompt(), {} as NodeJS.ProcessEnv);
    expect(dispatch).toBeUndefined();
  });

  it("leaves normal parent prompts unaffected", () => {
    const dispatch = verifyOrcaWorkerDispatch("Implement the new feature described in TASK.md", {
      ORCA_TERMINAL_HANDLE: "worker-7",
    } as NodeJS.ProcessEnv);
    expect(dispatch).toBeUndefined();
  });
});

describe("extractTaskAfterMarker", () => {
  it("extracts the task text following an exact standalone marker line", () => {
    expect(extractTaskAfterMarker("preamble text\n\n=== TASK ===\nFix the failing test.")).toBe(
      "Fix the failing test.",
    );
  });

  it("trims surrounding whitespace but preserves internal task formatting", () => {
    expect(extractTaskAfterMarker("=== TASK ===\n  Line one.\nLine two.  \n")).toBe("Line one.\nLine two.");
  });

  it("rejects a missing marker", () => {
    expect(extractTaskAfterMarker("no marker here, just a task description")).toBeUndefined();
  });

  it("rejects a marker that is not standalone on its own line", () => {
    expect(extractTaskAfterMarker("prefix === TASK === Fix the bug.")).toBeUndefined();
  });

  it("rejects an empty remainder after the marker", () => {
    expect(extractTaskAfterMarker("=== TASK ===\n")).toBeUndefined();
  });

  it("rejects a whitespace-only remainder after the marker", () => {
    expect(extractTaskAfterMarker("=== TASK ===\n   \n  ")).toBeUndefined();
  });
});

describe("buildOrcaSendArgs", () => {
  const dispatch = {
    workerHandle: "worker-7",
    taskId: "task_fba7406bf543",
    dispatchId: "dispatch-456",
    capability: "cap-secret-xyz",
  };

  it("constructs the exact orca orchestration send argument vector for a completed status", () => {
    const args = buildOrcaSendArgs(dispatch, "completed", "Implemented the feature and tests pass.");
    expect(args).toEqual([
      "orchestration",
      "send",
      "--from",
      "worker-7",
      "--dispatch-capability",
      "cap-secret-xyz",
      "--type",
      "worker_done",
      "--subject",
      "pi-imps:completed",
      "--body",
      "Implemented the feature and tests pass.",
      "--task-id",
      "task_fba7406bf543",
      "--dispatch-id",
      "dispatch-456",
      "--outcome",
      "succeeded",
      "--json",
    ]);
  });

  it("maps failed and truncated statuses to the failed Orca outcome", () => {
    for (const status of ["failed", "truncated"] as const) {
      const args = buildOrcaSendArgs(dispatch, status, "body");
      expect(args).toContain("--outcome");
      expect(args[args.indexOf("--outcome") + 1]).toBe("failed");
      expect(args[args.indexOf("--subject") + 1]).toBe(`pi-imps:${status}`);
    }
  });
});

describe("stable lifecycle status subject", () => {
  it("builds exact namespaced subjects with no identifiers or model text", () => {
    expect(buildStatusSubject("completed")).toBe("pi-imps:completed");
    expect(buildStatusSubject("failed")).toBe("pi-imps:failed");
    expect(buildStatusSubject("truncated")).toBe("pi-imps:truncated");
  });

  it("parses completed, failed, and truncated subjects exactly", () => {
    expect(parseImpLifecycleStatus(buildStatusSubject("completed"))).toBe("completed");
    expect(parseImpLifecycleStatus(buildStatusSubject("failed"))).toBe("failed");
    expect(parseImpLifecycleStatus(buildStatusSubject("truncated"))).toBe("truncated");
  });

  it("is not influenced by arbitrary model-provided summary text", () => {
    // The status comes only from buildStatusSubject's fixed vocabulary; a
    // model-controlled body/summary string can never parse as a status.
    expect(parseImpLifecycleStatus("pi-imps:completed and also succeeded and failed")).toBeUndefined();
    expect(parseImpLifecycleStatus("the model claims: pi-imps:completed")).toBeUndefined();
  });

  it("buildStatusSubject accepts only status, no worker handle parameter", () => {
    expect(buildStatusSubject.length).toBe(1);
  });
});

describe("parseImpTurnLimit", () => {
  it("defaults to 30 when unset", () => {
    expect(parseImpTurnLimit(undefined)).toBe(DEFAULT_IMP_TURN_LIMIT);
    expect(parseImpTurnLimit(undefined)).toBe(30);
  });

  it("parses a valid whole number >= 2", () => {
    expect(parseImpTurnLimit("2")).toBe(2);
    expect(parseImpTurnLimit("45")).toBe(45);
  });

  it("rejects non-integer, negative, and below-minimum values", () => {
    for (const bad of ["1", "0", "-5", "abc", "3.5", "", " 5", "5 "]) {
      expect(() => parseImpTurnLimit(bad)).toThrow(/imp-turn-limit/);
    }
  });
});

describe("reportImpCompletion", () => {
  const dispatch = {
    workerHandle: "worker-7",
    taskId: "task_fba7406bf543",
    dispatchId: "dispatch-456",
    capability: "cap-secret-xyz",
  };

  it("sends exactly once and seals completion on success", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });
    const state = createImpLifecycleState();

    await reportImpCompletion(dispatch, state, "completed", "Done.", exec);

    expect(state.completionSealed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("orca", buildOrcaSendArgs(dispatch, "completed", "Done."));
  });

  it("rejects a duplicate call after a successful send, generically", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });
    const state = createImpLifecycleState();

    await reportImpCompletion(dispatch, state, "completed", "Done.", exec);

    await expect(reportImpCompletion(dispatch, state, "failed", "Again.", exec)).rejects.toThrow(
      /already been reported/,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent call while a send is in flight, generically", async () => {
    let resolveExec: (value: { stdout: string; stderr: string; code: number }) => void = () => {};
    const exec = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveExec = resolve;
      }),
    );
    const state = createImpLifecycleState();

    const first = reportImpCompletion(dispatch, state, "completed", "Done.", exec);
    await expect(reportImpCompletion(dispatch, state, "completed", "Done again.", exec)).rejects.toThrow(
      /already in progress/,
    );

    resolveExec({ stdout: "{}", stderr: "", code: 0 });
    await first;
    expect(state.completionSealed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a failed send; only a successful send seals completion", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "unauthorized", code: 1 })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "", code: 0 });
    const state = createImpLifecycleState();

    await expect(reportImpCompletion(dispatch, state, "failed", "body", exec)).rejects.toThrow(/rejected/);
    expect(state.completionSealed).toBe(false);

    await reportImpCompletion(dispatch, state, "failed", "body", exec);
    expect(state.completionSealed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("redacts all dispatch identifiers from a thrown-exec failure message", async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(new Error(`worker-7 exploded: task_fba7406bf543 / dispatch-456 / cap-secret-xyz`));
    const state = createImpLifecycleState();

    await expect(reportImpCompletion(dispatch, state, "failed", "body", exec)).rejects.toThrow(
      /\[redacted\] exploded: \[redacted\] \/ \[redacted\] \/ \[redacted\]/,
    );
    expect(state.completionSealed).toBe(false);
  });

  it("redacts all dispatch identifiers from a nonzero-exit stderr message", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: `rejected for worker-7 task_fba7406bf543 dispatch-456 cap-secret-xyz`,
      code: 1,
    });
    const state = createImpLifecycleState();

    await expect(reportImpCompletion(dispatch, state, "failed", "body", exec)).rejects.toThrow(
      /rejected for \[redacted\] \[redacted\] \[redacted\] \[redacted\]/,
    );
    expect(state.completionSealed).toBe(false);
  });

  it("throws a host-neutral error when no active dispatch is available", async () => {
    const exec = vi.fn();
    const state = createImpLifecycleState();

    await expect(reportImpCompletion(undefined, state, "failed", "body", exec)).rejects.toThrow(/No active dispatch/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("agent_done tool", () => {
  it("invokes the injected report function with outcome/summary and returns terminate: true", async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const tool = createAgentDoneTool(report);

    const result = await tool.execute(
      "call-1",
      { outcome: "succeeded", summary: "All good." },
      undefined,
      undefined,
      undefined as never,
    );

    expect(report).toHaveBeenCalledWith("succeeded", "All good.");
    expect(result.terminate).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Completion reported." });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toMatch(/orca/i);
    expect(text).not.toMatch(/dispatch/i);
  });

  it("propagates a rejected report as a thrown error", async () => {
    const report = vi.fn().mockRejectedValue(new Error("Failed to report completion: [redacted]"));
    const tool = createAgentDoneTool(report);

    await expect(
      tool.execute(
        "call-1",
        { outcome: "failed", summary: "Could not finish." },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/\[redacted\]/);
  });

  it("propagates a host-neutral no-active-dispatch error from the report function", async () => {
    const report = vi
      .fn()
      .mockRejectedValue(new Error("No active dispatch for this session; cannot report completion."));
    const tool = createAgentDoneTool(report);

    await expect(
      tool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/No active dispatch/);
  });

  it("guidance is generic and never mentions Orca, dispatch ids, capability, or CLI", () => {
    const tool = createAgentDoneTool(vi.fn());
    const guidanceText = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
    expect(guidanceText.toLowerCase()).not.toContain("orca");
    expect(guidanceText.toLowerCase()).not.toContain("dispatch");
    expect(guidanceText.toLowerCase()).not.toContain("capability");
    expect(guidanceText.toLowerCase()).not.toContain("cli");
    expect(guidanceText).toMatch(/exactly once/);
  });
});
