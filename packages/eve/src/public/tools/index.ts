/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type BackgroundToolDefinition,
  type DisabledToolSentinel,
  type ExperimentalWorkflowToolDefinition,
  type ExperimentalWorkflowToolInput,
  defineDynamic,
  defineTool,
  disableTool,
  experimental_workflow,
  isDisabledToolSentinel,
  isExperimentalWorkflowToolDefinition,
  type TaskBinding,
  type TaskDelegated,
  type TaskExec,
  type TaskExecutorBinding,
  type TaskReceipt,
  type ToolAuthOptions,
  type ToolAuthProvider,
  type ToolDefinition,
  type ToolContext,
  type ToolModelOutput,
  type ToolModelOutputPart,
} from "#public/definitions/tool.js";
export { toolOutput, toolOutputPart } from "#public/tools/output-builders.js";
export type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalResponseAuth,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalResponsePolicy,
  ApprovalResponseSession,
  ApprovalStatus,
} from "#public/definitions/approval.js";
export type {
  DynamicToolEntry,
  DynamicEvents,
  DynamicToolEvents,
  DynamicResolveContext,
  DynamicSentinel,
  DynamicToolSet,
  DynamicToolResult,
} from "#shared/dynamic-tool-definition.js";
export { type SessionContext } from "#public/definitions/callback-context.js";
export {
  toolResultFrom,
  type MatchedConnectionResult,
  type MatchedToolResult,
  type ToolResultFromFn,
} from "#public/tool-result-narrowing.js";
export { type DefineBashToolInput, defineBashTool } from "#public/tools/bash.js";
export { type DefineGlobToolInput, defineGlobTool } from "#public/tools/glob.js";
export { type DefineGrepToolInput, defineGrepTool } from "#public/tools/grep.js";
export { type DefineReadFileToolInput, defineReadFileTool } from "#public/tools/read-file.js";
export { type DefineWriteFileToolInput, defineWriteFileTool } from "#public/tools/write-file.js";
export {
  type WebSearchProvider,
  type WebSearchToolDefinition,
  type WebSearchToolInput,
  webSearch,
} from "#public/tools/web-search.js";
