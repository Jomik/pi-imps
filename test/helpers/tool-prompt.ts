import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import type { preserveImpToolPrompt } from "../../src/tool-prompt.js";

export type PromptOptions = NonNullable<Parameters<typeof preserveImpToolPrompt>[0]["systemPromptOptions"]> & {
  cwd: string;
  appendSystemPrompt?: string;
  contextFiles?: { path: string; content: string }[];
};

/** Exercise the installed runner's old returned-prompt or modern structured-options contract. */
export async function effectiveRunnerPrompt(runner: ExtensionRunner, prompt: string, input: PromptOptions) {
  const build = buildSystemPrompt as (options: PromptOptions) => string;
  const base = build(input);
  const emit = runner.emitBeforeAgentStart as unknown as (
    ...args: unknown[]
  ) => Promise<{ systemPrompt?: string; systemPromptOptions?: PromptOptions } | undefined>;
  expect([3, 4]).toContain(emit.length);
  const modern = emit.length === 3;
  const result = await emit.call(runner, prompt, undefined, ...(modern ? [input] : [base, input]));
  if (modern) {
    expect(result?.systemPrompt).toBeUndefined();
    expect(result?.systemPromptOptions).toMatchObject({
      selectedTools: input.selectedTools,
      toolSnippets: input.toolSnippets,
      toolGuidelines: input.toolGuidelines,
      promptGuidelines: input.promptGuidelines,
    });
    expect(result?.systemPromptOptions?.sections).toBeDefined();
  } else {
    expect(result?.systemPromptOptions).toBeUndefined();
    if (result) expect(typeof result.systemPrompt).toBe("string");
  }
  return {
    base,
    effective: modern ? build(result?.systemPromptOptions as PromptOptions) : (result?.systemPrompt ?? base),
  };
}
