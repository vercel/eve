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
export { defineDynamic } from "#tools/dynamic.js";
export { serializeModelInputSchema } from "#tools/schema.js";
export { toolOutput, toolOutputPart } from "#tools/model-output.js";
export type {
  DynamicSentinel,
  ReactionView,
  ResolveContext,
  SelectContext,
} from "#dynamic/definition.js";
export type { DynamicToolEntry, DynamicToolSet, DynamicToolResult } from "#tools/dynamic.js";
export { type SessionContext } from "#public/definitions/callback-context.js";
export {
  toolResultFrom,
  type MatchedConnectionResult,
  type MatchedToolResult,
  type SettledCallRow,
  type ToolResultFromFn,
  type ToolResultSource,
} from "#public/tools/result.js";

export {
  defineWorkflowTool,
  type WorkflowExecuteToolDefinition,
  type WorkflowServeCall,
  type WorkflowServeContext,
  type WorkflowServeReceive,
  type WorkflowServeToolDefinition,
  type WorkflowStepToolContext,
  type WorkflowTaskToolDefinition,
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
