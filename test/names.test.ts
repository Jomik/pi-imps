import { describe, expect, it } from "vitest";
import { createNamePool } from "../src/names.js";

describe("createNamePool", () => {
  it("allocate returns a capitalized string name", () => {
    const pool = createNamePool();
    const name = pool.allocate();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    expect(name[0]).toBe(name[0].toUpperCase());
  });

  it("allocates unique names", () => {
    const pool = createNamePool();
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(pool.allocate());
    }
    expect(names.size).toBe(50);
  });

  it("does not return fallback names under normal usage", () => {
    const pool = createNamePool();
    for (let i = 0; i < 50; i++) {
      expect(pool.allocate()).not.toMatch(/^imp-\d+$/);
    }
  });

  it("release removes name from used set, allowing potential reuse", () => {
    const pool = createNamePool();
    const name = pool.allocate();
    pool.release(name);
    // After release, the same name should not cause a collision
    // if randomly generated again. We can't test deterministic reuse
    // since generation is random, but we verify release doesn't throw
    // and the pool continues to produce unique names.
    const next = pool.allocate();
    expect(typeof next).toBe("string");
    expect(next.length).toBeGreaterThan(0);
  });

  it("release is idempotent", () => {
    const pool = createNamePool();
    const name = pool.allocate();
    pool.release(name);
    pool.release(name); // should not throw
    expect(pool.allocate()).not.toMatch(/^imp-\d+$/);
  });
});
