const POOL = [
  "alice", "bob", "carol", "dave", "eve", "frank",
  "grace", "hank", "iris", "jake", "kate", "leo",
  "mona", "nick", "olive", "pete", "quinn", "rosa",
];

export function createNamePool() {
  const available = new Set(POOL);
  let counter = 0;

  return {
    allocate(): string {
      const first = available.values().next();
      if (!first.done) {
        available.delete(first.value);
        return first.value;
      }
      return `imp-${++counter}`;
    },
    release(name: string) {
      if (POOL.includes(name)) available.add(name);
    },
  };
}
