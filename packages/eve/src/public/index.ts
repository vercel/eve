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
  type AgentWorkflowRetentionDefinition,
  type AgentWorkflowWorldDefinition,
  type DefinedAgent,
  type SessionUsageLimit,
  type DynamicSubagentDefinition,
  type DynamicLocalSubagentDefinition,
  type DynamicSubagentResult,
  defineAgent,
  defineDynamic,
} from "#public/definitions/agent.js";
export type {
  DynamicContext,
  DynamicKey,
  DynamicModelContext,
  DynamicSentinel,
  DynamicTurn,
  Memo,
  Occurrence,
  SessionFrame,
} from "#dynamic/definition.js";
export {
  defineWorkspaceAgent,
  type WorkspaceAgentDefinition,
  type WorkspaceAgentTransport,
} from "#public/definitions/workspace-agent.js";
export {
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
  type RemoteAgentUrl,
  defineRemoteAgent,
} from "#public/definitions/remote-agent.js";

export type {
  AgentBuildDefinition,
  AgentPromptCacheDefinition,
  AgentToolExposure,
} from "#shared/agent-definition.js";
