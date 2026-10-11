import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { preserveImpToolPrompt } from "../src/tool-prompt.js";

type Options = NonNullable<Parameters<typeof preserveImpToolPrompt>[0]["systemPromptOptions"]> & {
  cwd: string;
  appendSystemPrompt?: string;
  contextFiles?: { path: string; content: string }[];
};
function options(): Options {
  return {
    customPrompt: "You are a reviewer, not a generic coding assistant.",
    cwd: "/project",
    appendSystemPrompt: "Keep the user's append.",
    contextFiles: [{ path: "/project/AGENTS.md", content: "Keep project context." }],
    selectedTools: ["batch", "read", "batch", "blank"],
    toolSnippets: {
      batch: "  Batch selected calls.  ",
      read: " Read a file. ",
      blank: " \n ",
      unavailable: "Hidden snippet",
    },
    promptGuidelines: [" Use batch for independent calls. ", "", "Use batch for independent calls.", "  "],
  };
}
function effectiveOld(input: Options) {
  const systemPrompt = buildSystemPrompt(input);
  return preserveImpToolPrompt({ systemPrompt, systemPromptOptions: input })?.systemPrompt ?? systemPrompt;
}
// Synthetic normalized newer SDK fixture: custom body, addendum/context and
// arbitrary sections render independently. No copied default Pi scaffold.
function renderNew(input: Options) {
  if (input.forceSystemPrompt !== undefined) return String(input.forceSystemPrompt);
  return [
    input.customPrompt,
    input.appendSystemPrompt,
    ...(input.contextFiles?.map((f) => f.content) ?? []),
    input.cwd,
    ...Object.entries(input.sections ?? {}).map(([name, text]) => `<${name}>\n${text}\n</${name}>`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
function assertGuidance(prompt: string) {
  expect(prompt).toContain("You are a reviewer, not a generic coding assistant.");
  expect(prompt).toContain("Keep the user's append.");
  expect(prompt).toContain("Keep project context.");
  expect(prompt).toContain("/project");
  expect(prompt.match(/- batch: Batch selected calls\./g)).toHaveLength(1);
  expect(prompt.match(/- Use batch for independent calls\./g)).toHaveLength(1);
  expect(prompt).toContain("- read: Read a file.");
  expect(prompt).not.toContain("blank:");
  expect(prompt).not.toContain("Hidden");
  expect(prompt).not.toContain("Pi documentation");
  expect(prompt).not.toContain("You are an expert coding assistant");
}

describe("preserveImpToolPrompt effective output", () => {
  it("restores old flattened runtime metadata through the returned prompt", () => {
    const input = options();
    const base = buildSystemPrompt(input);
    expect(base).not.toContain("Batch selected calls.");
    const output = effectiveOld(input);
    assertGuidance(output);
    expect(output.startsWith(base)).toBe(true);
    expect(preserveImpToolPrompt({ systemPrompt: output, systemPromptOptions: input })).toBeUndefined();
    input.selectedTools = ["read"];
    input.promptGuidelines = ["Read carefully."];
    const next = effectiveOld(input);
    expect(next).toContain("Read carefully.");
    expect(next).not.toContain("Batch selected calls.");
    expect(next).not.toContain("Use batch");
  });

  it("renders newer selected per-tool and global guidelines once, preserving existing sections", () => {
    const input = options();
    input.toolGuidelines = {
      batch: [" Use batch for independent calls. ", ""],
      read: ["Read carefully."],
      unavailable: ["Hidden guideline"],
    };
    input.sections = { imp_tool_guidance: "Existing extension text.", custom: "User section." };
    const event = { systemPrompt: renderNew(input), systemPromptOptions: input };
    expect(preserveImpToolPrompt(event)).toBeUndefined();
    assertGuidance(renderNew(input));
    expect(renderNew(input)).toContain("Existing extension text.");
    expect(renderNew(input)).toContain("User section.");
    preserveImpToolPrompt(event);
    assertGuidance(renderNew(input));
    input.sections.imp_tool_guidance += "\n\nLater extension text.";
    input.selectedTools = ["read"];
    input.promptGuidelines = [];
    preserveImpToolPrompt(event);
    expect(renderNew(input)).not.toContain("Batch selected calls.");
    expect(renderNew(input)).not.toContain("Use batch");
    expect(renderNew(input)).toContain("Read carefully.");
    input.selectedTools = [];
    preserveImpToolPrompt(event);
    expect(input.sections.imp_tool_guidance).toBe("Existing extension text.\n\nLater extension text.");
    delete input.sections.imp_tool_guidance;
    input.selectedTools = ["read"];
    preserveImpToolPrompt(event);
    expect(renderNew(input)).toContain("Read carefully.");
    input.selectedTools = [];
    preserveImpToolPrompt(event);
    expect(input.sections).toEqual({ custom: "User section." });
  });

  it.each([undefined, "", " \n "])("leaves default/empty custom prompts unchanged: %j", (customPrompt) => {
    const input = { ...options(), customPrompt };
    const before = buildSystemPrompt(input);
    expect(effectiveOld(input)).toBe(before);
    input.sections = { custom: "Untouched" };
    expect(preserveImpToolPrompt({ systemPrompt: before, systemPromptOptions: input })).toBeUndefined();
    expect(input.sections).toEqual({ custom: "Untouched" });
  });

  it("leaves missing options, opaque forced prompts, and blank metadata unchanged", () => {
    expect(preserveImpToolPrompt({ systemPrompt: "opaque" })).toBeUndefined();
    for (const sections of [undefined, {}]) {
      const input = { ...options(), sections, forceSystemPrompt: "" };
      expect(preserveImpToolPrompt({ systemPrompt: "opaque", systemPromptOptions: input })).toBeUndefined();
      expect(input.sections).toEqual(sections);
    }
    const input = { ...options(), selectedTools: [], promptGuidelines: ["", "  "] };
    expect(effectiveOld(input)).toBe(buildSystemPrompt(input));
  });
});
