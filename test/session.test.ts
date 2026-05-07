import { type Extension, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createImpSettingsManager,
  resolveToolAllowlist,
  resolveTurnLimit,
  shouldIncludeExtension,
} from "../src/session.js";

// ─── helpers ───────────────────────────────────────────────────────────────

/** Create a minimal Extension stub for testing shouldIncludeExtension. */
function makeExt(
  name: string,
  toolNames: string[],
  opts?: { origin?: "package" | "top-level"; baseDir?: string },
): Extension {
  const tools = new Map<string, unknown>();
  for (const t of toolNames) tools.set(t, {});
  return {
    path: `/fake/extensions/${name}/src/index.ts`,
    resolvedPath: `/fake/extensions/${name}/src/index.ts`,
    sourceInfo: {
      path: `/fake/extensions/${name}/src/index.ts`,
      source: opts?.origin === "top-level" ? "auto" : `npm:${name}@1.0.0`,
      scope: "user",
      origin: opts?.origin ?? "package",
      baseDir: opts?.baseDir ?? `/fake/node_modules/${name}`,
    },
    handlers: new Map(),
    tools: tools as Extension["tools"],
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}

// ─── resolveToolAllowlist ──────────────────────────────────────────────────

describe("resolveToolAllowlist", () => {
  it("agent tools override settings", () => {
    expect(resolveToolAllowlist(["read"], ["read", "bash"])).toEqual(["read"]);
  });

  it("falls back to settings when agent tools absent", () => {
    expect(resolveToolAllowlist(undefined, ["read", "bash"])).toEqual(["read", "bash"]);
  });

  it("returns undefined when both absent", () => {
    expect(resolveToolAllowlist(undefined, undefined)).toBeUndefined();
  });

  it("agent empty array means no tools (not fallback)", () => {
    expect(resolveToolAllowlist([], ["read", "bash"])).toEqual([]);
  });

  it("settings empty array means no tools", () => {
    expect(resolveToolAllowlist(undefined, [])).toEqual([]);
  });
});

// ─── resolveTurnLimit ──────────────────────────────────────────────────────

describe("resolveTurnLimit", () => {
  it("agent limit overrides settings", () => {
    expect(resolveTurnLimit(50, 30)).toBe(50);
  });

  it("falls back to settings when agent limit absent", () => {
    expect(resolveTurnLimit(undefined, 30)).toBe(30);
  });

  it("agent limit can be lower than settings", () => {
    expect(resolveTurnLimit(10, 30)).toBe(10);
  });
});

// ─── createImpSettingsManager ────────────────────────────────────────────────

describe("createImpSettingsManager", () => {
  it("passes through runtime settings", () => {
    const source = SettingsManager.inMemory({
      branchSummary: { reserveTokens: 1234, skipPrompt: true },
      compaction: { enabled: false, reserveTokens: 4321, keepRecentTokens: 1111 },
      defaultThinkingLevel: "high",
      enableInstallTelemetry: false,
      followUpMode: "all",
      images: { autoResize: false, blockImages: true },
      retry: { enabled: false, maxRetries: 7, baseDelayMs: 99 },
      shellCommandPrefix: "source ~/.bashrc",
      shellPath: "/bin/zsh",
      steeringMode: "all",
      thinkingBudgets: { low: 1024 },
      transport: "websocket",
    });

    const imp = createImpSettingsManager(process.cwd(), source);

    expect(imp.getBranchSummarySettings()).toEqual({ reserveTokens: 1234, skipPrompt: true });
    expect(imp.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 4321, keepRecentTokens: 1111 });
    expect(imp.getDefaultThinkingLevel()).toBe("high");
    expect(imp.getEnableInstallTelemetry()).toBe(false);
    expect(imp.getFollowUpMode()).toBe("all");
    expect(imp.getImageAutoResize()).toBe(false);
    expect(imp.getBlockImages()).toBe(true);
    expect(imp.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 7, baseDelayMs: 99 });
    expect(imp.getShellCommandPrefix()).toBe("source ~/.bashrc");
    expect(imp.getShellPath()).toBe("/bin/zsh");
    expect(imp.getSteeringMode()).toBe("all");
    expect(imp.getThinkingBudgets()).toEqual({ low: 1024 });
    expect(imp.getTransport()).toBe("websocket");
  });

  it("does not pass through resource, model, persistence, or UI settings", () => {
    const source = SettingsManager.inMemory({
      defaultProvider: "anthropic",
      defaultModel: "claude-test",
      enabledModels: ["anthropic/*"],
      extensions: ["pi-example"],
      skills: ["skill-example"],
      prompts: ["prompt-example"],
      themes: ["theme-example"],
      packages: ["pi-package"],
      enableSkillCommands: false,
      sessionDir: "/tmp/pi-sessions",
      theme: "custom-theme",
      terminal: { showImages: false, imageWidthCells: 12, clearOnShrink: true },
      quietStartup: true,
      hideThinkingBlock: true,
      collapseChangelog: true,
      npmCommand: ["pnpm"],
    });

    const imp = createImpSettingsManager(process.cwd(), source);

    expect(imp.getDefaultProvider()).toBeUndefined();
    expect(imp.getDefaultModel()).toBeUndefined();
    expect(imp.getEnabledModels()).toBeUndefined();
    expect(imp.getExtensionPaths()).toEqual([]);
    expect(imp.getSkillPaths()).toEqual([]);
    expect(imp.getPromptTemplatePaths()).toEqual([]);
    expect(imp.getThemePaths()).toEqual([]);
    expect(imp.getPackages()).toEqual([]);
    expect(imp.getEnableSkillCommands()).toBe(true);
    expect(imp.getSessionDir()).toBeUndefined();
    expect(imp.getTheme()).toBeUndefined();
    expect(imp.getShowImages()).toBe(true);
    expect(imp.getImageWidthCells()).toBe(60);
    expect(imp.getClearOnShrink()).toBe(false);
    expect(imp.getQuietStartup()).toBe(false);
    expect(imp.getHideThinkingBlock()).toBe(false);
    expect(imp.getCollapseChangelog()).toBe(false);
    expect(imp.getNpmCommand()).toBeUndefined();
  });
});

// ─── shouldIncludeExtension ────────────────────────────────────────────────

describe("shouldIncludeExtension", () => {
  // pi-imps self-exclusion
  it("excludes pi-imps regardless of allowlist", () => {
    const ext = makeExt("pi-imps", ["summon", "wait"]);
    expect(shouldIncludeExtension(ext, undefined, [], "pi-imps")).toBe(false);
    expect(shouldIncludeExtension(ext, ["summon"], [], "pi-imps")).toBe(false);
  });

  // Additional extensions
  it("includes additional extension even if its tools not in allowlist", () => {
    const ext = makeExt("pi-sandbox", ["sandbox_check"]);
    expect(shouldIncludeExtension(ext, ["read"], ["pi-sandbox"], "pi-sandbox")).toBe(true);
  });

  it("includes additional extension even with empty allowlist", () => {
    const ext = makeExt("pi-sandbox", ["sandbox_check"]);
    expect(shouldIncludeExtension(ext, [], ["pi-sandbox"], "pi-sandbox")).toBe(true);
  });

  // Allowlist: undefined (absent) = all tools
  it("includes all extensions when allowlist is undefined", () => {
    const ext = makeExt("pi-web-access", ["web_search", "fetch_content"]);
    expect(shouldIncludeExtension(ext, undefined, [], "pi-web-access")).toBe(true);
  });

  // Allowlist: empty = no tools
  it("excludes all non-additional extensions when allowlist is empty", () => {
    const ext = makeExt("pi-web-access", ["web_search", "fetch_content"]);
    expect(shouldIncludeExtension(ext, [], [], "pi-web-access")).toBe(false);
  });

  // Allowlist: specific tools
  it("includes extension when it provides an allowed tool", () => {
    const ext = makeExt("pi-web-access", ["web_search", "fetch_content"]);
    expect(shouldIncludeExtension(ext, ["web_search"], [], "pi-web-access")).toBe(true);
  });

  it("excludes extension when none of its tools are allowed", () => {
    const ext = makeExt("pi-web-access", ["web_search", "fetch_content"]);
    expect(shouldIncludeExtension(ext, ["read", "bash"], [], "pi-web-access")).toBe(false);
  });

  // Extension with no tools
  it("excludes extension with no tools when allowlist is set", () => {
    const ext = makeExt("pi-theme-only", []);
    expect(shouldIncludeExtension(ext, ["read"], [], "pi-theme-only")).toBe(false);
  });

  it("includes extension with no tools when allowlist is undefined", () => {
    const ext = makeExt("pi-theme-only", []);
    expect(shouldIncludeExtension(ext, undefined, [], "pi-theme-only")).toBe(true);
  });
});
