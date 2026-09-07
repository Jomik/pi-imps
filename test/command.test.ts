import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBadges,
  computeBaseToolSources,
  computeGrantCandidates,
  computeGrantResult,
  computeRemoveCandidates,
  computeRevokeResult,
  createImpsCommand,
  queryArmoryProjectTools,
} from "../src/command.js";
import * as settingsModule from "../src/settings.js";
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

/** Create a minimal ExtensionCommandContext mock with scriptable ui.select. */
function makeCtx(cwd: string, selectResponses: (string | undefined)[] = []) {
  const notify = vi.fn();
  const responses = [...selectResponses];
  const select = vi.fn(async (_title: string, _options: string[]) => responses.shift());
  const ctx = { cwd, ui: { notify, select } } as unknown as ExtensionCommandContext;
  return { ctx, notify, select };
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
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Usage"), ["OK"]);
  });

  it("shows usage dialog for an unknown subcommand", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("list", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Usage"), ["OK"]);
  });

  it("shows usage dialog for 'tools' without an agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Usage"), ["OK"]);
  });

  it("shows an 'unknown agent' dialog for an unknown agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools sentinel", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"), ["OK"]);
  });

  it("shows usage dialog for extra arguments after agent name", async () => {
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools mason extra", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Usage"), ["OK"]);
  });

  it("works with an RPC-style context (no TUI mode guard) — reaches the select-based loop", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalled();
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

  it("shows a select dialog and does not enter the action loop when .pi/imps.json is a directory (EISDIR)", async () => {
    mkdirSync(join(piDir, "imps.json"), { recursive: true });
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), ["OK"]);
  });

  it("shows a select dialog for non-object root config", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify([1, 2, 3]));
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), ["OK"]);
  });

  it("shows a select dialog for malformed JSON, and never overwrites the file", async () => {
    const configPath = join(piDir, "imps.json");
    writeFileSync(configPath, "not-json");
    const cmd = createImpsCommand(makePi([]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalledWith(expect.stringContaining("Cannot read project config"), ["OK"]);
    // File left untouched.
    expect(readFileSync(configPath, "utf-8")).toBe("not-json");
  });
});

// ─── handler: Armory query messaging ────────────────────────────────────────

describe("handler: Armory query messaging", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-armory-"));
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows an 'unavailable' dialog when Armory never responds", async () => {
    const cmd = createImpsCommand(makePi(["bash"]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls[0]).toEqual([expect.stringContaining("unavailable"), ["OK"]]);
  });

  it("shows a distinct 'no configured tools' dialog when Armory responds with []", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls[0]).toEqual([expect.stringContaining("no configured tools"), ["OK"]]);
  });

  it("the 'unavailable' and 'empty' messages are distinct", async () => {
    const cmdAbsent = createImpsCommand(makePi(["bash"]), makeAgents("mason"), makeSettings());
    const { ctx: ctxAbsent, select: selectAbsent } = makeCtx(tmpDir, ["Done"]);
    await cmdAbsent.handler("tools mason", ctxAbsent);

    const cmdEmpty = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx: ctxEmpty, select: selectEmpty } = makeCtx(tmpDir, ["Done"]);
    await cmdEmpty.handler("tools mason", ctxEmpty);

    const absentMsg = selectAbsent.mock.calls[0][0];
    const emptyMsg = selectEmpty.mock.calls[0][0];
    expect(absentMsg).not.toEqual(emptyMsg);
  });

  it("does not show a query-state dialog when Armory responds with tool names", async () => {
    const cmd = createImpsCommand(makePi(["bash", "run_tests"], ["run_tests"]), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    // First call is the main action menu, not a message dialog.
    expect(select.mock.calls[0]).toEqual([expect.stringContaining("Project tool grants for agent"), expect.any(Array)]);
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

  it("presents only tools not already available from any source, deduplicated", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["already_project"] } } }));
    const agents: AgentConfig[] = [makeAgentWithTools("mason", ["already_agent"])];
    const settings = makeSettings({ mason: ["already_global"] });
    const pi = makePi(
      ["already_agent", "already_global", "already_project", "run_tests", "run_tests", "unregistered_missing"],
      ["already_agent", "already_global", "already_project", "run_tests", "run_tests"],
    );
    const cmd = createImpsCommand(pi, agents, settings);
    const { ctx, select } = makeCtx(tmpDir, ["Grant project tool", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    const grantCall = select.mock.calls.find((c) => c[0] === "Select a tool to grant");
    expect(grantCall).toBeDefined();
    expect(grantCall?.[1]).toEqual(["run_tests"]);
  });

  it("persists a granted tool immediately and returns to the action loop", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests"], ["run_tests"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, [])); // empty allowlist: run_tests not already available by default
    const { ctx, select } = makeCtx(tmpDir, ["Grant project tool", "run_tests", "Done"]);
    await cmd.handler("tools mason", ctx);

    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["run_tests"]);
    // Loop continued: main menu was shown again (twice total — before and after the grant).
    const mainMenuCalls = select.mock.calls.filter((c) => c[0] === "Project tool grants for agent: mason");
    expect(mainMenuCalls.length).toBe(2);
  });

  it("shows a dialog and does not grant when there are no candidates", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, agents, makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Grant project tool", "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls.some((c) => c[0] === "No project tools are available to grant.")).toBe(true);
  });

  it("cancelling the tool pick (undefined) returns to the main menu without persisting", async () => {
    const agents = makeAgents("mason");
    const pi = makePi(["run_tests"], ["run_tests"]);
    const cmd = createImpsCommand(pi, agents, makeSettings({}, []));
    const { ctx } = makeCtx(tmpDir, ["Grant project tool", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);
    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
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
    const { ctx, select } = makeCtx(tmpDir, ["Remove project grant", undefined, "Done"]);
    await cmd.handler("tools mason", ctx);

    const removeCall = select.mock.calls.find((c) => c[0] === "Select a project grant to remove");
    expect(removeCall?.[1]).toEqual(["stale_unregistered"]);
  });

  it("shows remaining sources for a multi-source tool and removes only the project source", async () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["bash"] } } }));
    const agents = makeAgents("mason");
    const settings = makeSettings({ mason: ["bash"] }, []); // bash also globally granted; empty allowlist avoids a default badge
    const pi = makePi(["bash"], []);
    const cmd = createImpsCommand(pi, agents, settings);
    const { ctx, select } = makeCtx(tmpDir, ["Remove project grant", "bash (still available via: global)", "Done"]);
    await cmd.handler("tools mason", ctx);

    const config = settingsModule.loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools ?? []).toEqual([]);
    const removeCall = select.mock.calls.find((c) => c[0] === "Select a project grant to remove");
    expect(removeCall?.[1]).toEqual(["bash (still available via: global)"]);
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
    const { ctx } = makeCtx(tmpDir, ["Remove project grant", "run_tests", "Done"]);
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
    const { ctx, select } = makeCtx(tmpDir, ["Remove project grant", "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls.some((c) => c[0] === "No project grants to remove.")).toBe(true);
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
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, ["Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("exits the loop when the main menu selection is cancelled (undefined)", async () => {
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings());
    const { ctx, select } = makeCtx(tmpDir, [undefined]);
    await cmd.handler("tools mason", ctx);
    expect(select).toHaveBeenCalledTimes(1);
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

  it("shows a select dialog on grant persistence failure and keeps the loop open", async () => {
    vi.spyOn(settingsModule, "updateProjectAgentTools").mockImplementation(() => {
      throw new Error("disk full");
    });
    const cmd = createImpsCommand(makePi(["run_tests"], ["run_tests"]), makeAgents("mason"), makeSettings({}, []));
    const { ctx, select } = makeCtx(tmpDir, ["Grant project tool", "run_tests", "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls.some((c) => c[0] === "Failed to update project config: disk full")).toBe(true);
  });

  it("shows a select dialog on revoke persistence failure and keeps the loop open", async () => {
    writeFileSync(join(tmpDir, ".pi", "imps.json"), JSON.stringify({ agents: { mason: { tools: ["bash"] } } }));
    vi.spyOn(settingsModule, "updateProjectAgentTools").mockImplementation(() => {
      throw new Error("disk full");
    });
    const cmd = createImpsCommand(makePi(["bash"], []), makeAgents("mason"), makeSettings({}, []));
    const { ctx, select } = makeCtx(tmpDir, ["Remove project grant", "bash", "Done"]);
    await cmd.handler("tools mason", ctx);
    expect(select.mock.calls.some((c) => c[0] === "Failed to update project config: disk full")).toBe(true);
  });
});

// ─── no custom TUI code remains ──────────────────────────────────────────────

describe("no custom TUI picker code remains", () => {
  it("command.ts does not reference ctx.ui.custom or the removed picker class", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(__dirname, "../src/command.ts"), "utf-8");
    expect(source).not.toContain("ui.custom");
    expect(source).not.toContain("TwoPaneToolPicker");
    expect(source).not.toContain("pi-tui");
  });
});
