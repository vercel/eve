/**
 * Core agent authoring helpers for `agent/agent.ts`.
 */

export {
  type AgentCompactionDefinition,
  type AgentDefinition,
  type AgentExperimentalDefinition,
  type AgentLimitsDefinition,
  type AgentModelDefinition,
  type AgentModelOptionsDefinition,
  type AgentReasoningDefinition,
  type AgentStaticModelDefinition,
  type AgentWorkflowDefinition,
  type AgentWorkflowWorldDefinition,
  type DefinedAgent,
  type DynamicSubagentDefinition,
  type DynamicLocalSubagentDefinition,
  defineAgent,
  defineDynamic,
} from "#public/definitions/agent.js";
export type { DynamicResolveContext, DynamicSentinel } from "#shared/dynamic-tool-definition.js";
export {
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
  type RemoteAgentUrl,
  defineRemoteAgent,
} from "#public/definitions/remote-agent.js";
