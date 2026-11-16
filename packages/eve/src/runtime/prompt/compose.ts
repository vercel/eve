import type { ResolvedInstructionsDefinition } from "#runtime/types.js";

/**
 * The agent's static system instructions as one block: the content of every non-empty one, under
 * a single name (the file's, when there's only one of the agent's own).
 */
export function agentInstructionsOf(
  instructions:
    | readonly Pick<ResolvedInstructionsDefinition, "content" | "name" | "owner" | "role">[]
    | undefined,
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
