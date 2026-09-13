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
  setActiveTools: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  activeTools: string[];
}

function createMockPi(initialActiveTools: string[]): MockPi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const activeTools = [...initialActiveTools];
  const registerTool = vi.fn();
  const setActiveTools = vi.fn((names: string[]) => {
    activeTools.splice(0, activeTools.length, ...names);
  });
  const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 });

  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool,
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools,
    exec,
  } as unknown as ExtensionAPI;

  return { pi, handlers, registerTool, setActiveTools, exec, activeTools };
}

const BASE_TOOLS = ["summon", "wait", "dismiss", "list_imps", "bash", "read"];

const WORKER_PROMPT = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.

Your task ID is: task_fba7406bf543

orca orchestration send --from worker-7 --dispatch-capability cap-secret-xyz --type worker_done --subject "Task complete" --body "Implemented the feature." --task-id task_fba7406bf543 --dispatch-id dispatch-456 --outcome succeeded
`;

describe("before_agent_start: Orca dispatched-worker detection", () => {
  const originalHandle = process.env.ORCA_TERMINAL_HANDLE;

  beforeEach(() => {
    process.env.ORCA_TERMINAL_HANDLE = "worker-7";
  });

  afterEach(() => {
    if (originalHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = originalHandle;
  });

  it("leaves a normal prompt's system prompt and active tools unchanged", () => {
    const { pi, handlers, registerTool, setActiveTools } = createMockPi(BASE_TOOLS);
    extensionFactory(pi);

    const result = handlers.get("before_agent_start")?.(
      { prompt: "Fix the failing test", systemPrompt: "base system prompt" },
      createMockContext(),
    );

    expect(result).toBeUndefined();
    expect(setActiveTools).not.toHaveBeenCalled();
    // Only the four built-in imp tools are registered; agent_done is never added.
    expect(registerTool).toHaveBeenCalledTimes(4);
    expect(registerTool.mock.calls.map((c) => c[0].name)).not.toContain("agent_done");
  });

  it("leaves normal behavior unchanged when the terminal handle does not match", () => {
    process.env.ORCA_TERMINAL_HANDLE = "worker-9";
    const { pi, handlers, setActiveTools } = createMockPi(BASE_TOOLS);
    extensionFactory(pi);

    const result = handlers.get("before_agent_start")?.(
      { prompt: WORKER_PROMPT, systemPrompt: "base system prompt" },
      createMockContext(),
    );

    expect(result).toBeUndefined();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("activates agent_done, removes recursive imp tools, and suppresses the agents block for a verified worker", () => {
    const { pi, handlers, registerTool, activeTools } = createMockPi(BASE_TOOLS);
    extensionFactory(pi);

    const result = handlers.get("before_agent_start")?.(
      { prompt: WORKER_PROMPT, systemPrompt: "base system prompt" },
      createMockContext(),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toBe("base system prompt");
    expect(activeTools).toContain("agent_done");
    expect(activeTools).not.toContain("summon");
    expect(activeTools).not.toContain("wait");
    expect(activeTools).not.toContain("dismiss");
    expect(activeTools).not.toContain("list_imps");
    // Unrelated tools stay untouched.
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("read");

    const registeredNames = registerTool.mock.calls.map((c) => c[0].name);
    expect(registeredNames.filter((n) => n === "agent_done")).toHaveLength(1);
  });

  it("does not re-register agent_done for a reused worker session with a fresh dispatch preamble", async () => {
    const { pi, handlers, registerTool, exec } = createMockPi(BASE_TOOLS);
    extensionFactory(pi);

    const handler = handlers.get("before_agent_start");
    if (!handler) throw new Error("before_agent_start handler not registered");
    handler({ prompt: WORKER_PROMPT, systemPrompt: "base system prompt" }, createMockContext());

    const secondPrompt = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.

Your task ID is: task_999

orca orchestration send --from worker-7 --dispatch-capability cap-fresh-abc --type worker_done --subject "Task complete" --body "Implemented the feature." --task-id task_999 --dispatch-id dispatch-999 --outcome succeeded
`;
    handler({ prompt: secondPrompt, systemPrompt: "base system prompt" }, createMockContext());

    expect(registerTool.mock.calls.filter((c) => c[0].name === "agent_done")).toHaveLength(1);

    // The tool reads the current (updated) private dispatch at call time.
    const agentDoneTool = registerTool.mock.calls.find((c) => c[0].name === "agent_done")?.[0];
    await agentDoneTool.execute("call-1", { outcome: "succeeded", summary: "Done." }, undefined, undefined, {});

    expect(exec).toHaveBeenCalledWith(
      "orca",
      expect.arrayContaining(["--task-id", "task_999", "--dispatch-id", "dispatch-999"]),
    );
  });
});
