import type { DecisionModel } from "#ai/decision-types.js";
import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { decide } from "#ai/decide.js";
import { approvalEvaluation } from "#approval/evaluation.js";
import { parseJsonValue } from "#shared/json.js";

const MAX_ACTION_BYTES = 64 * 1024;

const DEFAULT_INSTRUCTIONS = `Review the exact tool action for dangerous effects. Return caution when it could cause meaningful harm, including destructive data loss, credential exposure, financial transactions, deployments or public changes, external communication, privilege or system changes, or concealed execution. Return clear for routine, low-impact actions. Judge the action's actual effects from its name and input. If important effects are unclear, return caution.`;
const DEFAULT_CLEAR_DESCRIPTION = "The action is routine and low impact.";
const DEFAULT_CAUTION_DESCRIPTION = "The action is dangerous or its important effects are unclear.";

export interface AutoApprovalOptions {
  /** Decision model instance or ID. Defaults to TypeSafe Jev. */
  readonly model?: DecisionModel;
  /** Instructions used to classify the exact tool call. */
  readonly instructions?: string;
  /** Descriptions of the fixed approval outcomes. */
  readonly criteria?: {
    readonly clear?: string;
    readonly caution?: string;
  };
}

async function autoApproval(
  decisionModel: DecisionModel,
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
    const result = await decide({
      model: decisionModel,
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
      signal: abortSignal,
      maxRetries: 0,
    });
    return result.answers.permission.choice === "clear" ? "approved" : "user-approval";
  } catch {
    context.abortSignal.throwIfAborted();
    return "user-approval";
  }
}

/**
 * Returns an `approval` callback that asks an AI SDK decision model whether
 * the exact tool call presents concrete security danger. Defaults to TypeSafe Jev.
 * Unavailable or invalid decisions require user approval.
 */
export function auto<TInput = unknown>(options: AutoApprovalOptions = {}): ApprovalPolicy<TInput> {
  const decisionModel = options.model ?? "typesafe-ai/jev";
  return (context) => autoApproval(decisionModel, options, context as ApprovalContext);
}

/** Returns an `approval` callback that always requires user approval. */
export function always<TInput = unknown>(): ApprovalPolicy<TInput> {
  return () => "user-approval";
}

/** Returns an `approval` callback that never requires user approval. */
export function never<TInput = unknown>(): ApprovalPolicy<TInput> {
  return () => "not-applicable";
}

/** Remembers a person's approval for this tool for the rest of the session. */
export function once<TInput = unknown>(): ApprovalPolicy<TInput> {
  if (arguments.length !== 0) {
    throw new TypeError(
      "once() does not accept options. Use a custom approval policy for input-dependent decisions.",
    );
  }
  return (context) => {
    const evaluation = approvalEvaluation(context as ApprovalContext);
    if (evaluation === undefined) return "user-approval";
    const { entry, pending } = evaluation.read("once");
    // An approval still waiting on its own answer stays a separate question.
    return entry?.outcome === "accepted" && !pending ? "approved" : evaluation.ask({ key: "once" });
  };
}
