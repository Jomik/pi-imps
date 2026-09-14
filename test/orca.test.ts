import { describe, expect, it, vi } from "vitest";
import {
  buildOrcaSendArgs,
  createAgentDoneTool,
  extractTaskAfterMarker,
  ORCA_DISPATCHED_WORKER_PREAMBLE,
  ORCA_RESTRICTED_TOOLS,
  parseOrcaWorkerDispatch,
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

describe("ORCA_RESTRICTED_TOOLS", () => {
  it("names the four recursive imp tools", () => {
    expect(ORCA_RESTRICTED_TOOLS).toEqual(["summon", "wait", "dismiss", "list_imps"]);
  });
});

describe("buildOrcaSendArgs", () => {
  it("constructs the exact orca orchestration send argument vector", () => {
    const args = buildOrcaSendArgs(
      {
        workerHandle: "worker-7",
        taskId: "task_fba7406bf543",
        dispatchId: "dispatch-456",
        capability: "cap-secret-xyz",
      },
      "succeeded",
      "Implemented the feature and tests pass.",
    );
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
      "Worker worker-7 succeeded",
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
});

describe("agent_done tool", () => {
  const dispatch = {
    workerHandle: "worker-7",
    taskId: "task_fba7406bf543",
    dispatchId: "dispatch-456",
    capability: "cap-secret-xyz",
  };

  it("invokes pi.exec('orca', args) with exactly the constructed arguments and reports success", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });
    const tool = createAgentDoneTool(() => dispatch, exec);

    const result = await tool.execute(
      "call-1",
      { outcome: "succeeded", summary: "All good." },
      undefined,
      undefined,
      undefined as never,
    );

    expect(exec).toHaveBeenCalledWith("orca", buildOrcaSendArgs(dispatch, "succeeded", "All good."));
    expect(result.content[0]).toEqual({ type: "text", text: "Reported succeeded to Orca." });
  });

  it("throws a non-empty actionable error on nonzero exit without exposing the capability", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: `unauthorized capability ${dispatch.capability}`, code: 1 });
    const tool = createAgentDoneTool(() => dispatch, exec);

    await expect(
      tool.execute(
        "call-1",
        { outcome: "failed", summary: "Could not finish." },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/\[redacted\]/);

    try {
      await tool.execute(
        "call-1",
        { outcome: "failed", summary: "Could not finish." },
        undefined,
        undefined,
        undefined as never,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(dispatch.capability);
    }
  });

  it("throws a non-empty actionable error when exec throws, without exposing the capability", async () => {
    const exec = vi.fn().mockRejectedValue(new Error(`network error near ${dispatch.capability}`));
    const tool = createAgentDoneTool(() => dispatch, exec);

    try {
      await tool.execute(
        "call-1",
        { outcome: "failed", summary: "Could not finish." },
        undefined,
        undefined,
        undefined as never,
      );
      throw new Error("expected execute to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(dispatch.capability);
    }
  });

  it("throws when no active dispatch is available", async () => {
    const exec = vi.fn();
    const tool = createAgentDoneTool(() => undefined, exec);

    await expect(
      tool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/No active Orca dispatch/);
    expect(exec).not.toHaveBeenCalled();
  });
});
