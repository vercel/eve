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
interface RuntimeTurnAgentBase {
  readonly availableSkills?: readonly AvailableSkillDescription[];
  readonly id: string;
  readonly instructions: readonly string[];
  /**
   * Optional model used only for compaction summaries.
   *
   * When omitted, the harness uses the active turn model for compaction.
   */
  readonly compactionModel?: RuntimeModelReference;
  readonly nodeId?: string;
  readonly outputSchema?: import("#runtime/types.js").ResolvedAgentDefinition["outputSchema"];
  readonly reasoning?: import("#runtime/types.js").ResolvedAgentDefinition["reasoning"];
  readonly tools: readonly PreparedRuntimeTool[];
  readonly workspaceSpec: WorkspaceRuntimeSpec;
}

export type RuntimeTurnAgent = RuntimeTurnAgentBase &
  (
    | {
        readonly configResolver?: never;
        readonly dynamicModel?: never;
        readonly model: RuntimeModelReference;
      }
    | {
        readonly dynamicModel: RuntimeDynamicModelReference;
        readonly configResolver?: never;
        readonly model?: never;
      }
    | {
        readonly configResolver: true;
        readonly dynamicModel?: never;
        readonly model?: never;
      }
  );

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
  readonly id?: string;
  readonly nodeId?: string;
  readonly tools: readonly PreparedRuntimeTool[];
}): RuntimeTurnAgent {
  const agent = input.agent;
  const config = agent.config;
  const id = input.id ?? config?.name;
  if (id === undefined) {
    throw new Error("Expected a path-derived agent id while resolving agent resources.");
  }
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
  const base: RuntimeTurnAgentBase = {
    availableSkills: agent.skills.map((skill) => ({
      description: skill.description,
      name: skill.name,
    })),
    id,
    instructions: composeRuntimeBasePrompt({
      connections: agent.connections,
      instructions: agent.instructions,
      persistentSubagentSessions: config?.experimental?.subagentPersistentSessions === true,
      subagentsAvailable: subagentDeclaredTool || subagentImplicitRootTool,
      toolsAvailable: input.tools.length > 0 || subagentImplicitRootTool,
      workspaceSpec: agent.workspaceSpec,
    }),
    compactionModel: config?.compaction?.model,
    nodeId: input.nodeId,
    outputSchema: config?.outputSchema,
    reasoning: config?.reasoning,
    tools: [...input.tools],
    workspaceSpec: agent.workspaceSpec,
  };

  if (config === undefined) return { ...base, configResolver: true };
  return config.dynamicModel === undefined
    ? { ...base, model: config.model }
    : { ...base, dynamicModel: config.dynamicModel };
}
