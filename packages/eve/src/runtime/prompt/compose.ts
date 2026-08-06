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
  "Agent messaging\nAgents you have already delegated to stay available after they answer. eve injects the current `<agents>` list into the conversation as a note labeled `[Agents]`; it is added automatically by the framework, not written by the user, and never requires a reply. The list is only a record of those existing agents — their `agentId`, name, and latest status. It does not limit which subagent tools you can call: your tool list is the source of truth, and any subagent tool can always be called without `agentId` to start a new agent, including when the `<agents>` list is empty or absent. Pass `agentId` to the same subagent tool only to continue one of those existing agents' sessions.";

/**
 * Input for composing the base authored instructions prompt for one
 * resolved agent.
 */
interface ComposeRuntimeBasePromptInput {
  connections?: readonly ResolvedConnectionDefinition[];
  instructions?: ResolvedInstructionsDefinition;
  /**
   * Whether the agent opted into `experimental.subagentPersistentSessions`.
   * Gates the agent-messaging prompt block that documents `agentId`
   * continuation and the `<agents>` listing.
   */
  persistentSubagentSessions?: boolean;
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
    ...(input.subagentsAvailable && input.persistentSubagentSessions
      ? [AGENT_MESSAGING_INSTRUCTION]
      : []),
    ...createConnectionsPromptBlocks(input.connections),
    ...createSkillsPromptBlocks(input.skills),
  ];
}

function createInstructionsPromptBlocks(
  instructions: ResolvedInstructionsDefinition | undefined,
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
