import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Extension, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ImpSettings } from "../src/types.js";

// ─── Controllable DefaultResourceLoader mock ──────────────────────────────
//
// Mirrors the real loader's extensionsOverride contract closely enough to
// exercise selectImpExtensions through buildImpResourceLoader, without any
// real extension discovery I/O.

let mockExtensions: Extension[] = [];

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...real,
    DefaultResourceLoader: class {
      private opts: {
        extensionsOverride?: (base: { extensions: Extension[] }) => { extensions: Extension[] };
      };
      constructor(opts: typeof this.opts) {
        this.opts = opts;
      }
      async reload() {}
      getExtensions() {
        const base = { extensions: mockExtensions, errors: [], runtime: {} };
        return this.opts.extensionsOverride ? this.opts.extensionsOverride(base) : base;
      }
    },
  };
});

const { prepareOrcaLaunch, buildOrcaLaunchArgv, buildOrcaCommand, posixQuote } = await import("../src/orca-launch.js");

// ─── helpers ───────────────────────────────────────────────────────────────

function makeExt(name: string, toolNames: string[], resolvedPath?: string): Extension {
  const tools = new Map<string, unknown>();
  for (const t of toolNames) tools.set(t, {});
  const path = resolvedPath ?? `/fake/extensions/${name}/src/index.ts`;
  return {
    path,
    resolvedPath: path,
    sourceInfo: {
      path,
      source: `npm:${name}@1.0.0`,
      scope: "user",
      origin: "package",
      baseDir: `/fake/node_modules/${name}`,
    },
    handlers: new Map(),
    tools: tools as Extension["tools"],
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}

/**
 * Like `makeExt`, but backs the extension with a real on-disk package
 * directory (under the test's temp `cwd`) so `getExtensionPackageName`'s
 * `package.json` walk actually resolves `name`. Needed for any extension
 * whose selection depends on name matching (e.g. `additionalExtensions`).
 */
function makeRealExt(cwd: string, name: string, toolNames: string[]): Extension {
  const pkgDir = join(cwd, "node_modules", name);
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name }));
  const path = join(pkgDir, "src", "index.ts");
  writeFileSync(path, "export default () => {}");
  return makeExt(name, toolNames, path);
}

function makeModel(id: string, provider: string): Model<Api> {
  return { id, name: id, provider, api: "anthropic-messages" } as unknown as Model<Api>;
}

function makeModelRegistry(models: Model<Api>[]): ModelRegistry {
  return { getAvailable: () => models } as unknown as ModelRegistry;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "coder",
    description: "Test agent",
    systemPrompt: "You are a coder.",
    source: "user",
    filePath: "/tmp/coder.md",
    ...overrides,
  };
}

function makeSettings(overrides: Partial<ImpSettings> = {}): ImpSettings {
  return {
    turnLimit: 30,
    toolAllowlist: undefined,
    additionalExtensions: [],
    agents: {},
    orca: { enabled: true },
    ...overrides,
  };
}

describe("posixQuote", () => {
  it("wraps a plain token in single quotes", () => {
    expect(posixQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded spaces safely (no escaping needed inside single quotes)", () => {
    expect(posixQuote("hello world")).toBe("'hello world'");
  });

  it("escapes newlines safely inside single quotes", () => {
    expect(posixQuote("line1\nline2")).toBe("'line1\nline2'");
  });

  it("escapes embedded single quotes using the '\\'' pattern", () => {
    expect(posixQuote("it's")).toBe("'it'\\''s'");
  });

  it("escapes shell metacharacters safely (no interpretation inside single quotes)", () => {
    expect(posixQuote("$(rm -rf /); echo `pwned` && true | false > out")).toBe(
      "'$(rm -rf /); echo `pwned` && true | false > out'",
    );
  });

  it("rejects a token containing a NUL byte", () => {
    expect(() => posixQuote("bad\0token")).toThrow(/NUL/);
  });
});

describe("buildOrcaCommand", () => {
  it("quotes every token including the program name", () => {
    expect(buildOrcaCommand(["pi", "--flag", "value with space"])).toBe("'pi' '--flag' 'value with space'");
  });
});

describe("buildOrcaLaunchArgv", () => {
  const base = {
    workerEntrypoint: "/abs/pi-imps/src/index.ts",
    extensionPaths: ["/abs/ext-a/src/index.ts", "/abs/ext-b/src/index.ts"],
    turnLimit: 30,
    modelId: "anthropic/claude-3",
    thinkingLevel: "high",
    systemPrompt: "You are a coder.",
  };

  it("builds exact tokens/ordering with a defined tool allowlist (unions agent_done)", () => {
    const argv = buildOrcaLaunchArgv({ ...base, toolAllowlist: ["read", "edit"] });
    expect(argv).toEqual([
      "pi",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-e",
      "/abs/pi-imps/src/index.ts",
      "-e",
      "/abs/ext-a/src/index.ts",
      "-e",
      "/abs/ext-b/src/index.ts",
      "--is-imp",
      "--imp-turn-limit",
      "30",
      "--model",
      "anthropic/claude-3",
      "--thinking",
      "high",
      "--system-prompt",
      "You are a coder.",
      "--tools",
      "read,edit,agent_done",
    ]);
  });

  it("does not duplicate agent_done when already present in the allowlist", () => {
    const argv = buildOrcaLaunchArgv({ ...base, toolAllowlist: ["read", "agent_done"] });
    expect(argv.at(-1)).toBe("read,agent_done");
  });

  it("omits --tools entirely when the allowlist is undefined (all tools)", () => {
    const argv = buildOrcaLaunchArgv({ ...base, toolAllowlist: undefined });
    expect(argv).not.toContain("--tools");
    expect(argv.at(-1)).toBe("You are a coder.");
  });
});

describe("prepareOrcaLaunch", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-imps-orca-launch-"));
    mockExtensions = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const parentModel = makeModel("claude-3", "anthropic");

  function makeExec(overrides?: {
    statusOk?: boolean;
    statusExit?: number;
    statusStdout?: string;
    worktreeOk?: boolean;
    worktreeExit?: number;
    worktreeStdout?: string;
  }) {
    return vi.fn(async (command: string, args: string[], _options?: { signal?: AbortSignal }) => {
      expect(command).toBe("orca");
      if (args[0] === "status") {
        if (overrides?.statusStdout !== undefined) {
          return { stdout: overrides.statusStdout, stderr: "", code: overrides.statusExit ?? 0 };
        }
        return {
          stdout: JSON.stringify({ ok: overrides?.statusOk ?? true }),
          stderr: "",
          code: overrides?.statusExit ?? 0,
        };
      }
      if (args[0] === "worktree") {
        if (overrides?.worktreeStdout !== undefined) {
          return { stdout: overrides.worktreeStdout, stderr: "", code: overrides.worktreeExit ?? 0 };
        }
        return {
          stdout: JSON.stringify({ ok: overrides?.worktreeOk ?? true }),
          stderr: "",
          code: overrides?.worktreeExit ?? 0,
        };
      }
      throw new Error(`unexpected orca command: ${args.join(" ")}`);
    });
  }

  // ── platform gate ─────────────────────────────────────────────────────

  it("rejects an unsupported platform without running any Orca check", async () => {
    const exec = makeExec();
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "win32",
      }),
    ).rejects.toThrow(/POSIX platform/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("accepts darwin and linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const exec = makeExec();
      const plan = await prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform,
      });
      expect(plan.command).toContain("--is-imp");
    }
  });

  // ── Orca prerequisite checks ──────────────────────────────────────────

  it("fails explicitly when orca status is unavailable (non-zero exit)", async () => {
    const exec = makeExec({ statusExit: 1, statusStdout: "orca: command not found" });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/status check failed \(exit 1\).*command not found/s);
  });

  it("fails explicitly when there is no current worktree", async () => {
    const exec = makeExec({ worktreeExit: 1, worktreeStdout: "no current worktree" });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/current worktree check failed \(exit 1\).*no current worktree/s);
  });

  it("fails explicitly on malformed (non-JSON) status output", async () => {
    const exec = makeExec({ statusStdout: "not-json" });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/status check returned malformed JSON/);
  });

  it("fails explicitly on a non-ok status JSON body", async () => {
    const exec = makeExec({ statusOk: false });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/status check reported a non-ok status/);
  });

  // ── model resolution ──────────────────────────────────────────────────

  it("uses the parent model when the agent has no model override", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "high",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });
    expect(plan.modelId).toBe("anthropic/claude-3");
  });

  it("uses the agent's configured model when present, formatted as provider/id", async () => {
    const gpt4 = makeModel("gpt-4", "openai");
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ model: "gpt-4" }),
      parentModel,
      parentThinkingLevel: "high",
      modelRegistry: makeModelRegistry([parentModel, gpt4]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });
    expect(plan.modelId).toBe("openai/gpt-4");
  });

  it("fails when the agent's configured model is not found in the registry", async () => {
    const exec = makeExec();
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent({ model: "nonexistent" }),
        parentModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/not found in registry/);
  });

  it("fails when the resolved model has no provider or id", async () => {
    const brokenModel = { id: "", name: "broken", provider: "" } as unknown as Model<Api>;
    const exec = makeExec();
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel: brokenModel,
        parentThinkingLevel: "high",
        modelRegistry: makeModelRegistry([brokenModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      }),
    ).rejects.toThrow(/missing a provider or id/);
  });

  // ── thinking level ────────────────────────────────────────────────────

  it("inherits the parent thinking level when the agent has none", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });
    expect(plan.thinkingLevel).toBe("low");
  });

  it("agent thinking level overrides the parent", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ thinking: "high" }),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });
    expect(plan.thinkingLevel).toBe("high");
  });

  it("maps the host-only max thinking level to xhigh", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ thinking: "max" }),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });
    expect(plan.thinkingLevel).toBe("xhigh");
  });

  // ── turn limit ─────────────────────────────────────────────────────────

  it("uses the settings turn limit when the agent has none", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings({ turnLimit: 40 }),
      exec,
      platform: "linux",
    });
    expect(plan.turnLimit).toBe(40);
  });

  it("agent turn limit overrides settings", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ turnLimit: 5 }),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings({ turnLimit: 40 }),
      exec,
      platform: "linux",
    });
    expect(plan.turnLimit).toBe(5);
  });

  // ── tools + extensions ────────────────────────────────────────────────

  it("resolves global+project additive tools and selects extensions/paths accordingly", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "imps.json"), JSON.stringify({ agents: { coder: { tools: ["run_tests"] } } }));

    const impsExt = makeExt("pi-imps", ["summon", "wait"], "/fake/pi-imps/src/index.ts");
    const readExt = makeExt("pi-read", ["read"]);
    const testsExt = makeExt("pi-tests", ["run_tests"]);
    const sandboxExt = makeRealExt(cwd, "pi-sandbox", ["sandbox_check"]);
    mockExtensions = [impsExt, readExt, testsExt, sandboxExt];

    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ tools: ["read"] }),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings({
        agents: { coder: { tools: ["run_tests"] } },
        additionalExtensions: ["pi-sandbox"],
      }),
      exec,
      platform: "linux",
    });

    // pi-imps itself is never selected (excluded by the shared selector).
    expect(plan.extensionPaths).not.toContain(impsExt.resolvedPath);
    // read tool provider selected via frontmatter tools.
    expect(plan.extensionPaths).toContain(readExt.resolvedPath);
    // run_tests provider selected via global+project additive union.
    expect(plan.extensionPaths).toContain(testsExt.resolvedPath);
    // additionalExtensions always loads regardless of allowlist.
    expect(plan.extensionPaths).toContain(sandboxExt.resolvedPath);

    expect(plan.toolAllowlist).toEqual(expect.arrayContaining(["read", "run_tests"]));
    expect(plan.argv).toContain("--tools");
    expect(plan.argv.at(-1)).toContain("agent_done");
  });

  it("falls back to a cwd-resolved absolute path when resolvedPath is missing and ext.path is relative", async () => {
    // Give the relative path a real package.json (named differently from
    // pi-imps) so the shared extension selector's package-name walk resolves
    // a name other than pi-imps's own; chdir into the temp cwd so that walk
    // (which resolves relative paths against the process cwd) finds it
    // instead of this repo's own package.json.
    mkdirSync(join(cwd, "relative", "ext"), { recursive: true });
    writeFileSync(join(cwd, "relative", "ext", "package.json"), JSON.stringify({ name: "pi-relative" }));
    writeFileSync(join(cwd, "relative", "ext", "index.ts"), "export default () => {}");

    const relExt = makeExt("pi-relative", ["read"]);
    relExt.resolvedPath = "";
    relExt.path = "relative/ext/index.ts";
    mockExtensions = [relExt];

    const exec = makeExec();
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const plan = await prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "low",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
      });

      expect(plan.extensionPaths).toEqual([join(cwd, "relative/ext/index.ts")]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("keeps pseudo (inline) extension paths excluded even without a resolvedPath", async () => {
    const pseudoExt = makeExt("pi-pseudo", ["read"]);
    pseudoExt.resolvedPath = "";
    pseudoExt.path = "<inline:pi-pseudo>";
    mockExtensions = [pseudoExt];

    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });

    expect(plan.extensionPaths).toEqual([]);
  });

  it("dedupes selected extension paths while preserving order", async () => {
    const sharedExt = makeExt("pi-shared", ["read"], "/fake/shared/src/index.ts");
    mockExtensions = [sharedExt, sharedExt];

    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });

    expect(plan.extensionPaths).toEqual(["/fake/shared/src/index.ts"]);
  });

  it("omits --tools when the resolved allowlist is undefined (all tools)", async () => {
    mockExtensions = [makeExt("pi-read", ["read"])];
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });

    expect(plan.toolAllowlist).toBeUndefined();
    expect(plan.argv).not.toContain("--tools");
  });

  // ── worker entrypoint + full command shape ────────────────────────────

  it("resolves the internal worker entrypoint to an absolute src/index.ts path", async () => {
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });

    expect(plan.workerEntrypoint.endsWith(join("src", "index.ts"))).toBe(true);
    expect(plan.argv).toContain(plan.workerEntrypoint);
  });

  it("builds a fully single-quoted command line containing the system prompt as one token", async () => {
    mockExtensions = [];
    const exec = makeExec();
    const plan = await prepareOrcaLaunch({
      cwd,
      config: makeAgent({ systemPrompt: "Body with 'quote' and spaces" }),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
    });

    expect(plan.command).toContain("'Body with '\\''quote'\\'' and spaces'");
    expect(plan.command.startsWith("'pi'")).toBe(true);
  });

  // ── abort signal ──────────────────────────────────────────────────────

  it("passes the signal through to the status prerequisite check", async () => {
    const exec = makeExec();
    const controller = new AbortController();
    await prepareOrcaLaunch({
      cwd,
      config: makeAgent(),
      parentModel,
      parentThinkingLevel: "low",
      modelRegistry: makeModelRegistry([parentModel]),
      settings: makeSettings(),
      exec,
      platform: "linux",
      signal: controller.signal,
    });

    for (const call of exec.mock.calls) {
      expect(call[2]).toEqual({ signal: controller.signal });
    }
  });

  it("rejects when the signal is already aborted before the status check runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn(async (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      if (options?.signal?.aborted) throw new Error("aborted");
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0 };
    });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "low",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("rejects when the signal is aborted between the worktree check and the resource loader reload", async () => {
    const controller = new AbortController();
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const result = { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0 };
      if (args[0] === "worktree") controller.abort();
      return result;
    });
    await expect(
      prepareOrcaLaunch({
        cwd,
        config: makeAgent(),
        parentModel,
        parentThinkingLevel: "low",
        modelRegistry: makeModelRegistry([parentModel]),
        settings: makeSettings(),
        exec,
        platform: "linux",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
