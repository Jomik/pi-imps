import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBadges,
  computeBaseToolSources,
  computeEffectiveTools,
  computeGrantCandidates,
  computeGrantResult,
  computeRemoveCandidates,
  computeRevokeResult,
  createImpsCommand,
  queryArmoryProjectTools,
} from "../src/command.js";
import * as settingsModule from "../src/settings.js";
import type { AgentConfig, ImpSettings } from "../src/types.js";

// The real theme helpers require `initTheme()` to have run (they read a global theme
// registry). Command-level tests only need identity color functions, not real styling.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getSelectListTheme: () => ({
      selectedPrefix: (t: string) => t,
      selectedText: (t: string) => t,
      description: (t: string) => t,
      scrollInfo: (t: string) => t,
      noMatch: (t: string) => t,
    }),
    getSettingsListTheme: () => ({
      label: (t: string) => t,
      value: (t: string) => t,
      description: (t: string) => t,
      cursor: "> ",
      hint: (t: string) => t,
    }),
  };
});

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

/**
 * Minimal ExtensionAPI stub — only exposes methods used by createImpsCommand.
 *
 * `armoryProjectTools`:
 * - `undefined` → Armory never responds (absent/incompatible).
 * - `string[]` → Armory responds once per emit with this array (fresh each call — no cache).
 */
function makePi(toolNames: string[], armoryProjectTools?: string[]) {
  const emit = vi.fn((_event: string, payload: { respond(names: string[]): void }) => {
    if (armoryProjectTools !== undefined) {
      payload.respond(armoryProjectTools);
    }
  });
  return {
    getAllTools: () => toolNames.map((name) => ({ name, description: "", parameters: {} })),
    events: { emit },
  } as unknown as ExtensionAPI;
}

/**
 * Fake theme passed to `ctx.ui.custom` factories — identity color functions, since these
 * tests exercise command wiring, not real terminal styling.
 */
// biome-ignore lint/suspicious/noExplicitAny: test harness stand-in for the real Theme type
const fakeTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const DRIVE_KEYS = Symbol("driveKeys");

/**
 * Marks a `customResponses` entry to drive the real returned component's `handleInput`
 * with actual terminal key sequences, instead of resolving the dialog with a scripted
 * value. The harness feeds each key to `component.handleInput(key)` in order and lets
 * the component's own `done` callback (wired to the factory by the real command code)
 * resolve the surrounding promise — exercising the genuine toggle/apply/cancel wiring
 * rather than duplicating it in the test.
 */
function driveKeys(...keys: string[]): { [DRIVE_KEYS]: string[] } {
  return { [DRIVE_KEYS]: keys };
}

/**
 * Create a minimal ExtensionCommandContext mock with a scriptable `ui.custom`.
 *
 * Every dialog shown by the command (agent selector, main menu, message dialogs,
 * grant/remove multi-selects) goes through `ctx.ui.custom`. Each call consumes the
 * next entry from `customResponses` as the resolved value (simulating the eventual
 * user interaction), and the built component's `render(80)` output is captured in
 * `rendered` for content assertions (titles, candidate lists, badges, messages).
 *
 * `hasUI` defaults to `true`. Pass `false` to model print/JSON modes with no UI.
 * `mode`, when provided, is set on the context to model the newer pi `ctx.mode`
 * discriminator ("tui" | "rpc" | "print" | "json"); omitted by default to model
 * legacy pi, where the guard falls back to `hasUI`.
 *
 * A `customResponses` entry may also be `driveKeys(...)` to drive the real component's
 * `handleInput` with actual key sequences instead of resolving with a scripted value.
 */
function makeCtx(cwd: string, customResponses: unknown[] = [], hasUI = true, mode?: string) {
  const notify = vi.fn();
  const responses = [...customResponses];
  const rendered: string[][] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test harness accepts any factory shape
  const custom = vi.fn(async (factory: any) => {
    const fakeTui = { requestRender: () => {} };
    const fakeKb = {};
    return new Promise((resolve) => {
      const built = factory(fakeTui, fakeTheme, fakeKb, (result: unknown) => resolve(result));
      Promise.resolve(built).then(
        (component: { render(width: number): string[]; handleInput?(data: string): void }) => {
          rendered.push(component.render(80));
          const next = responses.shift();
          if (next !== null && typeof next === "object" && DRIVE_KEYS in (next as object)) {
            for (const key of (next as { [DRIVE_KEYS]: string[] })[DRIVE_KEYS]) {
              component.handleInput?.(key);
            }
            return;
          }
          resolve(next);
        },
      );
    });
  });
  const base: Record<string, unknown> = { cwd, hasUI, ui: { notify, custom } };
  if (mode !== undefined) base.mode = mode;
  const ctx = base as unknown as ExtensionCommandContext;
  return { ctx, notify, custom, rendered };
}

/**
 * Create a context modeling RPC mode: `ctx.hasUI` is `true`, but `ctx.ui.custom`
 * degrades to a no-op returning `undefined` without invoking the factory at all
 * (per pi's documented RPC behavior). Used to verify the command bails out before
 * any Armory query or config mutation in RPC mode.
 */
function makeRpcCtx(cwd: string) {
  const notify = vi.fn();
  const custom = vi.fn(async () => undefined);
  const ctx = { cwd, hasUI: true, ui: { notify, custom } } as unknown as ExtensionCommandContext;
  return { ctx, notify, custom };
}

function text(lines: string[]): string {
  return lines.join("\n");
}

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
    const badges = computeBadges("tool-x", new Set(["tool-x"]), new Set(), new Set(["tool-x"]), new Set(["tool-x"]));
    expect(badges).toEqual(["agent", "global", "project"]);
  });
});

// ─── computeBaseToolSources ──────────────────────────────────────────────────

describe("computeBaseToolSources", () => {
  const allTools = ["read", "bash", "grep", "write"];

  it("uses agentTools from frontmatter when tools are explicitly defined", () => {
    const agent = makeAgentWithTools("mason", ["read", "bash"]);
    const { agentTools, defaultTools } = computeBaseToolSources(agent, makeSettings(), allTools);
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
    const { agentTools, defaultTools } = computeBaseToolSources(agent, makeSettings(), allTools);
    expect(agentTools.size).toBe(0);
    expect([...defaultTools].sort()).toEqual([...allTools].sort());
  });

  it("uses empty agentTools and empty defaultTools for explicit empty frontmatter tools: []", () => {
    const agent = makeAgentWithTools("mason", []);
    const settings = makeSettings({}, ["read", "grep"]);
    const { agentTools, defaultTools } = computeBaseToolSources(agent, settings, allTools);
    expect(agentTools.size).toBe(0);
    expect(defaultTools.size).toBe(0);
  });
});

// ─── computeEffectiveTools ────────────────────────────────────────────────────

describe("computeEffectiveTools", () => {
  it("unions agent, default, global, and project sources", () => {
    const result = computeEffectiveTools(
      new Set(["read"]),
      new Set(),
      new Set(["bash"]),
      new Set(["grep"]),
      new Set(["read", "bash", "grep", "write"]),
    );
    expect(result).toEqual(["bash", "grep", "read"]);
  });

  it("falls back to defaultTools when agentTools is empty (settings toolAllowlist or all tools)", () => {
    const result = computeEffectiveTools(
      new Set(),
      new Set(["read", "write"]),
      new Set(),
      new Set(),
      new Set(["read", "write"]),
    );
    expect(result).toEqual(["read", "write"]);
  });

  it("excludes configured names that are not currently registered", () => {
    const result = computeEffectiveTools(
      new Set(["read"]),
      new Set(),
      new Set(),
      new Set(["ghost_tool"]),
      new Set(["read"]),
    );
    expect(result).toEqual(["read"]);
  });

  it("deduplicates and sorts by tool name", () => {
    const result = computeEffectiveTools(
      new Set(["write", "read"]),
      new Set(),
      new Set(["read"]),
      new Set(["write"]),
      new Set(["read", "write"]),
    );
    expect(result).toEqual(["read", "write"]);
  });

  it("returns an empty list when no source contributes any registered tool", () => {
    const result = computeEffectiveTools(new Set(), new Set(), new Set(), new Set(), new Set(["read"]));
    expect(result).toEqual([]);
  });
});

// ─── queryArmoryProjectTools ──────────────────────────────────────────────────

describe("queryArmoryProjectTools", () => {
  it("returns undefined when Armory never responds", () => {
    const pi = makePi([]);
    expect(queryArmoryProjectTools(pi)).toBeUndefined();
  });

  it("returns [] when Armory responds with an empty array", () => {
    const pi = makePi([], []);
    expect(queryArmoryProjectTools(pi)).toEqual([]);
  });

  it("returns the responded tool names", () => {
    const pi = makePi([], ["run_tests", "run_checks"]);
    expect(queryArmoryProjectTools(pi)).toEqual(["run_tests", "run_checks"]);
  });

  it("is synchronous — result available immediately without awaiting", () => {
    const pi = makePi([], ["a"]);
    const result = queryArmoryProjectTools(pi);
    expect(result).toEqual(["a"]);
  });

  it("first response wins when respond is called more than once", () => {
    const emit = vi.fn((_event: string, payload: { respond(names: string[]): void }) => {
      payload.respond(["first"]);
      payload.respond(["second"]);
    });
    const pi = { getAllTools: () => [], events: { emit } } as unknown as ExtensionAPI;
    expect(queryArmoryProjectTools(pi)).toEqual(["first"]);
  });

  it("does not cache between invocations — reflects the current call's response", () => {
    const pi1 = makePi([], ["a"]);
    expect(queryArmoryProjectTools(pi1)).toEqual(["a"]);
    const pi2 = makePi([], ["b", "c"]);
    expect(queryArmoryProjectTools(pi2)).toEqual(["b", "c"]);
    const pi3 = makePi([]); // absent this time
    expect(queryArmoryProjectTools(pi3)).toBeUndefined();
  });
});

// ─── computeGrantCandidates ───────────────────────────────────────────────────

describe("computeGrantCandidates", () => {
  it("includes a query tool that is registered and has no other source", () => {
    const result = computeGrantCandidates(
      ["run_tests"],
      new Set(["run_tests", "bash"]),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
    );
    expect(result).toEqual(["run_tests"]);
  });

  it("excludes query tools that are not registered in the session", () => {
    const result = computeGrantCandidates(
      ["unregistered_tool"],
      new Set(["bash"]),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("excludes tools already available via agent frontmatter", () => {
    const result = computeGrantCandidates(
      ["run_tests"],
      new Set(["run_tests"]),
      new Set(["run_tests"]),
      new Set(),
      new Set(),
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("excludes tools already available via the default allowlist", () => {
    const result = computeGrantCandidates(
      ["run_tests"],
      new Set(["run_tests"]),
      new Set(),
      new Set(["run_tests"]),
      new Set(),
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("excludes tools already available via global agent grants", () => {
    const result = computeGrantCandidates(
      ["run_tests"],
      new Set(["run_tests"]),
      new Set(),
      new Set(),
      new Set(["run_tests"]),
      new Set(),
    );
    expect(result).toEqual([]);
  });

  it("excludes tools already granted at the project level", () => {
    const result = computeGrantCandidates(
      ["run_tests"],
      new Set(["run_tests"]),
      new Set(),
      new Set(),
      new Set(),
      new Set(["run_tests"]),
    );
    expect(result).toEqual([]);
  });

  it("deduplicates repeated names in the query", () => {
    const result = computeGrantCandidates(
      ["run_tests", "run_tests", "run_checks"],
      new Set(["run_tests", "run_checks"]),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
    );
    expect(result).toEqual(["run_checks", "run_tests"]);
  });

  it("returns an empty list for an empty query", () => {
    const result = computeGrantCandidates([], new Set(["bash"]), new Set(), new Set(), new Set(), new Set());
    expect(result).toEqual([]);
  });
});

// ─── computeRemoveCandidates ──────────────────────────────────────────────────

describe("computeRemoveCandidates", () => {
  it("returns every current project grant", () => {
    expect(computeRemoveCandidates(["a", "b"])).toEqual(["a", "b"]);
  });

  it("includes names unregistered/unknown in this session", () => {
    expect(computeRemoveCandidates(["future-armory-tool"])).toEqual(["future-armory-tool"]);
  });

  it("deduplicates repeated names", () => {
    expect(computeRemoveCandidates(["a", "a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty for no project grants", () => {
    expect(computeRemoveCandidates([])).toEqual([]);
  });
});

// ─── computeGrantResult / computeRevokeResult ────────────────────────────────

describe("computeGrantResult", () => {
  it("adds the tool to the write list", () => {
    expect(computeGrantResult("tool-a", new Set())).toEqual(["tool-a"]);
  });

  it("keeps existing project tools, including unregistered ones", () => {
    const result = computeGrantResult("tool-b", new Set(["tool-a", "future-tool"]));
    expect(result).toEqual(expect.arrayContaining(["tool-a", "future-tool", "tool-b"]));
  });

  it("does not duplicate when tool is already present", () => {
    const result = computeGrantResult("tool-a", new Set(["tool-a"]));
    expect(result.filter((t) => t === "tool-a")).toHaveLength(1);
  });

  it("does not mutate the input set", () => {
    const set = new Set(["tool-a"]);
    computeGrantResult("tool-b", set);
    expect(set.has("tool-b")).toBe(false);
  });
});

describe("computeRevokeResult", () => {
  it("removes the tool from the write list", () => {
    expect(computeRevokeResult("tool-a", new Set(["tool-a"]))).toEqual([]);
  });

  it("keeps other project tools, including unregistered ones", () => {
    const result = computeRevokeResult("tool-a", new Set(["tool-a", "tool-b", "future-tool"]));
    expect(result).not.toContain("tool-a");
    expect(result).toEqual(expect.arrayContaining(["tool-b", "future-tool"]));
  });

  it("does not mutate the input set", () => {
    const set = new Set(["tool-a"]);
    computeRevokeResult("tool-a", set);
    expect(set.has("tool-a")).toBe(true);
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

  it("returns null for a non-matching subcommand prefix", () => {
    expect(completions("x")).toBeNull();
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

  it("shows usage dialog for empty args (no subcommand)", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Usage");
  });

  it("shows usage dialog for an unknown subcommand", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("list", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Usage");
  });

  it("shows an 'unknown agent' dialog for an unknown agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools sentinel", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Unknown agent");
  });

  it("shows usage dialog for extra arguments after agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason extra", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Usage");
  });

  it("returns immediately without any dialogs, Armory emit, or config side effects when hasUI is false", async () => {
    const pi = makePi(["bash"], []);
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, ["Grant project tools", ["bash"], "Done"], false);
    await cmd.handler("tools mason", ctx);
    expect(custom).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("in RPC mode (ctx.ui.custom degrades to undefined), returns without querying Armory or mutating config", async () => {
    const pi = makePi(["bash"], []);
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeRpcCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("exits immediately with no dialog, Armory emit, or config side effects when ctx.mode is a non-tui value, even though hasUI is true", async () => {
    const pi = makePi(["bash"], []);
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, ["Grant project tools", ["bash"], "Done"], true, "rpc");
    await cmd.handler("tools mason", ctx);
    expect(custom).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("exits immediately when ctx.mode is 'print', even though hasUI is true", async () => {
    const pi = makePi(["bash"], []);
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, [], true, "print");
    await cmd.handler("tools mason", ctx);
    expect(custom).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when ctx.mode is 'tui'", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, ["Done"], true, "tui");
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Project tool grants for agent: mason");
  });
});

// ─── handler: agent selection (omitted agent name) ───────────────────────────────

describe("handler: agent selection (omitted agent name)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-select-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows a sorted agent selector when the agent name is omitted", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("sentinel", "mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["mason", "Done"]);
    await cmd.handler("tools", ctx);
    const first = text(rendered[0]);
    expect(first).toContain("Select an agent");
    expect(first.indexOf("mason")).toBeLessThan(first.indexOf("sentinel"));
  });

  it("proceeds to the selected agent's menu", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("sentinel", "mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["mason", "Done"]);
    await cmd.handler("tools", ctx);
    expect(text(rendered[1])).toContain("Project tool grants for agent: mason");
  });

  it("exits without further dialogs when the agent selector is cancelled", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("sentinel", "mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("shows a standard dialog and exits when no agents are discovered", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), [], makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("No agents discovered");
  });

  it("bypasses the selector and goes directly to the menu when an explicit known agent name is given", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("sentinel", "mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Project tool grants for agent: mason");
  });

  it("an unknown explicit agent name remains a visible error, not the selector", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools ghost", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Unknown agent");
  });

  it("shows the standard unknown-agent error and stops, without throwing, when the selector returns a name not offered", async () => {
    const pi = makePi(["bash"], []);
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const cmd = createImpsCommand(pi, makeAgents("sentinel", "mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, ["ghost"]);
    await expect(cmd.handler("tools", ctx)).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledTimes(2);
    expect(text(rendered[0])).toContain("Select an agent");
    expect(text(rendered[1])).toContain('Unknown agent: "ghost"');
    expect(pi.events.emit).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ─── handler: malformed project config ──────────────────────────────────────

describe("handler: malformed project config", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-cfg-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows a dialog and does not enter the action loop when .pi/imps.json is a directory (EISDIR)", async () => {
    mkdirSync(join(piDir, "imps.json"), { recursive: true });
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Cannot read project config");
  });

  it("shows a dialog for non-object root config", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify([1, 2, 3]));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(text(rendered[0])).toContain("Cannot read project config");
  });

  it("shows a dialog for malformed JSON, and never overwrites the file", async () => {
    const configPath = join(piDir, "imps.json");
    writeFileSync(configPath, "not-json");
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(text(rendered[0])).toContain("Cannot read project config");
    // File left untouched.
    expect(readFileSync(configPath, "utf-8")).toBe("not-json");
  });

  it("shows a dialog and does not enter the action loop when project config has a non-object 'agents' field", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: "bad" }));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Cannot read project config");
  });

  it("shows a dialog and does not enter the action loop when the selected agent's config entry is not an object", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: "bad" } }));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, custom, rendered } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(text(rendered[0])).toContain("Cannot read project config");
  });
});

// ─── handler: Armory query messaging (Grant action only) ────────────────────

describe("handler: Armory query messaging (Grant action only)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-armory-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not emit the Armory event before an action is chosen", async () => {
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("does not emit the Armory event for List granted tools", async () => {
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx } = makeCtx(tmpDir, ["List granted tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("does not emit the Armory event for Remove project grants", async () => {
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("shows an 'unavailable' dialog when Armory never responds to a Grant selection", async () => {
    const pi = makePi(["bash"]);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(text(rendered[1])).toContain("unavailable");
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
  });

  it("shows a distinct 'no configured tools' dialog when Armory responds with [] to a Grant selection", async () => {
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(text(rendered[1])).toContain("no configured tools");
  });

  it("the 'unavailable' and 'empty' messages are distinct", async () => {
    const cmdAbsent = createImpsCommand(makePi(["bash"]), makeAgents("mason"), makeSettings());
    const { ctx: ctxAbsent, rendered: renderedAbsent } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmdAbsent.handler("tools mason", ctxAbsent);

    const cmdEmpty = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx: ctxEmpty, rendered: renderedEmpty } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmdEmpty.handler("tools mason", ctxEmpty);

    expect(text(renderedAbsent[1])).not.toEqual(text(renderedEmpty[1]));
  });

  it("does not show a query-state dialog when Armory responds with tool names", async () => {
    const cmd = createImpsCommand(makePi(["bash", "run_tests"], ["run_tests"]), makeAgents("mason"), makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    // Second dialog is not an Armory-availability message (run_tests is already covered by
    // the default allowlist here, so it falls through to the "no candidates" dialog instead).
    const secondMessage = text(rendered[1]);
    expect(secondMessage).not.toContain("unavailable");
    expect(secondMessage).not.toContain("no configured tools");
    expect(secondMessage).toContain("No project tools are available to grant");
  });

  it("queries fresh on each Grant selection, reflecting the latest response", async () => {
    const emit = vi.fn();
    emit.mockImplementationOnce(() => {
      // First Grant: Armory absent — no respond call.
    });
    emit.mockImplementationOnce((_event: string, payload: { respond(names: string[]): void }) => {
      // Second Grant: Armory now responds.
      payload.respond(["run_tests"]);
    });
    const pi = {
      getAllTools: () => [{ name: "run_tests", description: "", parameters: {} }],
      events: { emit },
    } as unknown as ExtensionAPI;
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings({}, []));
    const { ctx, rendered } = makeCtx(tmpDir, [
      "Grant project tools",
      undefined,
      "Grant project tools",
      ["run_tests"],
      "Done",
    ]);

    await cmd.handler("tools mason", ctx);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(text(rendered[1])).toContain("unavailable");
    expect(text(rendered[3])).toContain("run_tests");

    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["run_tests"]);
  });
});

// ─── handler: List granted tools ────────────────────────────────────────────

describe("handler: List granted tools", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-list-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists every registered tool the agent would receive, sorted, with source badges", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["run_tests"] } } }));
    const agents: AgentConfig[] = [makeAgentWithTools("mason", ["bash"])];
    const settings = makeSettings({ mason: ["grep"] });
    const pi = makePi(["bash", "grep", "run_tests"]);
    const cmd = createImpsCommand(pi, agents, settings);
    const { ctx, rendered } = makeCtx(tmpDir, ["List granted tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    const listMessage = text(rendered[1]);
    expect(listMessage).toContain("bash (agent)");
    expect(listMessage).toContain("grep (global)");
    expect(listMessage).toContain("run_tests (project)");
  });

  it("excludes configured names that are not currently registered", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["ghost_tool"] } } }));
    const agents = makeAgents("mason");
    const pi = makePi(["bash"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, ["bash"]));
    const { ctx, rendered } = makeCtx(tmpDir, ["List granted tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    const listMessage = text(rendered[1]);
    expect(listMessage).not.toContain("ghost_tool");
    expect(listMessage).toContain("bash");
  });

  it("shows a concise empty state when no tools would be granted", async () => {
    const agents: AgentConfig[] = [makeAgentWithTools("mason", [])];
    const pi = makePi(["bash"]);
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["List granted tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(text(rendered[1])).toContain("No tools would be granted");
  });

  it("does not emit the Armory event", async () => {
    const pi = makePi(["bash"]);
    const cmd = createImpsCommand(pi, makeAgents("mason"), makeSettings());
    const { ctx } = makeCtx(tmpDir, ["List granted tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(pi.events.emit).not.toHaveBeenCalled();
  });
});

// ─── handler: grant flow ─────────────────────────────────────────────────────

describe("handler: grant flow", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-grant-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("presents only tools not already available from any source, deduplicated, as a searchable multi-select", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["already_project"] } } }));
    const agents: AgentConfig[] = [makeAgentWithTools("mason", ["already_agent"])];
    const settings = makeSettings({ mason: ["already_global"] });
    const pi = makePi(
      ["already_agent", "already_global", "already_project", "run_tests", "run_tests", "unregistered_missing"],
      ["already_agent", "already_global", "already_project", "run_tests", "run_tests"],
    );
    const cmd = createImpsCommand(pi, agents, settings);
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    const grantScreen = text(rendered[1]);
    expect(grantScreen).toContain("run_tests");
    expect(grantScreen).not.toContain("already_agent");
    expect(grantScreen).not.toContain("already_global");
    expect(grantScreen).not.toContain("already_project");
    expect(grantScreen).not.toContain("unregistered_missing");
  });

  it("applies selected grants together with a single config write and returns to the action loop", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests", "run_checks"], ["run_tests", "run_checks"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, [])); // empty allowlist: nothing already available by default
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", ["run_tests", "run_checks"], "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools?.sort()).toEqual(["run_checks", "run_tests"]);
    // Loop continued: main menu was shown again (twice total — before and after the grant).
    const mainMenuScreens = rendered.filter((lines) => text(lines).includes("Project tool grants for agent: mason"));
    expect(mainMenuScreens.length).toBe(2);
  });

  it("shows a dialog and does not grant when there are no candidates", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["bash"], ["bash"]);
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(rendered.some((lines) => text(lines).includes("No project tools are available to grant."))).toBe(true);
  });

  it("cancelling the multi-select (undefined) returns to the main menu without persisting", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests"], ["run_tests"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const { ctx } = makeCtx(tmpDir, ["Grant project tools", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
  });

  it("applying with an empty selection persists nothing", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests"], ["run_tests"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx } = makeCtx(tmpDir, ["Grant project tools", [], "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ─── handler: remove flow ────────────────────────────────────────────────────

describe("handler: remove flow", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-remove-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes a stale/unregistered project grant as a remove candidate", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["stale_unregistered"] } } }));
    const agents = makeAgents("mason");
    const pi = makePi(["bash"], []); // stale_unregistered no longer registered/in query
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Remove project grants", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(text(rendered[1])).toContain("stale_unregistered");
  });

  it("shows remaining sources for a multi-source tool and removes only the project source", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["bash"] } } }));
    const agents = makeAgents("mason");
    const settings = makeSettings({ mason: ["bash"] }, []); // bash also globally granted; empty allowlist avoids a default badge
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, agents, settings);
    const { ctx, rendered } = makeCtx(tmpDir, ["Remove project grants", ["bash"], "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(text(rendered[1])).toContain("bash (still available via: global)");
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
  });

  it("applies selected removals together with a single config write", async () => {
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({ agents: { mason: { tools: ["run_tests", "run_checks"] } } }),
    );
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests", "run_checks"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", ["run_tests", "run_checks"], "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
  });

  it("removing a project grant preserves other agents' config and unrelated top-level keys", async () => {
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({
        someUnrelatedKey: "keep-me",
        agents: {
          mason: { tools: ["run_tests"], someExtraField: "keep-too" },
          sentinel: { tools: ["run_checks"] },
        },
      }),
    );
    const agents = makeAgents("mason", "sentinel");
    const pi = makePi(["run_tests"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, [])); // empty allowlist avoids a default badge on run_tests
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", ["run_tests"], "Done"]);
    await cmd.handler("tools mason", ctx);

    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
    expect(config.agents?.sentinel?.tools).toEqual(["run_checks"]);
    const raw = JSON.parse(readFileSync(join(piDir, "imps.json"), "utf-8"));
    expect(raw.someUnrelatedKey).toBe("keep-me");
    expect(raw.agents.mason.someExtraField).toBe("keep-too");
  });

  it("shows a dialog and does not open a picker when there are no project grants", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx, rendered } = makeCtx(tmpDir, ["Remove project grants", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(rendered.some((lines) => text(lines).includes("No project grants to remove."))).toBe(true);
  });

  it("cancelling the multi-select (undefined) removes nothing", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["bash"] } } }));
    const agents = makeAgents("mason");
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["bash"]);
  });
});

// ─── handler: real multiSelectTools key-driven interaction ─────────────────

describe("handler: real multiSelectTools key-driven interaction", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-keys-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("grant: Space toggles multiple rows and Ctrl+S applies them with a single config write", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["a_tool", "b_tool"], ["a_tool", "b_tool"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    // Candidates sorted: ["a_tool", "b_tool"]. Space toggles a_tool selected, down
    // moves to b_tool, space toggles it selected too, ctrl+s applies both.
    const { ctx } = makeCtx(tmpDir, ["Grant project tools", driveKeys(" ", "\x1b[B", " ", "\x13"), "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools?.sort()).toEqual(["a_tool", "b_tool"]);
  });

  it("grant: Enter also toggles a row (not just Space)", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["a_tool"], ["a_tool"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const { ctx } = makeCtx(tmpDir, ["Grant project tools", driveKeys("\r", "\x13"), "Done"]);
    await cmd.handler("tools mason", ctx);

    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["a_tool"]);
  });

  it("grant: Escape cancels after a pending toggle, with no config write", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["a_tool"], ["a_tool"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx } = makeCtx(tmpDir, ["Grant project tools", driveKeys(" ", "\x1b"), "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).not.toHaveBeenCalled();
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
  });

  it("remove: Space toggles multiple rows and Ctrl+S applies them with a single config write", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["a_tool", "b_tool"] } } }));
    const agents = makeAgents("mason");
    const pi = makePi(["a_tool", "b_tool"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", driveKeys(" ", "\x1b[B", " ", "\x13"), "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
  });

  it("remove: Escape cancels after a pending toggle, with no config write", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["a_tool"] } } }));
    const agents = makeAgents("mason");
    const pi = makePi(["a_tool"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const updateSpy = vi.spyOn(settingsModule, "updateProjectAgentTools");
    const { ctx } = makeCtx(tmpDir, ["Remove project grants", driveKeys(" ", "\x1b"), "Done"]);
    await cmd.handler("tools mason", ctx);

    expect(updateSpy).not.toHaveBeenCalled();
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["a_tool"]);
  });
});

// ─── handler: cancellation / Done ────────────────────────────────────────────

describe("handler: cancellation and Done", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-done-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits the loop when 'Done' is selected", async () => {
    const cmd = createImpsCommand(makePi(["bash"], ["bash"]), makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("exits the loop when the main menu selection is cancelled (undefined)", async () => {
    const cmd = createImpsCommand(makePi(["bash"], ["bash"]), makeAgents("mason"), makeSettings());
    const { ctx, custom } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
  });
});

// ─── handler: write failures ─────────────────────────────────────────────────

describe("handler: write failures", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-writefail-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("shows a dialog on grant persistence failure and keeps the loop open", async () => {
    vi.spyOn(settingsModule, "updateProjectAgentTools").mockImplementation(() => {
      throw new Error("disk full");
    });
    const cmd = createImpsCommand(makePi(["run_tests"], ["run_tests"]), makeAgents("mason"), makeSettings({}, []));
    const { ctx, rendered } = makeCtx(tmpDir, ["Grant project tools", ["run_tests"], "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(rendered.some((lines) => text(lines).includes("Failed to update project config: disk full"))).toBe(true);
  });

  it("shows a dialog on revoke persistence failure and keeps the loop open", async () => {
    writeFileSync(join(tmpDir, ".pi", "imps.json"), JSON.stringify({ agents: { mason: { tools: ["bash"] } } }));
    vi.spyOn(settingsModule, "updateProjectAgentTools").mockImplementation(() => {
      throw new Error("disk full");
    });
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings({}, []));
    const { ctx, rendered } = makeCtx(tmpDir, ["Remove project grants", ["bash"], "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(rendered.some((lines) => text(lines).includes("Failed to update project config: disk full"))).toBe(true);
  });
});

// ─── TUI-only, custom-picker implementation ─────────────────────────────────

describe("interactive-TUI-only implementation", () => {
  it("gates non-TUI modes on ctx.mode when present, falling back to ctx.hasUI", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(__dirname, "../src/command.ts"), "utf-8");
    expect(source).toContain('mode !== "tui"');
    expect(source).toContain("ctx.hasUI");
  });

  it("builds Grant/Remove pickers as searchable multi-selects from pi-tui primitives", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(__dirname, "../src/command.ts"), "utf-8");
    expect(source).toContain("@earendil-works/pi-tui");
    expect(source).toContain("SettingsList");
    expect(source).toContain("enableSearch: true");
    expect(source).toContain("ctx.ui.custom");
  });
});
