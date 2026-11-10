import type { DecisionModel } from "#ai/decision-types.js";
import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import { decide } from "#ai/decide.js";
import { approvalEvaluation } from "#approval/evaluation.js";
import { callerSpokeLast, principalOf } from "#context/session-auth.js";
import { parseJsonValue } from "#shared/json.js";

const MAX_ACTION_BYTES = 64 * 1024;

const DEFAULT_INSTRUCTIONS = `Review the exact tool action for dangerous effects. Return caution when it could cause meaningful harm, including destructive data loss, credential exposure, financial transactions, deployments or public changes, external communication, privilege or system changes, or concealed execution. Return clear for routine, low-impact actions. Judge the action's actual effects from its name and input. If important effects are unclear, return caution.`;
const DEFAULT_CLEAR_DESCRIPTION = "The action is routine and low impact.";
const DEFAULT_CAUTION_DESCRIPTION = "The action is dangerous or its important effects are unclear.";

export interface AutoApprovalOptions {
  /** Decision model instance or ID. Defaults to TypeSafe Jev. */
  readonly model?: DecisionModel;
  /** Provider options for the decision call. */
  readonly modelOptions?: Pick<AgentModelOptionsDefinition, "providerOptions">;
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
      providerOptions: options.modelOptions?.providerOptions,
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

/** Options for `always()`. */
export interface AlwaysApprovalOptions {
  /**
   * `"principal-mismatch"` asks only while someone other than the turn's caller spoke last, and
   * only the caller can approve; anyone can deny.
   */
  readonly when: "principal-mismatch";
}

/** Options for `once()`. */
export interface OnceApprovalOptions {
  /**
   * `"principal-mismatch"` asks only while someone other than the turn's caller spoke last, and
   * only the caller can approve; anyone can deny. The caller's approval is remembered for each
   * person who spoke last.
   */
  readonly when: "principal-mismatch";
}

/**
 * Returns an `approval` callback that always requires user approval. With
 * `{ when: "principal-mismatch" }`, it asks only while someone other than the caller spoke last.
 */
export function always<TInput = unknown>(options?: AlwaysApprovalOptions): ApprovalPolicy<TInput> {
  if (mismatchOption(options, "always") === undefined) return () => "user-approval";
  return (context) => {
    const { auth } = (context as ApprovalContext).session;
    if (callerSpokeLast(auth)) return "not-applicable";
    const evaluation = approvalEvaluation(context as ApprovalContext);
    return evaluation === undefined
      ? "user-approval"
      : evaluation.ask(undefined, { callerApproves: true });
  };
}

/** Returns an `approval` callback that never requires user approval. */
export function never<TInput = unknown>(): ApprovalPolicy<TInput> {
  return () => "not-applicable";
}

/**
 * Remembers a person's approval for this tool for the rest of the session. With
 * `{ when: "principal-mismatch" }`, it asks only while someone other than the caller spoke last,
 * once for each caller and person who spoke last.
 */
export function once<TInput = unknown>(options?: OnceApprovalOptions): ApprovalPolicy<TInput> {
  if (
    arguments.length > 1 ||
    (arguments.length === 1 && mismatchOption(options, "once") === undefined)
  ) {
    throw new TypeError(
      'once() accepts only { when: "principal-mismatch" }. Use a custom approval policy for input-dependent decisions.',
    );
  }
  if (options === undefined) {
    return (context) => {
      const evaluation = approvalEvaluation(context as ApprovalContext);
      if (evaluation === undefined) return "user-approval";
      const { entry, pending } = evaluation.read("once");
      // An approval still waiting on its own answer stays a separate question.
      return entry?.outcome === "accepted" && !pending
        ? "approved"
        : evaluation.ask({ key: "once" });
    };
  }
  return (context) => {
    const { auth } = (context as ApprovalContext).session;
    if (callerSpokeLast(auth)) return "not-applicable";
    const evaluation = approvalEvaluation(context as ApprovalContext);
    if (evaluation === undefined) return "user-approval";
    const key = JSON.stringify(["once", principalOf(auth.current), principalOf(auth.sender)]);
    const { entry, pending } = evaluation.read(key);
    if (entry?.outcome === "accepted" && !pending) return evaluation.approveForCaller();
    return evaluation.ask({ key }, { callerApproves: true });
  };
}

function mismatchOption(
  options: AlwaysApprovalOptions | OnceApprovalOptions | undefined,
  helper: "always" | "once",
): AlwaysApprovalOptions | OnceApprovalOptions | undefined {
  if (options === undefined) return undefined;
  if (
    typeof options !== "object" ||
    options === null ||
    options.when !== "principal-mismatch" ||
    Object.keys(options).length !== 1
  ) {
    throw new TypeError(`${helper}() accepts only { when: "principal-mismatch" }.`);
  }
  return options;
}
