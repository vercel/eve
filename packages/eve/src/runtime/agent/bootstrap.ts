import { AGENT_TOOL_NAME, isImplicitAgentToolAvailable } from "#runtime/framework-tools/agent.js";
import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import type { ResolvedAgent } from "#runtime/types.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type { InternalAgentModelDefinition } from "#shared/agent-definition.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AvailableSkillDescription } from "#execution/skills/instructions.js";

/**
 * Fixed internal model reference used only by the framework-owned bootstrap
 * runtime path.
 */
export const BOOTSTRAP_RUNTIME_MODEL_ID = "eve-bootstrap-model";

/**
 * Runtime-owned model identifier prepared for one harness turn.
 */
export type RuntimeModelReference = Readonly<InternalAgentModelDefinition>;

/**
 * Runtime-owned reference to a dynamic model resolver authored in `agent.ts`.
 */
export type RuntimeDynamicModelReference = Readonly<
  ModuleSourceRef & {
    readonly eventNames: readonly string[];
  }
>;

/**
 * Minimal runtime-owned agent shape prepared for one harness turn.
 */
export interface RuntimeTurnAgent {
  readonly availableSkills?: readonly AvailableSkillDescription[];
  readonly id: string;
  readonly instructions: readonly string[];
  /**
   * Optional model used only for compaction summaries.
   *
   * When omitted, the harness uses the active turn model for compaction.
   */
  readonly compactionModel?: RuntimeModelReference;
  readonly dynamicModel?: RuntimeDynamicModelReference;
  readonly model: RuntimeModelReference;
  readonly nodeId?: string;
  readonly outputSchema?: ResolvedAgent["config"]["outputSchema"];
  readonly reasoning?: ResolvedAgent["config"]["reasoning"];
  readonly tools: readonly PreparedRuntimeTool[];
  readonly workspaceSpec: WorkspaceRuntimeSpec;
}

/**
 * Static system prompt for the bootstrap runtime path.
 */
export const BOOTSTRAP_RUNTIME_SYSTEM_PROMPT =
  "You are the eve bootstrap agent. Be concise, stay grounded in the current conversation, and do not assume tools are available unless the runtime provides them.";

/**
 * Creates the runtime-owned turn-preparation shape from a resolved authored
 * agent and the authored tool descriptors prepared for the harness.
 */
export function createResolvedRuntimeTurnAgent(input: {
  readonly agent: ResolvedAgent;
  readonly nodeId?: string;
  readonly tools: readonly PreparedRuntimeTool[];
}): RuntimeTurnAgent {
  const agent = input.agent;
  const subagentDeclaredTool = input.tools.some(
    (tool) => tool.kind === "subagent" || tool.kind === "remote",
  );
  // The framework `agent` tool is injected after graph resolution, so
  // declared tools alone under-count. isImplicitAgentToolAvailable is the
  // same predicate node-step uses for the injection itself — including the
  // authored-tool shadowing leg, so instructions never advertise a tool an
  // authored "agent" tool has replaced.
  const subagentImplicitRootTool = isImplicitAgentToolAvailable({
    disabledFrameworkTools: agent.disabledFrameworkTools,
    hasAuthoredAgentTool: input.tools.some((tool) => tool.name === AGENT_TOOL_NAME),
    nodeId: input.nodeId,
  });
  return {
    availableSkills: agent.skills.map((skill) => ({
      description: skill.description,
      name: skill.name,
    })),
    id: agent.config.name,
    instructions: composeRuntimeBasePrompt({
      connections: agent.connections,
      instructions: agent.instructions,
      persistentSubagentSessions: agent.config.experimental?.subagentPersistentSessions === true,
      subagentsAvailable: subagentDeclaredTool || subagentImplicitRootTool,
      toolsAvailable: input.tools.length > 0 || subagentImplicitRootTool,
      workspaceSpec: agent.workspaceSpec,
    }),
    compactionModel: agent.config.compaction?.model,
    dynamicModel: agent.config.dynamicModel,
    model: agent.config.model,
    nodeId: input.nodeId,
    outputSchema: agent.config.outputSchema,
    reasoning: agent.config.reasoning,
    tools: [...input.tools],
    workspaceSpec: agent.workspaceSpec,
  };
}
