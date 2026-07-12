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
  type AgentStaticSkillVisibilityDefinition,
  type StaticSkillVisibilityEventName,
  type StaticSkillVisibilityEvents,
  type StaticSkillVisibility,
  type AgentWorkflowDefinition,
  type AgentWorkflowWorldDefinition,
  defineAgent,
  defineStaticSkillVisibility,
} from "#public/definitions/agent.js";
export { defineDynamic } from "#public/definitions/tool.js";
export type { DynamicResolveContext, DynamicSentinel } from "#shared/dynamic-tool-definition.js";
export {
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
  type RemoteAgentUrl,
  defineRemoteAgent,
} from "#public/definitions/remote-agent.js";
