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
  type Harness,
  type HarnessAgent,
  type HarnessDeclared,
  type HarnessDeclaredInstructions,
  type HarnessDeclaredTools,
  type HarnessCompaction,
  type HarnessContext,
  type HarnessDefinition,
  type HarnessModelStep,
  type HarnessNext,
  type HarnessPlan,
  defineHarness,
} from "#public/definitions/harness.js";
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
  EveLanguageModel,
} from "#shared/agent-definition.js";
// Named in `limits.sessionUsage` callbacks, so declaration emit for `agent.ts` must reach it.
export type { TokenUsage } from "#shared/token-usage.js";
