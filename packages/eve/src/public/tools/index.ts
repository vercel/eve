/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type DisabledToolSentinel,
  defineTool,
  disableTool,
  isDisabledToolSentinel,
  type ApprovalResponder,
  type ApprovedCall,
  type ToolLabelDefinition,
  type ToolAuthOptions,
  type ToolAuthProvider,
  type ToolDefinition,
  type ToolContext,
  type ToolModelOutput,
  type ToolModelOutputPart,
} from "#tools/definition.js";
export { defineDynamic } from "#tools/dynamic.js";
export { toolOutput, toolOutputPart } from "#tools/model-output.js";
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
export type { DynamicToolEntry, DynamicToolSet, DynamicToolResult } from "#tools/dynamic.js";
export {
  toolResultFrom,
  type MatchedConnectionResult,
  type MatchedToolResult,
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
  type AgentSessionModelSelection,
  type AgentSessionOptions,
  type WorkflowAgentMetadata,
} from "#tools/workflow-definition.js";
export type { ToolQuestion, ToolAskOptions, ToolAnswer } from "#tools/definition.js";
