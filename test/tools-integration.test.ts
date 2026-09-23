import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, Extension } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImpSpawnerOptions } from "../src/tools.js";
import type { AgentConfig, ImpSettings } from "../src/types.js";
import { createMockContext, createMockSession, type MockSessionConfig } from "./helpers/index.js";

// ─── Module-level mock ref ────────────────────────────────────────────────────

const sessionRef: { current: ReturnType<typeof createMockSession> | null } = { current: null };
const extensionsRef: { current: Extension[] } = { current: [] };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...real,
    // biome-ignore lint/style/noNonNullAssertion: set by installMock before spawn reaches createAgentSession
    createAgentSession: vi.fn(async () => ({ session: sessionRef.current!.session })),
    // Stub resource loader to avoid real I/O in integration tests
    DefaultResourceLoader: class {
      constructor(private options: ConstructorParameters<typeof real.DefaultResourceLoader>[0]) {}
      async reload() {}
      getExtensions() {
        const base = { extensions: extensionsRef.current, errors: [] } as unknown as ReturnType<
          InstanceType<typeof real.DefaultResourceLoader>["getExtensions"]
        >;
        return this.options.extensionsOverride?.(base) ?? base;
      }
    },
  };
});

// Import AFTER vi.mock so src/session.ts picks up the mocked createAgentSession
const { summonTool, waitTool, dismissTool } = await import("../src/tools.js");
const { createAgentSession } = await import("@earendil-works/pi-coding-agent");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseResult(r: AgentToolResult<unknown>) {
  const item = r.content[0];
  if (item.type !== "text") throw new Error("expected text");
  return JSON.parse(item.text);
}

function makeSettings(overrides: Partial<ImpSettings> = {}): ImpSettings {
  return {
    turnLimit: 30,
    toolAllowlist: undefined,
    additionalExtensions: [],
    impFlags: [],
    agents: {},
    orca: { enabled: false },
    ...overrides,
  };
}

const testAgent: AgentConfig = {
  name: "coder",
  description: "Test coder agent",
  systemPrompt: "You are a coder.",
  source: "user",
  filePath: "/tmp/test-agent.md",
};

function makeNamePool() {
  const released: string[] = [];
  let counter = 0;
  return {
    allocate: () => `imp-${++counter}`,
    release: (n: string) => {
      released.push(n);
    },
    released,
  };
}

function installMock(config: MockSessionConfig = {}) {
  sessionRef.current = createMockSession(config);
  return sessionRef.current;
}

async function waitForPromptStart(mock: ReturnType<typeof createMockSession>, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!mock.controls.promptStarted) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for imp prompt to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ─── Reset mock implementation before each test ───────────────────────────────

beforeEach(() => {
  sessionRef.current = null;
  extensionsRef.current = [];
  vi.clearAllMocks();
  vi.mocked(createAgentSession).mockImplementation(
    // biome-ignore lint/style/noNonNullAssertion: set by installMock before spawn reaches createAgentSession
    async () => ({ session: sessionRef.current!.session }) as Awaited<ReturnType<typeof createAgentSession>>,
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("local imp flags", () => {
  function registeredExtension(type: "boolean" | "string", tools: string[] = ["policy_tool"]): Extension {
    return {
      path: "/fake/policy.ts",
      resolvedPath: "/fake/policy.ts",
      tools: new Map(tools.map((name) => [name, {}])),
      flags: new Map([["safe-mode", { name: "safe-mode", type, extensionPath: "/fake/policy.ts" }]]),
    } as unknown as Extension;
  }

  async function launch(flags: string[], agent: AgentConfig = testAgent) {
    const imps = new Map();
    const mock = installMock({ totalTurns: 1 });
    const ctx = createMockContext();
    const summon = summonTool(imps, [agent], makeNamePool(), makeSettings({ impFlags: flags }));
    await summon.execute(
      "tc1",
      { task: "analyze the codebase thoroughly", agent: agent.name },
      undefined,
      undefined,
      ctx,
    );
    const result = await waitTool(imps).execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    return { mock, result: parseResult(result) };
  }

  it("sets a selected extension's boolean flag before binding and prompting", async () => {
    extensionsRef.current = [registeredExtension("boolean")];
    const { mock, result } = await launch(["safe-mode"], { ...testAgent, tools: ["policy_tool"] });
    expect(mock.controls.flagsAtBind?.get("safe-mode")).toBe(true);
    expect(mock.controls.promptStarted).toBe(true);
    expect(result[0].status).toBe("completed");
  });

  it("leaves no-flag sessions unchanged", async () => {
    const { mock, result } = await launch([]);
    expect(mock.controls.flagValues.size).toBe(0);
    expect(result[0].status).toBe("completed");
  });

  it.each([
    ["missing", [], testAgent, /safe-mode.*not registered by a selected extension/],
    ["non-boolean", [registeredExtension("string")], testAgent, /safe-mode.*not a boolean flag/],
    ["filtered out", [registeredExtension("boolean")], { ...testAgent, tools: [] }, /safe-mode.*selected extension/],
  ])("rejects %s before worker creation or prompt", async (_case, extensions, agent, error) => {
    extensionsRef.current = extensions;
    const { mock, result } = await launch(["safe-mode"], agent);
    expect(result[0].status).toBe("failed");
    expect(result[0].error).toMatch(error);
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(mock.controls.promptStarted).toBe(false);
  });
});

describe("summon → wait integration", () => {
  it("completes with final output", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 2, finalText: "found 2 issues" });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "imp-1", status: "completed", agent: "coder", output: "found 2 issues" }]);
    expect(imps.size).toBe(0);
  });

  it("failed prompt yields status=failed", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ failOnPrompt: "session crashed" });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("session crashed");
  });

  it("maps inherited max thinking to the local SDK's highest supported level", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings(), () => "max");
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "xhigh" }));
  });

  it("agent thinking overrides parent thinking", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const agentWithThinking: AgentConfig = { ...testAgent, thinking: "high" };
    const summon = summonTool(imps, [agentWithThinking], namePool, makeSettings(), () => "low");
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
  });

  it("agent with no thinking inherits parent thinking", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const agentNoThinking: AgentConfig = { ...testAgent, thinking: undefined };
    const summon = summonTool(imps, [agentNoThinking], namePool, makeSettings(), () => "medium");
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "medium" }));
  });

  it("agent thinking max maps to xhigh (SDK compat)", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const agentWithMax: AgentConfig = { ...testAgent, thinking: "max" };
    const summon = summonTool(imps, [agentWithMax], namePool, makeSettings(), () => "low");
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "xhigh" }));
  });

  it("provider failure via auto_retry_end event yields status=failed", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    // Simulate provider exhausting retries after the prompt has started: emits auto_retry_end then resolves
    await waitForPromptStart(mock);
    mock.controls.failWithProviderEvent("API key invalid");

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("API key invalid");
  });

  it("resolved stopReason=length with partial text yields failed with partial output preserved", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    await waitForPromptStart(mock);
    mock.controls.finish("partial analysis before cutoff", { stopReason: "length" });

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].output).toBe("partial analysis before cutoff");
    expect(json[0].error).toContain("length");
  });

  it("resolved stopReason=error with errorMessage surfaces that message as the failure", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    await waitForPromptStart(mock);
    mock.controls.finish("", { stopReason: "error", errorMessage: "rate limit exceeded" });

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("rate limit exceeded");
  });

  it("resolved stopReason=stop with empty text yields failed with a stopReason-specific error", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    await waitForPromptStart(mock);
    mock.controls.finish("", { stopReason: "stop" });

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].output).toBe("");
    expect(json[0].error).toContain("stop");
  });

  it("resolved stopReason=aborted with no errorMessage yields failed, preserving partial output", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    await waitForPromptStart(mock);
    mock.controls.finish("partial work before abort", { stopReason: "aborted" });

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].output).toBe("partial work before abort");
    expect(json[0].error).toContain("aborted");
  });

  it("prompt rejection with an empty Error message yields failed with a stable non-empty diagnostic", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({}); // manual control — no totalTurns

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    await waitForPromptStart(mock);
    mock.controls.fail(""); // rejection with an empty Error message

    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(typeof json[0].error).toBe("string");
    expect(json[0].error.length).toBeGreaterThan(0);
  });

  it("turn limit triggers steer with FINAL TURN directive and truncates", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({ totalTurns: 10, finalText: "long result" });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings({ turnLimit: 3 }));
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(mock.controls.steerCalls.some((s) => s.includes("FINAL TURN"))).toBe(true);
    expect(json[0].status).toBe("truncated");
  });

  it("turn-end usage accumulates into imp tokens snapshot", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 2, perTurnUsage: { input: 100, output: 50 } });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    const tokenSnapshots: Array<{ input: number; output: number }> = [];
    const onUpdate = (u: AgentToolResult<{ imps: Array<{ tokens: { input: number; output: number } }> }>) => {
      const snap = u.details?.imps?.[0]?.tokens;
      if (snap) tokenSnapshots.push(snap);
    };

    await wait.execute("tc2", { mode: "all" }, undefined, onUpdate as Parameters<typeof wait.execute>[3], ctx);

    // After 2 turns at 100 input/turn, at least one snapshot should show ≥ 100 input tokens
    expect(tokenSnapshots.some((t) => t.input >= 100)).toBe(true);
  });
});

describe("wait mode=first", () => {
  it("returns first finisher; others remain running", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const mockA = createMockSession({ totalTurns: 1, finalText: "A done" });
    const mockB = createMockSession({}); // pending — no totalTurns

    // Queue: whichever spawn hits createAgentSession first gets mockA (A is summoned first)
    const sessionQueue = [mockA.session, mockB.session];
    vi.mocked(createAgentSession).mockImplementation(async () => {
      const session = sessionQueue.shift();
      if (!session) throw new Error("no more sessions in queue");
      return { session } as Awaited<ReturnType<typeof createAgentSession>>;
    });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "task A, first thing to do", agent: "coder" }, undefined, undefined, ctx);
    await summon.execute("tc2", { task: "task B, second thing to do", agent: "coder" }, undefined, undefined, ctx);

    const result = await wait.execute("tc3", { mode: "first" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json).toHaveLength(1);
    expect(json[0].output).toBe("A done");
    expect(imps.size).toBe(1); // B still running

    const remaining = [...imps.values()][0];
    expect(remaining.status).toBe("running");

    // Cleanup: resolve the pending imp
    mockB.controls.finish("done");
    await remaining.done;
  });
});

describe("dismiss", () => {
  it("aborts a running imp and releases its name", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({}); // pending

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const dismiss = dismissTool(imps, namePool);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const impRef = imps.get("imp-1");
    if (!impRef) throw new Error("imp-1 not found after summon");

    await dismiss.execute("tc2", { name: "imp-1" }, undefined, undefined, ctx);

    // dismissImp calls imp.controller.abort() synchronously
    expect(impRef.controller.signal.aborted).toBe(true);
    expect(imps.size).toBe(0);
    expect(namePool.released).toContain("imp-1");
  });
});

describe("summon error paths", () => {
  it("unknown agent → error result, no spawn, name released", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const result = await summon.execute(
      "tc1",
      { task: "analyze the codebase thoroughly", agent: "ghost" },
      undefined,
      undefined,
      ctx,
    );

    const item = result.content[0];
    expect(item.type).toBe("text");
    if (item.type === "text") expect(item.text).toContain("Unknown agent");
    expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
    expect(namePool.released).toContain("imp-1");
  });
});

describe("project config tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-pct-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("named agent: unions frontmatter tools with project config tools", async () => {
    writeFileSync(join(tmpDir, ".pi", "imps.json"), JSON.stringify({ agents: { coder: { tools: ["run_tests"] } } }));

    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext({ cwd: tmpDir });
    installMock({ totalTurns: 1 });

    const agentConfig: AgentConfig = {
      name: "coder",
      description: "A coding agent",
      tools: ["read", "edit"],
      systemPrompt: "You are a coding agent.",
      source: "user",
      filePath: "/tmp/coder.md",
    };

    const summon = summonTool(imps, [agentConfig], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(vi.mocked(createAgentSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining(["read", "edit", "run_tests"]),
      }),
    );
  });
});

describe("custom spawner (ImpSpawner injection)", () => {
  it("receives the generated name plus all resolved parent inputs", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    let resolveHandle!: () => void;
    const handlePromise = new Promise<{ abort(): Promise<void> }>((resolve) => {
      resolveHandle = () => resolve({ abort: async () => {} });
    });

    const spawner = vi.fn((_opts: ImpSpawnerOptions) => handlePromise);

    const summon = summonTool(imps, [testAgent], namePool, makeSettings(), () => "high", spawner);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    expect(spawner).toHaveBeenCalledTimes(1);
    const opts = spawner.mock.calls[0][0];
    expect(opts.name).toBe("imp-1");
    expect(opts.task).toBe("analyze the codebase thoroughly");
    expect(opts.config).toEqual(testAgent);
    expect(opts.cwd).toBe(ctx.cwd);
    expect(opts.parentModel).toBe(ctx.model);
    expect(opts.parentThinkingLevel).toBe("high");
    expect(opts.modelRegistry).toBe(ctx.modelRegistry);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.settings).toEqual(makeSettings());
    expect(typeof opts.onTurnEnd).toBe("function");
    expect(typeof opts.onToolActivity).toBe("function");
    expect(typeof opts.onUsageUpdate).toBe("function");
    expect(typeof opts.onComplete).toBe("function");

    resolveHandle();
    await handlePromise;
  });

  it("successful completion via the injected spawner integrates with wait", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const summon = summonTool(imps, [testAgent], namePool, makeSettings(), undefined, async (opts) => {
      opts.onComplete({ output: "custom spawner result" });
      return { abort: async () => {} };
    });
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "imp-1", status: "completed", agent: "coder", output: "custom spawner result" }]);
  });

  it("orca.enabled marks imp snapshots with telemetryAvailable: false, but JSON output is unaffected", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const summon = summonTool(
      imps,
      [testAgent],
      namePool,
      makeSettings({ orca: { enabled: true } }),
      undefined,
      async (opts) => {
        opts.onComplete({ output: "orca result" });
        return { abort: async () => {} };
      },
    );
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);

    expect(result.details?.imps[0]?.telemetryAvailable).toBe(false);
    expect(parseResult(result)).toEqual([
      { name: "imp-1", status: "completed", agent: "coder", output: "orca result" },
    ]);
  });

  it("a rejected spawn maps its exact error message onto the failed imp", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const spawner = vi.fn(async () => {
      throw new Error("orca coordinator unavailable");
    });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings(), undefined, spawner);
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("orca coordinator unavailable");
  });

  it("dismiss-before-ready aborts the resolved handle without overwriting the dismissed status", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();

    const abort = vi.fn(async () => {});
    let resolveHandle!: (handle: { abort(): Promise<void> }) => void;
    const handlePromise = new Promise<{ abort(): Promise<void> }>((resolve) => {
      resolveHandle = resolve;
    });
    const spawner = vi.fn(() => handlePromise);

    const summon = summonTool(imps, [testAgent], namePool, makeSettings(), undefined, spawner);
    const dismiss = dismissTool(imps, namePool);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    // Dismiss before the spawner's handle resolves.
    await dismiss.execute("tc2", { name: "imp-1" }, undefined, undefined, ctx);

    // Now let the spawn resolve — it must be aborted, not treated as a fresh session.
    resolveHandle({ abort });
    await handlePromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe("streaming", () => {
  it("wait emits valid JSON array updates", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const summon = summonTool(imps, [testAgent], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly", agent: "coder" }, undefined, undefined, ctx);

    const updates: string[] = [];
    const onUpdate = (u: AgentToolResult<unknown>) => {
      const item = u.content[0];
      if (item.type === "text") updates.push(item.text);
    };

    await wait.execute("tc2", { mode: "all" }, undefined, onUpdate as Parameters<typeof wait.execute>[3], ctx);

    expect(updates.length).toBeGreaterThan(0);
    for (const text of updates) {
      expect(Array.isArray(JSON.parse(text))).toBe(true);
    }
  });
});
