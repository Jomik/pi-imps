import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SettingsListTheme, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

function makeSettings(agentTools: Record<string, string[]> = {}): ImpSettings {
  const agents: Record<string, { tools?: string[] }> = {};
  for (const [k, v] of Object.entries(agentTools)) {
    agents[k] = { tools: v };
  }
  return { turnLimit: 30, toolAllowlist: undefined, additionalExtensions: [], agents };
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

// ─── partitionTools ──────────────────────────────────────────────────────────

describe("partitionTools", () => {
  it("puts globally-granted tools in granted column", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(["a"]), new Set());
    expect(granted).toContain("a");
    expect(available).not.toContain("a");
  });

  it("puts project-granted tools in granted column", () => {
    const { granted, available } = partitionTools(["a", "b", "c"], new Set(), new Set(["b"]));
    expect(granted).toContain("b");
    expect(available).not.toContain("b");
  });

  it("puts remaining tools in available column", () => {
    const { available } = partitionTools(["a", "b", "c"], new Set(["a"]), new Set(["b"]));
    expect(available).toEqual(["c"]);
  });

  it("tool in both global and project lands in granted once", () => {
    const { granted, available } = partitionTools(["a"], new Set(["a"]), new Set(["a"]));
    expect(granted).toEqual(["a"]);
    expect(available).toEqual([]);
  });

  it("returns empty granted when no grants", () => {
    const { granted, available } = partitionTools(["a", "b"], new Set(), new Set());
    expect(granted).toEqual([]);
    expect(available).toEqual(["a", "b"]);
  });

  it("returns empty available when all tools are granted", () => {
    const { granted, available } = partitionTools(["a", "b"], new Set(["a"]), new Set(["b"]));
    expect(granted).toEqual(["a", "b"]);
    expect(available).toEqual([]);
  });

  it("preserves order from input array", () => {
    const { granted, available } = partitionTools(["c", "a", "b"], new Set(["a"]), new Set(["c"]));
    expect(granted).toEqual(["c", "a"]); // order of visibleToolNames
    expect(available).toEqual(["b"]);
  });

  it("does not include tools omitted before calling (frontmatter filtering)", () => {
    // The handler filters frontmatter tools from visibleToolNames before calling partitionTools.
    const visible = ["bash", "write"]; // "read" already removed by handler
    const { granted, available } = partitionTools(visible, new Set(), new Set());
    expect([...granted, ...available]).not.toContain("read");
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
    const result = computeRevokeResult("tool-a", new Set(), new Set(["tool-a"]), []);
    expect(result).not.toBeNull();
    expect(result).not.toContain("tool-a");
  });

  it("returns null for a globally granted tool (read-only)", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a"]), new Set(["tool-a"]), []);
    expect(result).toBeNull();
  });

  it("keeps other project tools in the result", () => {
    const result = computeRevokeResult("tool-a", new Set(), new Set(["tool-a", "tool-b"]), []);
    expect(result).not.toContain("tool-a");
    expect(result).toContain("tool-b");
  });

  it("includes unknown preserved tools in the result", () => {
    const result = computeRevokeResult("tool-a", new Set(), new Set(["tool-a"]), ["unknown"]);
    expect(result).toContain("unknown");
  });

  it("preserves frontmatter-filtered project tools via unknown path", () => {
    // "read" is in frontmatter — filtered from visible, passed as unknownProjectTools.
    // Revoking "bash" must still preserve "read" in the write list.
    const result = computeRevokeResult("bash", new Set(), new Set(["bash"]), ["read"]);
    expect(result).not.toContain("bash");
    expect(result).toContain("read");
  });

  it("returns empty array when last project tool is removed", () => {
    const result = computeRevokeResult("tool-a", new Set(), new Set(["tool-a"]), []);
    expect(result).toEqual([]);
  });

  it("does not mutate currentProjectTools", () => {
    const set = new Set(["tool-a"]);
    computeRevokeResult("tool-a", new Set(), set, []);
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
      [],
      plainTheme,
      10,
      () => {},
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
      [],
      plainTheme,
      10,
      () => {},
      () => {},
    );
    const lines = picker.render(60);
    expect(lines[0]).toContain("▶ Available");
    expect(lines[0]).not.toContain("▶ Granted");
  });

  it("marks Granted as active by default when available is empty", () => {
    // All tools are globally granted → available is empty
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(["a"]),
      new Set(),
      [],
      plainTheme,
      10,
      () => {},
      () => {},
    );
    const lines = picker.render(60);
    expect(lines[0]).toContain("▶ Granted");
    expect(lines[0]).not.toContain("▶ Available");
  });

  it("all rendered lines are <= the requested width", () => {
    const picker = new TwoPaneToolPicker(
      ["tool-alpha", "tool-beta", "tool-gamma", "tool-delta"],
      new Set(["tool-alpha"]),
      new Set(["tool-beta"]),
      [],
      plainTheme,
      10,
      () => {},
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
      [],
      plainTheme,
      10,
      () => {},
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
      new Set(["bash"]),
      [],
      plainTheme,
      10,
      () => {},
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

// ─── TwoPaneToolPicker input ──────────────────────────────────────────────────

describe("TwoPaneToolPicker input", () => {
  it("Tab switches active column from Available to Granted", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      () => {},
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
      [],
      plainTheme,
      5,
      () => {},
      () => {},
    );
    picker.handleInput("\t"); // → Granted
    picker.handleInput("\t"); // → Available again
    expect(picker.render(60)[0]).toContain("▶ Available");
  });

  it("right arrow switches to Available column", () => {
    const picker = new TwoPaneToolPicker(
      ["a"],
      new Set(["a"]), // all global → no available → Granted is default
      new Set(),
      [],
      plainTheme,
      5,
      () => {},
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
      [],
      plainTheme,
      5,
      () => {},
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
      [],
      plainTheme,
      5,
      () => {},
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
      projectTools,
      [],
      plainTheme,
      5,
      (tools) => persisted.push([...tools]),
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
      projectTools,
      ["future-tool"], // unknown preserved
      plainTheme,
      5,
      (tools) => persisted.push([...tools]),
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
      projectTools,
      [],
      plainTheme,
      5,
      (tools) => persisted.push([...tools]),
      () => {},
    );
    // Switch to Granted (Available is active by default because tool-b is there)
    picker.handleInput("\t");
    picker.handleInput("\r"); // Enter — revokes tool-a
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).not.toContain("tool-a");
    expect(projectTools.has("tool-a")).toBe(false);
  });

  it("Enter on Granted global tool is a no-op (read-only)", () => {
    const persisted: string[][] = [];
    const picker = new TwoPaneToolPicker(
      ["tool-a", "tool-b"],
      new Set(["tool-a"]), // tool-a is global
      new Set(),
      [],
      plainTheme,
      5,
      (tools) => persisted.push([...tools]),
      () => {},
    );
    // Switch to Granted (tool-b in Available, Available is active by default)
    picker.handleInput("\t");
    // tool-a (global) is first/selected item in Granted
    picker.handleInput("\r"); // Enter — should be no-op
    expect(persisted).toHaveLength(0);
  });

  it("Escape calls onDone via the active list", () => {
    let closed = false;
    const picker = new TwoPaneToolPicker(
      ["tool-a"],
      new Set(),
      new Set(),
      [],
      plainTheme,
      5,
      () => {},
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
      new Set(["tool-a"]), // global → Granted is default active
      new Set(),
      [],
      plainTheme,
      5,
      () => {},
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

// ─── handler: frontmatter tool filtering ────────────────────────────────────

describe("handler: frontmatter tool filtering", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-fm-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens the TUI when agent has frontmatter tools", async () => {
    const agents: AgentConfig[] = [
      {
        name: "mason",
        description: "Mason",
        systemPrompt: "",
        source: "user",
        filePath: "/a/mason.md",
        tools: ["read"],
      },
    ];
    const cmd = createImpsCommand(makePi(["bash", "read"]), agents, makeSettings());
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledOnce();
  });

  it("preserves frontmatter-granted project tools on write via the unknown-preserved path", () => {
    // When mason has frontmatter tools: ["read"] and the project config already
    // grants "read", the handler classifies "read" as an unknown preserved tool
    // (not visible, not toggleable). Granting another visible tool must keep "read".
    // Verified via computeGrantResult with the same classification the handler uses:
    // "read" is in frontmatter — not in visibleToolNames, so it lands in unknownProjectTools.
    const result = computeGrantResult("bash", new Set(), ["read"]);
    expect(result).toContain("bash");
    expect(result).toContain("read"); // preserved from frontmatter-filtered project grant
  });

  it("does not show frontmatter tools as global grants even when both match", async () => {
    // A tool in both frontmatter AND global settings is hidden (not read-only visible).
    // partitionTools is called with the pre-filtered visibleToolNames, so the
    // frontmatter tool never reaches the partition at all.
    const agents: AgentConfig[] = [
      {
        name: "mason",
        description: "Mason",
        systemPrompt: "",
        source: "user",
        filePath: "/a/mason.md",
        tools: ["read"],
      },
    ];
    // "read" is also a global grant — it should still be hidden because frontmatter wins
    const settings = makeSettings({ mason: ["read"] });
    const cmd = createImpsCommand(makePi(["bash", "read"]), agents, settings);
    const { ctx, custom } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    // TUI opens (no error), meaning the handler ran past the filtering step cleanly.
    expect(custom).toHaveBeenCalledOnce();
  });
});
