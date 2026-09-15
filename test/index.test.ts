import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./helpers/index.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentDir: vi.fn(() => "/nonexistent-pi-agent-dir-for-testing-xyz"),
  };
});

const extensionFactory = (await import("../src/index.js")).default;

interface MockPi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerFlag: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function createMockPi(isImp = false, flags: Record<string, unknown> = {}): MockPi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const registerFlag = vi.fn();
  const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool,
    registerCommand,
    registerFlag,
    getFlag: vi.fn((name: string) => {
      if (name === "is-imp") return isImp;
      if (name in flags) return flags[name];
      return undefined;
    }),
    getThinkingLevel: vi.fn(() => "off"),
    exec,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerTool, registerCommand, registerFlag, exec, sendUserMessage };
}

/** Trigger the (single, bootstrap) `session_start` handler registered at factory time. */
function startSession(handlers: MockPi["handlers"], reason: "startup" | "reload" = "startup") {
  return handlers.get("session_start")?.({ reason }, createMockContext());
}

describe("factory execution (before session_start)", () => {
  it("never calls getFlag during factory execution", () => {
    const { pi } = createMockPi(false);
    extensionFactory(pi);

    expect(pi.getFlag).not.toHaveBeenCalled();
  });

  it("registers only the two custom flags and a single bootstrap session_start handler; no tools or commands yet", () => {
    const { pi, handlers, registerTool, registerCommand, registerFlag } = createMockPi(false);
    extensionFactory(pi);

    expect(registerFlag).toHaveBeenCalledTimes(2);
    expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean", default: false }));
    expect(registerFlag).toHaveBeenCalledWith(
      "imp-turn-limit",
      expect.objectContaining({ type: "string", default: "30" }),
    );
    expect([...handlers.keys()]).toEqual(["session_start"]);
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
  });

  it("regression: getFlag is unavailable/throws before session_start, then reports is-imp=true only once read during the event", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const registerTool = vi.fn();
    let flagsAvailable = false;
    const getFlag = vi.fn((name: string) => {
      if (!flagsAvailable) throw new Error("custom flag values are not available yet");
      if (name === "is-imp") return true;
      if (name === "imp-turn-limit") return "30";
      return undefined;
    });
    const pi = {
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      }),
      registerTool,
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      getFlag,
      getThinkingLevel: vi.fn(() => "off"),
      exec: vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    // Factory execution never reads getFlag, so it must not throw even though
    // getFlag itself would throw if called right now.
    expect(() => extensionFactory(pi)).not.toThrow();

    flagsAvailable = true;
    startSession(handlers);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["agent_done"]);
  });
});

describe("ordinary pi-imps extension behavior", () => {
  it("registers the is-imp flag with a false default", () => {
    const { pi, registerFlag } = createMockPi();
    extensionFactory(pi);

    expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean", default: false }));
  });

  it("registers exactly the four built-in imp tools and never agent_done, only after session_start", () => {
    const { pi, handlers, registerTool } = createMockPi();
    extensionFactory(pi);
    expect(registerTool).not.toHaveBeenCalled();

    startSession(handlers);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["summon", "wait", "dismiss", "list_imps"]);
    expect(registeredNames).not.toContain("agent_done");
  });

  it("registers the /imps command and session hooks after session_start", () => {
    const { pi, registerCommand, handlers } = createMockPi();
    extensionFactory(pi);
    expect(registerCommand).not.toHaveBeenCalled();

    startSession(handlers);

    expect(registerCommand).toHaveBeenCalledWith("imps", expect.anything());
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_before_switch")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("before_agent_start leaves the system prompt unchanged when no agents are discovered", () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    startSession(handlers);
    const result = handlers.get("before_agent_start")?.(
      { prompt: "Fix the failing test", systemPrompt: "base system prompt" },
      createMockContext(),
    );

    expect(result).toBeUndefined();
  });

  it("a second session_start does not duplicate tool/command registration", () => {
    const { pi, handlers, registerTool, registerCommand } = createMockPi();
    extensionFactory(pi);

    startSession(handlers, "startup");
    startSession(handlers, "reload");

    expect(registerTool).toHaveBeenCalledTimes(4);
    expect(registerCommand).toHaveBeenCalledTimes(1);
  });
});

describe("imp worker mode (is-imp flag)", () => {
  it("registers the is-imp flag", () => {
    const { pi, registerFlag } = createMockPi(true);
    extensionFactory(pi);

    expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean", default: false }));
  });

  it("registers exactly agent_done and no parent tools, command, or hooks, only after session_start", () => {
    const { pi, registerTool, registerCommand, handlers } = createMockPi(true);
    extensionFactory(pi);
    expect(registerTool).not.toHaveBeenCalled();

    startSession(handlers);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["agent_done"]);
    expect(registerCommand).not.toHaveBeenCalled();
    // The bootstrap session_start handler itself is always present (both
    // modes register it at factory time); worker mode never registers any
    // of the ordinary parent hooks/tools/commands.
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(false);
    expect(handlers.has("session_before_switch")).toBe(false);
    expect(handlers.has("session_shutdown")).toBe(false);
    expect(handlers.has("turn_start")).toBe(false);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("agent_settled")).toBe(true);
    expect(handlers.has("tool_execution_end")).toBe(false);
    expect(handlers.has("input")).toBe(true);
  });

  it("a second session_start does not re-initialize worker mode or register a duplicate agent_done", () => {
    const { pi, handlers, registerTool } = createMockPi(true);
    extensionFactory(pi);

    startSession(handlers, "startup");
    startSession(handlers, "reload");

    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  describe("input transform", () => {
    const originalHandle = process.env.ORCA_TERMINAL_HANDLE;

    beforeEach(() => {
      process.env.ORCA_TERMINAL_HANDLE = "worker-7";
    });

    afterEach(() => {
      if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
    });

    const CAPABILITY = "cap-secret-xyz";

    function workerPrompt(task: string, overrides?: Partial<{ handle: string; taskId: string; dispatchId: string }>) {
      const handle = overrides?.handle ?? "worker-7";
      const taskId = overrides?.taskId ?? "task_fba7406bf543";
      const dispatchId = overrides?.dispatchId ?? "dispatch-456";
      return `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.

Your task ID is: ${taskId}

orca orchestration send --from ${handle} --dispatch-capability ${CAPABILITY} --type worker_done --subject "Task complete" --body "Implemented the feature." --task-id ${taskId} --dispatch-id ${dispatchId} --outcome succeeded

=== TASK ===
${task}`;
    }

    it("agent_done guidance is generic and never mentions Orca, dispatch ids, capability, or CLI", () => {
      const { pi, handlers, registerTool } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const tool = registerTool.mock.calls[0][0];
      const guidanceText = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
      expect(guidanceText.toLowerCase()).not.toContain("orca");
      expect(guidanceText.toLowerCase()).not.toContain("dispatch");
      expect(guidanceText.toLowerCase()).not.toContain("capability");
      expect(guidanceText.toLowerCase()).not.toContain("cli");
      expect(guidanceText).toMatch(/exactly once/);
    });

    it("transforms a verified worker input to exactly the task text, stripping preamble/id/capability/command", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const prompt = workerPrompt("Fix the failing test in src/foo.ts.");
      const result = handlers.get("input")?.({ type: "input", text: prompt, source: "interactive" }, undefined) as
        | { action: string; text?: string }
        | undefined;

      expect(result).toEqual({ action: "transform", text: "Fix the failing test in src/foo.ts." });
      expect(result?.text).not.toContain("Orca");
      expect(result?.text).not.toContain(CAPABILITY);
      expect(result?.text).not.toContain("dispatch-456");
      expect(result?.text).not.toContain("task_fba7406bf543");
      expect(result?.text).not.toContain("orca orchestration send");
    });

    it("preserves images by not overriding them on transform", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const images = [{ type: "image", data: "base64", mimeType: "image/png" }];
      const result = handlers.get("input")?.(
        { type: "input", text: workerPrompt("Do the thing."), images, source: "interactive" },
        undefined,
      ) as { action: string; images?: unknown };

      expect(result.images).toBeUndefined();
    });

    it("continues unchanged when the exact '=== TASK ===' marker is missing", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const prompt = workerPrompt("ignored").replace("=== TASK ===\n", "");
      const result = handlers.get("input")?.({ type: "input", text: prompt, source: "interactive" }, undefined);

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged when the task after the marker is empty", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const prompt = workerPrompt("   ");
      const result = handlers.get("input")?.({ type: "input", text: prompt, source: "interactive" }, undefined);

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged when ORCA_TERMINAL_HANDLE does not match", () => {
      process.env.ORCA_TERMINAL_HANDLE = "worker-9";
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const result = handlers.get("input")?.(
        { type: "input", text: workerPrompt("Do the thing."), source: "interactive" },
        undefined,
      );

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged for a malformed (non-Orca) prompt", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const result = handlers.get("input")?.(
        { type: "input", text: "Please fix the failing test.\n=== TASK ===\nDo it.", source: "interactive" },
        undefined,
      );

      expect(result).toEqual({ action: "continue" });
    });

    it("does not update dispatch context or register a tool on an invalid input", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      handlers.get("input")?.({ type: "input", text: "not an orca prompt", source: "interactive" }, undefined);

      // Only the single agent_done registration from session_start; no dispatch was ever set.
      expect(registerTool).toHaveBeenCalledTimes(1);
      const tool = registerTool.mock.calls[0][0];
      await expect(
        tool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, {}),
      ).rejects.toThrow(/No active dispatch/);
      expect(exec).not.toHaveBeenCalled();
    });

    it("updates private dispatch on reuse; the single registered agent_done reads the latest dispatch", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const handler = handlers.get("input");
      if (!handler) throw new Error("input handler not registered");

      handler({ type: "input", text: workerPrompt("First task."), source: "interactive" }, undefined);
      handler(
        {
          type: "input",
          text: workerPrompt("Second task.", { taskId: "task_999", dispatchId: "dispatch-999" }),
          source: "interactive",
        },
        undefined,
      );

      expect(registerTool).toHaveBeenCalledTimes(1);
      const tool = registerTool.mock.calls[0][0];
      await tool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, {});

      expect(exec).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining(["--task-id", "task_999", "--dispatch-id", "dispatch-999"]),
      );
    });

    it("second verified dispatch resets turn/lifecycle state", () => {
      const { pi, handlers, sendUserMessage } = createMockPi(true, { "imp-turn-limit": "3" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("First task."), source: "interactive" }, undefined);
      turnEndHandler(
        { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] } },
        { abort: vi.fn() },
      );
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Re-verify a fresh dispatch: turn/lifecycle state must reset.
      inputHandler(
        {
          type: "input",
          text: workerPrompt("Second task.", { taskId: "task_999", dispatchId: "dispatch-999" }),
          source: "interactive",
        },
        undefined,
      );

      // With reset state, the first turn of the new dispatch should not
      // trigger the penultimate-turn directive (limit is 3, penultimate is
      // turnCount === 2 — it would already have fired without a reset).
      turnEndHandler(
        { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] } },
        { abort: vi.fn() },
      );
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Second turn of the new dispatch reaches the penultimate turn.
      turnEndHandler(
        { type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [] } },
        { abort: vi.fn() },
      );
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("tool_result handler uses normalizeEmptyToolError", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const handler = handlers.get("tool_result");
      if (!handler) throw new Error("tool_result handler not registered");

      const result = handler(
        { toolName: "some_tool", isError: true, content: [{ type: "text", text: "   " }] },
        undefined,
      ) as { content: Array<{ type: string; text: string }> } | undefined;

      expect(result).toEqual({
        content: [{ type: "text", text: 'Tool "some_tool" failed without an error message' }],
      });
    });
  });

  describe("turn limit lifecycle", () => {
    const originalHandle = process.env.ORCA_TERMINAL_HANDLE;

    beforeEach(() => {
      process.env.ORCA_TERMINAL_HANDLE = "worker-7";
    });

    afterEach(() => {
      if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
    });

    const CAPABILITY = "cap-secret-xyz";

    function workerPrompt(task: string) {
      return `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.

Your task ID is: task_fba7406bf543

orca orchestration send --from worker-7 --dispatch-capability ${CAPABILITY} --type worker_done --subject "Task complete" --body "Implemented the feature." --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded

=== TASK ===
${task}`;
    }

    function assistantTurnEnd(text: string) {
      return { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text }] } };
    }

    it("registers both custom flags at factory time", () => {
      const { pi, registerFlag } = createMockPi(true);
      extensionFactory(pi);

      expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean" }));
      expect(registerFlag).toHaveBeenCalledWith("imp-turn-limit", expect.objectContaining({ type: "string" }));
    });

    it("fails worker startup on an invalid --imp-turn-limit at session_start, not at factory time", () => {
      const { pi, handlers } = createMockPi(true, { "imp-turn-limit": "1" });
      expect(() => extensionFactory(pi)).not.toThrow();
      expect(() => startSession(handlers)).toThrow(/imp-turn-limit/);
    });

    it("uses the default turn limit when unset", () => {
      const { pi, handlers, sendUserMessage } = createMockPi(true);
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      for (let i = 0; i < 28; i++) {
        turnEndHandler(assistantTurnEnd("progress"), { abort: vi.fn() });
      }
      expect(sendUserMessage).not.toHaveBeenCalled();
      turnEndHandler(assistantTurnEnd("progress"), { abort: vi.fn() });
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("queues the exact FINAL_TURN_DIRECTIVE with deliverAs steer on the penultimate turn", async () => {
      const { FINAL_TURN_DIRECTIVE } = await import("../src/session.js");
      const { pi, handlers, sendUserMessage } = createMockPi(true, { "imp-turn-limit": "3" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(assistantTurnEnd("turn one"), { abort: vi.fn() });
      turnEndHandler(assistantTurnEnd("turn two"), { abort: vi.fn() });

      expect(sendUserMessage).toHaveBeenCalledWith(FINAL_TURN_DIRECTIVE, { deliverAs: "steer" });
    });

    it("final turn awaits the controlled exec promise before aborting; sends truncated subject, outcome failed, and the last assistant output", async () => {
      const { pi, handlers } = createMockPi(true, { "imp-turn-limit": "2" });
      extensionFactory(pi);
      startSession(handlers);

      let resolveExec: (value: { stdout: string; stderr: string; code: number }) => void = () => {};
      const controlledExec = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveExec = resolve;
        }),
      );
      (pi as unknown as { exec: unknown }).exec = controlledExec;

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(assistantTurnEnd("first turn"), { abort: vi.fn() });

      const abort = vi.fn();
      const pending = turnEndHandler(assistantTurnEnd("Final output text."), { abort });

      // exec is in flight; abort must not have been called yet.
      expect(controlledExec).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
      expect(controlledExec).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining([
          "--subject",
          "pi-imps:truncated",
          "--outcome",
          "failed",
          "--body",
          "Final output text.",
        ]),
      );

      resolveExec({ stdout: "{}", stderr: "", code: 0 });
      await pending;

      expect(abort).toHaveBeenCalledTimes(1);
    });

    it("falls back to the stable no-output message when no assistant output was recorded before completion", async () => {
      const { STABLE_NO_OUTPUT_FALLBACK } = await import("../src/orca.js");
      const { pi, handlers, exec } = createMockPi(true, { "imp-turn-limit": "2" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(
        { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] } },
        { abort: vi.fn() },
      );

      const abort = vi.fn();
      await turnEndHandler({ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: [] } }, { abort });

      expect(abort).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith("orca", expect.arrayContaining(["--body", STABLE_NO_OUTPUT_FALLBACK]));
    });

    it("natural agent_settled sends failed once", async () => {
      const { pi, handlers, exec } = createMockPi(true, { "imp-turn-limit": "30" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const settledHandler = handlers.get("agent_settled");
      if (!inputHandler || !settledHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);

      await settledHandler({}, undefined);

      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining(["--subject", "pi-imps:failed", "--outcome", "failed"]),
      );
    });

    it("successful agent_done returns terminate: true, and a subsequent agent_settled sends no duplicate", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true, { "imp-turn-limit": "30" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const settledHandler = handlers.get("agent_settled");
      if (!inputHandler || !settledHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);

      const tool = registerTool.mock.calls[0][0];
      const result = await tool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, {});
      expect(result.terminate).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);

      await settledHandler({}, undefined);
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("a failed agent_done send can retry", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true, { "imp-turn-limit": "30" });
      extensionFactory(pi);
      startSession(handlers);
      exec
        .mockResolvedValueOnce({ stdout: "", stderr: "unauthorized", code: 1 })
        .mockResolvedValueOnce({ stdout: "{}", stderr: "", code: 0 });

      const inputHandler = handlers.get("input");
      if (!inputHandler) throw new Error("input handler not registered");
      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);

      const tool = registerTool.mock.calls[0][0];
      await expect(
        tool.execute("call-1", { outcome: "failed", summary: "Broke." }, undefined, undefined, {}),
      ).rejects.toThrow(/rejected/);

      const result = await tool.execute("call-1", { outcome: "failed", summary: "Broke." }, undefined, undefined, {});
      expect(result.terminate).toBe(true);
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("an invalid/unverified prompt reaches the turn limit without a directive, report, or abort", () => {
      const { pi, handlers, sendUserMessage, exec } = createMockPi(true, { "imp-turn-limit": "2" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      // Not an Orca dispatch preamble at all: dispatch is never set.
      inputHandler({ type: "input", text: "Please fix the failing test.", source: "interactive" }, undefined);

      const abort = vi.fn();
      for (let i = 0; i < 5; i++) {
        turnEndHandler(assistantTurnEnd("progress"), { abort });
      }

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    });

    it("agent_done called during the active final turn is sealed as truncated regardless of the claimed outcome", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true, { "imp-turn-limit": "3" });
      extensionFactory(pi);
      startSession(handlers);

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      if (!inputHandler || !turnEndHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(assistantTurnEnd("turn one"), { abort: vi.fn() });
      turnEndHandler(assistantTurnEnd("turn two"), { abort: vi.fn() });

      const tool = registerTool.mock.calls[0][0];
      const result = await tool.execute(
        "call-1",
        { outcome: "succeeded", summary: "All done!" },
        undefined,
        undefined,
        {},
      );

      expect(result.terminate).toBe(true);
      expect(result.content[0]).toEqual({ type: "text", text: "Completion reported." });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining(["--subject", "pi-imps:truncated", "--outcome", "failed"]),
      );
    });

    it("a failed automatic final-turn report leaves the run unsealed; agent_settled retries and seals pi-imps:truncated", async () => {
      const { pi, handlers, exec } = createMockPi(true, { "imp-turn-limit": "2" });
      extensionFactory(pi);
      startSession(handlers);
      exec
        .mockResolvedValueOnce({ stdout: "", stderr: "unauthorized", code: 1 })
        .mockResolvedValueOnce({ stdout: "{}", stderr: "", code: 0 });

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      const settledHandler = handlers.get("agent_settled");
      if (!inputHandler || !turnEndHandler || !settledHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(assistantTurnEnd("turn one"), { abort: vi.fn() });
      await turnEndHandler(assistantTurnEnd("turn two"), { abort: vi.fn() });

      expect(exec).toHaveBeenCalledTimes(1);

      await settledHandler({}, undefined);

      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenNthCalledWith(
        2,
        "orca",
        expect.arrayContaining(["--subject", "pi-imps:truncated", "--outcome", "failed"]),
      );
    });

    it("an in-flight automatic report blocks a concurrent agent_settled attempt; only one send seals completion", async () => {
      const { pi, handlers } = createMockPi(true, { "imp-turn-limit": "2" });
      extensionFactory(pi);
      startSession(handlers);

      let resolveExec: (value: { stdout: string; stderr: string; code: number }) => void = () => {};
      const controlledExec = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveExec = resolve;
        }),
      );
      (pi as unknown as { exec: unknown }).exec = controlledExec;

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      const settledHandler = handlers.get("agent_settled");
      if (!inputHandler || !turnEndHandler || !settledHandler) throw new Error("handlers not registered");

      inputHandler({ type: "input", text: workerPrompt("Do the thing."), source: "interactive" }, undefined);
      turnEndHandler(assistantTurnEnd("turn one"), { abort: vi.fn() });
      const pendingTurnEnd = turnEndHandler(assistantTurnEnd("turn two"), { abort: vi.fn() });

      // The automatic report from turn_end is in flight; a concurrent
      // agent_settled attempt must not send a second report.
      await settledHandler({}, undefined);
      expect(controlledExec).toHaveBeenCalledTimes(1);

      resolveExec({ stdout: "{}", stderr: "", code: 0 });
      await pendingTurnEnd;

      expect(controlledExec).toHaveBeenCalledTimes(1);
    });
  });
});
