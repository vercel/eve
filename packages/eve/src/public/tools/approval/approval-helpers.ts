import type { ApprovalContext, ApprovalPolicy } from "#public/definitions/approval.js";
import type { JsonObject } from "#shared/json.js";
import {
  registerDurableDynamicCallback,
  stampDurableDynamicCallback,
} from "#shared/durable-dynamic-tool-callbacks.js";

const ALWAYS_STEP_ID = "eve:dynamic-tool-helper//approval/always/v1";
const NEVER_STEP_ID = "eve:dynamic-tool-helper//approval/never/v1";
const ONCE_STEP_ID = "eve:dynamic-tool-helper//approval/once/v1";

function alwaysApproval(_closure: JsonObject): "user-approval" {
  return "user-approval";
}

function neverApproval(_closure: JsonObject): "not-applicable" {
  return "not-applicable";
}

function onceApproval(
  _closure: JsonObject,
  context: ApprovalContext,
): "not-applicable" | "user-approval" {
  return context.approvedTools.has(context.toolName) ? "not-applicable" : "user-approval";
}

registerDurableDynamicCallback(ALWAYS_STEP_ID, alwaysApproval);
registerDurableDynamicCallback(NEVER_STEP_ID, neverApproval);
registerDurableDynamicCallback(ONCE_STEP_ID, onceApproval);

/**
 * Returns an `approval` callback that always requires user approval before
 * the tool executes.
 */
export function always<TInput = unknown>(): ApprovalPolicy<TInput> {
  return stampDurableDynamicCallback(() => "user-approval", {
    closure: {},
    stepId: ALWAYS_STEP_ID,
  });
}

/**
 * Returns an `approval` callback that never requires user approval before
 * the tool executes.
 */
export function never<TInput = unknown>(): ApprovalPolicy<TInput> {
  return stampDurableDynamicCallback(() => "not-applicable", {
    closure: {},
    stepId: NEVER_STEP_ID,
  });
}

/**
 * Returns an `approval` callback that requires approval until the user
 * approves this tool once in the current session. A tool is recorded as
 * approved only on an explicit approval; a denial (or continuing without
 * responding) leaves it unrecorded, so the next call prompts again. Keys off
 * the bare tool name, so it ignores compound approval keys.
 */
export function once<TInput = unknown>(): ApprovalPolicy<TInput> {
  return stampDurableDynamicCallback(
    ({ approvedTools, toolName }) =>
      approvedTools.has(toolName) ? "not-applicable" : "user-approval",
    { closure: {}, stepId: ONCE_STEP_ID },
  );
}
