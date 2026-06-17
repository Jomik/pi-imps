import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentsBlock, discoverAgents, parseToolsList, parseTurnLimit } from "../src/agents.js";
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
