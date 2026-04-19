import type { Imp } from "./types.js";

export function findImp(imps: Map<string, Imp>, name: string): Imp | undefined {
  return imps.get(name);
}

export function uncollectedImps(imps: Map<string, Imp>): Imp[] {
  return Array.from(imps.values()).filter((i) => !i.collected && i.status !== "dismissed");
}

export function runningImps(imps: Map<string, Imp>): Imp[] {
  return Array.from(imps.values()).filter((i) => i.status === "running");
}

export function allImps(imps: Map<string, Imp>): Imp[] {
  return Array.from(imps.values());
}
