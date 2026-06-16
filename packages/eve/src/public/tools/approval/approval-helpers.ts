import type { NeedsApprovalContext } from "#public/definitions/tool.js";

/**
 * Returns a `needsApproval` callback that always requires user approval before
 * the tool executes.
 */
export function always<TInput = unknown>(): (ctx: NeedsApprovalContext<TInput>) => boolean {
  return () => true;
}

/**
 * Returns a `needsApproval` callback that never requires user approval before
 * the tool executes.
 */
export function never<TInput = unknown>(): (ctx: NeedsApprovalContext<TInput>) => boolean {
  return () => false;
}

/**
 * Returns a `needsApproval` callback that requires approval until the user
 * approves this tool once in the current session. A tool is recorded as
 * approved only on an explicit approval; a denial (or continuing without
 * responding) leaves it unrecorded, so the next call prompts again. Keys off
 * the bare tool name, so it ignores compound approval keys.
 */
export function once<TInput = unknown>(): (ctx: NeedsApprovalContext<TInput>) => boolean {
  return ({ approvedTools, toolName }) => !approvedTools.has(toolName);
}
