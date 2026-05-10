import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadImpSettings, parseImpSettings } from "../src/settings.js";

describe("parseImpSettings", () => {
  it("returns defaults when block is undefined", () => {
    const settings = parseImpSettings(undefined);
    expect(settings.turnLimit).toBe(30);
    expect(settings.toolAllowlist).toBeUndefined();
    expect(settings.additionalExtensions).toEqual([]);
  });

  it("returns defaults when block is empty", () => {
    const settings = parseImpSettings({});
    expect(settings.turnLimit).toBe(30);
    expect(settings.toolAllowlist).toBeUndefined();
    expect(settings.additionalExtensions).toEqual([]);
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

  it("ignores unknown fields via parseImpSettings validation", () => {
    writeFileSync(join(tmpDir, "imps.json"), JSON.stringify({ turnLimit: 10, unknown: true }));
    const settings = loadImpSettings(tmpDir);
    expect(settings.turnLimit).toBe(10);
    expect((settings as unknown as Record<string, unknown>).unknown).toBeUndefined();
  });
});
