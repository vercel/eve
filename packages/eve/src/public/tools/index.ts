/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type BackgroundToolDefinition,
  type DisabledToolSentinel,
  defineDynamic,
  defineTool,
  disableTool,
  isDisabledToolSentinel,
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
