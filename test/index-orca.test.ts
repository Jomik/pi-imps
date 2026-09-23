import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./helpers/index.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentDir: vi.fn(() => "/nonexistent-pi-agent-dir-for-testing-xyz"),
  };
});

const loadImpSettingsMock = vi.fn((_agentDir?: string) => ({
  turnLimit: 30,
  toolAllowlist: undefined,
  additionalExtensions: [],
  impFlags: [],
  agents: {},
  orca: { enabled: true },
}));

vi.mock("../src/settings.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadImpSettings: (agentDir?: string) => loadImpSettingsMock(agentDir),
  };
});

interface FakeCoordinatorInstance {
  spawn: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  exec: (command: string, args: string[], options?: unknown) => Promise<unknown>;
}

const coordinatorInstances: FakeCoordinatorInstance[] = [];

vi.mock("../src/orca-coordinator.js", () => {
  class FakeOrcaCoordinator {
    spawn = vi.fn(async () => ({ abort: vi.fn(async () => {}) }));
    shutdown = vi.fn(async () => {});
    exec: (command: string, args: string[], options?: unknown) => Promise<unknown>;
    constructor(exec: (command: string, args: string[], options?: unknown) => Promise<unknown>) {
      this.exec = exec;
      coordinatorInstances.push(this);
    }
  }
  return { OrcaCoordinator: FakeOrcaCoordinator };
});

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverAgents: vi.fn(() => [
      {
        name: "coder",
        description: "test",
        systemPrompt: "You are a coder.",
        source: "user",
        filePath: "/tmp/coder.md",
      },
    ]),
  };
});

const extensionFactory = (await import("../src/index.js")).default;

function createMockPi(): {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  registerTool: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerTool = vi.fn();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool,
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
    exec: vi.fn().mockResolvedValue({ stdout: "{}", stderr: "", code: 0 }),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerTool };
}

function getTool(registerTool: ReturnType<typeof vi.fn>, name: string) {
  const call = registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} was not registered`);
  return call[0] as { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  const item = result.content[0];
  if (item.type !== "text") throw new Error("expected text");
  return JSON.parse(item.text);
}

beforeEach(() => {
  coordinatorInstances.length = 0;
  loadImpSettingsMock.mockReturnValue({
    turnLimit: 30,
    toolAllowlist: undefined,
    additionalExtensions: [],
    impFlags: [],
    agents: {},
    orca: { enabled: true },
  });
});

describe("orca disabled", () => {
  it("does not construct or use an OrcaCoordinator on session_start", () => {
    loadImpSettingsMock.mockReturnValue({
      turnLimit: 30,
      toolAllowlist: undefined,
      additionalExtensions: [],
      impFlags: [],
      agents: {},
      orca: { enabled: false },
    });

    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());

    expect(coordinatorInstances).toHaveLength(0);
  });
});

describe("orca enabled", () => {
  it("creates exactly one coordinator per session and injects a (command,args,options)=>pi.exec adapter", () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());

    expect(coordinatorInstances).toHaveLength(1);

    coordinatorInstances[0].exec("orca", ["status"], { signal: undefined });
    expect(pi.exec).toHaveBeenCalledWith("orca", ["status"], { signal: undefined });
  });

  it("routes summon through the mocked coordinator and completion integrates with wait", async () => {
    const { pi, handlers, registerTool } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(1);

    coordinatorInstances[0].spawn.mockImplementation(async (opts: { onComplete: (r: { output: string }) => void }) => {
      opts.onComplete({ output: "coordinator result" });
      return { abort: vi.fn(async () => {}) };
    });

    const summon = getTool(registerTool, "summon");
    const wait = getTool(registerTool, "wait");
    const ctx = createMockContext();

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    expect(coordinatorInstances[0].spawn).toHaveBeenCalledTimes(1);

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("completed");
    expect(json[0].agent).toBe("coder");
    expect(json[0].output).toBe("coordinator result");
  });

  it("two consecutive session_start events without teardown reuse the same coordinator", () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(1);
    const first = coordinatorInstances[0];

    // Reload/second session_start with no session_before_switch or
    // session_shutdown in between must reuse the existing coordinator, not
    // orphan its active records/mailbox by silently replacing it.
    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(1);
    expect(coordinatorInstances[0]).toBe(first);
    expect(first.shutdown).not.toHaveBeenCalled();
  });

  it("session switch shuts down the coordinator and session_start creates a fresh one", async () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(1);
    const first = coordinatorInstances[0];

    await handlers.get("session_before_switch")?.({}, undefined);
    expect(first.shutdown).toHaveBeenCalledTimes(1);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(2);
    expect(coordinatorInstances[1]).not.toBe(first);
  });

  it("session shutdown shuts down the coordinator idempotently alongside dismissAll", async () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    const first = coordinatorInstances[0];

    await handlers.get("session_shutdown")?.({}, undefined);
    expect(first.shutdown).toHaveBeenCalledTimes(1);

    // Calling shutdown again (e.g. a second lifecycle event) must not throw
    // or double-invoke the coordinator's shutdown, since it was already
    // cleared from the closure.
    await handlers.get("session_shutdown")?.({}, undefined);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly through the failed-imp path when the coordinator is unavailable (never falls back local)", async () => {
    const { pi, handlers, registerTool } = createMockPi();
    extensionFactory(pi);

    // Populate agents and create a coordinator, then tear the coordinator
    // down (e.g. via shutdown) without discarding the discovered agents, so
    // summon reaches the "coordinator unavailable" branch rather than
    // "Unknown agent".
    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    expect(coordinatorInstances).toHaveLength(1);
    await handlers.get("session_shutdown")?.({}, undefined);

    const summon = getTool(registerTool, "summon");
    const wait = getTool(registerTool, "wait");
    const ctx = createMockContext();

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("Orca coordinator is not available; cannot summon an Orca-dispatched imp.");
    expect(coordinatorInstances[0].spawn).not.toHaveBeenCalled();
  });
});
