import type { Approval } from "#public/definitions/approval.js";

/**
 * Returns an `approval` callback that always requires user approval before
 * the tool executes.
 */
export function always<TInput = unknown>(): Approval<TInput> {
  return () => "user-approval";
}

/**
 * Returns an `approval` callback that never requires user approval before
 * the tool executes.
 */
export function never<TInput = unknown>(): Approval<TInput> {
  return () => "not-applicable";
}

/**
 * Returns an `approval` callback that requires approval until the user
 * approves this tool once in the current session. A tool is recorded as
 * approved only on an explicit approval; a denial (or continuing without
 * responding) leaves it unrecorded, so the next call prompts again. Keys off
 * the bare tool name, so it ignores compound approval keys.
 */
export function once<TInput = unknown>(): Approval<TInput> {
  return ({ approvedTools, toolName }) =>
    approvedTools.has(toolName) ? "not-applicable" : "user-approval";
}
