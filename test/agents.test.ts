import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDiagnostic,
  buildAgentsBlock,
  discoverAgents,
  parseThinkingLevel,
  parseToolsList,
  parseTurnLimit,
} from "../src/agents.js";
import type { AgentConfig } from "../src/types.js";

// Mock getAgentDir so tests never touch the real ~/.pi/agent/agents/ directory.
// parseFrontmatter is kept from the actual module.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentDir: vi.fn(() => "/nonexistent-pi-agent-dir-for-testing-xyz"),
  };
});

describe("parseToolsList", () => {
  // YAML array
  it("parses YAML array of strings", () => {
    expect(parseToolsList(["read", "bash", "edit"])).toEqual(["read", "bash", "edit"]);
  });

  it("filters non-string values from YAML array", () => {
    expect(parseToolsList(["read", 123, true, null, "bash"])).toEqual(["read", "bash"]);
  });

  it("filters empty strings from YAML array", () => {
    expect(parseToolsList(["read", "", "bash"])).toEqual(["read", "bash"]);
  });

  it("returns empty array for YAML array with no valid strings", () => {
    expect(parseToolsList([123, true])).toEqual([]);
  });

  it("returns empty array for empty YAML array", () => {
    expect(parseToolsList([])).toEqual([]);
  });

  it("trims whitespace from YAML array string entries", () => {
    expect(parseToolsList(["  read  ", " bash", "edit  "])).toEqual(["read", "bash", "edit"]);
  });

  // Comma-separated string
  it("parses comma-separated string", () => {
    expect(parseToolsList("read, bash, edit")).toEqual(["read", "bash", "edit"]);
  });

  it("trims whitespace in comma-separated string", () => {
    expect(parseToolsList("  read ,  bash  , edit  ")).toEqual(["read", "bash", "edit"]);
  });

  it("filters empty segments from comma-separated string", () => {
    expect(parseToolsList("read,,bash,")).toEqual(["read", "bash"]);
  });

  it("handles single tool string", () => {
    expect(parseToolsList("read")).toEqual(["read"]);
  });

  // Absent / invalid
  it("returns undefined for undefined", () => {
    expect(parseToolsList(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(parseToolsList(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseToolsList("")).toBeUndefined();
  });

  it("returns undefined for number", () => {
    expect(parseToolsList(42)).toBeUndefined();
  });

  it("returns undefined for boolean", () => {
    expect(parseToolsList(true)).toBeUndefined();
  });
});

describe("parseTurnLimit", () => {
  it("accepts integer >= 2", () => {
    expect(parseTurnLimit(2)).toBe(2);
    expect(parseTurnLimit(30)).toBe(30);
    expect(parseTurnLimit(100)).toBe(100);
  });

  it("rejects values below 2", () => {
    expect(parseTurnLimit(1)).toBeUndefined();
    expect(parseTurnLimit(0)).toBeUndefined();
    expect(parseTurnLimit(-5)).toBeUndefined();
  });

  it("rejects non-integers", () => {
    expect(parseTurnLimit(2.5)).toBeUndefined();
    expect(parseTurnLimit(Number.NaN)).toBeUndefined();
    expect(parseTurnLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("rejects non-numbers", () => {
    expect(parseTurnLimit("30")).toBeUndefined();
    expect(parseTurnLimit(undefined)).toBeUndefined();
    expect(parseTurnLimit(null)).toBeUndefined();
    expect(parseTurnLimit(true)).toBeUndefined();
    expect(parseTurnLimit([30])).toBeUndefined();
  });
});

// ─── parseThinkingLevel ────────────────────────────────────────────────────

describe("parseThinkingLevel", () => {
  it("accepts all valid SDK levels", () => {
    expect(parseThinkingLevel("off")).toBe("off");
    expect(parseThinkingLevel("minimal")).toBe("minimal");
    expect(parseThinkingLevel("low")).toBe("low");
    expect(parseThinkingLevel("medium")).toBe("medium");
    expect(parseThinkingLevel("high")).toBe("high");
    expect(parseThinkingLevel("xhigh")).toBe("xhigh");
  });

  it("accepts the host-only max alias", () => {
    expect(parseThinkingLevel("max")).toBe("max");
  });

  it("returns undefined for unrecognized string", () => {
    expect(parseThinkingLevel("turbo")).toBeUndefined();
    expect(parseThinkingLevel("MAX")).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
  });

  it("returns undefined for non-string values", () => {
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel(null)).toBeUndefined();
    expect(parseThinkingLevel(42)).toBeUndefined();
    expect(parseThinkingLevel(true)).toBeUndefined();
    expect(parseThinkingLevel(["high"])).toBeUndefined();
  });
});

// ─── buildAgentsBlock ──────────────────────────────────────────────────────

describe("buildAgentsBlock", () => {
  it("returns empty string for empty agents array", () => {
    expect(buildAgentsBlock([])).toBe("");
  });

  it("wraps agents in <available_agents> block", () => {
    const agents: AgentConfig[] = [
      {
        name: "mason",
        description: "A coding agent",
        source: "user",
        systemPrompt: "",
        filePath: "/fake/mason.md",
      },
    ];
    const block = buildAgentsBlock(agents);
    expect(block).toContain("<available_agents>");
    expect(block).toContain("</available_agents>");
    expect(block).toContain("<name>mason</name>");
    expect(block).toContain("<description>A coding agent</description>");
    expect(block).toContain("<source>user</source>");
  });

  it("appends model to description when present", () => {
    const agents: AgentConfig[] = [
      {
        name: "mason",
        description: "A coding agent",
        model: "claude-3-5-sonnet",
        source: "user",
        systemPrompt: "",
        filePath: "/fake/mason.md",
      },
    ];
    const block = buildAgentsBlock(agents);
    expect(block).toContain("<description>A coding agent [model: claude-3-5-sonnet]</description>");
  });

  it("omits model annotation when model is absent", () => {
    const agents: AgentConfig[] = [
      { name: "alpha", description: "Alpha", source: "user", systemPrompt: "", filePath: "/a.md" },
    ];
    expect(buildAgentsBlock(agents)).not.toContain("[model:");
  });

  it("produces identical output on repeated calls with same input", () => {
    const agents: AgentConfig[] = [
      { name: "alpha", description: "Alpha", source: "user", systemPrompt: "", filePath: "/a.md" },
      { name: "beta", description: "Beta", source: "project", systemPrompt: "", filePath: "/b.md" },
    ];
    expect(buildAgentsBlock(agents)).toBe(buildAgentsBlock(agents));
  });

  it("emits one <agent> entry per config", () => {
    const agents: AgentConfig[] = [
      { name: "a", description: "A", source: "user", systemPrompt: "", filePath: "/a.md" },
      { name: "b", description: "B", source: "user", systemPrompt: "", filePath: "/b.md" },
      { name: "c", description: "C", source: "project", systemPrompt: "", filePath: "/c.md" },
    ];
    const block = buildAgentsBlock(agents);
    const matches = block.match(/<agent>/g);
    expect(matches).toHaveLength(3);
  });
});

// ─── discoverAgents ────────────────────────────────────────────────────────

describe("discoverAgents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-agents-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a minimal valid agent .md file. */
  function writeAgent(dir: string, filename: string, opts?: { name?: string; description?: string }) {
    const name = opts?.name;
    const description = opts?.description ?? `${filename.replace(/\.md$/, "")} agent`;
    const front = name
      ? `---\nname: ${name}\ndescription: ${description}\n---\n`
      : `---\ndescription: ${description}\n---\n`;
    writeFileSync(join(dir, filename), front);
  }

  it("returns empty array when no agent dirs exist", () => {
    expect(discoverAgents(tmpDir)).toEqual([]);
  });

  it("sorts project agents by name ascending", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    // Write in reverse alphabetical order to prove sorting is not filesystem-order
    writeAgent(dir, "zebra.md");
    writeAgent(dir, "alpha.md");
    writeAgent(dir, "mango.md");

    const names = discoverAgents(tmpDir).map((a) => a.name);
    expect(names).toEqual(["alpha", "mango", "zebra"]);
  });

  it("uses filename stem as name when frontmatter name is absent", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeAgent(dir, "sentinel.md");

    const agents = discoverAgents(tmpDir);
    expect(agents[0].name).toBe("sentinel");
  });

  it("uses frontmatter name over filename stem", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeAgent(dir, "file-name.md", { name: "custom-name" });

    const agents = discoverAgents(tmpDir);
    expect(agents[0].name).toBe("custom-name");
  });

  it("skips files without a string description in frontmatter", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    // Valid agent
    writeAgent(dir, "valid.md");
    // File with no description
    writeFileSync(join(dir, "nodesc.md"), "---\nname: nodesc\n---\n");

    const names = discoverAgents(tmpDir).map((a) => a.name);
    expect(names).toEqual(["valid"]);
  });

  it("marks project agents with source=project", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeAgent(dir, "mason.md");

    const agents = discoverAgents(tmpDir);
    expect(agents[0].source).toBe("project");
  });
});

// ─── discoverAgents diagnostics ───────────────────────────────────────────────────────────

describe("discoverAgents diagnostics", () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-agents-diag-test-"));
    projectDir = join(tmpDir, ".pi", "agents");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRaw(filename: string, content: string) {
    writeFileSync(join(projectDir, filename), content);
  }

  // Table-driven: each case writes one invalid file and expects it excluded
  // with a diagnostic, while a co-located valid agent still loads.
  const invalidCases: Array<{ label: string; filename: string; content: string }> = [
    {
      label: "malformed YAML frontmatter",
      filename: "broken.md",
      content: "---\ndescription: [unclosed\n---\nbody\n",
    },
    {
      label: "missing description",
      filename: "nodesc.md",
      content: "---\nname: nodesc\n---\n",
    },
    {
      label: "non-string description",
      filename: "baddesc.md",
      content: "---\ndescription: 42\n---\n",
    },
    {
      label: "non-string name",
      filename: "badname.md",
      content: "---\ndescription: valid\nname: [1, 2]\n---\n",
    },
    {
      label: "non-string model",
      filename: "badmodel.md",
      content: "---\ndescription: valid\nmodel: 5\n---\n",
    },
    {
      label: "invalid thinking level",
      filename: "badthinking.md",
      content: "---\ndescription: valid\nthinking: turbo\n---\n",
    },
    {
      label: "invalid turns (below minimum)",
      filename: "badturns.md",
      content: "---\ndescription: valid\nturns: 1\n---\n",
    },
    {
      label: "invalid tools (empty string)",
      filename: "badtools.md",
      content: "---\ndescription: valid\ntools: ''\n---\n",
    },
    {
      label: "invalid tools (array with non-string entries)",
      filename: "badtools2.md",
      content: "---\ndescription: valid\ntools:\n  - read\n  - 5\n---\n",
    },
    {
      label: "blank description",
      filename: "blankdesc.md",
      content: "---\ndescription: '   '\n---\n",
    },
    {
      label: "blank name",
      filename: "blankname.md",
      content: "---\ndescription: valid\nname: '   '\n---\n",
    },
    {
      label: "blank model",
      filename: "blankmodel.md",
      content: "---\ndescription: valid\nmodel: '   '\n---\n",
    },
    {
      label: "blank tools string",
      filename: "blanktools.md",
      content: "---\ndescription: valid\ntools: '   '\n---\n",
    },
    {
      label: "tools array with a blank entry",
      filename: "blanktoolsarr.md",
      content: "---\ndescription: valid\ntools:\n  - read\n  - '   '\n---\n",
    },
    {
      label: "comma/whitespace-only tools string",
      filename: "commatools.md",
      content: "---\ndescription: valid\ntools: ' , '\n---\n",
    },
  ];

  it.each(invalidCases)("reports a diagnostic and excludes the definition: $label", ({ filename, content }) => {
    writeRaw(filename, content);
    writeRaw("valid.md", "---\ndescription: a valid agent\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).toEqual(["valid"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].filePath).toContain(filename);
    expect(diagnostics[0].message.length).toBeGreaterThan(0);
  });

  it("accepts unknown extra frontmatter fields", () => {
    writeRaw("extra.md", "---\ndescription: valid\nsome_unknown_field: 123\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).toEqual(["extra"]);
    expect(diagnostics).toEqual([]);
  });

  it("accepts valid tools as comma-separated string, array, and empty array", () => {
    writeRaw("tools-str.md", "---\ndescription: valid\ntools: read, edit\n---\n");
    writeRaw("tools-arr.md", "---\ndescription: valid\ntools:\n  - read\n  - edit\n---\n");
    writeRaw("tools-empty.md", "---\ndescription: valid\ntools: []\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names.sort()).toEqual(["tools-arr", "tools-empty", "tools-str"]);
    expect(diagnostics).toEqual([]);
  });

  it("normalizes whitespace in YAML array tool entries when loading", () => {
    writeRaw("tools-whitespace.md", "---\ndescription: valid\ntools:\n  - '  read  '\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const agents = discoverAgents(tmpDir, diagnostics);

    expect(diagnostics).toEqual([]);
    expect(agents.find((a) => a.name === "tools-whitespace")?.tools).toEqual(["read"]);
  });

  it("reports diagnostics for multiple invalid files while valid ones continue loading", () => {
    writeRaw("bad1.md", "---\ndescription: 1\n---\n");
    writeRaw("bad2.md", "---\ndescription: valid\nthinking: nope\n---\n");
    writeRaw("good.md", "---\ndescription: valid\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).toEqual(["good"]);
    expect(diagnostics).toHaveLength(2);
  });

  it("does not require a diagnostics array (backward compatible callers)", () => {
    writeRaw("bad.md", "---\ndescription: 1\n---\n");
    writeRaw("good.md", "---\ndescription: valid\n---\n");

    expect(() => discoverAgents(tmpDir)).not.toThrow();
    expect(discoverAgents(tmpDir).map((a) => a.name)).toEqual(["good"]);
  });

  it("masks a same-name global agent when the project definition is invalid", async () => {
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = join(tmpDir, "global-agent-dir");
    const userAgentsDir = join(agentDir, "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "shared.md"), "---\ndescription: global shared agent\n---\n");

    vi.mocked(getAgentDir).mockReturnValueOnce(agentDir);

    writeRaw("shared.md", "---\nname: shared\ndescription: 42\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).not.toContain("shared");
    expect(diagnostics).toHaveLength(1);
  });

  it("retains a valid project agent when an invalid project file claims the same name as a global agent", async () => {
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = join(tmpDir, "global-agent-dir");
    const userAgentsDir = join(agentDir, "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "shared.md"), "---\ndescription: global shared agent\n---\n");

    vi.mocked(getAgentDir).mockReturnValueOnce(agentDir);

    writeRaw("shared.md", "---\nname: shared\ndescription: valid project shared agent\n---\n");
    writeRaw("shared-invalid.md", "---\nname: shared\ndescription: 42\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const agents = discoverAgents(tmpDir, diagnostics);
    const shared = agents.find((a) => a.name === "shared");

    expect(shared).toBeDefined();
    expect(shared?.source).toBe("project");
    expect(shared?.description).toBe("valid project shared agent");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].filePath).toContain("shared-invalid.md");
  });

  it("uses filename stem as the claimed name for masking when frontmatter name is invalid", () => {
    writeRaw("stemname.md", "---\ndescription: valid\nname: 42\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    discoverAgents(tmpDir, diagnostics);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].filePath).toContain("stemname.md");
  });

  it("uses filename stem as the claimed name for masking when frontmatter name is blank", async () => {
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = join(tmpDir, "global-agent-dir-blank");
    const userAgentsDir = join(agentDir, "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "blankname.md"), "---\ndescription: global agent\n---\n");

    vi.mocked(getAgentDir).mockReturnValueOnce(agentDir);

    writeRaw("blankname.md", "---\ndescription: valid\nname: '   '\n---\n");

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).not.toContain("blankname");
    expect(diagnostics).toHaveLength(1);
  });

  it("reports a diagnostic and returns no agents when the directory cannot be read", async () => {
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = join(tmpDir, "global-agent-dir-unreadable");
    mkdirSync(agentDir, { recursive: true });
    // Make the expected agents-directory path an ordinary file so readdirSync throws ENOTDIR.
    writeFileSync(join(agentDir, "agents"), "not a directory");

    vi.mocked(getAgentDir).mockReturnValueOnce(agentDir);

    const diagnostics: AgentDiagnostic[] = [];
    const names = discoverAgents(tmpDir, diagnostics).map((a) => a.name);

    expect(names).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].filePath).toContain(join(agentDir, "agents"));
    expect(diagnostics[0].message.length).toBeGreaterThan(0);
  });
});
