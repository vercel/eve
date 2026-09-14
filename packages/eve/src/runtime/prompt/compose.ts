import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedInstructionsDefinition,
  ResolvedSkillDefinition,
} from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import { formatConnectionsSection } from "#runtime/prompt/connections.js";

const PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nA single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.";

const AGENT_MESSAGING_INSTRUCTION =
  "Agent messaging\nSubagent calls start durable background tasks and return immediately with a task receipt. After delegating, continue helping the user or end your turn. The task will notify you when it completes, fails, needs input, or sends an update; completion and failure notifications include the task's result. Agents you have already delegated to remain visible in the framework-authored `<agents>` conversation note. To steer delegated work, send the updated instruction to the original subagent tool with that agentId. If availability=busy, this cancels its previous task and starts a new task in the same child session, preserving its history. Forward user steering to the affected child promptly; an acknowledgement alone does not update its work. Leave unrelated background work running. If availability=available, the same call continues the idle child. Calling a subagent without agentId starts a new agent session. Use task_cancel with its taskId to stop work without sending a replacement instruction.";

/**
 * Input for composing the base authored instructions prompt for one
 * resolved agent.
 */
interface ComposeRuntimeBasePromptInput {
  connections?: readonly ResolvedConnectionDefinition[];
  instructions?: readonly ResolvedInstructionsDefinition[];
  skills?: readonly ResolvedSkillDefinition[];
  subagentsAvailable?: boolean;
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
    ...(input.subagentsAvailable ? [AGENT_MESSAGING_INSTRUCTION] : []),
    ...createConnectionsPromptBlocks(input.connections),
    ...createSkillsPromptBlocks(input.skills),
  ];
}

function createInstructionsPromptBlocks(
  instructions: readonly ResolvedInstructionsDefinition[] | undefined,
): readonly string[] {
  const systemInstructions = (instructions ?? []).filter(
    (entry) => entry.role === "system" && entry.content.trim().length > 0,
  );
  if (systemInstructions.length === 0) {
    return [];
  }

  const only = systemInstructions.length === 1 ? systemInstructions[0] : undefined;
  const name = only !== undefined && only.owner.kind !== "extension" ? only.name : "instructions";
  const content = systemInstructions
    .map((entry) => entry.content)
    .join("\n\n")
    .trim();
  return [`Instructions (${name})\n${content}`];
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
