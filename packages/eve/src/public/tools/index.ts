/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type DisabledToolSentinel,
  type ExperimentalWorkflowToolDefinition,
  type ExperimentalWorkflowToolInput,
  defineDynamic,
  defineTool,
  disableTool,
  experimental_workflow,
  isDisabledToolSentinel,
  isExperimentalWorkflowToolDefinition,
  type ToolAuthOptions,
  type ToolAuthProvider,
  type ToolDefinition,
  type ToolContext,
  type ToolModelOutput,
} from "#public/definitions/tool.js";
export type { Approval, ApprovalContext, ApprovalStatus } from "#public/definitions/approval.js";
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
export { type DefineBashToolInput, defineBashTool } from "#public/tools/define-bash-tool.js";
export { type DefineGlobToolInput, defineGlobTool } from "#public/tools/define-glob-tool.js";
export { type DefineGrepToolInput, defineGrepTool } from "#public/tools/define-grep-tool.js";
export {
  type DefineReadFileToolInput,
  defineReadFileTool,
} from "#public/tools/define-read-file-tool.js";
export {
  type DefineWriteFileToolInput,
  defineWriteFileTool,
} from "#public/tools/define-write-file-tool.js";
