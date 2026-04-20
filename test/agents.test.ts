import { describe, expect, it } from "vitest";
import { parseToolsList } from "../src/agents.js";

describe("parseToolsList", () => {
  // YAML array
  it("parses YAML array of strings", () => {
    expect(parseToolsList(["read", "bash", "edit"])).toEqual(["read", "bash", "edit"]);
  });

  it("filters non-string values from YAML array", () => {
    expect(parseToolsList(["read", 123, true, null, "bash"])).toEqual(["read", "bash"]);
  });

  it("filters empty strings from YAML array", () => {
    expect(parseToolsList(["read", "", "bash"])).toEqual(["read", "bash"]);
  });

  it("returns empty array for YAML array with no valid strings", () => {
    expect(parseToolsList([123, true])).toEqual([]);
  });

  it("returns empty array for empty YAML array", () => {
    expect(parseToolsList([])).toEqual([]);
  });

  // Comma-separated string
  it("parses comma-separated string", () => {
    expect(parseToolsList("read, bash, edit")).toEqual(["read", "bash", "edit"]);
  });

  it("trims whitespace in comma-separated string", () => {
    expect(parseToolsList("  read ,  bash  , edit  ")).toEqual(["read", "bash", "edit"]);
  });

  it("filters empty segments from comma-separated string", () => {
    expect(parseToolsList("read,,bash,")).toEqual(["read", "bash"]);
  });

  it("handles single tool string", () => {
    expect(parseToolsList("read")).toEqual(["read"]);
  });

  // Absent / invalid
  it("returns undefined for undefined", () => {
    expect(parseToolsList(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(parseToolsList(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseToolsList("")).toBeUndefined();
  });

  it("returns undefined for number", () => {
    expect(parseToolsList(42)).toBeUndefined();
  });

  it("returns undefined for boolean", () => {
    expect(parseToolsList(true)).toBeUndefined();
  });
});
