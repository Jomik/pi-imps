import { describe, expect, it } from "vitest";
import {
  buildAgentsBlock,
  formatDismissResult,
  formatImpStatus,
  formatSummonDisplay,
  formatSummonResult,
  formatWaitResult,
  formatWaitResultCompact,
} from "../src/format.js";
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
    collected: false,
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

// --- formatImpStatus ---

describe("formatImpStatus", () => {
  it("running — shows activity, turns, tokens", () => {
    const imp = makeImp({
      name: "alice",
      agentName: "coder",
      status: "running",
      activity: "→ bash npm test",
      turns: 3,
      tokens: { input: 500, output: 200 },
    });
    const s = formatImpStatus(imp);
    expect(s).toContain("alice");
    expect(s).toContain("(coder)");
    expect(s).toContain("→ bash npm test");
    expect(s).toContain("3 turns");
    expect(s).toContain("700");
  });

  it("running — ephemeral agent omits parens", () => {
    const imp = makeImp({
      name: "bob",
      agentName: "ephemeral",
      status: "running",
      turns: 1,
      tokens: { input: 0, output: 0 },
    });
    const s = formatImpStatus(imp);
    expect(s).toMatch(/^bob:/);
  });

  it("completed — shows checkmark, turns, tokens", () => {
    const imp = makeImp({
      name: "carol",
      status: "completed",
      turns: 5,
      tokens: { input: 1500, output: 500 },
    });
    const s = formatImpStatus(imp);
    expect(s).toContain("✓");
    expect(s).toContain("5 turns");
    expect(s).toContain("2.0k");
  });

  it("failed — shows error", () => {
    const imp = makeImp({
      name: "dave",
      status: "failed",
      error: "timeout",
    });
    const s = formatImpStatus(imp);
    expect(s).toContain("✗");
    expect(s).toContain("timeout");
  });

  it("dismissed — shows dismissed", () => {
    const imp = makeImp({ name: "eve", status: "dismissed" });
    const s = formatImpStatus(imp);
    expect(s).toContain("dismissed");
  });

  it("truncated — shows warning, turns, tokens", () => {
    const imp = makeImp({
      name: "fred",
      agentName: "mason",
      status: "truncated",
      turns: 30,
      tokens: { input: 5000, output: 2000 },
    });
    const s = formatImpStatus(imp);
    expect(s).toContain("fred");
    expect(s).toContain("(mason)");
    expect(s).toContain("!");
    expect(s).toContain("truncated");
    expect(s).toContain("30 turns");
    expect(s).toContain("7.0k");
  });
});

// --- formatSummonResult ---

describe("formatSummonResult", () => {
  it("includes name and agent", () => {
    const s = formatSummonResult("alice", "coder");
    expect(s).toContain("alice");
    expect(s).toContain("coder");
  });
});

// --- formatSummonDisplay ---

describe("formatSummonDisplay", () => {
  // Minimal theme stub that wraps text in markers for assertion
  const theme = {
    fg: (_color: string, text: string) => `[${_color}:${text}]`,
  } as any;

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

// --- formatDismissResult ---

describe("formatDismissResult", () => {
  it("empty array says no imps", () => {
    expect(formatDismissResult([])).toBe("No imps to dismiss.");
  });

  it("lists dismissed names", () => {
    const a = makeImp({ name: "alice" });
    const b = makeImp({ name: "bob" });
    const s = formatDismissResult([a, b]);
    expect(s).toContain("alice");
    expect(s).toContain("bob");
    expect(s).toMatch(/^Dismissed:/);
  });
});

// --- formatWaitResult ---

describe("formatWaitResult", () => {
  it("includes output for completed imp", () => {
    const imp = makeImp({
      name: "alice",
      status: "completed",
      output: "All tests passed.",
    });
    const s = formatWaitResult([imp]);
    expect(s).toContain("alice");
    expect(s).toContain("completed");
    expect(s).toContain("All tests passed.");
  });

  it("includes error for failed imp", () => {
    const imp = makeImp({
      name: "bob",
      status: "failed",
      error: "segfault",
    });
    const s = formatWaitResult([imp]);
    expect(s).toContain("bob");
    expect(s).toContain("failed");
    expect(s).toContain("segfault");
  });

  it("includes output for truncated imp with truncated label", () => {
    const imp = makeImp({
      name: "carol",
      status: "truncated",
      output: "Completed X. Remaining: Y.",
      turns: 30,
    });
    const s = formatWaitResult([imp]);
    expect(s).toContain("carol");
    expect(s).toContain("truncated");
    expect(s).toContain("Completed X. Remaining: Y.");
  });
});

// --- formatWaitResultCompact ---

describe("formatWaitResultCompact", () => {
  it("empty imps returns no uncollected message", () => {
    expect(formatWaitResultCompact([], "all")).toBe("No uncollected imps.");
  });

  it("all mode shows status lines and 'All completed' footer", () => {
    const imps = [
      {
        name: "alice",
        agentName: "sentinel",
        status: "completed",
        turns: 3,
        tokens: 12400,
      },
      {
        name: "bob",
        agentName: "mason",
        status: "completed",
        turns: 5,
        tokens: 18100,
      },
    ];
    const s = formatWaitResultCompact(imps, "all");
    expect(s).toContain("alice");
    expect(s).toContain("bob");
    expect(s).toContain("All completed");
  });

  it("all mode omits footer when imps still running", () => {
    const imps = [
      {
        name: "alice",
        agentName: "sentinel",
        status: "completed",
        turns: 3,
        tokens: 500,
      },
      {
        name: "bob",
        agentName: "ephemeral",
        status: "running",
        turns: 1,
        tokens: 100,
      },
    ];
    const s = formatWaitResultCompact(imps, "all");
    expect(s).not.toContain("All completed");
  });

  it("first mode shows winner one-liner with stats", () => {
    const imps = [
      {
        name: "kevin",
        agentName: "cartographer",
        status: "completed",
        turns: 2,
        tokens: 8300,
      },
    ];
    const s = formatWaitResultCompact(imps, "first");
    expect(s).toContain("kevin");
    expect(s).toContain("cartographer");
    expect(s).toContain("finished first");
    expect(s).toContain("2 turns");
    expect(s).toContain("8.3k tokens");
  });

  it("first mode with ephemeral omits agent name", () => {
    const imps = [
      {
        name: "bob",
        agentName: "ephemeral",
        status: "completed",
        turns: 1,
        tokens: 500,
      },
    ];
    const s = formatWaitResultCompact(imps, "first");
    expect(s).toContain("bob");
    expect(s).toContain("finished first");
    expect(s).not.toContain("ephemeral");
  });
});
