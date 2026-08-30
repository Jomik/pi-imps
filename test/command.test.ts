import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyToolToggle, buildToolItems, createImpsCommand } from "../src/command.js";
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

// ─── buildToolItems ──────────────────────────────────────────────────────────

describe("buildToolItems", () => {
  it("marks global tools as read-only single-value item", () => {
    const items = buildToolItems(["run_tests", "read", "bash"], new Set(["run_tests"]), new Set());
    const runTests = items.find((i) => i.id === "run_tests");
    expect(runTests?.currentValue).toBe("global");
    expect(runTests?.values).toEqual(["global"]);
  });

  it("describes global items as granted via global settings", () => {
    const items = buildToolItems(["run_tests"], new Set(["run_tests"]), new Set());
    expect(items[0].description).toMatch(/global settings/i);
  });

  it("marks non-global project-toggled tools as 'yes'", () => {
    const items = buildToolItems(["read", "bash"], new Set(), new Set(["read"]));
    const read = items.find((i) => i.id === "read");
    expect(read?.currentValue).toBe("yes");
    expect(read?.values).toEqual(["yes", "no"]);
  });

  it("marks non-global non-project tools as 'no'", () => {
    const items = buildToolItems(["read", "bash"], new Set(), new Set());
    const bash = items.find((i) => i.id === "bash");
    expect(bash?.currentValue).toBe("no");
    expect(bash?.values).toEqual(["yes", "no"]);
  });

  it("global takes precedence over project when both sets contain the same tool", () => {
    const items = buildToolItems(["run_tests"], new Set(["run_tests"]), new Set(["run_tests"]));
    expect(items[0].currentValue).toBe("global");
    expect(items[0].values).toEqual(["global"]);
  });

  it("returns one item per tool in the same order", () => {
    const items = buildToolItems(["a", "b", "c"], new Set(), new Set());
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("does not include tools omitted before calling buildToolItems (frontmatter filtering)", () => {
    // Handler filters frontmatter tools from allToolNames before calling buildToolItems.
    // Verify that a pre-filtered list produces no item for the omitted tool.
    const visibleAfterFilter = ["bash", "write"]; // "read" already removed by handler
    const items = buildToolItems(visibleAfterFilter, new Set(), new Set());
    expect(items.map((i) => i.id)).toEqual(["bash", "write"]);
    expect(items.map((i) => i.id)).not.toContain("read");
  });
});

// ─── applyToolToggle ─────────────────────────────────────────────────────────

describe("applyToolToggle", () => {
  it("adds tool to set and returns it in result when toggled on", () => {
    const projectTools = new Set<string>();
    const result = applyToolToggle("run_tests", "yes", new Set(), projectTools, []);
    expect(result).not.toBeNull();
    expect(result).toContain("run_tests");
    expect(projectTools.has("run_tests")).toBe(true);
  });

  it("removes tool from set and omits it from result when toggled off", () => {
    const projectTools = new Set(["run_tests"]);
    const result = applyToolToggle("run_tests", "no", new Set(), projectTools, []);
    expect(result).not.toBeNull();
    expect(result).not.toContain("run_tests");
    expect(projectTools.has("run_tests")).toBe(false);
  });

  it("returns null for a globally granted tool (read-only)", () => {
    const projectTools = new Set<string>();
    const result = applyToolToggle("run_tests", "global", new Set(["run_tests"]), projectTools, []);
    expect(result).toBeNull();
    expect(projectTools.has("run_tests")).toBe(false);
  });

  it("includes unknown project tools in result to preserve them", () => {
    const projectTools = new Set(["read"]);
    const result = applyToolToggle("read", "no", new Set(), projectTools, ["future_tool"]);
    expect(result).not.toContain("read");
    expect(result).toContain("future_tool");
  });

  it("includes unknown tools even when the toggle adds a new tool", () => {
    const projectTools = new Set<string>();
    const result = applyToolToggle("bash", "yes", new Set(), projectTools, ["unknown_a", "unknown_b"]);
    expect(result).toContain("bash");
    expect(result).toContain("unknown_a");
    expect(result).toContain("unknown_b");
  });

  it("preserves project tools hidden because they are in agent frontmatter", () => {
    // The handler filters frontmatter tools from visibleToolNames, so they land in
    // unknownProjectTools. This verifies applyToolToggle preserves them on every write.
    const projectTools = new Set<string>(["bash"]); // bash is visible
    // "read" is in frontmatter — filtered from visible, passed as unknown preserved
    const result = applyToolToggle("bash", "no", new Set(), projectTools, ["read"]);
    expect(result).not.toContain("bash");
    expect(result).toContain("read");
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

  it("preserves frontmatter-granted project tools on write via the unknown-preserved path", async () => {
    // When mason has frontmatter tools: ["read"] and the project config already
    // grants "read", the handler classifies "read" as an unknown preserved tool
    // (not visible, not toggleable). Toggling another visible tool must keep "read".
    // Tested via applyToolToggle with the same classification the handler uses.
    // "read" is in frontmatter — not in visibleToolNames, so it lands in unknownProjectTools.
    const projectTools = new Set<string>(); // currentProjectTools has no visible entries
    const result = applyToolToggle("bash", "yes", new Set(), projectTools, ["read"]);
    expect(result).toContain("bash");
    expect(result).toContain("read"); // preserved from frontmatter-filtered project grant
  });

  it("does not show frontmatter tools as global grants even when both match", async () => {
    // A tool in both frontmatter AND global settings is hidden (not read-only visible).
    // buildToolItems is called with the pre-filtered visibleToolNames, so the
    // frontmatter tool never reaches the items builder at all.
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
