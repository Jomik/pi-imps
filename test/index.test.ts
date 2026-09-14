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
}

function createMockPi(isImp = false): MockPi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const registerFlag = vi.fn();
  const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool,
    registerCommand,
    registerFlag,
    getFlag: vi.fn((name: string) => (name === "is-imp" ? isImp : undefined)),
    getThinkingLevel: vi.fn(() => "off"),
    exec,
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerTool, registerCommand, registerFlag, exec };
}

describe("ordinary pi-imps extension behavior", () => {
  it("registers the is-imp flag with a false default", () => {
    const { pi, registerFlag } = createMockPi();
    extensionFactory(pi);

    expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean", default: false }));
  });

  it("registers exactly the four built-in imp tools and never agent_done", () => {
    const { pi, registerTool } = createMockPi();
    extensionFactory(pi);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["summon", "wait", "dismiss", "list_imps"]);
    expect(registeredNames).not.toContain("agent_done");
  });

  it("registers the /imps command and session hooks", () => {
    const { pi, registerCommand, handlers } = createMockPi();
    extensionFactory(pi);

    expect(registerCommand).toHaveBeenCalledWith("imps", expect.anything());
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_before_switch")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("before_agent_start leaves the system prompt unchanged when no agents are discovered", () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    const result = handlers.get("before_agent_start")?.(
      { prompt: "Fix the failing test", systemPrompt: "base system prompt" },
      createMockContext(),
    );

    expect(result).toBeUndefined();
  });
});

describe("imp worker mode (is-imp flag)", () => {
  it("registers the is-imp flag", () => {
    const { pi, registerFlag } = createMockPi(true);
    extensionFactory(pi);

    expect(registerFlag).toHaveBeenCalledWith("is-imp", expect.objectContaining({ type: "boolean", default: false }));
  });

  it("registers exactly agent_done and no parent tools, command, or hooks", () => {
    const { pi, registerTool, registerCommand, handlers } = createMockPi(true);
    extensionFactory(pi);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["agent_done"]);
    expect(registerCommand).not.toHaveBeenCalled();
    expect(handlers.has("session_start")).toBe(false);
    expect(handlers.has("before_agent_start")).toBe(false);
    expect(handlers.has("session_before_switch")).toBe(false);
    expect(handlers.has("session_shutdown")).toBe(false);
    expect(handlers.has("turn_start")).toBe(false);
    expect(handlers.has("turn_end")).toBe(false);
    expect(handlers.has("tool_execution_end")).toBe(false);
    expect(handlers.has("input")).toBe(true);
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
      const { pi, registerTool } = createMockPi(true);
      extensionFactory(pi);

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

      const prompt = workerPrompt("ignored").replace("=== TASK ===\n", "");
      const result = handlers.get("input")?.({ type: "input", text: prompt, source: "interactive" }, undefined);

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged when the task after the marker is empty", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);

      const prompt = workerPrompt("   ");
      const result = handlers.get("input")?.({ type: "input", text: prompt, source: "interactive" }, undefined);

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged when ORCA_TERMINAL_HANDLE does not match", () => {
      process.env.ORCA_TERMINAL_HANDLE = "worker-9";
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);

      const result = handlers.get("input")?.(
        { type: "input", text: workerPrompt("Do the thing."), source: "interactive" },
        undefined,
      );

      expect(result).toEqual({ action: "continue" });
    });

    it("continues unchanged for a malformed (non-Orca) prompt", () => {
      const { pi, handlers } = createMockPi(true);
      extensionFactory(pi);

      const result = handlers.get("input")?.(
        { type: "input", text: "Please fix the failing test.\n=== TASK ===\nDo it.", source: "interactive" },
        undefined,
      );

      expect(result).toEqual({ action: "continue" });
    });

    it("does not update dispatch context or register a tool on an invalid input", async () => {
      const { pi, handlers, registerTool, exec } = createMockPi(true);
      extensionFactory(pi);

      handlers.get("input")?.({ type: "input", text: "not an orca prompt", source: "interactive" }, undefined);

      // Only the single agent_done registration from load; no dispatch was ever set.
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
  });
});
