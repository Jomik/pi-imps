import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ImpSettings } from "../src/types.js";

let agentDir: string;
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...real, getAgentDir: () => agentDir, createAgentSession: vi.fn() };
});

const { buildImpResourceLoader, spawnImpSession, validateImpFlags } = await import("../src/session.js");
const { prepareOrcaLaunch } = await import("../src/orca-launch.js");
const { createAgentSession, DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");

const config: AgentConfig = {
  name: "test",
  description: "test worker",
  systemPrompt: "You are a test worker.",
  source: "user",
  filePath: "/test.md",
  tools: [],
};
function settings(sources: string[]): ImpSettings {
  return {
    turnLimit: 30,
    toolAllowlist: undefined,
    additionalExtensions: sources,
    impFlags: [],
    agents: {},
    orca: { enabled: false },
  };
}
let root: string;
let cwd: string;
function fixture(
  path: string,
  content = "export default (pi) => { pi.registerFlag('safe-mode', { type: 'boolean' }); };",
) {
  const file = join(agentDir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return file;
}
async function load(sources: string[], tools?: string[]) {
  const result = await buildImpResourceLoader(cwd, { ...config, tools }, settings(sources));
  await result.loader.reload();
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-imps-sources-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("requested extensions through the real Pi source resolver and loader", () => {
  it.each([
    [],
    ["read"],
    undefined,
  ])("loads an undiscovered global-relative file without broadening tools: %j", async (tools) => {
    const path = fixture("policy.ts");
    const { loader, toolAllowlist } = await load(["./policy.ts"], tools);
    expect(toolAllowlist).toEqual(tools);
    const selected = loader.getExtensions().extensions;
    expect(selected.map((ext) => ext.resolvedPath)).toContain(path);
    expect(validateImpFlags(["safe-mode"], selected)).toEqual(["safe-mode"]);
    expect(selected.some((ext) => ext.path === "<inline:1>")).toBe(true);
  });

  it("isolates requested sources from project npm commands while preserving the global local-path anchor", async () => {
    const path = fixture("policy.ts");
    fixture("settings.json", JSON.stringify({ npmCommand: ["npm-policy", "--policy"], packages: ["npm:unrequested"] }));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ npmCommand: ["project-command"] }));
    const resolve = DefaultPackageManager.prototype.resolveExtensionSources;
    const spy = vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources").mockImplementation(async function (
      this: InstanceType<typeof DefaultPackageManager>,
      sources,
      options,
    ) {
      const manager = this as unknown as {
        cwd: string;
        agentDir: string;
        settingsManager: { getNpmCommand(): string[] | undefined };
      };
      expect(manager.settingsManager.getNpmCommand()).toEqual(["npm-policy", "--policy"]);
      expect(manager.cwd).toBe(agentDir);
      expect(manager.agentDir).toBe(agentDir);
      // Substitute a local fixture for the package request; never invoke npm or git.
      const result = await resolve.call(this, sources[0] === "npm:policy" ? ["./policy.ts"] : sources, options);
      expect(result.extensions.map((resource) => resource.path)).toContain(path);
      return result;
    });
    // Do not reload configured packages; this check covers the requested-source resolver only.
    const { loader } = await buildImpResourceLoader(cwd, config, settings(["npm:policy", "./policy.ts"]));
    const loaderSettings = (
      loader as unknown as {
        settingsManager: { getNpmCommand(): string[] | undefined };
      }
    ).settingsManager;
    expect(loaderSettings.getNpmCommand()).toEqual(["project-command"]);
    expect(spy.mock.calls).toEqual([
      [["npm:policy"], { temporary: true }],
      [["./policy.ts"], { temporary: true }],
    ]);
  });

  it("loads a directory index and every package entrypoint", async () => {
    const index = fixture("directory/index.ts", "export default () => {};");
    const first = fixture("package/first.ts", "export default () => {};");
    const second = fixture("package/second.ts", "export default () => {};");
    fixture(
      "package/package.json",
      JSON.stringify({ name: "policy-package", pi: { extensions: ["first.ts", "second.ts"] } }),
    );
    const { loader } = await load(["./directory", "./package"]);
    const paths = loader.getExtensions().extensions.map((ext) => ext.resolvedPath);
    // Pi retains the directory source path for an index extension.
    expect(paths).toEqual(expect.arrayContaining([join(index, ".."), first, second]));
  });

  it("deduplicates requested aliases, symlinks and discovered paths using Pi's canonical identity", async () => {
    const path = fixture("extensions/policy.ts", "export default () => {};");
    symlinkSync(path, join(agentDir, "alias.ts"));
    const { loader } = await load(["./alias.ts", "./extensions/policy.ts", path]);
    const matching = loader.getExtensions().extensions.filter((ext) => !ext.path.startsWith("<"));
    expect(matching).toHaveLength(1);
    expect(realpathSync(matching[0].resolvedPath)).toBe(realpathSync(path));
  });

  it("does not fail for unrelated discovered errors", async () => {
    fixture("extensions/broken.ts", "export default () => { throw new Error('unrelated failure'); };");
    fixture("policy.ts");
    const { loader } = await load(["./policy.ts"]);
    expect(loader.getExtensions().errors.some((error) => error.error.includes("unrelated failure"))).toBe(true);
  });

  it.each([
    ["./missing.ts", /missing.ts.*missing or contains no enabled extensions/],
    ["builtin:unknown", /builtin:unknown.*(not loaded|does not exist|Cannot find)/],
    ["./empty", /empty.*no enabled extensions/],
    ["./throwing.ts", /throwing.ts.*requested failure/],
    ["./invalid.ts", /invalid.ts.*valid factory/],
    ["./recursive", /recursive.*pi-imps.*leaf workers/],
    ["./recursive-alias.ts", /recursive-alias.ts.*pi-imps.*leaf workers/],
  ])("rejects %s before creating an SDK session", async (source, error) => {
    fixture("empty/package.json", JSON.stringify({ name: "empty", pi: { extensions: [] } }));
    fixture("throwing.ts", "export default () => { throw new Error('requested failure'); };");
    fixture("invalid.ts", "export const notAnExtension = 1;");
    fixture("recursive/package.json", JSON.stringify({ name: "pi-imps", pi: { extensions: ["index.ts"] } }));
    const recursive = fixture("recursive/index.ts", "export default () => {};");
    symlinkSync(recursive, join(agentDir, "recursive-alias.ts"));
    await expect(
      spawnImpSession({
        cwd,
        config,
        settings: settings([source]),
        task: "test requested source",
        parentModel: { id: "test", provider: "test" } as never,
        parentThinkingLevel: "off",
        modelRegistry: {} as ModelRegistry,
        signal: new AbortController().signal,
        onTurnEnd: vi.fn(),
        onToolActivity: vi.fn(),
        onUsageUpdate: vi.fn(),
        onComplete: vi.fn(),
      }),
    ).rejects.toThrow(error);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("passes the same global-relative package entrypoints to Orca with the allowlist unchanged", async () => {
    const path = fixture("package/policy.ts");
    fixture("package/package.json", JSON.stringify({ name: "policy-package", pi: { extensions: ["policy.ts"] } }));
    const impSettings = { ...settings(["./package"]), impFlags: ["safe-mode"] };
    const plan = await prepareOrcaLaunch({
      cwd,
      config,
      settings: impSettings,
      parentModel: { id: "test", provider: "test" } as never,
      parentThinkingLevel: "off",
      modelRegistry: {} as ModelRegistry,
      exec: vi.fn(async () => ({ stdout: '{"ok":true}', stderr: "", code: 0 })),
      platform: "linux",
    });
    expect(plan.extensionPaths).toEqual([path]);
    expect(plan.argv).toContain("--safe-mode");
    expect(plan.toolAllowlist).toEqual([]);
    expect(plan.argv.slice(plan.argv.indexOf("--tools"), plan.argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  });
});
