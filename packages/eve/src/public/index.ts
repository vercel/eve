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
  type LocalSubagentDefinition,
  type LocalSubagentDefinitionInput,
  defineAgent,
  defineDynamic,
  defineLocalSubagent,
} from "#public/definitions/agent.js";
export type { DynamicResolveContext, DynamicSentinel } from "#dynamic/definition.js";
export {
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
  type RemoteAgentUrl,
  type RemoteSubagentDefinition,
  type RemoteSubagentDefinitionInput,
  defineRemoteAgent,
  defineRemoteSubagent,
} from "#public/definitions/remote-agent.js";
