import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { dismissTool, listImpsTool, waitTool } from "../src/tools.js";
import type { Imp } from "../src/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeImp(overrides: Partial<Imp> & { name: string }): Imp {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    agent: undefined,
    task: "test",
    startedAt: Date.now(),
    controller: new AbortController(),
    status: "running",
    turns: 0,
    tokens: { input: 0, output: 0 },
    done,
    resolveDone,
    ...overrides,
  };
}

function buildMap(...imps: Imp[]): Map<string, Imp> {
  return new Map(imps.map((i) => [i.name, i]));
}

const nullCtx = {} as ExtensionContext;

function parseResult(result: AgentToolResult<unknown>) {
  const item = result.content[0];
  if (item.type !== "text") throw new Error("expected text content");
  return JSON.parse(item.text);
}

// ─── wait ───────────────────────────────────────────────────────────────────

describe("waitTool", () => {
  it("all mode returns JSON array of completed imps", async () => {
    const a = makeImp({
      name: "alice",
      agent: "sentinel",
      status: "completed",
      turns: 3,
      tokens: { input: 6000, output: 6200 },
      output: "found 2 issues",
    });
    a.resolveDone();
    const b = makeImp({
      name: "bob",
      status: "completed",
      turns: 5,
      tokens: { input: 9000, output: 9100 },
      output: "done",
    });
    b.resolveDone();

    const imps = buildMap(a, b);
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([
      {
        name: "alice",
        status: "completed",
        agent: "sentinel",
        output: "found 2 issues",
      },
      { name: "bob", status: "completed", output: "done" },
    ]);
  });

  it("first mode returns single-element array with winner", async () => {
    const a = makeImp({
      name: "alice",
      status: "completed",
      output: "result",
    });
    a.resolveDone();

    const imps = buildMap(a);
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "first" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "alice", status: "completed", output: "result" }]);
  });

  it("returns empty text for no uncollected imps", async () => {
    const imps = new Map<string, Imp>();
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);

    const item = result.content[0];
    expect(item.type).toBe("text");
    if (item.type === "text") expect(item.text).toBe("No uncollected imps to wait for.");
  });

  it("failed imp includes error in result", async () => {
    const a = makeImp({
      name: "carl",
      status: "failed",
      error: "session crashed",
    });
    a.resolveDone();

    const imps = buildMap(a);
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "carl", status: "failed", error: "session crashed" }]);
  });

  it("streaming updates use same JSON array format", async () => {
    const a = makeImp({
      name: "alice",
      status: "completed",
      output: "done",
    });
    a.resolveDone();

    const updates: string[] = [];
    const onUpdate: AgentToolUpdateCallback<unknown> = (update) => {
      const item = update.content[0];
      if (item.type === "text") updates.push(item.text);
    };

    const imps = buildMap(a);
    const tool = waitTool(imps);
    await tool.execute("tc1", { mode: "all" }, undefined, onUpdate, nullCtx);

    // Every streaming update should be valid JSON array
    for (const text of updates) {
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  it("collects imps — removes from map after wait", async () => {
    const a = makeImp({ name: "alice", status: "completed" });
    a.resolveDone();

    const imps = buildMap(a);
    const tool = waitTool(imps);
    await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);

    expect(imps.size).toBe(0);
  });

  it("ephemeral imp omits agent field", async () => {
    const a = makeImp({
      name: "eve",
      status: "completed",
      output: "result",
    });
    a.resolveDone();

    const imps = buildMap(a);
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json[0]).not.toHaveProperty("agent");
  });

  it("truncated imp preserves status and output", async () => {
    const a = makeImp({
      name: "fay",
      agent: "mason",
      status: "truncated",
      output: "partial",
    });
    a.resolveDone();

    const imps = buildMap(a);
    const tool = waitTool(imps);
    const result = await tool.execute("tc1", { mode: "all" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([{ name: "fay", status: "truncated", agent: "mason", output: "partial" }]);
  });
});

// ─── list_imps ──────────────────────────────────────────────────────────────

describe("listImpsTool", () => {
  it("returns JSON array of all imps", async () => {
    const a = makeImp({
      name: "alice",
      agent: "sentinel",
      status: "completed",
      output: "ok",
    });
    const b = makeImp({ name: "bob", status: "running" });
    const c = makeImp({ name: "carl", status: "dismissed" });

    const imps = buildMap(a, b, c);
    const tool = listImpsTool(imps);
    const result = await tool.execute("tc1", {} as Record<string, never>, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([
      { name: "alice", status: "completed", agent: "sentinel", output: "ok" },
      { name: "bob", status: "running" },
      { name: "carl", status: "dismissed" },
    ]);
  });

  it("returns empty array when no imps", async () => {
    const imps = new Map<string, Imp>();
    const tool = listImpsTool(imps);
    const result = await tool.execute("tc1", {} as Record<string, never>, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual([]);
  });
});

// ─── dismiss ────────────────────────────────────────────────────────────────

describe("dismissTool", () => {
  it("dismisses by name and returns dismissed list", async () => {
    const a = makeImp({ name: "alice", status: "running" });
    const imps = buildMap(a);
    const namePool = { allocate: () => "", release: () => {} };
    const tool = dismissTool(imps, namePool);
    const result = await tool.execute("tc1", { name: "alice" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual({ dismissed: ["alice"] });
    expect(imps.size).toBe(0);
  });

  it("dismiss all clears map", async () => {
    const a = makeImp({ name: "alice", status: "running" });
    const b = makeImp({ name: "bob", status: "completed" });
    const imps = buildMap(a, b);
    const namePool = { allocate: () => "", release: () => {} };
    const tool = dismissTool(imps, namePool);
    const result = await tool.execute("tc1", { name: "all" }, undefined, undefined, nullCtx);
    const json = parseResult(result);

    expect(json).toEqual({ dismissed: ["alice", "bob"] });
    expect(imps.size).toBe(0);
  });

  it("returns error for unknown imp", async () => {
    const imps = new Map<string, Imp>();
    const namePool = { allocate: () => "", release: () => {} };
    const tool = dismissTool(imps, namePool);
    const result = await tool.execute("tc1", { name: "ghost" }, undefined, undefined, nullCtx);

    const item = result.content[0];
    expect(item.type).toBe("text");
    if (item.type === "text") expect(item.text).toContain("No imp found");
  });
});
