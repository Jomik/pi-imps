import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SettingsListTheme, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBadges,
  computeBaseToolSources,
  computeGrantResult,
  computeRevokeResult,
  createImpsCommand,
  partitionTools,
  TwoPaneToolPicker,
} from "../src/command.js";
import type { AgentConfig, ImpSettings } from "../src/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeAgents(...names: string[]): AgentConfig[] {
  return names.map((name) => ({
    name,
    description: `Agent ${name}`,
    systemPrompt: "",
    source: "user" as const,
    filePath: `/agents/${name}.md`,
  }));
}

/** Make an AgentConfig with explicit frontmatter tools. */
function makeAgentWithTools(name: string, tools: string[]): AgentConfig {
  return {
    name,
    description: `Agent ${name}`,
    systemPrompt: "",
    source: "user" as const,
    filePath: `/agents/${name}.md`,
    tools,
  };
}

function makeSettings(agentTools: Record<string, string[]> = {}, toolAllowlist?: string[]): ImpSettings {
  const agents: Record<string, { tools?: string[] }> = {};
  for (const [k, v] of Object.entries(agentTools)) {
    agents[k] = { tools: v };
  }
  return { turnLimit: 30, toolAllowlist, additionalExtensions: [], agents };
}

/** Minimal ExtensionAPI stub — only exposes methods used by createImpsCommand. */
function makePi(toolNames: string[]) {
  return {
    getAllTools: () => toolNames.map((name) => ({ name, description: "", parameters: {} })),
  } as unknown as Parameters<typeof createImpsCommand>[0];
}

/**
 * Create a minimal ExtensionCommandContext mock.
 *
 * Pass `{ mode: ... }` for newer pi (>= 0.75) — mode is set on the context.
 * Pass `{ hasUI: ... }` for legacy pi 0.74 — no mode property is set.
 * Omit overrides for the default (newer tui).
 *
 * Returns the typed ctx alongside separate notify/custom handles so test
 * assertions can use the full MockInstance API.
 */
function makeCtx(cwd: string, overrides?: { mode: "tui" | "rpc" | "print" } | { hasUI: boolean }) {
  const notify = vi.fn();
  const custom = vi.fn().mockResolvedValue(undefined);

  const base: Record<string, unknown> = { cwd, ui: { notify, custom } };

  if (overrides !== undefined && "hasUI" in overrides) {
    // Legacy pi 0.74: no mode property — guard falls back to hasUI.
    base.hasUI = overrides.hasUI;
  } else {
    // Newer pi (>= 0.75): context carries a mode discriminator.
    const mode = overrides?.mode ?? "tui";
    base.mode = mode;
    base.hasUI = mode === "tui";
  }

  const ctx = base as unknown as ExtensionCommandContext;
  return { ctx, notify, custom };
}

/** Plain no-ANSI theme suitable for deterministic render assertions. */
const plainTheme: SettingsListTheme = {
  label: (text, _selected) => text,
  value: (text, _selected) => text,
  description: (text) => text,
  cursor: "> ",
  hint: (text) => text,
};

/** Minimal no-op onPersist callback indicating success. */
const persistOk = (): true => true;

// ─── computeBadges ────────────────────────────────────────────────────────────

describe("computeBadges", () => {
  it("returns [agent] when tool is in agentTools", () => {
    expect(computeBadges("read", new Set(["read"]), new Set(), new Set(), new Set())).toEqual(["agent"]);
  });

  it("returns [default] when tool is in defaultTools", () => {
    expect(computeBadges("read", new Set(), new Set(["read"]), new Set(), new Set())).toEqual(["default"]);
  });

  it("returns [global] when tool is in globalTools", () => {
    expect(computeBadges("read", new Set(), new Set(), new Set(["read"]), new Set())).toEqual(["global"]);
  });

  it("returns [project] when tool is in projectTools", () => {
    expect(computeBadges("read", new Set(), new Set(), new Set(), new Set(["read"]))).toEqual(["project"]);
  });

  it("returns [] when tool has no source", () => {
    expect(computeBadges("read", new Set(), new Set(), new Set(), new Set())).toEqual([]);
  });

  it("returns badges in stable order: agent, global, project", () => {
    const badges = computeBadges(
      "tool-x",
      new Set(["tool-x"]), // agent
      new Set(), // default
      new Set(["tool-x"]), // global
      new Set(["tool-x"]), // project
    );
    expect(badges).toEqual(["agent", "global", "project"]);
  });

  it("returns badges in stable order: default, global, project", () => {
    const badges = computeBadges(
      "tool-x",
      new Set(), // agent
      new Set(["tool-x"]), // default
      new Set(["tool-x"]), // global
      new Set(["tool-x"]), // project
    );
    expect(badges).toEqual(["default", "global", "project"]);
  });

  it("agent and default are mutually exclusive: only agent appears when both could apply", () => {
    // In practice, computeBaseToolSources ensures they cannot both be set,
    // but computeBadges itself doesn't enforce that. Test the expected case:
    // when agent tools are present, only agent badge shows (no default).
    const badges = computeBadges("x", new Set(["x"]), new Set(), new Set(), new Set());
    expect(badges).not.toContain("default");
    expect(badges).toContain("agent");
  });

  it("returns [agent, global] for tool in both agent frontmatter and global settings", () => {
    const badges = computeBadges("read", new Set(["read"]), new Set(), new Set(["read"]), new Set());
    expect(badges).toEqual(["agent", "global"]);
  });

  it("returns [default, project] for tool in default baseline and project grants", () => {
    const badges = computeBadges("bash", new Set(), new Set(["bash"]), new Set(), new Set(["bash"]));
    expect(badges).toEqual(["default", "project"]);
  });
});

// ─── computeBaseToolSources ──────────────────────────────────────────────────

describe("computeBaseToolSources", () => {
  const allTools = ["read", "bash", "grep", "write"];

  it("uses agentTools from frontmatter when tools are explicitly defined", () => {
    const agent = makeAgentWithTools("mason", ["read", "bash"]);
    const settings = makeSettings();
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect([...agentTools].sort()).toEqual(["bash", "read"]);
    expect(defaultTools.size).toBe(0);
  });

  it("uses defaultTools from toolAllowlist when agent has no frontmatter tools", () => {
    const agent = makeAgents("mason")[0];
    const settings = makeSettings({}, ["read", "grep"]);
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect([...defaultTools].sort()).toEqual(["grep", "read"]);
  });

  it("uses all tools as defaultTools when agent has no frontmatter and no toolAllowlist", () => {
    const agent = makeAgents("mason")[0];
    const settings = makeSettings();
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect([...defaultTools].sort()).toEqual([...allTools].sort());
  });

  it("uses empty agentTools and empty defaultTools for explicit empty frontmatter tools: []", () => {
    const agent = makeAgentWithTools("mason", []); // explicit tools: []
    const settings = makeSettings({}, ["read", "grep"]); // allowlist present but ignored
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect(defaultTools.size).toBe(0);
  });

  it("agentTools and defaultTools are mutually exclusive", () => {
    const agentWithTools = makeAgentWithTools("mason", ["read"]);
    const agentWithoutTools = makeAgents("mason")[0];
    const settings = makeSettings({}, ["bash"]);

    const { agentTools: at1, defaultTools: dt1 } = computeBaseToolSources(agentWithTools, settings, allTools);
    expect(at1.size).toBeGreaterThan(0);
    expect(dt1.size).toBe(0);

    const { agentTools: at2, defaultTools: dt2 } = computeBaseToolSources(agentWithoutTools, settings, allTools);
    expect(at2.size).toBe(0);
    expect(dt2.size).toBeGreaterThan(0);
  });
});

// ─── partitionTools ──────────────────────────────────────────────────────────

describe("partitionTools", () => {
  it("puts tools in Granted when they have an agent source", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(["a"]), new Set(), new Set(), new Set());
    expect(granted).toContain("a");
    expect(available).not.toContain("a");
  });

  it("puts tools in Granted when they have a default source", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(), new Set(["b"]), new Set(), new Set());
    expect(granted).toContain("b");
    expect(available).not.toContain("b");
  });

  it("puts globally-granted tools in granted column", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(), new Set(), new Set(["a"]), new Set());
    expect(granted).toContain("a");
    expect(available).not.toContain("a");
  });

  it("puts project-granted tools in granted column", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(), new Set(), new Set(), new Set(["b"]));
    expect(granted).toContain("b");
    expect(available).not.toContain("b");
  });

  it("puts remaining tools in available column", () => {
    const { available } = partitionTools(["a", "b", "c"], new Set(["a"]), new Set(), new Set(), new Set(["b"]));
    expect(available).toEqual(["c"]);
  });

  it("tool in multiple sources lands in granted once (one-row invariant)", () => {
    const { granted, available } = partitionTools(["a"], new Set(["a"]), new Set(), new Set(["a"]), new Set(["a"]));
    expect(granted).toEqual(["a"]);
    expect(available).toEqual([]);
  });

  it("returns empty granted when no grants", () => {
    const { granted, available } = partitionTools(["a", "b"], new Set(), new Set(), new Set(), new Set());
    expect(granted).toEqual([]);
    expect(available).toEqual(["a", "b"]);
  });

  it("returns empty available when all tools have sources", () => {
    const { granted, available } = partitionTools(["a", "b"], new Set(["a"]), new Set(), new Set(), new Set(["b"]));
    expect(granted).toEqual(["a", "b"]);
    expect(available).toEqual([]);
  });

  it("preserves order from input array", () => {
    const { granted, available } = partitionTools(
      ["c", "a", "b"],
      new Set(["a"]),
      new Set(),
      new Set(),
      new Set(["c"]),
    );
    expect(granted).toEqual(["c", "a"]); // order of allToolNames
    expect(available).toEqual(["b"]);
  });

  it("every tool appears exactly once across granted and available", () => {
    const allTools = ["a", "b", "c", "d", "e"];
    const { granted, available } = partitionTools(
      allTools,
      new Set(["a"]),
      new Set(["b"]),
      new Set(["c"]),
      new Set(["d"]),
    );
    expect([...granted, ...available].sort()).toEqual(allTools);
  });
});

// ─── computeGrantResult ──────────────────────────────────────────────────────

describe("computeGrantResult", () => {
  it("adds the tool to the write list", () => {
    const result = computeGrantResult("tool-a", new Set(), []);
    expect(result).toContain("tool-a");
  });

  it("includes already-granted tools in the result", () => {
    const result = computeGrantResult("tool-b", new Set(["tool-a"]), []);
    expect(result).toContain("tool-a");
    expect(result).toContain("tool-b");
  });

  it("includes unknown preserved tools in the result", () => {
    const result = computeGrantResult("tool-a", new Set(), ["unknown-tool"]);
    expect(result).toContain("tool-a");
    expect(result).toContain("unknown-tool");
  });

  it("does not duplicate when tool is already in current set", () => {
    const result = computeGrantResult("tool-a", new Set(["tool-a"]), []);
    expect(result.filter((t) => t === "tool-a")).toHaveLength(1);
  });

  it("does not mutate currentProjectTools", () => {
    const set = new Set(["tool-a"]);
    computeGrantResult("tool-b", set, []);
    expect(set.has("tool-b")).toBe(false);
  });
});

// ─── computeRevokeResult ─────────────────────────────────────────────────────

describe("computeRevokeResult", () => {
  it("removes the tool from the write list", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a"]), []);
    expect(result).not.toBeNull();
    expect(result).not.toContain("tool-a");
  });

  it("returns null when tool has no project source (inherited-only — read-only)", () => {
    // Tool exists in other sources (agent/default/global) but NOT in currentProjectTools.
    const result = computeRevokeResult("tool-a", new Set(), []); // not in project
    expect(result).toBeNull();
  });

  it("allows revoking a tool that is also in global/agent sources (removes only project)", () => {
    // A multi-source tool can still be revoked from the project.
    const result = computeRevokeResult("tool-a", new Set(["tool-a"]), []);
    expect(result).not.toBeNull();
    expect(result).not.toContain("tool-a");
  });

  it("keeps other project tools in the result", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a", "tool-b"]), []);
    expect(result).not.toContain("tool-a");
    expect(result).toContain("tool-b");
  });

  it("includes unknown preserved tools in the result", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a"]), ["unknown"]);
    expect(result).toContain("unknown");
  });

  it("preserves unregistered project tool names via unknown path", () => {
    // "future-tool" is not registered in the session — in unknownProjectTools.
    // Revoking "bash" must still preserve "future-tool" in the write list.
    const result = computeRevokeResult("bash", new Set(["bash"]), ["future-tool"]);
    expect(result).not.toContain("bash");
    expect(result).toContain("future-tool");
  });

  it("returns empty array when last project tool is removed", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a"]), []);
    expect(result).toEqual([]);
  });

  it("does not mutate currentProjectTools", () => {
    const set = new Set(["tool-a"]);
    computeRevokeResult("tool-a", set, []);
    expect(set.has("tool-a")).toBe(true);
  });
});

// ─── TwoPaneToolPicker render ─────────────────────────────────────────────────

describe("TwoPaneToolPicker render", () => {
  it("renders both Granted and Available column headers", () => {
    const picker = new TwoPaneToolPicker(
      ["a", "b"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines[0]).toContain("Granted");
    expect(lines[0]).toContain("Available");
  });

  it("marks Available as active by default when available is non-empty", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines[0]).toContain("▶ Available");
    expect(lines[0]).not.toContain("▶ Granted");
  });

  it("marks Granted as active by default when available is empty", () => {
    // All tools are agent-granted → available is empty
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(["a"]),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines[0]).toContain("▶ Granted");
    expect(lines[0]).not.toContain("▶ Available");
  });

  it("renders [agent] badge for a tool with agent source", () => {
    const picker = new TwoPaneToolPicker(
      ["read"],
      new Set(["read"]),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines.join("\n")).toContain("[agent]");
  });

  it("renders [default] badge for a tool with default source", () => {
    const picker = new TwoPaneToolPicker(
      ["bash"],
      new Set(),
      new Set(["bash"]),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines.join("\n")).toContain("[default]");
  });

  it("renders [global] badge for a tool with global source", () => {
    const picker = new TwoPaneToolPicker(
      ["bash"],
      new Set(),
      new Set(),
      new Set(["bash"]),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines.join("\n")).toContain("[global]");
  });

  it("renders [project] badge for a tool with project source", () => {
    const picker = new TwoPaneToolPicker(
      ["bash"],
      new Set(),
      new Set(),
      new Set(),
      new Set(["bash"]),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    expect(lines.join("\n")).toContain("[project]");
  });

  it("renders multiple badges for a tool with multiple sources", () => {
    const picker = new TwoPaneToolPicker(
      ["bash"],
      new Set(),
      new Set(),
      new Set(["bash"]),
      new Set(["bash"]),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const rendered = lines_with_text(picker.render(60), "bash");
    expect(rendered.join("\n")).toContain("[global]");
    expect(rendered.join("\n")).toContain("[project]");
  });

  it("renders badges in stable order: agent before global before project", () => {
    const picker = new TwoPaneToolPicker(
      ["tool-x"],
      new Set(["tool-x"]),
      new Set(),
      new Set(["tool-x"]),
      new Set(["tool-x"]),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const rendered = picker.render(80).join("\n");
    const agentPos = rendered.indexOf("[agent]");
    const globalPos = rendered.indexOf("[global]");
    const projectPos = rendered.indexOf("[project]");
    expect(agentPos).toBeGreaterThanOrEqual(0);
    expect(globalPos).toBeGreaterThan(agentPos);
    expect(projectPos).toBeGreaterThan(globalPos);
  });

  it("Available tools have no badge text", () => {
    const picker = new TwoPaneToolPicker(
      ["a", "b"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const lines = picker.render(60);
    const allText = lines.slice(1).join("\n");
    // Available items carry no badge — verify none of the four badge tokens appear.
    // (Raw ANSI CSI sequences contain `[` so we check the specific tokens, not bare `[`.)
    for (const badge of ["[agent]", "[default]", "[global]", "[project]"]) {
      expect(allText).not.toContain(badge);
    }
  });

  it("all rendered lines are <= the requested width", () => {
    const picker = new TwoPaneToolPicker(
      ["tool-alpha", "tool-beta", "tool-gamma", "tool-delta"],
      new Set(),
      new Set(),
      new Set(["tool-alpha"]),
      new Set(["tool-beta"]),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const width = 60;
    const lines = picker.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("all rendered lines are <= the requested width on a narrow terminal", () => {
    const picker = new TwoPaneToolPicker(
      ["very-long-tool-name-here", "another-extremely-long-tool-name"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    const width = 20;
    const lines = picker.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("all rendered lines are <= width across multiple widths", () => {
    const tools = ["read", "write", "bash", "grep", "run_tests", "edit"];
    const picker = new TwoPaneToolPicker(
      tools,
      new Set(["read"]),
      new Set(),
      new Set(),
      new Set(["bash"]),
      [],
      plainTheme,
      10,
      persistOk,
      () => {},
    );
    for (const width of [15, 30, 60, 80, 120]) {
      const lines = picker.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

/** Helper: return lines from a render output that visibly contain the given text. */
function lines_with_text(lines: string[], text: string): string[] {
  return lines.filter((l) => l.includes(text));
}

// ─── TwoPaneToolPicker input ──────────────────────────────────────────────────

describe("TwoPaneToolPicker input", () => {
  it("Tab switches active column from Available to Granted", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    // Available is active by default (non-empty)
    expect(picker.render(60)[0]).toContain("▶ Available");
    picker.handleInput("\t");
    expect(picker.render(60)[0]).toContain("▶ Granted");
  });

  it("Tab switches active column from Granted back to Available", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    picker.handleInput("\t"); // → Granted
    picker.handleInput("\t"); // → Available again
    expect(picker.render(60)[0]).toContain("▶ Available");
  });

  it("right arrow switches to Available column", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(["a"]),
      new Set(),
      new Set(),
      new Set(), // all agent → no available → Granted is default
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    expect(picker.render(60)[0]).toContain("▶ Granted");
    picker.handleInput("\x1b[C"); // right arrow
    expect(picker.render(60)[0]).toContain("▶ Available");
  });

  it("left arrow switches to Granted column", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    // Available is active by default
    picker.handleInput("\x1b[D"); // left arrow
    expect(picker.render(60)[0]).toContain("▶ Granted");
  });

  it("alternate left/right arrow sequences (\\x1bOC/D) also switch columns", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    picker.handleInput("\x1bOD"); // alternate left
    expect(picker.render(60)[0]).toContain("▶ Granted");
    picker.handleInput("\x1bOC"); // alternate right
    expect(picker.render(60)[0]).toContain("▶ Available");
  });

  it("Enter on Available grants the tool and calls onPersist", () => {
    const projectTools = new Set<string>();
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      (tools) => {
        persisted.push([...tools]);
        return true;
      },
      () => {},
    );
    // Available is active by default
    picker.handleInput("\r"); // Enter — grants tool-a
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain("tool-a");
    expect(projectTools.has("tool-a")).toBe(true);
  });

  it("Enter on Available also preserves unknown project tools", () => {
    const projectTools = new Set<string>();
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      ["future-tool"], // unknown preserved
      plainTheme,
      5,
      (tools) => {
        persisted.push([...tools]);
        return true;
      },
      () => {},
    );
    picker.handleInput("\r");
    expect(persisted[0]).toContain("tool-a");
    expect(persisted[0]).toContain("future-tool");
  });

  it("Enter on Granted project tool revokes it and calls onPersist", () => {
    const projectTools = new Set(["tool-a"]);
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"], // tool-b in Available
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      (tools) => {
        persisted.push([...tools]);
        return true;
      },
      () => {},
    );
    // Switch to Granted (Available is active by default because tool-b is there)
    picker.handleInput("\t");
    picker.handleInput("\r"); // Enter — revokes tool-a
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toContain("tool-a");
    expect(projectTools.has("tool-a")).toBe(false);
  });

  it("Enter on Granted project-only tool moves it to Available", () => {
    const projectTools = new Set(["tool-a"]);
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      persistOk,
      () => {},
    );
    picker.handleInput("\t"); // switch to Granted
    picker.handleInput("\r"); // revoke tool-a

    // tool-a should now be in Available (not Granted)
    const rendered = picker.render(60).join("\n");
    // Both tool-a and tool-b are now in Available, no tools in Granted
    expect(rendered).toContain("▶ Available");
  });

  it("Enter on Granted multi-source tool with project source removes only project", () => {
    const projectTools = new Set(["tool-a"]);
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"],
      new Set(),
      new Set(),
      new Set(["tool-a"]), // tool-a also global
      projectTools,
      [],
      plainTheme,
      5,
      (tools) => {
        persisted.push([...tools]);
        return true;
      },
      () => {},
    );
    picker.handleInput("\t"); // switch to Granted
    picker.handleInput("\r"); // revoke project source of tool-a

    // tool-a remains in Granted (still has global source), only project badge removed
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toContain("tool-a");
    expect(projectTools.has("tool-a")).toBe(false);
    // tool-a should still be in Granted column (global source remains)
    const rendered = picker.render(60).join("\n");
    expect(rendered).toContain("[global]");
  });

  it("Enter on Granted inherited-only tool is a no-op (no project source)", () => {
    // tool-a has only a global/agent source, not a project source
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"],
      new Set(["tool-a"]), // agent source — no project source
      new Set(),
      new Set(),
      new Set(), // currentProjectTools empty
      [],
      plainTheme,
      5,
      (tools) => {
        persisted.push([...tools]);
        return true;
      },
      () => {},
    );
    // Switch to Granted (tool-b in Available, Available is active by default)
    picker.handleInput("\t");
    // tool-a (agent-only) is first/selected item in Granted
    picker.handleInput("\r"); // Enter — should be no-op
    expect(persisted).toHaveLength(0);
  });

  it("grant persistence false leaves tool in Available and project set unchanged", () => {
    const projectTools = new Set<string>();
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      (_tools) => false, // simulate persistence failure
      () => {},
    );
    // Available is active by default
    picker.handleInput("\r"); // Enter — attempt to grant tool-a
    expect(projectTools.has("tool-a")).toBe(false); // in-memory set unchanged
    expect(picker.render(60)[0]).toContain("▶ Available"); // column state unchanged
  });

  it("revoke persistence false leaves tool in Granted and project set unchanged", () => {
    const projectTools = new Set(["tool-a"]);
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      (_tools) => false, // simulate persistence failure
      () => {},
    );
    // Switch to Granted (Available is default because tool-b is there)
    picker.handleInput("\t");
    picker.handleInput("\r"); // Enter — attempt to revoke tool-a
    expect(projectTools.has("tool-a")).toBe(true); // in-memory set unchanged
    expect(picker.render(60)[0]).toContain("▶ Granted"); // column state unchanged
  });

  it("Escape calls onDone via the active list", () => {
    let closed = false;
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      persistOk,
      () => {
        closed = true;
      },
    );
    picker.handleInput("\x1b"); // Escape
    expect(closed).toBe(true);
  });

  it("Escape from Granted column also closes", () => {
    let closed = false;
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(["tool-a"]),
      new Set(),
      new Set(),
      new Set(), // agent → Granted is default active
      [],
      plainTheme,
      5,
      persistOk,
      () => {
        closed = true;
      },
    );
    picker.handleInput("\x1b"); // Escape from Granted
    expect(closed).toBe(true);
  });
});

// ─── getArgumentCompletions ─────────────────────────────────────────────────

describe("getArgumentCompletions", () => {
  const agents = makeAgents("mason", "sentinel");
  const cmd = createImpsCommand(makePi([]), agents, makeSettings());
  const completions = cmd.getArgumentCompletions.bind(cmd);

  it("completes 'tools' from empty prefix", () => {
    expect(completions("")).toEqual([{ value: "tools", label: "tools" }]);
  });

  it("completes 'tools' from partial 't'", () => {
    expect(completions("t")).toEqual([{ value: "tools", label: "tools" }]);
  });

  it("completes 'tools' from full word", () => {
    expect(completions("tools")).toEqual([{ value: "tools", label: "tools" }]);
  });

  it("returns null for a non-matching subcommand prefix", () => {
    expect(completions("x")).toBeNull();
  });

  it("returns null for an unknown subcommand before space", () => {
    expect(completions("list")).toBeNull();
  });

  it("completes all agent names after 'tools '", () => {
    expect(completions("tools ")).toEqual(
      expect.arrayContaining([
        { value: "tools mason", label: "mason" },
        { value: "tools sentinel", label: "sentinel" },
      ]),
    );
  });

  it("filters agent names by prefix after 'tools '", () => {
    expect(completions("tools ma")).toEqual([{ value: "tools mason", label: "mason" }]);
  });

  it("returns null when no agent names match prefix", () => {
    expect(completions("tools zzz")).toBeNull();
  });

  it("returns null for an unknown subcommand followed by space", () => {
    expect(completions("list ")).toBeNull();
  });
});

// ─── handler: argument validation ───────────────────────────────────────────

describe("handler argument validation", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-cmd-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows usage info for empty args (no subcommand)", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir);
    await cmd.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "info");
  });

  it("shows usage info for an unknown subcommand", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir);
    await cmd.handler("list", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "info");
  });

  it("shows usage info for 'tools' without an agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir);
    await cmd.handler("tools", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "info");
  });

  it("shows a warning for an unknown agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir);
    await cmd.handler("tools sentinel", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"), "warning");
  });

  it("shows a warning when TUI is unavailable (rpc mode)", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir, { mode: "rpc" });
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "warning");
  });

  it("shows a warning when TUI is unavailable (print mode)", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir, { mode: "print" });
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "warning");
  });

  it("shows a warning when TUI is unavailable (legacy hasUI=false)", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir, { hasUI: false });
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "warning");
  });

  it("opens the TUI on legacy pi 0.74 when hasUI=true", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, { hasUI: true });
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("shows usage info for extra arguments after agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify } = makeCtx(tmpDir);
    await cmd.handler("tools mason extra", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "info");
  });

  it("shows an error and does not open TUI when .pi/imps.json is a directory (EISDIR)", async () => {
    mkdirSync(join(piDir, "imps.json"), { recursive: true });
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("shows an error and does not open TUI when project config has non-object root", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify([1, 2, 3]));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("shows an error and does not open TUI when project config has non-object agents", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: "bad" }));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("shows an error and does not open TUI when selected agent entry is not an object", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: "bad" } }));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("shows an error and does not open TUI when project config is malformed", async () => {
    writeFileSync(join(piDir, "imps.json"), "not-json");
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, notify, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), "error");
    expect(custom).not.toHaveBeenCalled();
  });

  it("opens the TUI for a valid agent when UI is available", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });
});

// ─── handler: tool source computation ────────────────────────────────────────

describe("handler: tool source computation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-src-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens the TUI when agent has frontmatter tools", async () => {
    const agents: AgentConfig[] = [makeAgentWithTools("mason", ["read"])];
    const cmd = createImpsCommand(makePi(["bash", "read"]), agents, makeSettings());
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("opens the TUI when agent has no frontmatter tools (default baseline)", async () => {
    const cmd = createImpsCommand(makePi(["bash", "read"]), makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("opens the TUI when agent has explicit empty frontmatter tools: []", async () => {
    const agents: AgentConfig[] = [makeAgentWithTools("mason", [])];
    const cmd = createImpsCommand(makePi(["bash", "read"]), agents, makeSettings({}, ["bash"]));
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("computeBaseToolSources: explicit frontmatter produces agentTools, empty defaultTools", () => {
    const agent = makeAgentWithTools("mason", ["read", "bash"]);
    const settings = makeSettings({}, ["grep"]); // allowlist present but should be ignored
    const allTools = ["bash", "grep", "read"];
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect([...agentTools].sort()).toEqual(["bash", "read"]);
    expect(defaultTools.size).toBe(0);
  });

  it("computeBaseToolSources: no frontmatter + toolAllowlist → defaultTools from allowlist", () => {
    const agent = makeAgents("mason")[0];
    const settings = makeSettings({}, ["grep", "bash"]);
    const allTools = ["bash", "grep", "read"];
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect([...defaultTools].sort()).toEqual(["bash", "grep"]);
  });

  it("computeBaseToolSources: no frontmatter + no toolAllowlist → defaultTools = all tools", () => {
    const agent = makeAgents("mason")[0];
    const settings = makeSettings(); // no toolAllowlist
    const allTools = ["bash", "grep", "read"];
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect([...defaultTools].sort()).toEqual(allTools);
  });

  it("computeBaseToolSources: explicit empty [] → both agentTools and defaultTools empty", () => {
    const agent = makeAgentWithTools("mason", []);
    const settings = makeSettings({}, ["grep"]); // allowlist present but irrelevant
    const allTools = ["bash", "grep", "read"];
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect(defaultTools.size).toBe(0);
  });

  it("preserves unregistered project tool names on write (unknown preservation)", () => {
    // An unregistered tool name in the project config must be preserved on every write.
    // We test this via computeGrantResult with the same logic the handler uses:
    // "future-armory-tool" is not in allToolNames → goes into unknownProjectTools.
    const result = computeGrantResult("bash", new Set(), ["future-armory-tool"]);
    expect(result).toContain("bash");
    expect(result).toContain("future-armory-tool");
  });

  it("frontmatter tools appear in Granted column (not hidden) with agent badge", () => {
    // Unlike the previous design that filtered frontmatter tools from the picker,
    // they now appear in Granted with an [agent] badge.
    const agent = makeAgentWithTools("mason", ["read"]);
    const { agentTools } = computeBaseToolSources(agent, makeSettings(), ["bash", "read"]);
    const { granted, available } = partitionTools(["bash", "read"], agentTools, new Set(), new Set(), new Set());
    expect(granted).toContain("read");
    expect(available).not.toContain("read");
  });

  it("failed write: transactional — in-memory state unchanged on persistence failure", () => {
    const projectTools = new Set<string>();
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      new Set(),
      projectTools,
      [],
      plainTheme,
      5,
      (_tools) => false, // persistence always fails
      () => {},
    );
    picker.handleInput("\r"); // attempt to grant
    expect(projectTools.has("tool-a")).toBe(false);
  });
});
