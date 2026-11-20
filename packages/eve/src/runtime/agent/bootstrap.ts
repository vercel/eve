import type { PreparedRuntimeTool } from "#runtime/sessions/turn.js";
import type { ResolvedAgent, ResolvedAgentDefinition } from "#runtime/types.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type {
  AgentReasoningDefinition,
  InternalAgentModelDefinition,
} from "#shared/agent-definition.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export const BOOTSTRAP_RUNTIME_MODEL_ID = "eve-bootstrap-model";

export type RuntimeModelReference = Readonly<
  InternalAgentModelDefinition & { reasoning?: AgentReasoningDefinition }
>;

export type RuntimeDynamicModelReference = Readonly<ModuleSourceRef>;

interface RuntimeTurnAgentBase {
  readonly id: string;
  readonly compactionModel?: RuntimeModelReference;
  readonly nodeId?: string;
  readonly reasoning?: ResolvedAgentDefinition["reasoning"];
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

export const BOOTSTRAP_RUNTIME_SYSTEM_PROMPT =
  "You are the eve bootstrap agent. Be concise, stay grounded in the current conversation, and do not assume tools are available unless the runtime provides them.";

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
  const base: RuntimeTurnAgentBase = {
    id,
    compactionModel: config?.compaction?.model,
    nodeId: input.nodeId,
    reasoning: config?.reasoning,
    tools: [...input.tools],
    workspaceSpec: agent.workspaceSpec,
  };

  if (config === undefined) return { ...base, configResolver: true };
  return config.dynamicModel === undefined
    ? { ...base, model: config.model }
    : { ...base, dynamicModel: config.dynamicModel };
}
