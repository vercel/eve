import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalPolicy,
} from "#approval/definition.js";
import type { JsonObject } from "#shared/json.js";
import {
  readDurableDynamicCallback,
  stampDurableDynamicCallback,
} from "#tools/durable-callbacks.js";

const NEVER_APPROVAL = Symbol.for("eve:approval-policy:never");

function alwaysApproval(_closure: JsonObject): "user-approval" {
  return "user-approval";
}

function neverApproval(_closure: JsonObject): "not-applicable" {
  return "not-applicable";
}

// Authored modules and the harness can load separate copies of eve.
Object.defineProperty(neverApproval, NEVER_APPROVAL, { value: true });

function onceApproval(
  _closure: JsonObject,
  context: ApprovalContext,
): "not-applicable" | "user-approval" {
  return context.approvedTools.has(context.toolName) ? "not-applicable" : "user-approval";
}

/**
 * Returns an `approval` callback that always requires user approval before
 * the tool executes.
 */
export function always<TInput = unknown>(): ApprovalPolicy<TInput> {
  return stampDurableDynamicCallback(() => "user-approval", {
    callback: alwaysApproval,
    closure: {},
  });
}

/**
 * Returns an `approval` callback that never requires user approval before
 * the tool executes.
 */
export function never<TInput = unknown>(): ApprovalPolicy<TInput> {
  return stampDurableDynamicCallback(() => "not-applicable", {
    callback: neverApproval,
    closure: {},
  });
}

export function isNeverApproval(approval: Approval<any>): boolean {
  const callback = readDurableDynamicCallback(resolveApprovalPolicy(approval))?.callback;
  return callback !== undefined && Reflect.get(callback, NEVER_APPROVAL) === true;
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
    { callback: onceApproval, closure: {} },
  );
}
