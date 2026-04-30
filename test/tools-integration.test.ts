import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ImpSettings } from "../src/types.js";
import { createMockContext, createMockSession, type MockSessionConfig } from "./helpers/index.js";

// ─── Module-level mock ref ────────────────────────────────────────────────────

const sessionRef: { current: ReturnType<typeof createMockSession> | null } = { current: null };

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...real,
    // biome-ignore lint/style/noNonNullAssertion: set by installMock before spawn reaches createAgentSession
    createAgentSession: vi.fn(async () => ({ session: sessionRef.current!.session })),
  };
});

// Import AFTER vi.mock so src/session.ts picks up the mocked createAgentSession
const { summonTool, waitTool, dismissTool } = await import("../src/tools.js");
const { createAgentSession } = await import("@mariozechner/pi-coding-agent");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseResult(r: AgentToolResult<unknown>) {
  const item = r.content[0];
  if (item.type !== "text") throw new Error("expected text");
  return JSON.parse(item.text);
}

function makeSettings(overrides: Partial<ImpSettings> = {}): ImpSettings {
  return { turnLimit: 30, toolAllowlist: undefined, additionalExtensions: [], ...overrides };
}

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

// ─── Reset mock implementation before each test ───────────────────────────────

beforeEach(() => {
  sessionRef.current = null;
  vi.clearAllMocks();
  vi.mocked(createAgentSession).mockImplementation(
    // biome-ignore lint/style/noNonNullAssertion: set by installMock before spawn reaches createAgentSession
    async () => ({ session: sessionRef.current!.session }) as Awaited<ReturnType<typeof createAgentSession>>,
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("summon → wait integration", () => {
  it("completes with final output", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 2, finalText: "found 2 issues" });

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "imp-1", status: "completed", output: "found 2 issues" }]);
    expect(imps.size).toBe(0);
  });

  it("failed prompt yields status=failed", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ failOnPrompt: "session crashed" });

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);
    const result = await wait.execute("tc2", { mode: "all" }, undefined, undefined, ctx);
    const json = parseResult(result);

    expect(json[0].status).toBe("failed");
    expect(json[0].error).toBe("session crashed");
  });

  it("turn limit triggers steer with FINAL TURN directive and truncates", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    const mock = installMock({ totalTurns: 10, finalText: "long result" });

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings({ turnLimit: 3 }));
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);
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

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);

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

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "task A, first thing to do" }, undefined, undefined, ctx);
    await summon.execute("tc2", { task: "task B, second thing to do" }, undefined, undefined, ctx);

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

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const dismiss = dismissTool(imps, namePool);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);
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

describe("streaming", () => {
  it("wait emits valid JSON array updates", async () => {
    const imps = new Map();
    const namePool = makeNamePool();
    const ctx = createMockContext();
    installMock({ totalTurns: 1 });

    const summon = summonTool(imps, [] as AgentConfig[], namePool, makeSettings());
    const wait = waitTool(imps);

    await summon.execute("tc1", { task: "analyze the codebase thoroughly" }, undefined, undefined, ctx);

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
