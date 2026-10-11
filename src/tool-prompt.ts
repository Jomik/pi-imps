import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

// Track only our insertion, not tool metadata, so reused sections can be refreshed
// without losing text installed by the user or another extension.
const insertions = new WeakMap<Record<string, string>, { before: string; after: string }>();

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

  // Normalized newer options expose mutable sections that the runner rebuilds.
  const sections = options.sections;
  if (sections && typeof sections === "object" && !Array.isArray(sections)) {
    const current = sections.imp_tool_guidance ?? "";
    const previous = insertions.get(sections);
    const before =
      previous?.after && current.startsWith(previous.after)
        ? previous.before + current.slice(previous.after.length)
        : current;
    const after = [before, guidance].filter(Boolean).join("\n\n");
    if (after) sections.imp_tool_guidance = after;
    else delete sections.imp_tool_guidance;
    insertions.set(sections, { before, after });
    return undefined;
  }

  // Pi 0.85.1 ignores option mutations; its supported return hook is required.
  if (!guidance || event.systemPrompt.endsWith(`\n\n${guidance}`)) return undefined;
  return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
}
