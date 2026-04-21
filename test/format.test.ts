import { describe, expect, it } from "vitest";
import { buildAgentsBlock } from "../src/agents.js";
import { formatSummonDisplay, formatWaitDisplay } from "../src/display.js";
import type { AgentConfig, Imp } from "../src/types.js";

function makeImp(overrides: Partial<Imp> & { name: string }): Imp {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    agentName: "ephemeral",
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

function makeAgent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return {
    description: "A test agent",
    systemPrompt: "You are a test agent.",
    source: "user",
    filePath: "/test",
    ...overrides,
  };
}

// Minimal theme stub that wraps text in markers for assertion
const theme = {
  fg: (_color: string, text: string) => `[${_color}:${text}]`,
  // biome-ignore lint/suspicious/noExplicitAny: minimal theme stub for tests
} as any;

// --- buildAgentsBlock ---

describe("buildAgentsBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildAgentsBlock([])).toBe("");
  });

  it("returns XML with correct structure", () => {
    const result = buildAgentsBlock([
      makeAgent({
        name: "coder",
        description: "Writes code",
        source: "project",
      }),
    ]);
    expect(result).toContain("<available_agents>");
    expect(result).toContain("</available_agents>");
    expect(result).toContain("<name>coder</name>");
    expect(result).toContain("<description>Writes code</description>");
    expect(result).toContain("<source>project</source>");
  });

  it("includes model in description when present", () => {
    const result = buildAgentsBlock([makeAgent({ name: "fast", description: "Quick agent", model: "gpt-5" })]);
    expect(result).toContain("[model: gpt-5]");
  });
});

// --- formatSummonDisplay ---

describe("formatSummonDisplay", () => {
  it("named agent uses 'the' phrasing", () => {
    const s = formatSummonDisplay("alice", "coder", theme);
    expect(s).toContain("alice");
    expect(s).toContain("coder");
    expect(s).toContain("the");
    expect(s).toContain("has answered your summons!");
  });

  it("ephemeral agent omits agent name", () => {
    const s = formatSummonDisplay("bob", "ephemeral", theme);
    expect(s).toContain("bob");
    expect(s).not.toContain("ephemeral");
    expect(s).toContain("has answered your summons!");
  });
});

// --- formatWaitDisplay ---

describe("formatWaitDisplay", () => {
  it("empty imps returns no uncollected message", () => {
    expect(formatWaitDisplay([], "all", theme)).toContain("No uncollected imps.");
  });

  it("all mode shows status lines", () => {
    const imps = [
      makeImp({
        name: "alice",
        agentName: "sentinel",
        status: "completed",
        turns: 3,
        tokens: { input: 6200, output: 6200 },
      }),
      makeImp({
        name: "bob",
        agentName: "mason",
        status: "completed",
        turns: 5,
        tokens: { input: 9000, output: 9100 },
      }),
    ];
    const s = formatWaitDisplay(imps, "all", theme);
    expect(s).toContain("alice");
    expect(s).toContain("bob");
  });

  it("all mode with mixed status does not show first-mode winner line", () => {
    const imps = [
      makeImp({
        name: "alice",
        agentName: "sentinel",
        status: "completed",
        turns: 3,
        tokens: { input: 250, output: 250 },
      }),
      makeImp({
        name: "bob",
        status: "running",
        turns: 1,
        tokens: { input: 50, output: 50 },
      }),
    ];
    const s = formatWaitDisplay(imps, "all", theme);
    expect(s).toContain("alice");
    expect(s).toContain("bob");
    expect(s).not.toContain("finished first");
  });

  it("first mode shows winner one-liner with stats", () => {
    const imps = [
      makeImp({
        name: "kevin",
        agentName: "cartographer",
        status: "completed",
        turns: 2,
        tokens: { input: 4000, output: 4300 },
      }),
    ];
    const s = formatWaitDisplay(imps, "first", theme);
    expect(s).toContain("kevin");
    expect(s).toContain("cartographer");
    expect(s).toContain("finished first");
    expect(s).toContain("2⟳");
    expect(s).toContain("4.0k↓");
    expect(s).toContain("4.3k↑");
  });

  it("first mode with ephemeral omits agent name", () => {
    const imps = [
      makeImp({
        name: "bob",
        status: "completed",
        turns: 1,
        tokens: { input: 250, output: 250 },
      }),
    ];
    const s = formatWaitDisplay(imps, "first", theme);
    expect(s).toContain("bob");
    expect(s).toContain("finished first");
    expect(s).not.toContain("ephemeral");
  });
});
