import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type { ResolvedInstructionsDefinition, ResolvedSkillDefinition } from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";

/** eve's note on parallel tool calls, part of the default prompt when the agent has tools. */
export const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nTool calls in one response run in parallel, so batch only calls that don't depend on each other.";

/**
 * Input for composing the base authored instructions prompt for one
 * resolved agent.
 */
interface ComposeRuntimeBasePromptInput {
  instructions?: readonly ResolvedInstructionsDefinition[];
  skills?: readonly ResolvedSkillDefinition[];
  toolsAvailable?: boolean;
  workspaceSpec?: WorkspaceRuntimeSpec;
}

/**
 * Composes the authored base prompt from the resolved instructions source
 * without flattening skills into always-on instructions.
 */
export function composeRuntimeBasePrompt(input: ComposeRuntimeBasePromptInput): readonly string[] {
  return [
    ...createInstructionsPromptBlocks(input.instructions),
    ...createWorkspacePromptBlocks(input.workspaceSpec),
    ...(input.toolsAvailable ? [PARALLEL_ACTION_INSTRUCTION] : []),
    ...createSkillsPromptBlocks(input.skills),
  ];
}

function createInstructionsPromptBlocks(
  instructions: readonly ResolvedInstructionsDefinition[] | undefined,
): readonly string[] {
  const block = agentInstructionsOf(instructions);
  return block === undefined ? [] : [renderInstructionsBlock(block)];
}

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

function createWorkspacePromptBlocks(
  workspaceSpec: WorkspaceRuntimeSpec | undefined,
): readonly string[] {
  if (workspaceSpec === undefined) {
    return [];
  }

  const workspaceSection = createWorkspacePromptSection(workspaceSpec);
  return workspaceSection === undefined ? [] : [workspaceSection];
}

function createSkillsPromptBlocks(
  skills: readonly ResolvedSkillDefinition[] | undefined,
): readonly string[] {
  if (!skills || skills.length === 0) return [];
  const section = formatAvailableSkillsSection(skills);
  if (section === null) return [];
  return [section];
}
