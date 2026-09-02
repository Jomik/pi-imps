import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./helpers/index.js";

// Mock getAgentDir so tests never touch the real ~/.pi/agent/agents/ directory.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentDir: vi.fn(() => "/nonexistent-pi-agent-dir-for-testing-xyz"),
  };
});

const extensionFactory = (await import("../src/index.js")).default;

/** Minimal ExtensionAPI stub capturing registered "session_start" handlers. */
function createMockPi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(name, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

describe("session_start agent discovery diagnostics", () => {
  let tmpDir: string;
  let projectAgentsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-imps-session-start-test-"));
    projectAgentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("notifies exactly once with an aggregated warning when diagnostics are found", () => {
    writeFileSync(join(projectAgentsDir, "bad1.md"), "---\ndescription: 42\n---\n");
    writeFileSync(join(projectAgentsDir, "bad2.md"), "---\ndescription: valid\nthinking: nope\n---\n");
    writeFileSync(join(projectAgentsDir, "good.md"), "---\ndescription: valid\n---\n");

    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    const ctx = createMockContext({ cwd: tmpDir });
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(level).toBe("warning");
    expect(message).toContain("bad1.md");
    expect(message).toContain("bad2.md");
    expect(message).not.toContain("good.md");
  });

  it("does not notify when discovery is clean, including on reload", () => {
    writeFileSync(join(projectAgentsDir, "good.md"), "---\ndescription: valid\n---\n");

    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    const ctx = createMockContext({ cwd: tmpDir });
    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
