import { describe, expect, it } from "vitest";
import { createNamePool } from "../src/names.js";

const POOL_SIZE = 18;

describe("createNamePool", () => {
  it("allocate returns a name from the pool", () => {
    const pool = createNamePool();
    const name = pool.allocate();
    expect(typeof name).toBe("string");
    expect(name).not.toMatch(/^imp-\d+$/);
  });

  it("allocating all 18 names exhausts the pool", () => {
    const pool = createNamePool();
    const names = new Set<string>();
    for (let i = 0; i < POOL_SIZE; i++) {
      names.add(pool.allocate());
    }
    expect(names.size).toBe(POOL_SIZE);
    // none should be generated names
    for (const n of names) {
      expect(n).not.toMatch(/^imp-\d+$/);
    }
  });

  it("after exhaustion, allocate returns imp-1, imp-2, etc.", () => {
    const pool = createNamePool();
    for (let i = 0; i < POOL_SIZE; i++) pool.allocate();
    expect(pool.allocate()).toBe("imp-1");
    expect(pool.allocate()).toBe("imp-2");
  });

  it("releasing a pool name makes it available again", () => {
    const pool = createNamePool();
    const first = pool.allocate();
    pool.release(first);
    // allocate should return the released name (it's the only one re-added, but pool is a Set so order may vary)
    // exhaust all others, then the last one from pool should be `first`
    const names: string[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      names.push(pool.allocate());
    }
    expect(names).toContain(first);
    // none should be generated
    for (const n of names) {
      expect(n).not.toMatch(/^imp-\d+$/);
    }
  });

  it("releasing a generated name does NOT add it to the pool", () => {
    const pool = createNamePool();
    for (let i = 0; i < POOL_SIZE; i++) pool.allocate();
    const generated = pool.allocate(); // imp-1
    expect(generated).toBe("imp-1");
    pool.release(generated);
    // next allocate should still be imp-2, not imp-1
    expect(pool.allocate()).toBe("imp-2");
  });
});
