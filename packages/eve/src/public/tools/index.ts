/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type DisabledToolSentinel,
  defineTool,
  disableTool,
  isDisabledToolSentinel,
  type ToolLabelDefinition,
  type ToolAuthOptions,
  type ToolAuthProvider,
  type ToolDefinition,
  type ToolContext,
  type ToolModelOutput,
  type ToolModelOutputPart,
} from "#tools/definition.js";
export { defineDynamic } from "#dynamic/definition.js";
export { defineDurableSchema } from "#tools/durable-schema.js";
export { defineDurableCallback } from "#tools/durable-callbacks.js";
export { toolOutput, toolOutputPart } from "#tools/model-output.js";
export type { DynamicEvents, DynamicResolveContext, DynamicSentinel } from "#dynamic/definition.js";
export type {
  DynamicToolEntry,
  DynamicToolEvents,
  DynamicToolSet,
  DynamicToolResult,
} from "#tools/dynamic.js";
export { type SessionContext } from "#public/definitions/callback-context.js";
export {
  toolResultFrom,
  type MatchedConnectionResult,
  type MatchedToolResult,
  type ToolResultFromFn,
} from "#public/tools/result.js";

export {
  defineWorkflowTool,
  type WorkflowStepToolContext,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
  type AgentMessageResult,
  type AgentResponse,
  type AgentSendOptions,
  type AgentSession,
  type WorkflowAgentMetadata,
} from "#tools/workflow-definition.js";
export type {
  ToolInputRequest,
  ToolInputRequestOptions,
  ToolInputResponse,
} from "#tools/definition.js";
