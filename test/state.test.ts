import { describe, expect, it } from "vitest";
import { allImps, findImp, runningImps, uncollectedImps } from "../src/state.js";
import type { Imp } from "../src/types.js";

function makeImp(overrides: Partial<Imp> & { name: string }): Imp {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    agentName: "ephemeral",
    task: "test task",
    startedAt: Date.now(),
    controller: new AbortController(),
    status: "running",
    turns: 0,
    tokens: { input: 0, output: 0 },
    done,
    resolveDone,
    ...overrides,
  };
}

function buildMap(...imps: Imp[]): Map<string, Imp> {
  return new Map(imps.map((i) => [i.name, i]));
}

describe("findImp", () => {
  const a = makeImp({ name: "alice" });
  const b = makeImp({ name: "bob" });
  const map = buildMap(a, b);

  it("finds by name (map key)", () => {
    expect(findImp(map, "alice")).toBe(a);
  });

  it("finds another by name", () => {
    expect(findImp(map, "bob")).toBe(b);
  });

  it("returns undefined for unknown", () => {
    expect(findImp(map, "nope")).toBeUndefined();
  });
});

describe("uncollectedImps", () => {
  it("excludes dismissed", () => {
    const a = makeImp({ name: "a", status: "completed" });
    const b = makeImp({ name: "b", status: "dismissed" });
    const c = makeImp({ name: "c", status: "running" });
    const result = uncollectedImps(buildMap(a, b, c));
    expect(result).toEqual([a, c]);
  });
});

describe("runningImps", () => {
  it("only returns status=running", () => {
    const a = makeImp({ name: "a", status: "running" });
    const b = makeImp({ name: "b", status: "completed" });
    const c = makeImp({ name: "c", status: "failed" });
    const result = runningImps(buildMap(a, b, c));
    expect(result).toEqual([a]);
  });
});

describe("allImps", () => {
  it("returns everything", () => {
    const a = makeImp({ name: "a", status: "running" });
    const b = makeImp({ name: "b", status: "completed" });
    const c = makeImp({ name: "c", status: "dismissed" });
    const map = buildMap(a, b, c);
    expect(allImps(map)).toEqual([a, b, c]);
  });
});
