import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMockContext } from "./helpers/index.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentDir: vi.fn(() => "/nonexistent-pi-agent-dir-for-testing-xyz"),
  };
});

const extensionFactory = (await import("../src/index.js")).default;

function createMockPi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerTool = vi.fn();
  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    }),
    registerTool,
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerTool };
}

describe("ordinary pi-imps extension behavior", () => {
  it("registers exactly the four built-in imp tools and never agent_done", () => {
    const { pi, registerTool } = createMockPi();
    extensionFactory(pi);

    const registeredNames = registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(registeredNames).toEqual(["summon", "wait", "dismiss", "list_imps"]);
    expect(registeredNames).not.toContain("agent_done");
  });

  it("before_agent_start leaves the system prompt unchanged when no agents are discovered", () => {
    const { pi, handlers } = createMockPi();
    extensionFactory(pi);

    handlers.get("session_start")?.({ reason: "startup" }, createMockContext());
    const result = handlers.get("before_agent_start")?.(
      { prompt: "Fix the failing test", systemPrompt: "base system prompt" },
      createMockContext(),
    );

    expect(result).toBeUndefined();
  });
});
