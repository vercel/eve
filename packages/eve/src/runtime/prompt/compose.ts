import type { ResolvedInstructionsDefinition } from "#runtime/types.js";

/** eve's note on parallel tool calls, part of the default prompt when the agent has tools. */
export const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nTool calls in one response run in parallel, so batch only calls that don't depend on each other.";

/**
 * The agent's static system instructions as one block: the content of every non-empty one, under
 * a single name (the file's, when there's only one of the agent's own).
 */
export function agentInstructionsOf(
  instructions: readonly ResolvedInstructionsDefinition[] | undefined,
): { readonly name: string; readonly content: string } | undefined {
  const systemInstructions = (instructions ?? []).filter(
    (entry) => entry.role === "system" && entry.content.trim().length > 0,
  );
  if (systemInstructions.length === 0) return undefined;
  const only = systemInstructions.length === 1 ? systemInstructions[0] : undefined;
  const name = only !== undefined && only.owner.kind !== "extension" ? only.name : "instructions";
  const content = systemInstructions
    .map((entry) => entry.content)
    .join("\n\n")
    .trim();
  return { content, name };
}

/** The agent's instructions block in eve's default prompt. */
export function renderInstructionsBlock(block: {
  readonly name: string;
  readonly content: string;
}): string {
  return `Instructions (${block.name})\n${block.content}`;
}
