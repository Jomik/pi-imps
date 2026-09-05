import { describe, expect, it } from "vitest";
import { buildAgentsBlock } from "../src/agents.js";
import {
  formatImpStatusDisplay,
  formatSummonDisplay,
  formatSummonTaskPreview,
  formatWaitDisplay,
} from "../src/display.js";
import type { AgentConfig, Imp } from "../src/types.js";

function makeImp(overrides: Partial<Imp> & { name: string }): Imp {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    agent: "test-agent",
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

describe("formatSummonTaskPreview", () => {
  it("collapsed: shows task text with expand hint", () => {
    const task = "Write a function to parse JSON";
    const s = formatSummonTaskPreview(task, false, theme);
    expect(s).toContain(task);
    expect(s).toContain("expand");
    expect(s).not.toContain("collapse");
  });

  it("collapsed: truncates long task with ellipsis", () => {
    const task = "a".repeat(80);
    const s = formatSummonTaskPreview(task, false, theme);
    expect(s).toContain("\u2026");
    expect(s).toContain("expand");
    // Should not contain the full string (truncated)
    expect(s).not.toContain(task);
  });

  it("collapsed: task exactly at limit is not truncated", () => {
    const task = "a".repeat(60);
    const s = formatSummonTaskPreview(task, false, theme);
    expect(s).not.toContain("\u2026");
    expect(s).toContain(task);
  });

  it("collapsed: normalizes multiline task text into one line", () => {
    const s = formatSummonTaskPreview("Review\n  the\tcode", false, theme);
    expect(s).toContain("Review the code");
    expect(s).not.toContain("Review\n");
  });

  it("supports custom expand and collapse hints", () => {
    expect(formatSummonTaskPreview("do it", false, theme, "open", "close")).toContain("open");
    expect(formatSummonTaskPreview("do it", true, theme, "open", "close")).toContain("close");
  });

  it("expanded: shows full task text with collapse hint", () => {
    const task = "a".repeat(80);
    const s = formatSummonTaskPreview(task, true, theme);
    expect(s).toContain(task);
    expect(s).toContain("collapse");
    expect(s).not.toContain("expand");
  });

  it("expanded: shows task: label", () => {
    const s = formatSummonTaskPreview("do something", true, theme);
    expect(s).toContain("task:");
  });
});

// --- formatImpStatusDisplay ---

describe("formatImpStatusDisplay", () => {
  it("failed: renders the exact imp.error beneath the status row", () => {
    const imp = makeImp({
      name: "alice",
      status: "failed",
      error: "Provider error: rate limit exceeded (429)",
      turns: 4,
      tokens: { input: 100, output: 50 },
    });
    const s = formatImpStatusDisplay(imp, theme, 0);
    expect(s).toContain("Provider error: rate limit exceeded (429)");
    expect(s).toContain("\n  ");
  });

  it("failed: falls back to a non-empty message when imp.error is missing", () => {
    const imp = makeImp({
      name: "bob",
      status: "failed",
      turns: 1,
      tokens: { input: 10, output: 5 },
    });
    const s = formatImpStatusDisplay(imp, theme, 0);
    expect(s).toMatch(/\S/);
    const secondLine = s.split("\n")[1] ?? "";
    expect(secondLine.trim().length).toBeGreaterThan(0);
  });

  it("truncated: retains stats and states turn limit reached", () => {
    const imp = makeImp({
      name: "carol",
      status: "truncated",
      turns: 30,
      tokens: { input: 5000, output: 5100 },
    });
    const s = formatImpStatusDisplay(imp, theme, 0);
    expect(s).toContain("turn limit reached");
    expect(s).toContain("30\u27f3");
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
        agent: "sentinel",
        status: "completed",
        turns: 3,
        tokens: { input: 6200, output: 6200 },
      }),
      makeImp({
        name: "bob",
        agent: "mason",
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
        agent: "sentinel",
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
        agent: "cartographer",
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

  it("first mode with failed winner shows failed status and error", () => {
    const imps = [
      makeImp({
        name: "kevin",
        agent: "cartographer",
        status: "failed",
        error: "boom: something broke",
        turns: 2,
        tokens: { input: 4000, output: 4300 },
      }),
    ];
    const s = formatWaitDisplay(imps, "first", theme);
    expect(s).toContain("kevin");
    expect(s).toContain("boom: something broke");
    expect(s).not.toContain("finished first");
  });

  it("first mode with truncated winner shows turn limit reached", () => {
    const imps = [
      makeImp({
        name: "kevin",
        agent: "cartographer",
        status: "truncated",
        turns: 2,
        tokens: { input: 4000, output: 4300 },
      }),
    ];
    const s = formatWaitDisplay(imps, "first", theme);
    expect(s).toContain("kevin");
    expect(s).toContain("turn limit reached");
    expect(s).not.toContain("finished first");
  });
});
