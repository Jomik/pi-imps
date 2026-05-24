import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadImpSettings, loadProjectConfig, parseImpSettings } from "../src/settings.js";

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

  it("reads ephemeral agent key '_'", () => {
    const settings = parseImpSettings({
      agents: { _: { tools: ["run_tests"] } },
    });
    expect(settings.agents._).toEqual({ tools: ["run_tests"] });
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

  it("reads ephemeral agent '_' key", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { _: { tools: ["run_tests"] } } }));
    const config = loadProjectConfig(tmpDir);
    expect(config.agents?._).toEqual({ tools: ["run_tests"] });
  });

  it("validates agents: ignores non-array tools", () => {
    writeFileSync(join(piDir, "imps.json"), JSON.stringify({ agents: { mason: { tools: "run_tests" } } }));
    const config = loadProjectConfig(tmpDir);
    // tools: "run_tests" (string) should be rejected; entry becomes {}
    expect(config.agents?.mason).toEqual({});
  });
});
