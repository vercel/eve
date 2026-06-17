import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";
import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import type { ResolvedAgent } from "#runtime/types.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type { InternalAgentModelDefinition } from "#shared/agent-definition.js";

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
 * Minimal runtime-owned agent shape prepared for one harness turn.
 */
export interface RuntimeTurnAgent {
  readonly id: string;
  readonly instructions: readonly string[];
  /**
   * Optional model used only for compaction summaries.
   *
   * When omitted, the harness uses the active turn model for compaction.
   */
  readonly compactionModel?: RuntimeModelReference;
  readonly model: RuntimeModelReference;
  readonly nodeId?: string;
  readonly outputSchema?: ResolvedAgent["config"]["outputSchema"];
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
  return {
    id: agent.config.name,
    instructions: composeRuntimeBasePrompt({
      connections: agent.connections,
      instructions: agent.instructions,
      skills: agent.skills,
      toolsAvailable: input.tools.length > 0,
      workspaceSpec: agent.workspaceSpec,
    }),
    compactionModel: agent.config.compaction?.model,
    model: agent.config.model,
    nodeId: input.nodeId,
    outputSchema: agent.config.outputSchema,
    tools: [...input.tools],
    workspaceSpec: agent.workspaceSpec,
  };
}
