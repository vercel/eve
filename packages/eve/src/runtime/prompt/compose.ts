import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedInstructions,
  ResolvedSkillDefinition,
} from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import { formatConnectionsSection } from "#runtime/prompt/connections.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";

const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nA single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.";

export const CONDITIONAL_DELIVERY_INSTRUCTION = `Conditional delivery\nOnly when the current task explicitly makes delivery conditional and there is nothing to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text. Do not use this marker for ordinary conversations, after input or approval responses, or merely because you have no additional commentary. Never return an empty response; use the marker to intentionally deliver nothing.`;

/**
 * Input for composing the base authored instructions prompt for one
 * resolved agent.
 */
interface ComposeRuntimeBasePromptInput {
  connections?: readonly ResolvedConnectionDefinition[];
  instructions?: ResolvedInstructions;
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
    CONDITIONAL_DELIVERY_INSTRUCTION,
    ...createConnectionsPromptBlocks(input.connections),
    ...createSkillsPromptBlocks(input.skills),
  ];
}

function createInstructionsPromptBlocks(
  instructions: ResolvedInstructions | undefined,
): readonly string[] {
  if (instructions === undefined) {
    return [];
  }

  const markdown = instructions.markdown.trim();

  if (markdown.length === 0) {
    return [];
  }

  return [`Instructions (${instructions.name})\n${markdown}`];
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

function createConnectionsPromptBlocks(
  connections: readonly ResolvedConnectionDefinition[] | undefined,
): readonly string[] {
  if (!connections || connections.length === 0) return [];
  return [formatConnectionsSection(connections)];
}

function createSkillsPromptBlocks(
  skills: readonly ResolvedSkillDefinition[] | undefined,
): readonly string[] {
  if (!skills || skills.length === 0) return [];
  const section = formatAvailableSkillsSection(skills);
  if (section === null) return [];
  return [section];
}
