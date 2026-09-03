/**
 * Tool authoring helpers for `agent/tools/*.ts` files.
 */

export {
  type BackgroundToolDefinition,
  type DisabledToolSentinel,
  defineTool,
  disableTool,
  isDisabledToolSentinel,
  type TaskExec,
  type TaskReceipt,
  type ToolAuthOptions,
  type ToolAuthProvider,
  type ToolDefinition,
  type ToolContext,
  type ToolModelOutput,
  type ToolModelOutputPart,
} from "#tools/definition.js";
export { defineDynamic } from "#dynamic/definition.js";
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
