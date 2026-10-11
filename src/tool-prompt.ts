import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** Retain runtime-provided tool guidance when an imp replaces Pi's default prompt. */
export function preserveImpToolPrompt(
  event: Pick<BeforeAgentStartEvent, "systemPrompt"> & {
    systemPromptOptions?: {
      customPrompt?: string;
      forceSystemPrompt?: unknown;
      selectedTools?: string[];
      toolSnippets?: Record<string, string>;
      toolGuidelines?: Record<string, string[]>;
      promptGuidelines?: string[];
      sections?: Record<string, string>;
    };
  },
) {
  const options = event.systemPromptOptions;
  if (!options?.customPrompt?.trim() || options.forceSystemPrompt !== undefined) return undefined;

  const snippets = new Set<string>();
  const guidelines = new Set<string>();
  for (const name of new Set(options.selectedTools ?? [])) {
    const snippet = options.toolSnippets?.[name]?.trim();
    if (snippet) snippets.add(`- ${name}: ${snippet}`);
    for (const guideline of options.toolGuidelines?.[name] ?? []) {
      if (guideline.trim()) guidelines.add(`- ${guideline.trim()}`);
    }
  }
  // Older Pi has already flattened the selected tools' guidelines here.
  for (const guideline of options.promptGuidelines ?? []) {
    if (guideline.trim()) guidelines.add(`- ${guideline.trim()}`);
  }
  const guidance = [
    snippets.size ? `Available tools:\n${[...snippets].join("\n")}` : "",
    guidelines.size ? `Guidelines:\n${[...guidelines].join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Guidance is computed at agent start; mid-run tool reconfiguration takes effect next start.
  // Newer Pi normalizes fresh mutable sections for each agent start.
  const sections = options.sections;
  if (sections && typeof sections === "object" && !Array.isArray(sections)) {
    const current = sections.imp_tool_guidance ?? "";
    if (guidance && current !== guidance && !current.endsWith(`\n\n${guidance}`)) {
      sections.imp_tool_guidance = [current, guidance].filter(Boolean).join("\n\n");
    }
    return undefined;
  }

  // Pi 0.85.1 ignores option mutations; its supported return hook is required.
  if (!guidance || event.systemPrompt.endsWith(`\n\n${guidance}`)) return undefined;
  return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
}
