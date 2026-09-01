import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadImpSettings, loadProjectConfig, parseImpSettings, updateProjectAgentTools } from "../src/settings.js";

describe("parseImpSettings", () => {
  it("returns defaults when block is undefined", () => {
    const settings = parseImpSettings(undefined);
    expect(settings.turnLimit).toBe(30);
    expect(settings.toolAllowlist).toBeUndefined();
    expect(settings.additionalExtensions).toEqual([]);
    expect(settings.agents).toEqual({});
  });

  it("returns defaults when block is empty", () => {
    const settings = parseImpSettings({});
    expect(settings.turnLimit).toBe(30);
    expect(settings.toolAllowlist).toBeUndefined();
    expect(settings.additionalExtensions).toEqual([]);
    expect(settings.agents).toEqual({});
  });

  it("reads turnLimit", () => {
    const settings = parseImpSettings({ turnLimit: 50 });
    expect(settings.turnLimit).toBe(50);
  });

  it("reads toolAllowlist", () => {
    const settings = parseImpSettings({ toolAllowlist: ["read", "bash"] });
    expect(settings.toolAllowlist).toEqual(["read", "bash"]);
  });

  it("reads additionalExtensions", () => {
    const settings = parseImpSettings({
      additionalExtensions: ["pi-sandbox"],
    });
    expect(settings.additionalExtensions).toEqual(["pi-sandbox"]);
  });

  it("ignores invalid turnLimit (negative)", () => {
    const settings = parseImpSettings({ turnLimit: -5 });
    expect(settings.turnLimit).toBe(30);
  });

  it("ignores invalid turnLimit (zero)", () => {
    const settings = parseImpSettings({ turnLimit: 0 });
    expect(settings.turnLimit).toBe(30);
  });

  it("ignores invalid turnLimit (1, minimum is 2)", () => {
    const settings = parseImpSettings({ turnLimit: 1 });
    expect(settings.turnLimit).toBe(30);
  });

  it("ignores invalid turnLimit (string)", () => {
    const settings = parseImpSettings({ turnLimit: "10" });
    expect(settings.turnLimit).toBe(30);
  });

  it("handles non-array toolAllowlist gracefully", () => {
    const settings = parseImpSettings({ toolAllowlist: "read" });
    expect(settings.toolAllowlist).toBeUndefined();
  });

  it("handles non-array additionalExtensions gracefully", () => {
    const settings = parseImpSettings({ additionalExtensions: "pi-sandbox" });
    expect(settings.additionalExtensions).toEqual([]);
  });

  it("reads all fields together", () => {
    const settings = parseImpSettings({
      turnLimit: 20,
      toolAllowlist: ["read", "edit", "bash"],
      additionalExtensions: ["pi-sandbox", "pi-audit"],
    });
    expect(settings.turnLimit).toBe(20);
    expect(settings.toolAllowlist).toEqual(["read", "edit", "bash"]);
    expect(settings.additionalExtensions).toEqual(["pi-sandbox", "pi-audit"]);
  });

  // ── agents field ──────────────────────────────────────────────────────

  it("reads agents config", () => {
    const settings = parseImpSettings({
      agents: {
        mason: { tools: ["run_tests", "run_checks"] },
        sentinel: { tools: ["run_tests"] },
      },
    });
    expect(settings.agents).toEqual({
      mason: { tools: ["run_tests", "run_checks"] },
      sentinel: { tools: ["run_tests"] },
    });
  });

  it("returns empty agents when agents is not an object", () => {
    expect(parseImpSettings({ agents: "invalid" }).agents).toEqual({});
    expect(parseImpSettings({ agents: ["bad"] }).agents).toEqual({});
  });

  it("skips agent entries that are not objects", () => {
    const settings = parseImpSettings({
      agents: { mason: "bad", sentinel: { tools: ["run_tests"] } },
    });
    expect(settings.agents).toEqual({ sentinel: { tools: ["run_tests"] } });
  });

  it("agent entry without tools field becomes empty object", () => {
    const settings = parseImpSettings({ agents: { mason: {} } });
    expect(settings.agents.mason).toEqual({});
  });

  it("ignores non-array tools in agent entry", () => {
    const settings = parseImpSettings({ agents: { mason: { tools: "run_tests" } } });
    expect(settings.agents.mason).toEqual({});
  });

  it("filters invalid elements from tools array", () => {
    const settings = parseImpSettings({
      agents: { mason: { tools: ["run_tests", 1, null, ""] } },
    });
    expect(settings.agents.mason).toEqual({ tools: ["run_tests"] });
  });
});

describe("loadImpSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when imps.json does not exist", () => {
    const settings = loadImpSettings(tmpDir);
    expect(settings.turnLimit).toBe(30);
    expect(settings.toolAllowlist).toBeUndefined();
    expect(settings.additionalExtensions).toEqual([]);
  });

  it("throws when imps.json contains invalid JSON", () => {
    writeFileSync(join(tmpDir, "imps.json"), "not-json");
    expect(() => loadImpSettings(tmpDir)).toThrow(SyntaxError);
  });

  it("reads turnLimit from imps.json", () => {
    writeFileSync(join(tmpDir, "imps.json"), JSON.stringify({ turnLimit: 50 }));
    const settings = loadImpSettings(tmpDir);
    expect(settings.turnLimit).toBe(50);
  });

  it("reads toolAllowlist from imps.json", () => {
    writeFileSync(join(tmpDir, "imps.json"), JSON.stringify({ toolAllowlist: ["read", "bash"] }));
    const settings = loadImpSettings(tmpDir);
    expect(settings.toolAllowlist).toEqual(["read", "bash"]);
  });

  it("reads all fields from imps.json", () => {
    writeFileSync(
      join(tmpDir, "imps.json"),
      JSON.stringify({ turnLimit: 20, toolAllowlist: ["read"], additionalExtensions: ["pi-sandbox"] }),
    );
    const settings = loadImpSettings(tmpDir);
    expect(settings.turnLimit).toBe(20);
    expect(settings.toolAllowlist).toEqual(["read"]);
    expect(settings.additionalExtensions).toEqual(["pi-sandbox"]);
  });

  it("reads agents from imps.json", () => {
    writeFileSync(join(tmpDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["run_tests"] } } }));
    const settings = loadImpSettings(tmpDir);
    expect(settings.agents).toEqual({ mason: { tools: ["run_tests"] } });
  });

  it("ignores unknown fields via parseImpSettings validation", () => {
    writeFileSync(join(tmpDir, "imps.json"), JSON.stringify({ turnLimit: 10, unknown: true }));
    const settings = loadImpSettings(tmpDir);
    expect(settings.turnLimit).toBe(10);
    expect((settings as unknown as Record<string, unknown>).unknown).toBeUndefined();
  });
});

// ─── loadProjectConfig ───────────────────────────────────────────────

describe("loadProjectConfig", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-proj-"));
    piDir = join(tmpDir, ".pi");
    mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty config when .pi/imps.json does not exist", () => {
    const config = loadProjectConfig(tmpDir);
    expect(config).toEqual({});
  });

  it("throws when .pi/imps.json is a directory (EISDIR)", () => {
    mkdirSync(join(piDir, "imps.json"), { recursive: true });
    expect(() => loadProjectConfig(tmpDir)).toThrow();
  });

  it("returns empty config when .pi directory does not exist", () => {
    rmSync(piDir, { recursive: true, force: true });
    const config = loadProjectConfig(tmpDir);
    expect(config).toEqual({});
  });

  it("throws on invalid JSON", () => {
    writeFileSync(join(piDir, "imps.json"), "not-json");
    expect(() => loadProjectConfig(tmpDir)).toThrow(SyntaxError);
  });

  it("reads agents config", () => {
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({ agents: { mason: { tools: ["run_tests", "run_checks"] } } }),
    );
    const config = loadProjectConfig(tmpDir);
    expect(config.agents).toEqual({ mason: { tools: ["run_tests", "run_checks"] } });
  });

  it("validates agents: ignores non-array tools", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: "run_tests" } } }));
    const config = loadProjectConfig(tmpDir);
    // tools: "run_tests" (string) should be rejected; entry becomes {}
    expect(config.agents?.mason).toEqual({});
  });

  it("throws on non-object root", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify([1, 2, 3]));
    expect(() => loadProjectConfig(tmpDir)).toThrow();
  });

  it("throws on non-object agents field", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: "bad" }));
    expect(() => loadProjectConfig(tmpDir)).toThrow();
  });

  it("throws on non-object agent entry", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: "bad" } }));
    expect(() => loadProjectConfig(tmpDir)).toThrow();
  });
});

// ─── updateProjectAgentTools ─────────────────────────────────────────────────

describe("updateProjectAgentTools", () => {
  let tmpDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-update-"));
    piDir = join(tmpDir, ".pi");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .pi directory and imps.json when neither exists", () => {
    updateProjectAgentTools(tmpDir, "mason", ["run_tests"]);
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["run_tests"]);
  });

  it("creates imps.json when .pi exists but file does not", () => {
    mkdirSync(piDir, { recursive: true });
    updateProjectAgentTools(tmpDir, "mason", ["run_tests"]);
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["run_tests"]);
  });

  it("updates existing agent tools", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: ["old_tool"] } } }));
    updateProjectAgentTools(tmpDir, "mason", ["run_tests", "run_checks"]);
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toEqual(["run_tests", "run_checks"]);
  });

  it("preserves other agents", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({ agents: { mason: { tools: ["run_tests"] }, sentinel: { tools: ["check_style"] } } }),
    );
    updateProjectAgentTools(tmpDir, "mason", ["run_checks"]);
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?.sentinel?.tools).toEqual(["check_style"]);
    expect(config.agents?.mason?.tools).toEqual(["run_checks"]);
  });

  it("preserves unrelated top-level properties", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({ customProp: "value", agents: { mason: { tools: ["run_tests"] } } }),
    );
    updateProjectAgentTools(tmpDir, "mason", ["run_checks"]);
    const raw = JSON.parse(readFileSync(join(piDir, "imps.json"), "utf-8")) as Record<string, unknown>;
    expect(raw.customProp).toBe("value");
  });

  it("preserves unknown properties in target agent entry", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "imps.json"),
      JSON.stringify({ agents: { mason: { tools: ["run_tests"], customKey: "preserved" } } }),
    );
    updateProjectAgentTools(tmpDir, "mason", ["run_checks"]);
    const raw = JSON.parse(readFileSync(join(piDir, "imps.json"), "utf-8")) as Record<string, unknown>;
    const masonEntry = (raw.agents as Record<string, unknown>).mason as Record<string, unknown>;
    expect(masonEntry.customKey).toBe("preserved");
  });

  it("caller can pass unknown tool names to preserve them across writes", () => {
    mkdirSync(piDir, { recursive: true });
    // Simulate unknown tool 'future_tool' already in project config.
    // The command passes it through by merging unknownProjectTools.
    updateProjectAgentTools(tmpDir, "mason", ["run_tests", "future_tool"]);
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?.mason?.tools).toContain("run_tests");
    expect(config.agents?.mason?.tools).toContain("future_tool");
  });

  it("leaves no partial tmp file after successful write", () => {
    updateProjectAgentTools(tmpDir, "mason", ["run_tests"]);
    expect(existsSync(join(piDir, "imps.json.tmp"))).toBe(false);
    expect(existsSync(join(piDir, "imps.json"))).toBe(true);
  });

  it("throws on invalid JSON in existing file", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "imps.json"), "not-json");
    expect(() => updateProjectAgentTools(tmpDir, "mason", ["run_tests"])).toThrow(SyntaxError);
  });

  it("throws on non-object root (array)", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "imps.json"), JSON.stringify([1, 2, 3]));
    expect(() => updateProjectAgentTools(tmpDir, "mason", ["run_tests"])).toThrow();
  });

  it("throws when agents field is not an object", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: "bad" }));
    expect(() => updateProjectAgentTools(tmpDir, "mason", ["run_tests"])).toThrow();
  });

  it("throws when target agent entry is not an object", () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: "bad" } }));
    expect(() => updateProjectAgentTools(tmpDir, "mason", ["run_tests"])).toThrow();
  });

  it("does not overwrite when malformed — file remains unchanged", () => {
    mkdirSync(piDir, { recursive: true });
    const badContent = "{ invalid";
    writeFileSync(join(piDir, "imps.json"), badContent);
    try {
      updateProjectAgentTools(tmpDir, "mason", ["run_tests"]);
    } catch {
      // expected
    }
    expect(readFileSync(join(piDir, "imps.json"), "utf-8")).toBe(badContent);
  });
});
