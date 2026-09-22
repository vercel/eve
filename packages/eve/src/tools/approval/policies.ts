import type { Experimental_EvaluationModel as EvaluationModel } from "ai";

import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { evaluate } from "#ai/evaluate.js";
import { parseJsonValue, type JsonObject } from "#shared/json.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";

const MAX_ACTION_BYTES = 64 * 1024;

const DEFAULT_INSTRUCTIONS = `Review the exact tool action for dangerous effects. Return caution when it could cause meaningful harm, including destructive data loss, credential exposure, financial transactions, deployments or public changes, external communication, privilege or system changes, or concealed execution. Return clear for routine, low-impact actions. Judge the action's actual effects from its name and input. If important effects are unclear, return caution.`;
const DEFAULT_CLEAR_DESCRIPTION = "The action is routine and low impact.";
const DEFAULT_CAUTION_DESCRIPTION = "The action is dangerous or its important effects are unclear.";

export interface AutoApprovalOptions {
  /** Evaluation model instance or ID. Defaults to TypeSafe Jev. */
  readonly model?: EvaluationModel;
  /** Instructions used to classify the exact tool call. */
  readonly instructions?: string;
  /** Descriptions of the fixed approval outcomes. */
  readonly criteria?: {
    readonly clear?: string;
    readonly caution?: string;
  };
}

async function autoApproval(
  evaluationModel: EvaluationModel,
  options: AutoApprovalOptions,
  context: ApprovalContext,
): Promise<"approved" | "user-approval"> {
  try {
    const input = parseJsonValue(context.toolInput ?? null);
    const serializedInput = JSON.stringify(input);
    if (new TextEncoder().encode(serializedInput).byteLength > MAX_ACTION_BYTES) {
      return "user-approval";
    }
    const abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)]);
    const result = await evaluate({
      model: evaluationModel,
      state: {
        action: {
          input,
          tool: context.toolName,
        },
      },
      questions: {
        permission: {
          type: "choice",
          instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
          criteria: {
            clear: options.criteria?.clear ?? DEFAULT_CLEAR_DESCRIPTION,
            caution: options.criteria?.caution ?? DEFAULT_CAUTION_DESCRIPTION,
          },
        },
      },
      abortSignal,
      maxRetries: 0,
    });
    return result.answers.permission.choice === "clear" ? "approved" : "user-approval";
  } catch {
    context.abortSignal.throwIfAborted();
    return "user-approval";
  }
}

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

/**
 * Returns an `approval` callback that asks an AI SDK evaluation model whether
 * the exact tool call presents concrete security danger. Defaults to TypeSafe Jev.
 * Unavailable or invalid evaluations require user approval.
 */
export function auto<TInput = unknown>(options: AutoApprovalOptions = {}): ApprovalPolicy<TInput> {
  const evaluationModel = options.model ?? "typesafe-ai/jev";
  const callback = (_closure: JsonObject, context: ApprovalContext) =>
    autoApproval(evaluationModel, options, context);
  return stampDurableDynamicCallback(
    (context) => autoApproval(evaluationModel, options, context as ApprovalContext),
    { callback, closure: {} },
  ) as ApprovalPolicy<TInput>;
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
